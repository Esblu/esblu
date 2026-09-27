// =============================================================================
// Mobile M0 — transport + deep-link foundation (2026-09-27).
//
// SPUSTENIE
//   npm run test:mobile-m0
//
// Beží v režime MOBILNÉHO buildu (NEXT_PUBLIC_ESBLU_MOBILE=1 pred importmi);
// webové správanie apiUrl() sa overuje v samostatnom Node procese.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEXT_PUBLIC_ESBLU_MOBILE = "1";
delete process.env.NEXT_PUBLIC_ESBLU_API_ORIGIN;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const origin = await import("@/lib/app-origin");
const { apiUrl } = await import("@/lib/api-url");
const { publicWebUrl } = await import("@/lib/public-url");
const cors = await import("@/lib/cors");
const routes = await import("@/lib/app-routes");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// API origin
// -----------------------------------------------------------------------------
await check("mobil: API volania idú na https://www.esblu.com (nie apex, ktorý 308-uje)", () => {
  assert.equal(origin.CANONICAL_WEB_ORIGIN, "https://www.esblu.com");
  assert.equal(apiUrl("/api/assistant/intent"), "https://www.esblu.com/api/assistant/intent");
  assert.equal(publicWebUrl("/invite/abc"), "https://www.esblu.com/invite/abc");
  assert.equal(origin.canonicalWebUrl("/auth/callback"), "https://www.esblu.com/auth/callback");
});

await check("override originu: iba https alebo lokálny http; nič s cestou/credentials", () => {
  const n = origin.normalizeOriginOverride;
  assert.equal(n("https://staging.esblu.com"), "https://staging.esblu.com");
  assert.equal(n("https://staging.esblu.com/"), "https://staging.esblu.com");
  assert.equal(n("http://10.0.2.2:3000"), "http://10.0.2.2:3000");
  assert.equal(n("http://localhost:3000"), "http://localhost:3000");
  for (const bad of ["http://esblu.com", "https://x.test/api", "https://u:p@x.test", "javascript:alert(1)", "ftp://x.test", "", "nonsense", "https://x.test?a=1"]) {
    assert.equal(n(bad), null, bad);
  }
});

await check("web build: apiUrl ostáva relatívne (same-origin), bez zmeny", () => {
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/alias-loader.mjs", "--input-type=module", "-e",
      'const { apiUrl } = await import("@/lib/api-url"); process.stdout.write(apiUrl("/api/scan-document"));'],
    { cwd: ROOT, env: { ...process.env, NEXT_PUBLIC_ESBLU_MOBILE: "" }, encoding: "utf8" }
  );
  assert.equal(out, "/api/scan-document");
});

await check("v kóde už nie je natvrdo apex https://esblu.com (okrem komentárov)", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      if (["node_modules", ".next", "out", "android", "public"].includes(name)) continue;
      const st = statSync(path.join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs)$/.test(name)) {
        const lines = read(rel).split("\n");
        lines.forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "").trim();
          if (code.startsWith("*") || code.startsWith("/*")) return;
          if (/["'`]https:\/\/esblu\.com/.test(code)) offenders.push(`${rel}:${i + 1}`);
        });
      }
    }
  };
  for (const dir of ["app", "lib", "hooks", "mobile/app"]) walk(dir);
  assert.deepEqual(offenders, []);
});

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------
await check("CORS: povolené sú iba presné natívne originy", () => {
  assert.equal(cors.isAllowedCorsOrigin("https://localhost", ""), true);
  assert.equal(cors.isAllowedCorsOrigin("capacitor://localhost", ""), true);
  for (const bad of [null, "", "null", "*", "http://localhost", "https://localhost:8080", "https://evil.example", "https://localhost.evil.example", "https://www.esblu.com"]) {
    assert.equal(cors.isAllowedCorsOrigin(bad, ""), false, String(bad));
  }
});

await check("CORS: ESBLU_CORS_EXTRA_ORIGINS prijme iba presné originy, nikdy * ani null", () => {
  const env = "https://staging-app.esblu.com, *, null, https://x.test/path, not a url";
  assert.equal(cors.isAllowedCorsOrigin("https://staging-app.esblu.com", env), true);
  assert.equal(cors.isAllowedCorsOrigin("*", env), false);
  assert.equal(cors.isAllowedCorsOrigin("https://x.test", env), false);
});

await check("CORS extra origins: https/capacitor presne, http iba lokálny vývoj", () => {
  const p = cors.parseExtraOrigin;
  // prijaté
  assert.equal(p("https://staging-app.esblu.com"), "https://staging-app.esblu.com");
  assert.equal(p("https://staging-app.esblu.com/"), "https://staging-app.esblu.com");
  assert.equal(p("https://staging-app.esblu.com:8443"), "https://staging-app.esblu.com:8443");
  assert.equal(p("capacitor://localhost"), "capacitor://localhost");
  assert.equal(p("http://localhost"), "http://localhost");
  assert.equal(p("http://localhost:3000"), "http://localhost:3000");
  assert.equal(p("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(p("http://10.0.2.2:3000"), "http://10.0.2.2:3000");
  // odmietnuté
  for (const bad of [
    "http://example.com", "http://www.esblu.com", "http://192.168.1.10:3000", "http://localhost.evil.example",
    "*", "https://*.esblu.com", "null", "", "   ",
    "https://x.test/path", "https://x.test?q=1", "https://u:p@x.test", "ftp://x.test", "file:///etc", "javascript:alert(1)", "not a url",
    "HTTPS://X.TEST",
  ]) {
    assert.equal(p(bad), null, bad);
  }
  // cez env → allowlist (presná zhoda, bez credentials)
  const env = "https://staging-app.esblu.com,capacitor://localhost,http://localhost:3000,http://127.0.0.1:3000,http://10.0.2.2:3000,http://example.com,*,null";
  for (const ok of ["https://staging-app.esblu.com", "capacitor://localhost", "http://localhost:3000", "http://127.0.0.1:3000", "http://10.0.2.2:3000"]) {
    assert.equal(cors.isAllowedCorsOrigin(ok, env), true, ok);
    assert.ok(!("Access-Control-Allow-Credentials" in cors.corsPreflightHeaders(ok, env)));
  }
  for (const no of ["http://example.com", "*", "null", "http://localhost", "https://staging-app.esblu.com.evil.example"]) {
    assert.equal(cors.isAllowedCorsOrigin(no, env), false, no);
  }
});

await check("CORS: preflight hlavičky — origin echo, bez credentials, iba známe hlavičky", () => {
  const h = cors.corsPreflightHeaders("https://localhost", "");
  assert.equal(h["Access-Control-Allow-Origin"], "https://localhost");
  assert.ok(!("Access-Control-Allow-Credentials" in h));
  const allowed = h["Access-Control-Allow-Headers"].split(", ");
  assert.deepEqual(allowed.sort(), ["authorization", "content-type", "idempotency-key", "x-esblu-locale"]);
  assert.match(h["Access-Control-Allow-Methods"], /OPTIONS/);
  assert.match(h.Vary, /Origin/);
  const denied = cors.corsPreflightHeaders("https://evil.example", "");
  assert.deepEqual(denied, { Vary: "Origin" });
});

await check("CORS: odpoveď vystaví hlavičky exportov (Content-Disposition, X-Esblu-*)", () => {
  const h = cors.corsResponseHeaders("https://localhost", "");
  assert.equal(h["Access-Control-Allow-Origin"], "https://localhost");
  for (const name of ["Content-Disposition", "X-Esblu-Package-Id", "X-Esblu-Invoice-Count", "X-Esblu-Excluded-Drafts"]) {
    assert.match(h["Access-Control-Expose-Headers"], new RegExp(name));
  }
  assert.deepEqual(cors.corsResponseHeaders(undefined, ""), { Vary: "Origin" });
});

await check("CORS: klient neposiela žiadnu hlavičku mimo allowlistu", () => {
  // Všetky requestové hlavičky použité vo fetch() volaniach klienta.
  const used = new Set<string>();
  const files = ["app/ai-evidencia/page.tsx", "app/components/Dashboard.tsx", "app/components/voice/VoiceLauncher.tsx", "hooks/use-voice-session.ts", "lib/account-deletion.ts", "lib/document-package-client.ts", "lib/push/client.ts"];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/headers:\s*\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/(?:^|[,{\s])(?:"([A-Za-z-]+)"|([A-Za-z]+)|\[(REQUEST_LOCALE_HEADER)\])\s*:/g)) {
        const key = k[1] ?? k[2] ?? (k[3] ? "x-esblu-locale" : "");
        if (key) used.add(key.toLowerCase());
      }
    }
  }
  const allowed = new Set<string>(cors.CORS_ALLOWED_HEADERS);
  for (const header of used) assert.ok(allowed.has(header), `hlavička ${header} nie je v CORS allowliste`);
});

await check("CORS: proxy.ts matchuje /api, vylučuje cron, odpovedá na OPTIONS", async () => {
  const src = read("proxy.ts");
  assert.match(src, /matcher:\s*"\/api\/:path\*"/);
  assert.match(src, /isCorsExcludedPath/);
  assert.match(src, /request\.method === "OPTIONS"/);
  assert.doesNotMatch(src, /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*/);
  assert.equal(cors.isCorsExcludedPath("/api/cron/deadline-notifications"), true);
  assert.equal(cors.isCorsExcludedPath("/api/assistant/intent"), false);
  const { proxy } = await import("../proxy.ts");
  const { NextRequest } = await import("next/server");
  const pre = proxy(new NextRequest("https://www.esblu.com/api/scan-document", {
    method: "OPTIONS",
    headers: { origin: "https://localhost", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,idempotency-key,x-esblu-locale" },
  }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://localhost");
  const evil = proxy(new NextRequest("https://www.esblu.com/api/scan-document", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const cron = proxy(new NextRequest("https://www.esblu.com/api/cron/deadline-notifications", { method: "OPTIONS", headers: { origin: "https://localhost" } }));
  assert.equal(cron.headers.get("access-control-allow-origin"), null);
  const same = proxy(new NextRequest("https://www.esblu.com/api/assistant/intent", { method: "POST" }));
  assert.equal(same.headers.get("access-control-allow-origin"), null);
  const mobile = proxy(new NextRequest("https://www.esblu.com/api/assistant/intent", { method: "POST", headers: { origin: "https://localhost" } }));
  assert.equal(mobile.headers.get("access-control-allow-origin"), "https://localhost");
  assert.equal(mobile.headers.get("access-control-allow-credentials"), null);
});

await check("server auth ostáva Bearer-only (žiadne cookies → CORS bez credentials je bezpečný)", () => {
  const src = read("lib/server-auth.ts");
  assert.match(src, /headers\.get\("authorization"\)/);
  assert.doesNotMatch(src, /cookies\(\)|headers\.get\("cookie"\)/);
});

// -----------------------------------------------------------------------------
// Odkazy zo servera / zdieľaných komponentov
// -----------------------------------------------------------------------------
await check("web: resolveAppHref je identita pre interné odkazy", () => {
  for (const href of ["/faktury/abc", "/vozidla/123?tab=photos", "/priecinky/x", "/chat/c1", "/", "/ai-evidencia?filter=a#top"]) {
    assert.equal(routes.resolveAppHref(href, false), href);
  }
});

await check("mobil: detail /<modul>/<id> → /<modul>/detail?id= (query zachovaná)", () => {
  assert.equal(routes.resolveAppHref("/vozidla/2a1b-3c", true), "/vozidla/detail?id=2a1b-3c");
  assert.equal(routes.resolveAppHref("/stroje/abc?tab=photos", true), "/stroje/detail?tab=photos&id=abc");
  assert.equal(routes.resolveAppHref("/sklad/i1", true), "/sklad/detail?id=i1");
  assert.equal(routes.resolveAppHref("/vozidla/detail?id=x", true), "/vozidla/detail?id=x");
  assert.equal(routes.resolveAppHref("/ai-evidencia?view=unassigned", true), "/ai-evidencia?view=unassigned");
  const token = "ab".repeat(32);
  assert.equal(routes.resolveAppHref(`/invite/${token}`, true), `/invite?token=${token}`);
});

await check("mobil: moduly, ktoré v appke nie sú, → null (žiadny mŕtvy odkaz)", () => {
  for (const href of ["/faktury", "/faktury/abc", "/faktury/new", "/obchodni-partneri/p1", "/priecinky/f1", "/chat/c1", "/cennik", "/neexistuje"]) {
    assert.equal(routes.resolveAppHref(href, true), null, href);
  }
});

await check("nebezpečné/absolútne odkazy → null na webe aj v appke", () => {
  for (const href of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "vozidla/1", "", null, undefined]) {
    assert.equal(routes.resolveAppHref(href as string, true), null, String(href));
    assert.equal(routes.resolveAppHref(href as string, false), null, String(href));
  }
  assert.equal(routes.resolveAppHref("/vozidla/<script>", true), null);
});

await check("MOBILE_STATIC_ROUTES zodpovedá stránkam v mobile/app", () => {
  const pages: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const full = path.join(dir, name);
      if (statSync(path.join(ROOT, full)).isDirectory()) walk(full, `${prefix}/${name}`);
      else if (name === "page.tsx") pages.push(prefix || "/");
    }
  };
  walk("mobile/app", "");
  assert.deepEqual([...routes.MOBILE_STATIC_ROUTES].sort(), pages.sort());
});

await check("IntentResultView a Dashboard používajú normalizáciu odkazov", () => {
  const view = read("app/components/voice/IntentResultView.tsx");
  assert.doesNotMatch(view, /from "next\/link"/);
  assert.match(view, /AppLink/);
  const dash = read("app/components/Dashboard.tsx");
  assert.match(dash, /if \(!isAppRouteAvailable\(href\)\) return false;/);
  assert.doesNotMatch(dash, /href: `\/(vozidla|stroje|sklad)\/\$\{/);
});

// -----------------------------------------------------------------------------
// Deep links (Android App Links)
// -----------------------------------------------------------------------------
await check("DeepLinkBridge: www + apex presne, token 64 hex, iba povolené cesty", async () => {
  const { resolveEsbluDeepLink } = await import("../mobile/app/deep-link-resolve.ts");
  const token = "0f".repeat(32);
  assert.equal(resolveEsbluDeepLink(`https://www.esblu.com/invite/${token}`), `/invite.html?token=${token}`);
  assert.equal(resolveEsbluDeepLink(`https://esblu.com/invite/${token}`), `/invite.html?token=${token}`);
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/auth/callback?token_hash=abc&type=email"), "/auth/callback.html?token_hash=abc&type=email");
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/reset-hesla"), "/reset-hesla.html");
  for (const bad of [
    `http://www.esblu.com/invite/${token}`,
    `https://www.esblu.com.evil.example/invite/${token}`,
    `https://evil.example/invite/${token}`,
    `https://app.esblu.com/invite/${token}`,
    "https://www.esblu.com/invite/not-a-token",
    "https://www.esblu.com/invite/%zz",
    "https://www.esblu.com/vozidla",
    "https://www.esblu.com/login",
    "not a url",
  ]) {
    assert.equal(resolveEsbluDeepLink(bad), null, bad);
  }
});

await check("AndroidManifest: App Links iba https://www.esblu.com, úzke cesty; mikrofón + fotoaparát", () => {
  const m = read("mobile/android/app/src/main/AndroidManifest.xml").replace(/<!--[\s\S]*?-->/g, "");
  assert.match(m, /android:autoVerify="true"/);
  assert.match(m, /<data android:scheme="https" android:host="www\.esblu\.com" \/>/);
  assert.doesNotMatch(m, /android:host="esblu\.com"/);
  assert.doesNotMatch(m, /android:scheme="http"/);
  assert.match(m, /<data android:path="\/invite" \/>/);
  assert.match(m, /<data android:pathPrefix="\/invite\/" \/>/);
  assert.doesNotMatch(m, /android:pathPrefix="\/invite"\s/);
  assert.doesNotMatch(m, /android:pathPattern="\.\*"|android:pathPrefix="\/"\s/);
  assert.match(m, /android\.permission\.RECORD_AUDIO/);
  assert.match(m, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
  assert.match(m, /<action android:name="android\.media\.action\.IMAGE_CAPTURE" \/>/);
  assert.doesNotMatch(m, /android\.permission\.CAMERA/);
});

await check("AndroidManifest: komentár App Links zodpovedá stavu (www kanonický, apex zámerne nie, debug sa neoverí)", () => {
  const raw = read("mobile/android/app/src/main/AndroidManifest.xml");
  const comments = (raw.match(/<!--[\s\S]*?-->/g) ?? []).join("\n");
  assert.match(comments, /https:\/\/www\.esblu\.com\/\.well-known\/assetlinks\.json/);
  assert.match(comments, /apex ZÁMERNE NIE JE registrovaný/);
  assert.match(comments, /debug APK sa NEoverí automaticky/);
  for (const stale of [/Host je\s+iba apex/, /"www\.esblu\.com" tu\s+zámerne nie je/, /ktorý ešte neexistuje/]) {
    assert.doesNotMatch(comments, stale);
  }
});

await check("assetlinks.json: package com.esblu.app, SHA-256 fingerprint", () => {
  const json = JSON.parse(read("public/.well-known/assetlinks.json"));
  const target = json[0].target;
  assert.equal(target.package_name, "com.esblu.app");
  assert.ok(target.sha256_cert_fingerprints.every((f: string) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f)));
});

await check("capacitor.config: žiadny server.url (bundlované assets), predvolený https://localhost origin", () => {
  const src = read("mobile/capacitor.config.ts").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /server\s*:/);
  assert.match(src, /webDir:\s*"out"/);
});

await check("mobile public: demo video (~41 MB) a .well-known sa do appky nekopírujú", () => {
  const src = read("scripts/prepare-mobile-public.mjs");
  assert.match(src, /MOBILE_PUBLIC_EXCLUDES = \["video", "\.well-known"\]/);
  assert.match(src, /filter: \(source\) => !isExcludedFromMobile\(source\)/);
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
