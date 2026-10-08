#!/usr/bin/env node
// =============================================================================
// Kontrola pred prvým Android buildom na zariadení (Mobile Platform 2026-10-09).
//
//   node scripts/android-prebuild-check.mjs            (po `npm run build -w mobile` + `npx cap sync android`)
//
// Statická kontrola repa + skopírovaného bundlu (mobile/android/app/src/main/assets/public):
//   package id, build varianty, signing bez secrets v repe, google-services.json
//   necommitnutý, secure storage plugin registrovaný, OAuth custom scheme,
//   allowBackup=false, žiadne server secrets v APK assets a do akého backendu
//   bundle smeruje (Supabase projekt + API origin). Nič nemení. Exit 1 pri chybe.
// =============================================================================
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok: Boolean(ok), detail });
const info = [];

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
check("EsbluSecureStoragePlugin registrovaný pred super.onCreate", /registerPlugin\(EsbluSecureStoragePlugin\.class\);\s*super\.onCreate/.test(main));
check("EsbluSecureStoragePlugin.java existuje", existsSync(path.join(ROOT, "mobile/android/app/src/main/java/com/esblu/app/EsbluSecureStoragePlugin.java")));
const cap = read("mobile/capacitor.config.ts");
check("capacitor appId com.esblu.app, bez server.url (lokálne assets)", /appId: "com\.esblu\.app"/.test(cap) && !/server:\s*\{[^}]*url:/.test(cap));

// Bundle skopírovaný do APK (po cap sync).
const assets = path.join(ROOT, "mobile/android/app/src/main/assets/public");
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
  const apiOrigins = [...new Set(all.match(/https:\/\/www\.esblu\.com|http:\/\/10\.0\.2\.2:\d+|https:\/\/[a-z0-9-]+\.vercel\.app/g) ?? [])];
  info.push(`API origin(y) v bundli: ${apiOrigins.join(", ") || "(žiadny)"}`);
  const prodSupabase = supabaseUrls.some((u) => u.includes("fkpgvgvsmbpieduoatrt"));
  const prodApi = apiOrigins.includes("https://www.esblu.com") && !apiOrigins.some((o) => o.includes("vercel.app") || o.includes("10.0.2.2"));
  check("Supabase a API origin sú z rovnakého prostredia (prod+prod alebo staging+staging)", supabaseUrls.length !== 1 || prodSupabase === prodApi, `prodSupabase=${prodSupabase} prodApi=${prodApi}`);
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
