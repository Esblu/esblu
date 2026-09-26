// =============================================================================
// Serverové volania nárokov — vždy cez user-scoped Supabase klienta (JWT
// volajúceho). Firma sa odvodí v DB z auth.uid(), nikdy z tela požiadavky.
// Žiadny service_role. Každé zlyhanie = fail closed.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { translate } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locales";
import {
  entitlementMessageKey,
  entitlementModuleKey,
  parseCompanyEntitlements,
  parseEntitlementDenial,
  type CompanyEntitlements,
  type EntitlementDenial,
  type EntitlementKey,
} from "@/lib/entitlements";

export async function getCompanyEntitlements(db: SupabaseClient): Promise<CompanyEntitlements | null> {
  try {
    const { data, error } = await db.rpc("esblu_get_my_company_entitlements");
    if (error) return null;
    return parseCompanyEntitlements(data);
  } catch {
    return null;
  }
}

export type RequireResult =
  | { ok: true }
  | { ok: false; denial: EntitlementDenial | null };

/** Serverová brána pre schopnosť (napr. hlas). `denial: null` = technická chyba (tiež odmietnuté). */
export async function requireEntitlement(db: SupabaseClient, key: EntitlementKey): Promise<RequireResult> {
  try {
    const { error } = await db.rpc("esblu_require_my_entitlement", { p_key: key });
    if (!error) return { ok: true };
    return { ok: false, denial: parseEntitlementDenial(error) };
  } catch {
    return { ok: false, denial: null };
  }
}

/**
 * Hlas (prepis reči) je platená schopnosť. Klient sa „oblečie" do JWT z
 * hlavičky Authorization (už overenej volajúcim cez verifyRequestUser);
 * firma sa odvodí v DB. Iná hodnota v tele požiadavky sa nečíta.
 */
export async function requireVoiceEntitlement(req: Request): Promise<RequireResult> {
  const authorization = req.headers.get("authorization") || "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!accessToken) return { ok: false, denial: null };
  return requireEntitlement(getUserScopedSupabaseClient(accessToken), "voice");
}

export type AiEndpoint = "scan-document" | "scan-vehicle-registration" | "scan-vehicle-doc";

export type AiReservation =
  | { ok: true; usageId: string; reused: boolean }
  | { ok: false; denial: EntitlementDenial | null; code: string | null };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** Kľúč z hlavičky `Idempotency-Key`; chýbajúci/neplatný → nový (bez ochrany retry, ale nikdy nie bez účtovania). */
export function resolveIdempotencyKey(req: Request): string {
  const header = req.headers.get("idempotency-key")?.trim() ?? "";
  return IDEMPOTENCY_KEY.test(header) ? header : crypto.randomUUID().replace(/-/g, "");
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Rezervuje JEDNO AI spracovanie. Volať AŽ po autentifikácii a validácii
 * vstupu, tesne pred prvým volaním modelu.
 */
export async function reserveAiProcessing(
  db: SupabaseClient,
  endpoint: AiEndpoint,
  idempotencyKey: string,
  contentSha256: string
): Promise<AiReservation> {
  try {
    const { data, error } = await db.rpc("esblu_reserve_ai_processing", {
      p_endpoint: endpoint,
      p_idempotency_key: idempotencyKey,
      p_content_sha256: contentSha256,
    });
    if (error) {
      const code = /ESBLU_[A-Z_]+/.exec(`${error.message ?? ""}`)?.[0] ?? null;
      return { ok: false, denial: parseEntitlementDenial(error), code };
    }
    const value = data as { usage_id?: unknown; reused?: unknown } | null;
    if (!value || typeof value.usage_id !== "string") return { ok: false, denial: null, code: null };
    return { ok: true, usageId: value.usage_id, reused: value.reused === true };
  } catch {
    return { ok: false, denial: null, code: null };
  }
}

/** Po volaní modelu: `true` = model odpovedal (účtuje sa), `false` = zlyhanie AI (neúčtuje sa). */
export async function finalizeAiProcessing(db: SupabaseClient, usageId: string, succeeded: boolean): Promise<void> {
  try {
    await db.rpc("esblu_finalize_ai_processing", { p_usage_id: usageId, p_succeeded: succeeded });
  } catch {
    // Nefinalizovaná rezervácia ostáva 'reserved' → počíta sa (fail closed).
  }
}

// -----------------------------------------------------------------------------
// Jednotná HTTP odpoveď pre odmietnutie nárokom (403). Klient/hlas čítajú
// `code` + `reason` + `key`, text je iba lokalizovaná pomôcka. Neobsahuje
// žiadne billing údaje, ceny ani stav iných firiem.
// -----------------------------------------------------------------------------

export function entitlementDenialMessage(locale: Locale, denial: EntitlementDenial): string {
  return translate(locale, entitlementMessageKey(denial.reason), {
    module: translate(locale, entitlementModuleKey(denial.key)),
  });
}

export function entitlementDenialResponse(locale: Locale, denial: EntitlementDenial): Response {
  return Response.json(
    {
      success: false,
      code: denial.code,
      reason: denial.reason,
      key: denial.key,
      error: entitlementDenialMessage(locale, denial),
    },
    { status: 403, headers: { "Cache-Control": "private, no-store" } }
  );
}

/**
 * Spoločná brána pre AI endpointy, ktoré doteraz nemali kontrolu firmy ani
 * stropu (scan-vehicle-registration, scan-vehicle-doc): technický abuse limit
 * (esblu_consume_ai_scan_quota, overí aj aktívne členstvo) + rezervácia AI
 * spracovania. Volať po validácii vstupu, pred prvým volaním modelu.
 */
export async function guardAiProcessing(
  db: SupabaseClient,
  req: Request,
  locale: Locale,
  endpoint: AiEndpoint,
  content: Uint8Array
): Promise<{ ok: true; usageId: string } | { ok: false; response: Response }> {
  const fail = (status: number, key: string) => ({
    ok: false as const,
    response: Response.json({ success: false, error: translate(locale, key) }, { status }),
  });

  const { error: quotaError } = await db.rpc("esblu_consume_ai_scan_quota", { p_endpoint: endpoint });
  if (quotaError) {
    const message = `${quotaError.message ?? ""} ${quotaError.hint ?? ""}`;
    if (message.includes("ESBLU_AI_SCAN_RATE_LIMIT")) return fail(429, "inbox.errors.scanRateLimited");
    if (message.includes("ESBLU_NO_ACTIVE_COMPANY") || message.includes("ESBLU_NOT_AUTHENTICATED")) {
      return fail(403, "inbox.errors.scanNoActiveCompany");
    }
    return fail(503, "inbox.errors.scanFailedGeneric");
  }

  const reservation = await reserveAiProcessing(db, endpoint, resolveIdempotencyKey(req), await sha256Hex(content));
  if (!reservation.ok) {
    if (reservation.denial) return { ok: false, response: entitlementDenialResponse(locale, reservation.denial) };
    return fail(reservation.code === "ESBLU_AI_IDEMPOTENCY_CONFLICT" ? 409 : 503, "inbox.errors.scanFailedGeneric");
  }
  return { ok: true, usageId: reservation.usageId };
}
