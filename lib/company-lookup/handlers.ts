import "server-only";

import { guardCompanyLookup, type CompanyLookupGuardDeps } from "./guard.ts";
import { canonicalIco, parseLookupQuery } from "./normalize.ts";
import type { CompanyLookupService } from "./service.ts";
import type { CompanyLookupErrorCode } from "./types.ts";

// =============================================================================
// Esblu — HTTP handlery POST /api/company-lookup/{search,detail}.
// =============================================================================
// Názov firmy aj IČO môžu byť osobné údaje (SZČO), preto idú VÝHRADNE v
// JSON tele POST požiadavky — nikdy v URL, kde by skončili v prístupových
// logoch proxy/Vercelu, histórii prehliadača či Referer hlavičke. Query
// string sa nečíta vôbec (ani ako fallback).
//
// Poradie je zámerne: autentifikácia → oprávnenie (finance.manage z DB) →
// telo požiadavky → validácia → rate limit → register. Bez oprávnenia sa
// telo ani register nikdy nečítajú. Odpoveď je vždy `private, no-store`.
// Chyby nesú iba kód; text prekladá klient. Firma/rola z požiadavky sa
// nečítajú.
// =============================================================================

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
/** Strop tela požiadavky — dopyt má max ~100 znakov, IČO 8 číslic. */
const MAX_BODY_BYTES = 2048;

export type CompanyLookupHandlerDeps = {
  guardDeps: (req: Request) => CompanyLookupGuardDeps;
  service: CompanyLookupService;
};

function errorResponse(status: number, code: CompanyLookupErrorCode): Response {
  return Response.json({ ok: false, code }, { status, headers: NO_STORE });
}

/**
 * Prečíta JSON objekt z tela so stropom veľkosti. Iný Content-Type, prázdne,
 * príliš veľké alebo neplatné telo = null (volajúci vráti 400).
 */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) return null;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createCompanyLookupHandlers(deps: CompanyLookupHandlerDeps) {
  return {
    async search(req: Request): Promise<Response> {
      const guard = await guardCompanyLookup(deps.guardDeps(req));
      if (!guard.ok) return errorResponse(guard.status, guard.code);

      const body = await readJsonBody(req);
      if (!body) return errorResponse(400, "INVALID_QUERY");
      const parsed = parseLookupQuery(typeof body.q === "string" ? body.q : "");
      if (parsed.kind === "error") return errorResponse(400, typeof body.q === "string" ? parsed.code : "INVALID_QUERY");

      if (!deps.service.consumeRateLimit(guard.userId, guard.companyId)) return errorResponse(429, "RATE_LIMITED");

      const outcome = await deps.service.search(parsed);
      if (!outcome.ok) return errorResponse(outcome.status, outcome.code);
      return Response.json(outcome.body, { status: 200, headers: NO_STORE });
    },

    async detail(req: Request): Promise<Response> {
      const guard = await guardCompanyLookup(deps.guardDeps(req));
      if (!guard.ok) return errorResponse(guard.status, guard.code);

      const body = await readJsonBody(req);
      const ico = body && typeof body.ico === "string" ? canonicalIco(body.ico) : null;
      if (!ico) return errorResponse(400, "INVALID_ICO");

      if (!deps.service.consumeRateLimit(guard.userId, guard.companyId)) return errorResponse(429, "RATE_LIMITED");

      const outcome = await deps.service.detail(ico);
      if (!outcome.ok) return errorResponse(outcome.status, outcome.code);
      return Response.json(outcome.body, { status: 200, headers: NO_STORE });
    },
  };
}
