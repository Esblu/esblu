// =============================================================================
// E-Faktúra — STAGING E2E driver: hard guard (čistá funkcia, bez I/O).
//
// Driver (`app/api/einvoice/staging-e2e`) existuje IBA na to, aby sa reálny
// sandbox E2E (eFaktura.sk partner sandbox × staging Supabase esblu-test)
// dal spustiť z Vercel Preview, kde je sieťový prístup na api.efaktura.sk.
// V každom inom prostredí je route neviditeľná (404) — aj keď sa kód dostane
// do main, bez VŠETKÝCH podmienok nižšie nič nespraví.
//
// Podmienky (všetky naraz):
//   VERCEL_ENV = preview a VERCEL_GIT_COMMIT_REF = einvoice-port
//   ESBLU_STAGING_E2E_ENABLED = true, ESBLU_STAGING_E2E_SECRET ≥ 32 znakov
//   Supabase URL = presne staging esblu-test; service_role JWT (ak je JWT) má ref stagingu
//   žiadna premenná neobsahuje produkčný ref
//   eFaktúra: sandbox, kľúč efk_pk_test_…, ESBLU_EINVOICE_LIVE_ENABLED nenastavené
// =============================================================================

export const STAGING_SUPABASE_REF = "cjbdijbbcujvmrzezusd";
export const PRODUCTION_SUPABASE_REF = "fkpgvgvsmbpieduoatrt";
export const STAGING_E2E_BRANCH = "einvoice-port";

export type GuardResult = { ok: true } | { ok: false; reason: string };

function jwtRef(token: string): string | null | "not-jwt" {
  const parts = token.split(".");
  if (parts.length !== 3 || !token.startsWith("eyJ")) return "not-jwt";
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { ref?: unknown };
    return typeof json.ref === "string" ? json.ref : null;
  } catch {
    return null;
  }
}

export function stagingE2eGuard(env: Record<string, string | undefined>): GuardResult {
  const v = (k: string) => (env[k] ?? "").trim();
  if (v("VERCEL_ENV") !== "preview") return { ok: false, reason: "NOT_PREVIEW" };
  if (v("VERCEL_GIT_COMMIT_REF") !== STAGING_E2E_BRANCH) return { ok: false, reason: "WRONG_BRANCH" };
  if (v("ESBLU_STAGING_E2E_ENABLED") !== "true") return { ok: false, reason: "DISABLED" };
  if (v("ESBLU_STAGING_E2E_SECRET").length < 32) return { ok: false, reason: "SECRET_MISSING" };
  if (v("NEXT_PUBLIC_SUPABASE_URL") !== `https://${STAGING_SUPABASE_REF}.supabase.co`) return { ok: false, reason: "NOT_STAGING_DB" };
  for (const [k, val] of Object.entries(env)) {
    if (typeof val === "string" && val.includes(PRODUCTION_SUPABASE_REF)) return { ok: false, reason: `PRODUCTION_REF_IN_${k.replace(/[^A-Z0-9_]/g, "")}` };
  }
  const svc = v("SUPABASE_SERVICE_ROLE_KEY");
  if (!svc) return { ok: false, reason: "SERVICE_KEY_MISSING" };
  const ref = jwtRef(svc);
  if (ref !== "not-jwt" && ref !== STAGING_SUPABASE_REF) return { ok: false, reason: "SERVICE_KEY_NOT_STAGING" };
  const anonRef = jwtRef(v("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
  if (anonRef !== "not-jwt" && anonRef !== STAGING_SUPABASE_REF) return { ok: false, reason: "ANON_KEY_NOT_STAGING" };
  if (v("ESBLU_EINVOICE_PROVIDER") !== "efaktura_sk") return { ok: false, reason: "PROVIDER" };
  if (v("ESBLU_EINVOICE_ENVIRONMENT") !== "sandbox") return { ok: false, reason: "NOT_SANDBOX" };
  if (!v("ESBLU_EFAKTURA_API_KEY").startsWith("efk_pk_test_")) return { ok: false, reason: "NOT_TEST_KEY" };
  if (v("ESBLU_EINVOICE_LIVE_ENABLED")) return { ok: false, reason: "LIVE_FLAG_SET" };
  const base = v("ESBLU_EFAKTURA_BASE_URL");
  if (base && !/^https:\/\/api\.efaktura\.sk\/?$/.test(base)) return { ok: false, reason: "BASE_URL" };
  return { ok: true };
}

/**
 * Uzavretý zoznam syntetických firiem E2E (seed: scripts/einvoice-staging-e2e-seed.sql).
 * A, B = plný tok (A → B); C = neplatný FS kód; D = send_only. Iné firmy driver odmietne.
 */
export const STAGING_E2E_COMPANIES = {
  A: "e2e5a000-0000-4000-8000-00000000000a",
  B: "e2e5a000-0000-4000-8000-00000000000b",
  C: "e2e5a000-0000-4000-8000-00000000000c",
  D: "e2e5a000-0000-4000-8000-00000000000d",
} as const;
export type StagingE2eTarget = keyof typeof STAGING_E2E_COMPANIES;

/** Používatelia (owner) firiem A a B — syntetické rezervované e-maily (RFC 2606). */
export const STAGING_E2E_USERS = { A: "e2e-partner-a@example.com", B: "e2e-partner-b@example.com" } as const;

/** Sandbox FS overovacie kódy z dokumentácie eFaktura.sk (iné kódy driver neprijme). */
export const STAGING_E2E_TOKENS = { ok: "a1b2c3", invalid: "000000000000dead", sendOnly: "000000000000beef" } as const;

export function parseTarget(raw: unknown): StagingE2eTarget | null {
  return raw === "A" || raw === "B" || raw === "C" || raw === "D" ? raw : null;
}

export function targetForCompany(companyId: string | null | undefined): StagingE2eTarget | null {
  for (const [k, id] of Object.entries(STAGING_E2E_COMPANIES)) if (id === companyId) return k as StagingE2eTarget;
  return null;
}
