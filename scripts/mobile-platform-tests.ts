// =============================================================================
// Mobile Platform (2026-10-08) — auth v natívnej appke, deep links, životný
// cyklus, odhlásenie, súbory, zrušenie účtu a statická validácia natívnej
// konfigurácie (Android manifest, iOS Xcode projekt). Bez siete a bez zariadenia.
//
//   npm run test:mobile-platform
// =============================================================================

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const oauth = await import("@/lib/auth/oauth-routing");
const lifecycle = await import("@/lib/mobile/lifecycle");
const { resolveEsbluDeepLink } = await import("../mobile/app/deep-link-resolve.ts");
const push = await import("@/lib/push/deep-link");
const retention = await import("@/lib/account-deletion-retention");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function walk(dir: string, filter: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (name === "node_modules" || name.startsWith(".next") || name === "out" || name === "public") continue;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, filter, out);
    else if (filter(rel)) out.push(rel);
  }
  return out;
}

// ----------------------------------------------------------------------------- AUTH
await check("OAuth: natívna appka = systémový prehliadač (nikdy WebView); web redirect; iOS PWA nie", () => {
  assert.equal(oauth.oauthFlowForRuntime({ isCapacitorBuild: true, isIos: false, isStandalone: false }), "system_browser");
  assert.equal(oauth.oauthFlowForRuntime({ isCapacitorBuild: true, isIos: true, isStandalone: false }), "system_browser");
  assert.equal(oauth.oauthFlowForRuntime({ isCapacitorBuild: false, isIos: false, isStandalone: false }), "redirect");
  assert.equal(oauth.oauthFlowForRuntime({ isCapacitorBuild: false, isIos: true, isStandalone: true }), "none");
  // pôvodné pravidlo (žiadny vložený WebView OAuth) ostáva
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: true, isIos: false, isStandalone: false }), false);
});
await check("OAuth: iOS bez Sign in with Apple neponúkne Google (App Review 4.8); Android/web áno", () => {
  assert.deepEqual(oauth.oauthProvidersForPlatform("ios", ["google"]), []);
  assert.deepEqual(oauth.oauthProvidersForPlatform("ios", ["google", "apple"]), ["google", "apple"]);
  assert.deepEqual(oauth.oauthProvidersForPlatform("android", ["google"]), ["google"]);
  assert.deepEqual(oauth.oauthProvidersForPlatform("web", ["google"]), ["google"]);
  assert.deepEqual(oauth.parseEnabledOAuthProviders("google"), ["google"], "Apple iba pri výslovnej konfigurácii");
});
await check("OAuth: mobilná návratová URL iba z allowlistu", () => {
  assert.equal(oauth.normalizeMobileOAuthRedirect(undefined), "com.esblu.app://auth/callback");
  assert.equal(oauth.normalizeMobileOAuthRedirect("https://www.esblu.com/auth/callback"), "https://www.esblu.com/auth/callback");
  assert.equal(oauth.normalizeMobileOAuthRedirect("https://evil.example/auth/callback"), "com.esblu.app://auth/callback");
  assert.equal(oauth.normalizeMobileOAuthRedirect("com.esblu.app://auth/callback?next=//evil"), "com.esblu.app://auth/callback");
});
await check("OAuth klient: mobile = skipBrowserRedirect + @capacitor/browser; web nezmenený", () => {
  const src = read("lib/auth/oauth-client.ts");
  assert.match(src, /skipBrowserRedirect: true/);
  assert.match(src, /import\("@capacitor\/browser"\)/);
  assert.match(src, /redirectTo: `\$\{publicWebUrl\("\/auth\/callback"\)\}\?oauth=\$\{provider\}`/);
  assert.match(read("lib/supabase.ts"), /flowType: "pkce"/);
});

// ----------------------------------------------------------------------------- DEEP LINKS
await check("deep link: OAuth callback cez custom scheme → lokálny callback (query zachované)", () => {
  assert.equal(resolveEsbluDeepLink("com.esblu.app://auth/callback?oauth=google&code=abc"), "/auth/callback.html?oauth=google&code=abc");
  assert.equal(resolveEsbluDeepLink("com.esblu.app://auth/callback/?code=x"), "/auth/callback.html?code=x");
});
await check("deep link: iné custom scheme cesty, cudzie schémy a hosty → ignorované (žiadny open redirect)", () => {
  for (const url of [
    "com.esblu.app://evil/callback?code=x",
    "com.esblu.app://auth/other",
    "esblu://auth/callback?code=x",
    "javascript:alert(1)",
    "https://www.esblu.com.evil.example/auth/callback",
    "http://www.esblu.com/auth/callback",
    "https://www.esblu.com/vozidla",
    "file:///data/data/com.esblu.app/x",
  ]) assert.equal(resolveEsbluDeepLink(url), null, url);
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/auth/callback?token_hash=t&type=recovery"), "/auth/callback.html?token_hash=t&type=recovery");
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/invite/" + "a".repeat(64)), `/invite.html?token=${"a".repeat(64)}`);
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/invite/not-a-token"), null);
});
await check("push tap: iba allowlist obrazoviek + UUID; neznáme → domov (žiadne cudzie cesty)", () => {
  assert.equal(push.pushHrefFromData({ screen: "chat", id: "11111111-1111-4111-8111-111111111111" }), "/chat/11111111-1111-4111-8111-111111111111");
  assert.equal(push.pushHrefFromData({ screen: "chat", id: "../../nastavenia" }), "/");
  assert.equal(push.pushHrefFromData({ screen: "https://evil.example" }), "/");
  assert.equal(push.pushHrefFromData({ screen: "invoice", id: "11111111-1111-4111-8111-111111111111" }), "/");
  assert.equal(push.pushHrefFromData(null), "/");
});
await check("Android manifest: App Links (autoVerify) + OAuth custom scheme iba auth/callback; allowBackup=false", () => {
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android:allowBackup="false"/, "session v WebView úložisku sa nesmie zálohovať/preniesť");
  assert.match(manifest, /<data android:scheme="com\.esblu\.app" android:host="auth" android:path="\/callback" \/>/);
  assert.match(manifest, /android:autoVerify="true"/);
  assert.doesNotMatch(manifest, /usesCleartextTraffic="true"/);
  assert.equal((manifest.match(/android:scheme="com\.esblu\.app"/g) ?? []).length, 1);
});

// ----------------------------------------------------------------------------- LIFECYCLE / OFFLINE / UX
await check("lifecycle: po SIGNED_OUT presmerovanie iba z chránenej obrazovky", () => {
  assert.equal(lifecycle.shouldRedirectToLoginAfterSignOut("SIGNED_OUT", "/faktury.html"), true);
  assert.equal(lifecycle.shouldRedirectToLoginAfterSignOut("SIGNED_OUT", "/vozidla/detail.html"), true);
  assert.equal(lifecycle.shouldRedirectToLoginAfterSignOut("SIGNED_OUT", "/login.html"), false);
  assert.equal(lifecycle.shouldRedirectToLoginAfterSignOut("SIGNED_OUT", "/auth/callback.html"), false);
  assert.equal(lifecycle.shouldRedirectToLoginAfterSignOut("SIGNED_OUT", "/"), false);
  assert.equal(lifecycle.shouldRedirectToLoginAfterSignOut("TOKEN_REFRESHED", "/faktury"), false);
  assert.equal(lifecycle.normalizeLocalPath("/sklad/detail.html"), "/sklad/detail");
  assert.equal(lifecycle.isPublicPath("/invite.html"), true);
  assert.equal(lifecycle.isPublicPath("/nastavenia"), false);
});
await check("lifecycle bridge: stop/start auto-refresh podľa popredia + overenie session po návrate", () => {
  const src = read("mobile/app/AppLifecycleBridge.tsx");
  assert.match(src, /appStateChange/);
  assert.match(src, /stopAutoRefresh\(\)/);
  assert.match(src, /startAutoRefresh\(\)/);
  assert.match(src, /getSession\(\)/);
  const layout = read("mobile/app/layout.tsx");
  assert.match(layout, /<AppLifecycleBridge \/>/);
  assert.match(layout, /<OfflineBanner \/>/);
  assert.match(layout, /viewportFit: "cover"/);
  assert.doesNotMatch(read("app/layout.tsx"), /viewportFit/, "web viewport nezmenený");
});
await check("offline: navigator.onLine=false → offline; inak online (žiadne predstieranie uloženia)", () => {
  assert.equal(lifecycle.connectivityFrom(false), "offline");
  assert.equal(lifecycle.connectivityFrom(true), "online");
  assert.equal(lifecycle.connectivityFrom(undefined), "online");
});
await check("klávesnica: textové polia skryjú spodnú navigáciu, tlačidlá/checkboxy nie", () => {
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "INPUT", type: "text" }), true);
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "INPUT", type: "email" }), true);
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "INPUT", type: "file" }), false);
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "TEXTAREA" }), true);
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "TEXTAREA", readOnly: true }), false);
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(lifecycle.isKeyboardEditable({ tagName: "BUTTON" }), false);
  assert.equal(lifecycle.isKeyboardEditable(null), false);
});
await check("chat: dvojité Enter počas odosielania neodošle správu znova", () => {
  assert.match(read("app/components/chat/ChatMessageView.tsx"), /if \(!sending\) sendMessage\(\);/);
});

// ----------------------------------------------------------------------------- LOGOUT
await check("odhlásenie: všetky vstupy idú cez signOutOnThisDevice (push odregistrácia + lokálne artefakty)", () => {
  const offenders = walk("app", (f) => /\.tsx?$/.test(f))
    .concat(walk("lib", (f) => /\.tsx?$/.test(f)))
    .filter((f) => f !== path.join("lib", "sign-out.ts"))
    .filter((f) => /auth\.signOut\(/.test(read(f)));
  assert.deepEqual(offenders, []);
});
await check("odhlásenie: clearSessionArtifacts zmaže OAuth stav a sessionStorage, nie jazyk ani installationId", async () => {
  const { clearSessionArtifacts } = await import("@/lib/sign-out");
  const store = (init: Record<string, string>) => {
    const data = new Map(Object.entries(init));
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    };
  };
  const local = store({ "esblu.oauthPending.v1": "{}", "esblu.locale": "sk", "esblu.push.installationId": "x" });
  const session = store({ "esblu.partnerPrefill": "{}" });
  clearSessionArtifacts({ local: local as unknown as Storage, session: session as unknown as Storage });
  assert.equal(local.data.has("esblu.oauthPending.v1"), false);
  assert.equal(local.data.get("esblu.locale"), "sk");
  assert.equal(local.data.get("esblu.push.installationId"), "x");
  assert.equal(session.data.size, 0);
});

// ----------------------------------------------------------------------------- FILES
await check("súbory: fotky so signed URL sa na mobile otvárajú cez in-app prehliadač (žiadny holý target=_blank)", () => {
  for (const file of ["app/ai-evidencia/page.tsx", "app/sklad/InventoryItemDetailView.tsx", "app/stroje/MachineDetailView.tsx"]) {
    const src = read(file);
    assert.match(src, /externalFileLinkProps\(/, file);
    assert.doesNotMatch(src, /href=\{(documentPhotoUrl|otherDocumentPhotoUrl|photoUrl\(photo\.file_path\))\}/, file);
  }
  const fa = read("lib/file-actions.ts");
  assert.match(fa, /export function externalFileLinkProps/);
  assert.match(fa, /Directory\.Cache/, "exporty iba do privátnej cache (žiadny verejný permanentný priečinok)");
});
await check("súbory: žiadny klientsky kód neotvára signed URL mimo file-actions (window.open / location = url)", () => {
  const offenders = walk("app", (f) => f.endsWith(".tsx") && !f.startsWith(path.join("app", "api")))
    .filter((f) => /window\.open\(|location\.href\s*=\s*(signed|url)/.test(read(f)));
  assert.deepEqual(offenders, []);
});

// ----------------------------------------------------------------------------- ACCOUNT DELETION
await check("zrušenie firmy s finalizovanými dokladmi: blokované PRED akýmkoľvek mazaním", async () => {
  const fakeAdmin = (count: number | null, error: unknown = null) =>
    ({ from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ count, error }) }) }) }) }) as never;
  assert.equal(await retention.findOwnerDeletionBlocker(fakeAdmin(2), "c"), "FINALIZED_ACCOUNTING_DOCUMENTS");
  assert.equal(await retention.findOwnerDeletionBlocker(fakeAdmin(0), "c"), null);
  await assert.rejects(() => retention.findOwnerDeletionBlocker(fakeAdmin(null, { code: "x" }), "c"));
  const route = read("app/api/account/delete/route.ts");
  const blockAt = route.indexOf("findOwnerDeletionBlocker(admin, membership.company_id)");
  const storageAt = route.indexOf("await collectOwnerStorageTargets(");
  assert.ok(blockAt > 0 && storageAt > blockAt, "kontrola musí byť pred mazaním Storage");
  assert.match(read("app/api/account/preflight/route.ts"), /ownerDeletionBlocked/);
  assert.match(read("app/nastavenia/page.tsx"), /ownerDeletionBlocked \?/);
});

// ----------------------------------------------------------------------------- NATIVE CONFIG (static)
await check("android-prebuild-check: statické kontroly prechádzajú (bez buildu iba chýbajúce assets)", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/android-prebuild-check.mjs")], { cwd: ROOT, encoding: "utf8" });
  const fails = r.stdout.split("\n").filter((l) => l.startsWith("FAIL"));
  assert.ok(fails.every((l) => /APK assets existujú/.test(l)), fails.join("\n"));
});
await check("prebuild --target staging: mixed staging/produkcia FAIL, čistý staging OK", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const bundle = (js: string) => {
    const d = mkdtempSync(path.join(tmpdir(), "esblu-apk-"));
    mkdirSync(path.join(d, "_next"), { recursive: true });
    writeFileSync(path.join(d, "_next", "a.js"), `var c="https://www.esblu.com";${js}`);
    return d;
  };
  const run = (d: string, target: string) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/android-prebuild-check.mjs"), "--target", target, "--assets", d], { cwd: ROOT, encoding: "utf8" });
  const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJlLXRlc3Q`;
  const STAGING = `var s="https://cjbdijbbcujvmrzezusd.supabase.co",k="${jwt({ ref: "cjbdijbbcujvmrzezusd", role: "anon" })}"`;
  const PROD = `var s="https://fkpgvgvsmbpieduoatrt.supabase.co",k="${jwt({ ref: "fkpgvgvsmbpieduoatrt", role: "anon" })}"`;
  const PREVIEW = 'var a="https://esblu-git-mobile-platform-esblu.vercel.app"';
  const mixed1 = run(bundle(STAGING), "staging"); // staging DB + produkčné API
  assert.equal(mixed1.status, 1);
  assert.match(mixed1.stdout, /FAIL  Supabase a API origin sú z rovnakého prostredia/);
  const mixed2 = run(bundle(PROD + ";" + PREVIEW), "staging"); // produkčná DB + preview API
  assert.equal(mixed2.status, 1);
  assert.match(mixed2.stdout, /FAIL  TARGET staging: Supabase = esblu-test/);
  const prodForStaging = run(bundle(PROD), "staging");
  assert.equal(prodForStaging.status, 1);
  const ok = run(bundle(STAGING + ";" + PREVIEW), "staging");
  assert.ok(!/FAIL  (Supabase a API|Supabase kľúče|TARGET staging: (?!API reálne))/.test(ok.stdout), ok.stdout);
  // Živá sonda API vždy beží a pri nedostupnom / chránenom API zlyhá (fail closed).
  assert.match(ok.stdout, /(OK|FAIL)  TARGET staging: API reálne odpovedá bez Vercel prihlásenia/);
});
await check("prebuild --target production: čistý produkčný bundle OK, staging stopa / mix / service_role FAIL", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJlLXRlc3Q`;
  const bundle = (js: string) => {
    const d = mkdtempSync(path.join(tmpdir(), "esblu-apk-"));
    mkdirSync(path.join(d, "_next"), { recursive: true });
    writeFileSync(path.join(d, "_next", "a.js"), `var c="https://www.esblu.com";${js}`);
    return d;
  };
  const run = (d: string) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/android-prebuild-check.mjs"), "--target", "production", "--assets", d], { cwd: ROOT, encoding: "utf8" });
  const PROD = `var s="https://fkpgvgvsmbpieduoatrt.supabase.co",k="${jwt({ ref: "fkpgvgvsmbpieduoatrt", role: "anon" })}"`;
  const ok = run(bundle(PROD));
  assert.ok(!/FAIL  (Supabase|APK|TARGET production: (?!API reálne))/.test(ok.stdout), ok.stdout);
  assert.match(ok.stdout, /(OK|FAIL)  TARGET production: API reálne odpovedá/);
  const stagingTrace = run(bundle(PROD + ';var x="cjbdijbbcujvmrzezusd";var h="https://mobile-staging.esblu.com"'));
  assert.equal(stagingTrace.status, 1);
  assert.match(stagingTrace.stdout, /FAIL  TARGET production: v bundli nie je staging Supabase ref/);
  assert.match(stagingTrace.stdout, /FAIL  TARGET production: API = www\.esblu\.com/);
  const service = run(bundle(PROD + `;var z="${jwt({ ref: "fkpgvgvsmbpieduoatrt", role: "service_role" })}"`));
  assert.equal(service.status, 1);
  assert.match(service.stdout, /FAIL  Supabase kľúče v bundli sú iba role=anon/);
  const wrongKey = run(bundle(`var s="https://fkpgvgvsmbpieduoatrt.supabase.co",k="${jwt({ ref: "cjbdijbbcujvmrzezusd", role: "anon" })}"`));
  assert.equal(wrongKey.status, 1);
});
await check("push bez google-services.json: register() sa nevolá (PUSH NOT CONFIGURED), žiadny pád", () => {
  const native = read("lib/push/native.ts");
  assert.match(native, /if \(!\(await nativePushConfigured\(\)\)\) return "not_configured";/);
  assert.match(native, /if \(!\(await nativePushEnabled\(\)\) \|\| !\(await nativePushConfigured\(\)\)\) return;/);
  assert.match(read("mobile/android/app/src/main/java/com/esblu/app/EsbluAppConfigPlugin.java"), /getIdentifier\("google_app_id", "string"/);
  assert.match(read("app/components/push/PushNotificationSettings.tsx"), /settings\.push\.notConfigured/);
});
await check("notifikačná ikona: monochrómny symbol zapojený (manifest + drawable-*), bez textu", async () => {
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /default_notification_icon"\s+android:resource="@drawable\/ic_stat_esblu"/);
  const { spawnSync } = await import("node:child_process");
  const py = `
from PIL import Image
for d, s in {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}.items():
    im = Image.open("mobile/android/app/src/main/res/drawable-" + d + "/ic_stat_esblu.png").convert("RGBA")
    assert im.size == (s, s)
    px = [p for p in im.getdata() if p[3] > 0]
    assert all(p[0] > 240 and p[1] > 240 and p[2] > 240 for p in px), "iba biela silueta"
print("ok")
`;
  const r = spawnSync("python3", ["-c", py], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
await check("Capacitor: appId com.esblu.app, žiadny server.url (lokálne assets), iOS + Android bundle id zhodné", () => {
  const cfg = read("mobile/capacitor.config.ts");
  assert.match(cfg, /appId: "com\.esblu\.app"/);
  assert.doesNotMatch(cfg, /server:\s*\{[^}]*url:/);
  assert.match(read("mobile/android/app/build.gradle"), /applicationId "com\.esblu\.app"/);
  const pbx = read("mobile/ios/App/App.xcodeproj/project.pbxproj");
  assert.equal((pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.esblu\.app;/g) ?? []).length, 2);
  assert.equal((pbx.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g) ?? []).length, 2);
  assert.doesNotMatch(pbx, /DEVELOPMENT_TEAM = [A-Z0-9]{10}/, "žiadny Team ID v repe (Apple user step)");
});
await check("iOS Info.plist: usage descriptions, OAuth URL scheme, arm64, export compliance", () => {
  const plist = read("mobile/ios/App/App/Info.plist");
  for (const key of ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "NSMicrophoneUsageDescription", "CFBundleURLSchemes", "ITSAppUsesNonExemptEncryption"]) {
    assert.match(plist, new RegExp(`<key>${key}</key>`), key);
  }
  assert.match(plist, /<string>com\.esblu\.app<\/string>/);
  assert.match(plist, /<string>arm64<\/string>/);
  assert.doesNotMatch(plist, /NSAllowsArbitraryLoads/, "ATS ostáva zapnuté");
  const ent = read("mobile/ios/App/App/App.entitlements");
  assert.match(ent, /applinks:www\.esblu\.com/);
  assert.match(ent, /aps-environment/);
  const delegate = read("mobile/ios/App/App/AppDelegate.swift");
  assert.match(delegate, /capacitorDidRegisterForRemoteNotifications/);
  assert.match(delegate, /capacitorDidFailToRegisterForRemoteNotifications/);
});
await check("secrets: žiadny google-services.json / GoogleService-Info.plist / keystore / .p8 v repe", () => {
  for (const p of ["mobile/android/app/google-services.json", "mobile/ios/App/App/GoogleService-Info.plist", "mobile/android/app/keystore.properties"]) {
    assert.equal(existsSync(path.join(ROOT, p)), false, p);
  }
  const gitignore = read("mobile/android/.gitignore") + read("mobile/.gitignore");
  assert.match(read("mobile/android/app/build.gradle"), /keystore\.properties/);
  assert.ok(gitignore.length > 0);
});
await check("secrets: klientsky kód (use client / mobile) nikdy nečíta service_role ani server-only env", () => {
  const clientFiles = walk("app", (f) => f.endsWith(".tsx")).concat(walk("mobile/app", (f) => f.endsWith(".tsx")))
    .filter((f) => !f.startsWith(path.join("app", "api")))
    .filter((f) => read(f).includes('"use client"'));
  const offenders = clientFiles.filter((f) => {
    const src = read(f);
    return /SUPABASE_SERVICE_ROLE_KEY|supabase-admin|process\.env\.(?!NEXT_PUBLIC_)[A-Z_]+/.test(src);
  });
  assert.deepEqual(offenders, []);
});


// ============================================================================= SECURE STORAGE (Keystore / Keychain adapter)
const secureMod = await import("@/lib/mobile/secure-storage");
function fakeSecurePlugin(opts: { failSet?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    async get({ key }: { key: string }) {
      return { value: data.get(key) ?? null };
    },
    async set({ key, value }: { key: string; value: string }) {
      if (opts.failSet) throw new Error("WRITE_FAILED");
      data.set(key, value);
    },
    async remove({ key }: { key: string }) {
      data.delete(key);
    },
    async clear() {
      data.clear();
    },
  };
}
function fakeLocalStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
  };
}
const AUTH_KEY = "sb-localhost-auth-token";

await check("secure storage: migrácia zo starého localStorage → Keystore/Keychain, legacy kópia zmazaná AŽ po zápise", async () => {
  const plugin = fakeSecurePlugin();
  const legacy = fakeLocalStorage({ [AUTH_KEY]: '{"access_token":"old"}', "esblu.locale": "sk" });
  const storage = secureMod.createAuthStorage({ plugin: async () => plugin, legacy: () => legacy });
  assert.equal(await storage.backend(), "secure");
  assert.equal(await storage.getItem(AUTH_KEY), '{"access_token":"old"}');
  assert.equal(plugin.data.get(AUTH_KEY), '{"access_token":"old"}');
  assert.equal(legacy.data.has(AUTH_KEY), false, "čitateľná kópia nesmie ostať");
  assert.equal(legacy.data.get("esblu.locale"), "sk", "iné kľúče sa nemenia");
});
await check("secure storage: zlyhaný zápis do Keystore → session ostáva (žiadne odhlásenie migráciou)", async () => {
  const plugin = fakeSecurePlugin({ failSet: true });
  const legacy = fakeLocalStorage({ [AUTH_KEY]: "s" });
  const storage = secureMod.createAuthStorage({ plugin: async () => plugin, legacy: () => legacy });
  assert.equal(await storage.getItem(AUTH_KEY), "s");
  assert.equal(legacy.data.get(AUTH_KEY), "s");
});
await check("secure storage: setItem ide do Keystore a odstráni legacy; bez pluginu (web / starý build) localStorage", async () => {
  const plugin = fakeSecurePlugin();
  const legacy = fakeLocalStorage({ [AUTH_KEY]: "stale" });
  const storage = secureMod.createAuthStorage({ plugin: async () => plugin, legacy: () => legacy });
  await storage.setItem(AUTH_KEY, "fresh");
  assert.equal(plugin.data.get(AUTH_KEY), "fresh");
  assert.equal(legacy.data.has(AUTH_KEY), false);
  const webLegacy = fakeLocalStorage();
  const web = secureMod.createAuthStorage({ plugin: async () => null, legacy: () => webLegacy });
  assert.equal(await web.backend(), "legacy");
  await web.setItem(AUTH_KEY, "w");
  assert.equal(webLegacy.data.get(AUTH_KEY), "w");
});
await check("secure logout: clearAll vyčistí Keystore/Keychain aj legacy Supabase kľúče, nič iné", async () => {
  const plugin = fakeSecurePlugin();
  plugin.data.set(AUTH_KEY, "x");
  plugin.data.set(`${AUTH_KEY}-code-verifier`, "v");
  const legacy = fakeLocalStorage({ [`${AUTH_KEY}-user`]: "u", "esblu.locale": "sk", "esblu.push.installationId": "i" });
  await secureMod.createAuthStorage({ plugin: async () => plugin, legacy: () => legacy }).clearAll();
  assert.equal(plugin.data.size, 0);
  assert.deepEqual([...legacy.data.keys()].sort(), ["esblu.locale", "esblu.push.installationId"]);
  const signOut = read("lib/sign-out.ts");
  assert.match(signOut, /finally \{[\s\S]*mobileAuthStorage\?\.clearAll\(\)/, "Keystore sa vyčistí aj keď server signOut zlyhá");
});
await check("secure storage + skutočný supabase-js: cold start, expired session → refresh, logout", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const plugin = fakeSecurePlugin();
  const now = Math.floor(Date.now() / 1000);
  const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "a@example.invalid", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  // Stav po „predošlom behu appky": vypršaný access token v Keystore.
  plugin.data.set(AUTH_KEY, JSON.stringify({ access_token: "expired", refresh_token: "rt-1", token_type: "bearer", expires_in: 3600, expires_at: now - 60, user }));
  let refreshCalls = 0;
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
      refreshCalls++;
      assert.match(String(init?.body), /rt-1/);
      return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rt-2", token_type: "bearer", expires_in: 3600, expires_at: now + 3600, user }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const storage = secureMod.createAuthStorage({ plugin: async () => plugin, legacy: () => fakeLocalStorage() });
  // „Cold start": nový klient, session iba v Keystore.
  const client = createClient("http://localhost:54321", "anon", { auth: { storage, autoRefreshToken: false, persistSession: true, flowType: "pkce" }, global: { fetch: fetchMock } });
  const { data } = await client.auth.getSession();
  assert.equal(data.session?.access_token, "fresh", "vypršaná session sa obnoví refresh tokenom");
  assert.equal(refreshCalls, 1);
  assert.equal(JSON.parse(plugin.data.get(AUTH_KEY)!).refresh_token, "rt-2", "nová session uložená späť do Keystore");
  // Resume: druhé čítanie bez ďalšieho refreshu (token platný).
  await client.auth.getSession();
  assert.equal(refreshCalls, 1);
  await client.auth.signOut();
  await storage.clearAll();
  assert.equal(plugin.data.size, 0, "logout vyprázdni Keystore");
  const after = await client.auth.getSession();
  assert.equal(after.data.session, null);
});
await check("secure storage: natívne pluginy (Android Keystore AES-GCM, iOS Keychain ThisDeviceOnly) registrované", () => {
  const java = read("mobile/android/app/src/main/java/com/esblu/app/EsbluSecureStoragePlugin.java");
  assert.match(java, /AndroidKeyStore/);
  assert.match(java, /AES\/GCM\/NoPadding/);
  assert.match(java, /@CapacitorPlugin\(name = "EsbluSecureStorage"\)/);
  assert.match(read("mobile/android/app/src/main/java/com/esblu/app/MainActivity.java"), /registerPlugin\(EsbluSecureStoragePlugin\.class\);[\s\S]*registerPlugin\(EsbluAppConfigPlugin\.class\);\s*super\.onCreate/);
  const swift = read("mobile/ios/App/App/EsbluSecureStoragePlugin.swift");
  assert.match(swift, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(swift, /jsName = "EsbluSecureStorage"/);
  assert.match(read("mobile/ios/App/App/MainViewController.swift"), /registerPluginInstance\(EsbluSecureStoragePlugin\(\)\)/);
  assert.match(read("mobile/ios/App/App/SceneDelegate.swift"), /rootViewController = MainViewController\(\)/);
  const pbx = read("mobile/ios/App/App.xcodeproj/project.pbxproj");
  for (const f of ["EsbluSecureStoragePlugin.swift", "EsbluAppleSignInPlugin.swift", "MainViewController.swift"]) {
    assert.equal((pbx.match(new RegExp(`${f.replace(".", "\\.")} in Sources \\*/,`, "g")) ?? []).length, 1, `${f} v Sources`);
  }
  assert.match(read("lib/supabase.ts"), /storage: mobileAuthStorage/);
});

// ============================================================================= IDEMPOTENT CREATE (unit; DB: test:idempotency-db)
const idem = await import("@/lib/idempotent-insert");
await check("idempotencia: rovnaký obsah = rovnaký kľúč (retry), iný obsah / po úspechu = nový kľúč", () => {
  const ref = { current: null } as { current: { fingerprint: string; key: string } | null };
  const k1 = idem.mutationKeyFor(ref, { b: 1, a: "x" });
  assert.equal(idem.mutationKeyFor(ref, { a: "x", b: 1 }), k1, "poradie kľúčov nemení fingerprint");
  assert.notEqual(idem.mutationKeyFor(ref, { a: "y", b: 1 }), k1);
  const k3 = idem.mutationKeyFor(ref, { a: "y", b: 1 });
  idem.resetMutationKey(ref);
  assert.notEqual(idem.mutationKeyFor(ref, { a: "y", b: 1 }), k3);
  assert.match(k1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
await check("idempotencia: všetkých 7 tvorných ciest posiela client_mutation_id cez insertIdempotent", () => {
  const expectations: [string, RegExp][] = [
    ["lib/invoices.ts", /insertIdempotent<Invoice>\(db as unknown as InsertDb, "invoices"/],
    ["lib/business-partners.ts", /"business_partners", row, mutationId/],
    ["app/vozidla/page.tsx", /"vehicles",\s*registrationRow/],
    ["app/vozidla/page.tsx", /"vehicles", vehicleRow, mutationKeyFor\(VEHICLE_CREATE_MUTATION/],
    ["app/stroje/page.tsx", /"machines",\s*payload,\s*mutationKeyFor\(MACHINE_CREATE_MUTATION/],
    ["app/sklad/page.tsx", /"inventory_items",\s*payload,\s*mutationKeyFor\(INVENTORY_CREATE_MUTATION/],
    ["lib/document-folders.ts", /"document_folders", row, mutationId/],
    ["app/components/chat/ChatMessageView.tsx", /"chat_messages",\s*messageRow,\s*mutationId/],
    ["app/faktury/new/page.tsx", /mutationRef: DRAFT_INVOICE_MUTATION/],
    ["app/obchodni-partneri/page.tsx", /mutationRef: PARTNER_CREATE_MUTATION/],
    ["app/priecinky/page.tsx", /mutationRef: FOLDER_CREATE_MUTATION/],
  ];
  for (const [file, re] of expectations) assert.match(read(file), re, file);
  assert.match(read("app/components/chat/ChatMessageView.tsx"), /if \(!replayed\) void notifyChatMessage/, "replay neposiela push znova");
  const migration = read("supabase/migrations/20261008130000_client_mutation_idempotency.sql");
  assert.match(migration, /\(company_id, client_mutation_id\) where client_mutation_id is not null/);
  assert.doesNotMatch(migration, /create policy|drop policy|grant /i, "RLS ani granty sa nemenia");
});

// ============================================================================= SIGN IN WITH APPLE (fail closed)
await check("Apple: ponúkne sa iba pri výslovnej konfigurácii; iOS Google iba spolu s Apple (4.8)", () => {
  assert.deepEqual(oauth.parseEnabledOAuthProviders("google"), ["google"]);
  assert.deepEqual(oauth.parseEnabledOAuthProviders("google,apple"), ["google", "apple"]);
  assert.deepEqual(oauth.oauthProvidersForPlatform("ios", oauth.parseEnabledOAuthProviders("google")), []);
  assert.deepEqual(oauth.oauthProvidersForPlatform("ios", oauth.parseEnabledOAuthProviders("google,apple")), ["google", "apple"]);
});
await check("Apple: nonce — Apple dostane SHA-256(raw), Supabase raw (ochrana pred replay tokenu)", async () => {
  const { createAppleNonce } = await import("@/lib/auth/apple-nonce");
  const { createHash } = await import("node:crypto");
  const a = await createAppleNonce();
  const b = await createAppleNonce();
  assert.match(a.raw, /^[0-9a-f]{64}$/);
  assert.equal(a.hashed, createHash("sha256").update(a.raw).digest("hex"));
  assert.notEqual(a.raw, b.raw);
});
await check("Apple: natívny plugin + capability pripravené; bez pluginu fallback na systémový prehliadač; callback routing", () => {
  const client = read("lib/auth/oauth-client.ts");
  assert.match(client, /signInWithIdToken\(\{ provider: "apple", token: identityToken, nonce: nonce\.raw \}\)/);
  assert.match(client, /if \(native !== "unavailable"\) return native;/);
  assert.match(client, /navigateHard\("\/auth\/callback\?oauth=apple"\)/);
  const swift = read("mobile/ios/App/App/EsbluAppleSignInPlugin.swift");
  assert.match(swift, /request\.nonce = hashedNonce/);
  assert.match(swift, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(read("mobile/ios/App/App/App.entitlements"), /com\.apple\.developer\.applesignin/);
  assert.match(read("app/components/auth/SocialAuthButtons.tsx"), /bg-black/, "Apple HIG tlačidlo");
});

// ============================================================================= BUNDLE VERIFIER + PATH LEAK
await check("verify:mobile-bundle: webpack bundle → jasné odmietnutie (exit 3), lokálna cesta → FAIL", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const mk = (chunk: string) => {
    const d = mkdtempSync(path.join(tmpdir(), "esblu-bundle-"));
    mkdirSync(path.join(d, "_next", "static", "chunks"), { recursive: true });
    writeFileSync(path.join(d, "_next", "static", "chunks", "a.js"), chunk);
    writeFileSync(path.join(d, "index.html"), "<html></html>");
    mkdirSync(path.join(d, "vozidla"), { recursive: true });
    writeFileSync(path.join(d, "vozidla", "detail.html"), '<meta name="viewport" content="width=device-width, initial-scale=1">');
    return d;
  };
  const run = (d: string) => spawnSync(process.execPath, [path.join(ROOT, "scripts/verify-mobile-bundle.mjs"), d], { encoding: "utf8" });
  const webpack = run(mk("console.log(1)"));
  assert.equal(webpack.status, 3);
  assert.match(webpack.stderr, /NIE JE z Turbopacku/);
  const leak = run(mk('globalThis.TURBOPACK||[];var p="/home/builder/esblu/legal"'));
  assert.match(leak.stdout, /FAIL  bez lokálnych ciest build stroja/);
  const clean = run(mk("globalThis.TURBOPACK||[];"));
  assert.match(clean.stdout, /OK    bez lokálnych ciest build stroja/);
});
await check("ESBLU_LEGAL_CONTENT_ROOT nie je v mobile/next.config env; legal/ sa nájde bez neho", async () => {
  const cfg = read("mobile/next.config.ts");
  assert.doesNotMatch(cfg, /ESBLU_LEGAL_CONTENT_ROOT:/);
  assert.doesNotMatch(read("lib/legal-content.ts"), /process\.env\.ESBLU_LEGAL_CONTENT_ROOT/);
});

// ============================================================================= NAVIGATION
await check("navigácia: odkazy v právnych textoch a vo výsledkoch hľadania idú cez AppLink (mobile-safe)", async () => {
  const legal = read("app/components/LegalMarkdown.tsx");
  assert.match(legal, /<AppLink\s/);
  assert.doesNotMatch(legal, /from "next\/link"/);
  assert.match(read("app/components/Dashboard.tsx"), /<AppLink\s+key=\{index\}\s+href=\{result\.href\}/);
  const routes = await import("@/lib/app-routes");
  assert.equal(routes.resolveAppHref("/cennik", true), null, "web-only cieľ v appke = bez odkazu");
  assert.equal(routes.resolveAppHref("/vozidla/11111111-1111-4111-8111-111111111111", true), "/vozidla/detail?id=11111111-1111-4111-8111-111111111111");
  assert.equal(routes.resolveAppHref("//evil.example/x", true), null);
});

// ============================================================================= AASA / ASSETLINKS
await check("AASA / assetlinks šablóny: placeholdery, mimo public/, render fail-closed", async () => {
  const { renderDeepLinkFiles } = await import("../scripts/render-deep-link-files.mjs");
  assert.throws(() => renderDeepLinkFiles({ teamId: "__APPLE_TEAM_ID__", playSha256: "x" }), /Team ID/);
  assert.throws(() => renderDeepLinkFiles({ teamId: "ABCDE12345", playSha256: "AA:BB" }), /SHA-256/);
  const ok = renderDeepLinkFiles({ teamId: "ABCDE12345", playSha256: Array(32).fill("AB").join(":") });
  assert.match(ok.aasa, /ABCDE12345\.com\.esblu\.app/);
  assert.equal(existsSync(path.join(ROOT, "public/.well-known/apple-app-site-association")), false, "nič nenasadené na web");
});

// ============================================================================= ICON / SPLASH
await check("ikony: vygenerované zo schválenej master ikony (iOS 1024 bez alfa, Android legacy/round/adaptive), návrhy nezapojené", async () => {
  const { spawnSync } = await import("node:child_process");
  const py = `
from PIL import Image
import sys
r = "mobile/"
ios = Image.open(r + "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
assert ios.size == (1024, 1024) and ios.mode == "RGB", ios.mode
sizes = {"mdpi": (48, 108), "hdpi": (72, 162), "xhdpi": (96, 216), "xxhdpi": (144, 324), "xxxhdpi": (192, 432)}
for d, (s, f) in sizes.items():
    base = r + "android/app/src/main/res/mipmap-" + d + "/"
    assert Image.open(base + "ic_launcher.png").size == (s, s)
    assert Image.open(base + "ic_launcher_round.png").size == (s, s)
    fg = Image.open(base + "ic_launcher_foreground.png").convert("RGB")
    assert fg.size == (f, f)
# biely symbol + text mastra musí po zmenšení ležať v 66dp safe kruhu
import importlib.util, math
spec = importlib.util.spec_from_file_location("gen", "scripts/generate-mobile-assets.py")
gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
m_rgb = Image.open(r + "icon-source/esblu-master-icon.png").convert("RGB")
(xa, xb), sym, text = gen._mark_bands(m_rgb)
W = m_rgb.size[0]; mp = m_rgb.load(); rmax = 0
for y in range(sym[0], (text or sym)[1] + 1, 2):
    for x in range(xa, xb + 1, 2):
        if gen._is_mark(mp[x, y]):
            rmax = max(rmax, math.hypot(x - W / 2, y - W / 2) / W)
if rmax * gen.ADAPTIVE_SCALE > 0.3056:
    sys.exit("obsah mimo safe zóny: %.3f" % (rmax * gen.ADAPTIVE_SCALE))
# master sa porovná s iOS výstupom (bez úprav artworku)
m = Image.open(r + "icon-source/esblu-master-icon.png").convert("RGB").resize((64, 64))
o = ios.resize((64, 64))
diff = sum(abs(a - b) for p, q in zip(m.getdata(), o.getdata()) for a, b in zip(p, q)) / (64 * 64 * 3)
assert diff < 2, diff
print("ok")
`;
  const r = spawnSync("python3", ["-c", py], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);

});
await check("ikona: generátor fail-closed bez 1024×1024 zdroja; splash zo schváleného brand assetu", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python3", [path.join(ROOT, "scripts/generate-mobile-assets.py"), "icon"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /1024×1024/);
});

console.log(`\nmobile-platform: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
