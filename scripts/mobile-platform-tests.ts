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
  assert.deepEqual(oauth.parseEnabledOAuthProviders("google,apple"), ["google"], "Apple zatiaľ nie je podporovaný");
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

console.log(`\nmobile-platform: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
