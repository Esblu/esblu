import "server-only";

import { CircuitBreaker, SlidingWindowLimiter, TtlCache, sha256Key } from "./memory.ts";
import { foldForCompare, icoChecksumValid, SEARCH_RESULT_LIMIT, type ParsedLookupQuery } from "./normalize.ts";
import type {
  CompanyCandidate,
  CompanyDetailResponseBody,
  CompanyLookupErrorCode,
  CompanyLookupProvider,
  CompanyLookupWarning,
  CompanySearchResponseBody,
  CompanyTaxIdEnrichmentProvider,
  VerificationStatus,
} from "./types.ts";

// =============================================================================
// Esblu — Company lookup service (PHASE 1): RPO primárne, RÚZ iba DIČ.
// =============================================================================
// Logovanie: IBA technické minimum {op, provider, outcome, ms, count}.
// Nikdy text dopytu, IČO, názov ani odpoveď registra.
// =============================================================================

const DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;

export type LookupLogEvent = {
  op: "search" | "detail";
  provider: "rpo" | "ruz" | "cache";
  outcome: VerificationStatus | "RATE_LIMITED" | "CIRCUIT_OPEN" | "HIT";
  ms: number;
  count?: number;
  error?: string;
};

export type CompanyLookupServiceDeps = {
  rpo: CompanyLookupProvider;
  ruz: CompanyTaxIdEnrichmentProvider;
  now?: () => number;
  log?: (event: LookupLogEvent) => void;
  limits?: { perUserPerMinute: number; perCompanyPerHour: number };
};

export type ServiceOutcome<T> = { ok: true; body: T } | { ok: false; status: 404 | 429 | 503; code: CompanyLookupErrorCode };

export type CompanyLookupService = {
  consumeRateLimit(userId: string, companyId: string): boolean;
  search(query: Exclude<ParsedLookupQuery, { kind: "error" }>): Promise<ServiceOutcome<CompanySearchResponseBody>>;
  detail(ico: string): Promise<ServiceOutcome<CompanyDetailResponseBody>>;
};

export function createCompanyLookupService(deps: CompanyLookupServiceDeps): CompanyLookupService {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const limits = deps.limits ?? { perUserPerMinute: 40, perCompanyPerHour: 600 };

  const detailCache = new TtlCache<CompanyDetailResponseBody>(DETAIL_TTL_MS, 2000, now);
  const searchCache = new TtlCache<CompanySearchResponseBody>(SEARCH_TTL_MS, 1000, now);
  const userLimiter = new SlidingWindowLimiter(limits.perUserPerMinute, 60_000, now);
  const companyLimiter = new SlidingWindowLimiter(limits.perCompanyPerHour, 3_600_000, now);
  const rpoBreaker = new CircuitBreaker(5, 60_000, now);
  const ruzBreaker = new CircuitBreaker(5, 60_000, now);

  return {
    consumeRateLimit(userId, companyId) {
      // Oba buckety sa skontrolujú; firma je z DB (guard), nie z požiadavky.
      const userOk = userLimiter.consume(`u:${userId}`);
      const companyOk = userOk && companyLimiter.consume(`c:${companyId}`);
      return userOk && companyOk;
    },

    async search(query) {
      const started = now();
      const cacheKey = await sha256Key(query.kind === "ico" ? `ico:${query.ico}` : `name:${foldForCompare(query.name)}`);
      const cached = searchCache.get(cacheKey);
      if (cached) {
        log({ op: "search", provider: "cache", outcome: "HIT", ms: now() - started, count: cached.results.length });
        return { ok: true, body: cached };
      }

      if (rpoBreaker.isOpen()) {
        log({ op: "search", provider: "rpo", outcome: "CIRCUIT_OPEN", ms: 0 });
        return { ok: false, status: 503, code: "UNAVAILABLE" };
      }

      const result =
        query.kind === "ico"
          ? await deps.rpo.searchByIco(query.ico, { limit: SEARCH_RESULT_LIMIT })
          : await deps.rpo.searchByName(query.name, { onlyActive: true, limit: SEARCH_RESULT_LIMIT });

      if (result.status === "UNAVAILABLE" || !result.data) {
        if (result.error?.retryable !== false) rpoBreaker.recordFailure();
        log({ op: "search", provider: "rpo", outcome: "UNAVAILABLE", ms: now() - started, error: result.error?.code });
        return { ok: false, status: 503, code: "UNAVAILABLE" };
      }
      rpoBreaker.recordSuccess();

      const results: CompanyCandidate[] = result.data.slice(0, SEARCH_RESULT_LIMIT);
      const body: CompanySearchResponseBody = {
        ok: true,
        mode: query.kind,
        status: results.length ? "VERIFIED" : "NOT_FOUND",
        source: "rpo",
        checkedAt: result.checkedAt,
        results,
      };
      searchCache.set(cacheKey, body);
      log({ op: "search", provider: "rpo", outcome: body.status, ms: now() - started, count: results.length });
      return { ok: true, body };
    },

    async detail(ico) {
      const started = now();
      const cached = detailCache.get(ico);
      if (cached) {
        log({ op: "detail", provider: "cache", outcome: "HIT", ms: now() - started });
        return { ok: true, body: cached };
      }

      if (rpoBreaker.isOpen()) {
        log({ op: "detail", provider: "rpo", outcome: "CIRCUIT_OPEN", ms: 0 });
        return { ok: false, status: 503, code: "UNAVAILABLE" };
      }

      const rpo = await deps.rpo.getDetailByIco(ico);
      if (rpo.status === "NOT_FOUND") {
        rpoBreaker.recordSuccess();
        log({ op: "detail", provider: "rpo", outcome: "NOT_FOUND", ms: now() - started });
        return { ok: false, status: 404, code: "NOT_FOUND" };
      }
      if (rpo.status !== "VERIFIED" || !rpo.data) {
        if (rpo.error?.retryable !== false) rpoBreaker.recordFailure();
        log({ op: "detail", provider: "rpo", outcome: "UNAVAILABLE", ms: now() - started, error: rpo.error?.code });
        return { ok: false, status: 503, code: "UNAVAILABLE" };
      }
      rpoBreaker.recordSuccess();

      const warnings: CompanyLookupWarning[] = [];
      const rpoPartial = rpo.error !== null;
      if (rpoPartial) warnings.push("RPO_DETAIL_UNAVAILABLE");
      if (!icoChecksumValid(ico)) warnings.push("ICO_CHECKSUM");

      // RÚZ je iba doplnok: akékoľvek zlyhanie = dic null + varovanie, nikdy chyba lookupu.
      let dic: string | null = null;
      let ruzStatus: VerificationStatus = "UNAVAILABLE";
      if (ruzBreaker.isOpen()) {
        warnings.push("RUZ_UNAVAILABLE");
      } else {
        const ruzStarted = now();
        let ruz: Awaited<ReturnType<CompanyTaxIdEnrichmentProvider["getDicByIco"]>> | null = null;
        try {
          ruz = await deps.ruz.getDicByIco(ico);
        } catch {
          ruz = null;
        }
        if (!ruz || ruz.status === "UNAVAILABLE") {
          if (!ruz || ruz.error?.retryable !== false) ruzBreaker.recordFailure();
          warnings.push("RUZ_UNAVAILABLE");
          log({ op: "detail", provider: "ruz", outcome: "UNAVAILABLE", ms: now() - ruzStarted, error: ruz?.error?.code ?? "EXCEPTION" });
        } else {
          ruzBreaker.recordSuccess();
          ruzStatus = ruz.status;
          if (ruz.status === "NOT_FOUND") warnings.push("RUZ_NOT_FOUND");
          if (ruz.data?.ambiguous) warnings.push("DIC_AMBIGUOUS");
          dic = ruz.data?.ambiguous ? null : ruz.data?.dic ?? null;
          log({ op: "detail", provider: "ruz", outcome: ruz.status, ms: now() - ruzStarted });
        }
      }

      const body: CompanyDetailResponseBody = {
        ok: true,
        checkedAt: rpo.checkedAt,
        company: { ...rpo.data, dic },
        sources: [
          { id: "rpo", status: "VERIFIED" },
          { id: "ruz", status: ruzStatus },
        ],
        warnings,
      };
      // Do cache iba úplný výsledok — čiastočný sa pri ďalšom pokuse skúsi znova.
      if (!rpoPartial && ruzStatus !== "UNAVAILABLE") detailCache.set(ico, body);
      log({ op: "detail", provider: "rpo", outcome: "VERIFIED", ms: now() - started });
      return { ok: true, body };
    },
  };
}

function defaultLog(event: LookupLogEvent): void {
  console.info(JSON.stringify({ evt: "company_lookup", ...event }));
}
