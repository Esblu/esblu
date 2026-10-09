#!/usr/bin/env node
// =============================================================================
// Kontrola pred prvým Android buildom na zariadení (Mobile Platform 2026-10-09).
//
//   node scripts/android-prebuild-check.mjs --target staging   (po `npm run build -w mobile` + `npx cap sync android`)
//
// Statická kontrola repa + skopírovaného bundlu (mobile/android/app/src/main/assets/public):
//   package id, build varianty, signing bez secrets v repe, google-services.json
//   necommitnutý, secure storage plugin registrovaný, OAuth custom scheme,
//   allowBackup=false, žiadne server secrets v APK assets a do akého backendu
//   bundle smeruje (Supabase projekt + API origin). Nič nemení. Exit 1 pri chybe.
//   --target staging navyše živo overí, že Preview API odpovedá bez Vercel
//   prihlásenia (fail closed: SSO redirect / HTML / sieťová chyba = FAIL).
// =============================================================================
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// --target staging | production (povinné pre device build; bez neho iba konzistencia)
const targetArg = process.argv.indexOf("--target");
const TARGET = targetArg >= 0 ? process.argv[targetArg + 1] : null;
if (TARGET && TARGET !== "staging" && TARGET !== "production") {
  console.error("--target musí byť staging alebo production");
  process.exit(2);
}
const STAGING_REF = "cjbdijbbcujvmrzezusd";
const PROD_REF = "fkpgvgvsmbpieduoatrt";
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok: Boolean(ok), detail });
const info = [];
let apiProbe = null;

const gradle = read("mobile/android/app/build.gradle");
check("applicationId com.esblu.app", /applicationId "com\.esblu\.app"/.test(gradle));
check("namespace com.esblu.app", /namespace = "com\.esblu\.app"/.test(gradle));
check("release signing iba z keystore.properties (mimo Git)", /keystorePropertiesFile = file\("keystore\.properties"\)/.test(gradle));
check("debug variant = predvolený (Android debug keystore, žiadny release kľúč nepotrebný)", !/buildTypes\s*\{[\s\S]*debug\s*\{[\s\S]*signingConfig signingConfigs\.release/.test(gradle));

let tracked = "";
try {
  tracked = execFileSync("git", ["ls-files", "mobile/android", "mobile/ios"], { cwd: ROOT, encoding: "utf8" });
} catch {
  tracked = "";
}
check("google-services.json NIE JE v Gite", !/google-services\.json/.test(tracked));
check("GoogleService-Info.plist NIE JE v Gite", !/GoogleService-Info\.plist/.test(tracked));
check("keystore / keystore.properties NIE SÚ v Gite", !/(\.jks|\.keystore|keystore\.properties)$/m.test(tracked));
check("google-services.json je v .gitignore", /google-services\.json/.test(read("mobile/android/.gitignore")));
const gsj = path.join(ROOT, "mobile/android/app/google-services.json");
info.push(existsSync(gsj) ? "google-services.json: PRÍTOMNÝ lokálne (push môže fungovať)" : "google-services.json: CHÝBA — build prejde, push (FCM) nebude fungovať");
if (existsSync(gsj)) {
  try {
    const j = JSON.parse(readFileSync(gsj, "utf8"));
    const pkgs = (j.client ?? []).map((c) => c.client_info?.android_client_info?.package_name);
    check("google-services.json obsahuje com.esblu.app", pkgs.includes("com.esblu.app"), pkgs.join(", "));
  } catch {
    check("google-services.json je platný JSON", false);
  }
}

const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
check("allowBackup=false", /android:allowBackup="false"/.test(manifest));
check("OAuth deep link com.esblu.app://auth/callback", /android:scheme="com\.esblu\.app" android:host="auth" android:path="\/callback"/.test(manifest));
check("App Links (autoVerify) www.esblu.com", /android:autoVerify="true"/.test(manifest) && /android:host="www\.esblu\.com"/.test(manifest));
check("bez cleartext HTTP", !/usesCleartextTraffic="true"/.test(manifest));
const main = read("mobile/android/app/src/main/java/com/esblu/app/MainActivity.java");
check("EsbluSecureStoragePlugin registrovaný pred super.onCreate", /registerPlugin\(EsbluSecureStoragePlugin\.class\);[\s\S]*registerPlugin\(EsbluAppConfigPlugin\.class\);\s*super\.onCreate/.test(main));
check("EsbluSecureStoragePlugin.java existuje", existsSync(path.join(ROOT, "mobile/android/app/src/main/java/com/esblu/app/EsbluSecureStoragePlugin.java")));
const cap = read("mobile/capacitor.config.ts");
check("capacitor appId com.esblu.app, bez server.url (lokálne assets)", /appId: "com\.esblu\.app"/.test(cap) && !/server:\s*\{[^}]*url:/.test(cap));

// Bundle skopírovaný do APK (po cap sync).
const assetsArg = process.argv.indexOf("--assets");
const assets = assetsArg >= 0 ? path.resolve(process.argv[assetsArg + 1]) : path.join(ROOT, "mobile/android/app/src/main/assets/public");
if (!existsSync(assets)) {
  check("APK assets existujú (npm run build -w mobile && npx cap sync android)", false, assets);
} else {
  const files = [];
  (function walk(p) {
    for (const n of readdirSync(p)) {
      const f = path.join(p, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(js|html|json|txt)$/.test(n)) files.push(f);
    }
  })(assets);
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const forbidden = [
    ["service_role JWT", /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*cm9sZSI6InNlcnZpY2Vfcm9sZS[A-Za-z0-9_-]*/],
    ["SUPABASE_SERVICE_ROLE_KEY", /SUPABASE_SERVICE_ROLE_KEY/],
    ["OpenAI kľúč", /sk-(proj-)?[A-Za-z0-9]{20,}/],
    ["Stripe secret", /sk_(live|test)_[A-Za-z0-9]{10,}/],
    ["súkromný kľúč", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["lokálna cesta build stroja", /(?:[A-Z]:\\\\Users\\\\|\/home\/[a-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/)/],
  ];
  for (const [label, re] of forbidden) check(`APK assets bez: ${label}`, !re.test(all));
  const supabaseUrls = [...new Set(all.match(/https:\/\/[a-z0-9]{20}\.supabase\.co/g) ?? [])];
  const known = { fkpgvgvsmbpieduoatrt: "PRODUKCIA (assetpilot)", cjbdijbbcujvmrzezusd: "STAGING (esblu-test)" };
  for (const u of supabaseUrls) info.push(`Supabase v bundli: ${u} → ${known[u.slice(8, 28)] ?? "NEZNÁMY projekt"}`);
  check("bundle smeruje na práve jeden Supabase projekt", supabaseUrls.length === 1, supabaseUrls.join(", "));
  const apiOrigins = [...new Set(all.match(/https:\/\/[a-z0-9-]+\.esblu\.com|http:\/\/10\.0\.2\.2:\d+|https:\/\/[a-z0-9-]+\.vercel\.app/g) ?? [])];
  info.push(`API origin(y) v bundli: ${apiOrigins.join(", ") || "(žiadny)"}`);
  // API origin: mobilný build ho má IBA v apiUrl() (mobileApiOrigin) — prod = www.esblu.com bez overridu.
  const nonProdApi = apiOrigins.filter((o) => o !== "https://www.esblu.com" && o !== "https://esblu.com");
  const prodSupabase = supabaseUrls.some((u) => u.includes(PROD_REF));
  const stagingSupabase = supabaseUrls.some((u) => u.includes(STAGING_REF));
  const prodApi = nonProdApi.length === 0;
  check(
    "Supabase a API origin sú z rovnakého prostredia (mixed staging/produkcia = FAIL)",
    supabaseUrls.length === 1 && ((prodSupabase && prodApi) || (stagingSupabase && !prodApi)),
    `supabase=${prodSupabase ? "PROD" : stagingSupabase ? "STAGING" : "?"} api=${prodApi ? "PROD www.esblu.com" : nonProdApi.join(", ")}`
  );
  const envMarker = all.match(/esbluEnv\s*=\s*"(staging|production)"/)?.[1] ?? (/"staging"===|NEXT_PUBLIC_ESBLU_ENV/.test(all) ? "?" : null);
  const bakedEnv = /esbluEnv=\S{0,4}"staging"|"staging"/.test(all) && stagingSupabase ? "staging" : prodSupabase ? "production" : envMarker;
  info.push(`Prostredie buildu: ${bakedEnv ?? "neznáme"}`);
  if (TARGET === "staging") {
    check("TARGET staging: Supabase = esblu-test (cjbdijbbcujvmrzezusd)", stagingSupabase && !prodSupabase);
    check("TARGET staging: API origin NIE JE produkcia (www.esblu.com)", !prodApi, nonProdApi.join(", ") || "www.esblu.com");
    check("TARGET staging: v bundli nie je produkčný Supabase", !all.includes(PROD_REF));
    check("TARGET staging: práve jeden staging API origin", nonProdApi.length === 1, nonProdApi.join(", ") || "(žiadny)");
    const stagingApi = nonProdApi.length === 1 ? nonProdApi[0] : null;
    check(
      "TARGET staging: API hostname je staging (Vercel Preview esblu-*.vercel.app alebo *staging*.esblu.com)",
      stagingApi && (/^https:\/\/esblu-[a-z0-9-]+\.vercel\.app$/.test(stagingApi) || /^https:\/\/[a-z0-9-]*staging[a-z0-9-]*\.esblu\.com$/.test(stagingApi)),
      stagingApi ?? ""
    );
    if (stagingApi) apiProbe = stagingApi;
  } else if (TARGET === "production") {
    check("TARGET production: Supabase = produkcia", prodSupabase);
    check("TARGET production: API = www.esblu.com", prodApi);
  } else {
    info.push("Bez --target: device build spusti s --target staging (prvý test iba proti stagingu).");
  }
}

// Živá sonda: Preview API musí odpovedať samotná appka (JSON 401 bez session),
// nie Vercel Deployment Protection (302 → vercel.com/sso-api / HTML login).
// FAIL CLOSED: sieťová chyba, timeout, redirect, HTML alebo 5xx = FAIL.
if (apiProbe) {
  const url = `${apiProbe}/api/push/preferences`;
  let ok = false;
  let detail = "";
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
    const ct = res.headers.get("content-type") ?? "";
    const loc = res.headers.get("location") ?? "";
    const body = await res.text();
    const redirected = res.status >= 300 && res.status < 400;
    // Vercel Authentication odpovedá aj JSON 401 ("Protected deployment") — preto
    // vyžadujeme presne odpoveď appky ({"success":false} z lib/push/request.ts).
    const protectedByVercel =
      (redirected && /vercel\.com\/(sso|login)/.test(loc)) ||
      /_vercel_sso_nonce/.test(res.headers.get("set-cookie") ?? "") ||
      /Protected by Vercel Authentication|"protection"\s*:|Protected deployment/.test(body);
    let appBody = false;
    try {
      const j = JSON.parse(body);
      appBody = j && j.success === false && Object.keys(j).length === 1;
    } catch {
      appBody = false;
    }
    const sso = protectedByVercel;
    ok = !redirected && !protectedByVercel && ct.includes("application/json") && appBody && res.status === 401;
    detail = `HTTP ${res.status}${loc ? ` → ${new URL(loc, url).host}` : ""} ${ct.split(";")[0] || "?"}${appBody ? " (odpoveď appky)" : ""}`;
    if (sso) detail += " — Vercel Deployment Protection blokuje API";
  } catch (e) {
    detail = `nedostupné: ${e?.cause?.code ?? e?.name ?? "chyba"}`;
  }
  check("TARGET staging: Preview API reálne odpovedá bez Vercel prihlásenia (/api/push/preferences → JSON 401 {success:false})", ok, detail);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "OK  " : "FAIL"}  ${r.label}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log("");
for (const line of info) console.log(`INFO  ${line}`);
console.log(failed ? `\n${failed} kontrol ZLYHALO` : "\nVšetky kontroly prešli.");
process.exit(failed ? 1 : 0);
