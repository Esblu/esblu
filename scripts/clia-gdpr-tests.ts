// =============================================================================
// J10 CLIA GDPR reconciliation — unit/statické testy (bez DB, bez siete).
//
//   - DPA brána pre AI (lib/ai/company-dpa-guard.ts): fail closed.
//   - Registračné potvrdenie: verzie zobrazené pri odškrtnutí (2.2.4).
//   - Legal verzie: config ↔ súbory ↔ DB seed hash (sha256 SK originálu).
//   - Privacy 1.4 = CLIA text: bez zástupného riadku, odkaz na /cookies,
//     žiadny neautorizovaný EN/DE preklad 1.4.
//   - Cookies 1.1: každý localStorage/sessionStorage kľúč „esblu…“ v kóde je
//     v inventári; žiadne cookies v kóde; žiadne analytické/3rd-party skripty.
//   - AI routes volajú DPA bránu pred OpenAI.
//
//   npm run test:clia-gdpr
// =============================================================================
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideCompanyDpaGuard, companyDpaGuardMessageKey } from "@/lib/ai/company-dpa-guard";
import { registrationAckVersions, currentLegalAckMetadata, LEGAL_ACK_METADATA_KEY } from "@/lib/legal-ack-versions";
import { legalConfig, REQUIRED_ACCEPTANCE_DOCUMENTS } from "@/lib/legal-config";
import { legalTranslationAvailability } from "@/lib/legal-content";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (["node_modules", ".next", "android", "ios", "out"].includes(name)) continue;
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}
const SOURCES = [...walk("app"), ...walk("lib"), ...walk("hooks"), ...(existsSync(path.join(ROOT, "mobile/app")) ? walk("mobile/app") : []), "public/sw.js"];

// ----------------------------------------------------------------------------- DPA brána
check("DPA brána: prijatá DPA → ok", () => {
  assert.deepEqual(decideCompanyDpaGuard([{ has_current_acceptance: true }], null), { ok: true });
  assert.deepEqual(decideCompanyDpaGuard({ has_current_acceptance: true }, null), { ok: true });
});
check("DPA brána: neprijatá / nejasná DPA → 403, nič do AI", () => {
  for (const v of [false, null, undefined, "true", 1]) {
    const d = decideCompanyDpaGuard([{ has_current_acceptance: v }], null);
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.status, 403);
      assert.equal(d.code, "ESBLU_COMPANY_DPA_NOT_ACCEPTED");
      assert.equal(companyDpaGuardMessageKey(d), "companyDpaGate.aiBlocked");
    }
  }
});
check("DPA brána: bez aktívnej firmy → 403; chyba RPC → 503 (fail closed)", () => {
  const none = decideCompanyDpaGuard([], null);
  assert.ok(!none.ok && none.status === 403 && none.code === "ESBLU_NO_ACTIVE_COMPANY");
  const err = decideCompanyDpaGuard(null, { code: "PGRST202" });
  assert.ok(!err.ok && err.status === 503 && err.code === "ESBLU_DPA_STATUS_UNAVAILABLE");
});
check("AI routes: DPA brána je volaná pred OpenAI (scan-document, transcribe, intent, guardAiProcessing)", () => {
  // OpenAI pomocné funkcie sú definované pred POST — rozhoduje poradie v POST tele
  // (helpery sa volajú až po bráne).
  const scanFull = read("app/api/scan-document/route.ts");
  const scan = scanFull.slice(scanFull.indexOf("export async function POST"));
  assert.ok(scan.indexOf("checkCompanyDpaForAi(userClient)") > 0);
  assert.ok(scan.indexOf("checkCompanyDpaForAi(userClient)") < scan.indexOf('rpc("esblu_consume_ai_scan_quota"'));
  assert.ok(scan.indexOf("checkCompanyDpaForAi(userClient)") < scan.search(/extract[A-Za-z]*\(|callOpenAiWithCostGuard\(|responses\.create/));
  const trFull = read("app/api/assistant/transcribe/route.ts");
  const tr = trFull.slice(trFull.indexOf("export async function POST"));
  assert.ok(tr.indexOf("checkCompanyDpaForAi(") > 0 && tr.indexOf("checkCompanyDpaForAi(") < tr.indexOf("audio.transcriptions.create"));
  assert.ok(tr.indexOf("checkCompanyDpaForAi(") < tr.indexOf("req.formData()"), "DPA pred čítaním audia");
  const intent = read("app/api/assistant/intent/route.ts");
  assert.match(intent, /if \(!dpaForAi\.ok\) return Promise\.resolve\(null\);/);
  const ent = read("lib/entitlements-server.ts");
  const g = ent.slice(ent.indexOf("export async function guardAiProcessing"));
  assert.ok(g.indexOf("checkCompanyDpaForAi(db)") > 0 && g.indexOf("checkCompanyDpaForAi(db)") < g.indexOf('rpc("esblu_consume_ai_scan_quota"'));
  for (const r of ["app/api/scan-vehicle-registration/route.ts", "app/api/scan-vehicle-doc/route.ts"]) {
    const s = read(r);
    assert.ok(s.indexOf("guardAiProcessing(") > 0 && s.indexOf("guardAiProcessing(") < s.indexOf("responses.create"), r);
  }
});

// ----------------------------------------------------------------------------- registračné potvrdenie
check("registrácia: zapisujú sa verzie zobrazené pri odškrtnutí; inak aktuálne; nevalidné ignorované", () => {
  const current = currentLegalAckMetadata();
  assert.deepEqual(current, Object.fromEntries(REQUIRED_ACCEPTANCE_DOCUMENTS.map((d) => [d.type, d.version])));
  assert.deepEqual(registrationAckVersions({ [LEGAL_ACK_METADATA_KEY]: { terms: "1.1", privacy_policy: "1.3" } }), [
    { type: "terms", version: "1.1" },
    { type: "privacy_policy", version: "1.3" },
  ]);
  assert.deepEqual(registrationAckVersions(null), REQUIRED_ACCEPTANCE_DOCUMENTS.map((d) => ({ type: d.type, version: d.version })));
  assert.deepEqual(registrationAckVersions({ [LEGAL_ACK_METADATA_KEY]: { privacy_policy: "1.4; drop" } })[1], { type: "privacy_policy", version: legalConfig.privacyPolicyVersion });
});
check("registrácia: SK text potvrdenia = odporúčané znenie CLIA 2.2.2 (informačné, nie súhlas)", () => {
  const sk = read("lib/i18n/dictionaries/sk.ts");
  assert.match(sk, /agreePrivacyPrefix: "Potvrdzujem, že som sa oboznámil\/a so",\n\s+agreePrivacyLink: "Zásadami spracúvania osobných údajov",\n\s+agreePrivacySuffix: "spoločnosti Esblu s\. r\. o\.",/);
  const login = read("app/login/page.tsx");
  assert.match(login, /data: \{ \[LEGAL_ACK_METADATA_KEY\]: currentLegalAckMetadata\(\) \}/);
  assert.match(read("app/onboarding/company/page.tsx"), /registrationAckVersions\(session\.user\.user_metadata\)/);
});

// ----------------------------------------------------------------------------- verzie a seedy
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(ROOT, p))).digest("hex");
const allMigrations = readdirSync(path.join(ROOT, "supabase/migrations")).map((f) => read(`supabase/migrations/${f}`)).join("\n");
check("legal verzie: každá aktuálna verzia má SK súbor a DB seed s rovnakým sha256", () => {
  const docs: [string, string, string][] = [
    ["privacy_policy", legalConfig.privacyPolicyVersion, `legal/privacy/${legalConfig.privacyPolicyVersion}.md`],
    ["terms", legalConfig.termsVersion, `legal/terms/${legalConfig.termsVersion}.md`],
    ["cookie_policy", legalConfig.cookiePolicyVersion, `legal/cookies/${legalConfig.cookiePolicyVersion}.md`],
    ["dpa", legalConfig.dpaVersion, `legal/dpa/${legalConfig.dpaVersion}.md`],
  ];
  for (const [type, version, file] of docs) {
    assert.ok(existsSync(path.join(ROOT, file)), file);
    const re = new RegExp(`'${type}',\\s*'${version.replace(".", "\\.")}',[^']*'${sha(file)}'`);
    assert.match(allMigrations, re, `${type} ${version}: seed hash ≠ sha256(${file})`);
  }
});
check("privacy 1.4: CLIA text, zástupný riadok nahradený odkazom na /cookies, bez EN/DE prekladu", () => {
  assert.equal(legalConfig.privacyPolicyVersion, "1.4");
  const md = read("legal/privacy/1.4.md");
  assert.ok(md.startsWith("**ZÁSADY SPRACÚVANIA OSOBNÝCH ÚDAJOV**"));
  assert.ok(!/^[.…]{5,}$/m.test(md), "zástupný riadok z CLIA ostal v texte");
  assert.match(md, /sú uvedené:\n\n\[Informácie o cookies\]\(\/cookies\)\n/);
  assert.match(md, /Posledná aktualizácia:\n\n09\.11\.2026/);
  assert.ok(!/Anthropic/.test(md), "Privacy Policy (prevádzkovateľ) neuvádza Anthropic");
  assert.deepEqual(legalTranslationAvailability("privacy_policy", "1.4"), { sk: true, de: false, en: false });
});

// ----------------------------------------------------------------------------- cookies inventár
check("cookies 1.1: každý esblu localStorage/sessionStorage kľúč v kóde je v inventári (sk/en/de)", () => {
  const keys = new Set<string>();
  for (const f of SOURCES) {
    const src = read(f);
    for (const m of src.matchAll(/["'`](esblu[._][A-Za-z0-9._-]*?)(?:["'`]|\$\{|:\$\{)/g)) keys.add(m[1].replace(/[.:]$/, ""));
  }
  // kľúče, ktoré nie sú úložisko prehliadača (iné identifikátory s prefixom esblu)
  const NOT_STORAGE = /^(esblu_(secure_storage|before_|accept|get_|my_|purge|record|push|list|account|company|owner|member|user|consume|reserve|finalize|require|raise|usage|einvoice|intake|claim|create|media|role|set|ensure|switch|session|resolve|preview|billing|subscription|trial|plan|legal|ai_|document|invoice|chat|vehicle|machine|inventory|partner|fx|deadline|notification|storage)|esblu\.(com|office|client_purchase|sync|einvoice)|esblu_locale_cookie)/;
  const storageKeys = [...keys].filter((k) => !NOT_STORAGE.test(k) && /^(esblu\.[a-zA-Z]|esblu_locale$)/.test(k));
  assert.ok(storageKeys.length >= 8, `nájdené: ${storageKeys.join(", ")}`);
  for (const loc of ["", ".en", ".de"]) {
    const md = read(`legal/cookies/1.1${loc}.md`);
    for (const k of storageKeys) {
      const base = k.replace(/\.$/, "");
      assert.ok(md.includes(base), `legal/cookies/1.1${loc}.md chýba ${base}`);
    }
  }
});
check("cookies: kód nenastavuje cookies a nevkladá analytické / 3rd-party skripty", () => {
  for (const f of SOURCES) {
    const src = read(f);
    assert.ok(!/document\.cookie\s*=/.test(src), `${f}: document.cookie`);
    assert.ok(!/cookies\(\)\.set|response\.cookies\.set|["']Set-Cookie["']/i.test(src), `${f}: Set-Cookie`);
    assert.ok(!/googletagmanager|google-analytics|gtag\(|fbq\(|hotjar|posthog|plausible|clarity\.ms|@vercel\/analytics|@vercel\/speed-insights/.test(src), `${f}: analytika`);
  }
  const pkg = read("package.json");
  assert.ok(!/@vercel\/analytics|@vercel\/speed-insights|posthog|@sentry\//.test(pkg));
});

// ----------------------------------------------------------------------------- Anthropic
check("Anthropic: žiadna produkčná integrácia (deps, env, runtime kód)", () => {
  assert.ok(!/anthropic/i.test(read("package.json")));
  for (const f of SOURCES) assert.ok(!/@anthropic-ai|api\.anthropic\.com|ANTHROPIC_API_KEY/.test(read(f)), f);
});

// ----------------------------------------------------------------------------- push minimalizácia
check("push: odhlásenie nevytvára nové ID inštalácie", () => {
  const src = read("lib/push/native.ts");
  const fn = src.slice(src.indexOf("export async function disableNativePush"), src.indexOf("export async function refreshNativePush"));
  assert.ok(!/installationId\(\)/.test(fn), "disableNativePush volá installationId() (vytvára nové ID)");
  const cron = read("app/api/cron/deadline-notifications/route.ts");
  assert.ok(cron.indexOf('rpc("esblu_push_revoke_ended")') < cron.indexOf("hasAnyProvider(providers)"), "revoke sweep beží aj bez providera");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
