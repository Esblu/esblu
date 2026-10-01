import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import type {
  CompanyDetail,
  CompanyDetailResponseBody,
  CompanyLookupErrorCode,
  CompanySearchResponseBody,
} from "./types.ts";

// =============================================================================
// Klientské volania /api/company-lookup/* (web aj mobilný build cez apiUrl).
// Dopyt aj IČO idú VÝHRADNE v JSON tele POST požiadavky, nikdy v URL
// (minimalizácia osobných údajov v proxy/Vercel logoch a histórii).
// Vracia iba typované výsledky alebo kód chyby — text prekladá UI. Zrušenie
// (AbortController) sa hlási ako "aborted", nie ako chyba.
// =============================================================================

export type LookupClientResult<T> =
  | { ok: true; body: T }
  | { ok: false; code: CompanyLookupErrorCode | "NETWORK" }
  | { ok: false; aborted: true };

const KNOWN_CODES = new Set<CompanyLookupErrorCode>([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "QUERY_TOO_SHORT",
  "INVALID_QUERY",
  "INVALID_ICO",
  "RATE_LIMITED",
  "NOT_FOUND",
  "UNAVAILABLE",
]);

async function postJson<T>(path: string, payload: Record<string, string>, signal?: AbortSignal): Promise<LookupClientResult<T>> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return { ok: false, code: "UNAUTHENTICATED" };

    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal,
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; code?: unknown } | null;
    if (response.ok && body && body.ok === true) return { ok: true, body: body as T };
    const code = typeof body?.code === "string" && KNOWN_CODES.has(body.code as CompanyLookupErrorCode) ? (body.code as CompanyLookupErrorCode) : "UNAVAILABLE";
    return { ok: false, code };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return { ok: false, aborted: true };
    return { ok: false, code: "NETWORK" };
  }
}

export function searchCompanies(query: string, signal?: AbortSignal) {
  return postJson<CompanySearchResponseBody>("/api/company-lookup/search", { q: query }, signal);
}

export function getCompanyDetail(ico: string, signal?: AbortSignal) {
  return postJson<CompanyDetailResponseBody>("/api/company-lookup/detail", { ico }, signal);
}

export type { CompanyDetail };
