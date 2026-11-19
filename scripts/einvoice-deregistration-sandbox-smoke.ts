// =============================================================================
// E-Faktúra — SANDBOX smoke pre offboarding (peppol/deactivate) a dôkaz overenia
// organizácie (mandát regrant). RUČNÉ spúšťanie, NIE CI. Iba sandbox kľúč efk_pk_test_…
//
// Kroky (iba nebillované volania):
//   S1  GET  /v1/agent/organizations/{SANDBOX_ORG_ID}   → stav + SHA-256 normalizovanej odpovede
//   S2  POST /v1/agent/organizations/{THROWAWAY}/peppol/deactivate  (IBA s --allow-deactivate=<THROWAWAY>
//       a iba pre syntetickú sandbox organizáciu založenú na tento účel; NIKDY org používanú v A/B E2E)
//   S3  opakované S2 → očakávané 2xx (idempotentné) alebo 409 (→ job retry); 404 = fail closed (operátor)
// Výstup: iba stavy, HTTP kódy chýb a prefixy SHA-256 — žiadny kľúč, žiadne PII.
//
//   node --env-file=.env.local --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs \
//     scripts/einvoice-deregistration-sandbox-smoke.ts --confirm-sandbox --org=<SANDBOX_ORG_ID> [--allow-deactivate=<THROWAWAY_ORG_ID>]
// =============================================================================
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import { EinvoiceProviderError } from "../lib/einvoice/provider/types.ts";
import { canonicalSha256 } from "../lib/einvoice/mandate.ts";
import { classifyDeactivateError } from "../lib/einvoice/deregistration.ts";

const ARGS = new Map<string, string>();
for (const raw of process.argv.slice(2)) {
  const [k, ...v] = raw.replace(/^--/, "").split("=");
  ARGS.set(k, v.join("=") || "true");
}
function stop(message: string): never {
  console.error(`STOP: ${message}`);
  process.exit(2);
}
if (ARGS.get("confirm-sandbox") !== "true") stop("chýba --confirm-sandbox");
const key = process.env.ESBLU_EFAKTURA_API_KEY?.trim() ?? "";
if (!key.startsWith("efk_pk_test_")) stop("iba sandbox kľúč (efk_pk_test_…); live kľúč sa nikdy nepoužije");
if ((process.env.ESBLU_EINVOICE_ENVIRONMENT ?? "sandbox") !== "sandbox") stop("ESBLU_EINVOICE_ENVIRONMENT musí byť sandbox");
const org = ARGS.get("org") ?? stop("chýba --org=<SANDBOX_ORG_ID>");
const throwaway = ARGS.get("allow-deactivate") ?? null;
if (throwaway && throwaway === org) stop("--allow-deactivate nesmie byť rovnaká org ako --org");

const provider = new EfakturaSkProvider({ apiKey: key, environment: "sandbox", baseUrl: process.env.ESBLU_EFAKTURA_BASE_URL });
const out: Record<string, unknown> = {};
try {
  const info = await provider.getOrganization({ environment: "sandbox", providerOrgId: org });
  out.S1 = { ok: true, peppolEligible: info.peppolEligible, peppolStatus: info.peppolStatus, sha256: canonicalSha256({ ...info, reused: undefined }).slice(0, 12) };
} catch (e) {
  out.S1 = { ok: false, code: e instanceof EinvoiceProviderError ? e.code : "ERROR" };
}
if (throwaway) {
  for (const step of ["S2", "S3"]) {
    try {
      const r = await provider.deactivatePeppol({ environment: "sandbox", providerOrgId: throwaway });
      out[step] = { ok: true, peppolStatus: r.peppolStatus, sha256: r.responseSha256?.slice(0, 12) ?? null };
    } catch (e) {
      const c = classifyDeactivateError(e);
      out[step] = { ok: false, code: c.code, jobOutcome: c.outcome };
    }
  }
} else {
  out.S2 = "SKIP (bez --allow-deactivate)";
}
console.log(JSON.stringify(out, null, 2));
