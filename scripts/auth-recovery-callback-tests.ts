// =============================================================================
// Regresné testy: reset hesla → /auth/callback → /reset-hesla (fix 2026-10-09).
// Pôvodný bug (staging): vstavaný Supabase mailer poslal Supabase-hosted odkaz,
// redirectTo nebol v allowliste → Site URL "/" → hlavná stránka, žiadny
// formulár na heslo. Bez siete (fetch je podvrhnutý), skutočný supabase-js.
//
//   npm run test:auth-recovery
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const rc = await import("@/lib/auth/recovery-callback");
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${(error as Error)?.stack ?? error}`);
  }
}
process.on("unhandledRejection", () => undefined);

const REF = "cjbdijbbcujvmrzezusd";
const URL_ = `https://${REF}.supabase.co`;
function memStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k) };
}
function fakeSessionBody() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: "h.p.s",
    refresh_token: "r",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: "00000000-0000-4000-8000-0000000000aa", aud: "authenticated", role: "authenticated", email: "e2e@esblu.test", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

console.log("Recovery callback routing");

await check("token_hash + type=recovery → verifyOtp vetva", () => {
  assert.deepEqual(rc.decideEmailCallback("?token_hash=abc&type=recovery", ""), { kind: "token_hash", tokenHash: "abc", type: "recovery" });
});
await check("úspešné overenie recovery → /reset-hesla?verified=1, nikdy /", () => {
  assert.equal(rc.destinationAfterVerifiedLink("recovery"), "/reset-hesla?verified=1");
  assert.notEqual(rc.destinationAfterVerifiedLink("recovery"), "/");
});
await check("PKCE recovery (?flow=recovery&code=) → výmena kódu", () => {
  assert.deepEqual(rc.decideEmailCallback("?flow=recovery&code=xyz", ""), { kind: "pkce_recovery", code: "xyz" });
});
await check("?code bez flow=recovery → neplatné (fail closed)", () => {
  assert.deepEqual(rc.decideEmailCallback("?code=xyz", ""), { kind: "error", reason: "invalid" });
});
await check("expirovaný odkaz (query aj hash) → reason expired", () => {
  assert.deepEqual(rc.decideEmailCallback("?error=access_denied&error_code=otp_expired&error_description=x", ""), { kind: "error", reason: "expired" });
  assert.deepEqual(rc.decideEmailCallback("", "#error=access_denied&error_code=otp_expired"), { kind: "error", reason: "expired" });
});
await check("implicitné tokeny v hash (#access_token&type=recovery) sa NEPRIJÍMAJÚ", () => {
  assert.deepEqual(rc.decideEmailCallback("", "#access_token=a&refresh_token=b&type=recovery"), { kind: "error", reason: "unsupported_link" });
});
await check("nepodporovaný type alebo chýbajúci token → invalid", () => {
  assert.deepEqual(rc.decideEmailCallback("?token_hash=abc&type=magiclink", ""), { kind: "error", reason: "invalid" });
  assert.deepEqual(rc.decideEmailCallback("", ""), { kind: "error", reason: "invalid" });
});
await check("auth odkaz pristátý na / sa odovzdá /auth/callback (nie signed-in redirect)", () => {
  assert.ok(rc.isStrayAuthLanding("?flow=recovery&code=x", ""));
  assert.ok(rc.isStrayAuthLanding("", "#error_code=otp_expired"));
  assert.ok(rc.isStrayAuthLanding("", "#access_token=a&type=recovery"));
  assert.ok(rc.isStrayAuthLanding("?token_hash=t&type=recovery", ""));
  assert.equal(rc.isStrayAuthLanding("", ""), false);
  assert.equal(rc.isStrayAuthLanding("?tab=x", "#section"), false);
});
await check("redirectTo zostáva na rovnakom origine (staging ≠ www)", () => {
  assert.equal(rc.recoveryRedirectTo("https://mobile-staging.esblu.com"), "https://mobile-staging.esblu.com/auth/callback?flow=recovery");
  assert.equal(rc.recoveryRedirectTo("https://www.esblu.com/"), "https://www.esblu.com/auth/callback?flow=recovery");
});
await check("verifyOtp chyba otp_expired → expired, iná → invalid", () => {
  assert.equal(rc.reasonForVerifyError({ code: "otp_expired", message: "Email link is invalid or has expired" }), "expired");
  assert.equal(rc.reasonForVerifyError({ code: "bad_jwt", message: "nope" }), "invalid");
});

await check("supabase-js: verifyOtp(token_hash, recovery) → session → cieľ /reset-hesla", async () => {
  const storage = memStorage();
  const sb = createClient(URL_, "anon", {
    auth: { storage, flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => (String(input).includes("/verify") ? json(200, fakeSessionBody()) : json(200, fakeSessionBody().user)) },
  });
  const d = rc.decideEmailCallback("?token_hash=abc&type=recovery", "");
  assert.equal(d.kind, "token_hash");
  const { error } = await sb.auth.verifyOtp({ token_hash: "abc", type: "recovery" });
  assert.equal(error, null);
  assert.ok((await sb.auth.getSession()).data.session);
  assert.equal(rc.destinationAfterVerifiedLink("recovery"), "/reset-hesla?verified=1");
});
await check("supabase-js: expirovaný token_hash → chyba → reason expired (žiadna session)", async () => {
  const sb = createClient(URL_, "anon", {
    auth: { storage: memStorage(), flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => json(403, { code: 403, error_code: "otp_expired", msg: "Email link is invalid or has expired" }) },
  });
  const { error } = await sb.auth.verifyOtp({ token_hash: "old", type: "recovery" });
  assert.ok(error);
  assert.equal(rc.reasonForVerifyError(error!), "expired");
  assert.equal((await sb.auth.getSession()).data.session, null);
});
await check("supabase-js: PKCE recovery kód + code_verifier z tohto prehliadača → session (callback ide na /reset-hesla podľa flow=recovery)", async () => {
  const storage = memStorage({ [`sb-${REF}-auth-token-code-verifier`]: JSON.stringify("verifier123/PASSWORD_RECOVERY") });
  let tokenBody = "";
  const sb = createClient(URL_, "anon", {
    auth: { storage, flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        if (String(input).includes("grant_type=pkce")) {
          tokenBody = String(init?.body ?? "");
          return json(200, fakeSessionBody());
        }
        return json(200, fakeSessionBody().user);
      },
    },
  });
  const events: string[] = [];
  sb.auth.onAuthStateChange((e) => void events.push(e));
  const { error } = await sb.auth.exchangeCodeForSession("code-from-email");
  assert.equal(error, null);
  assert.match(tokenBody, /verifier123/);
  assert.ok(events.includes("SIGNED_IN"), events.join(","));
  assert.ok((await sb.auth.getSession()).data.session);
  assert.equal(rc.destinationAfterVerifiedLink("recovery"), "/reset-hesla?verified=1");
});
await check("supabase-js: PKCE kód BEZ code_verifiera (iný prehliadač) → chyba, žiadna session", async () => {
  const sb = createClient(URL_, "anon", {
    auth: { storage: memStorage(), flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => json(400, { error_code: "bad_code_verifier", msg: "invalid" }) },
  });
  const { error } = await sb.auth.exchangeCodeForSession("code-from-email");
  assert.ok(error);
  assert.equal((await sb.auth.getSession()).data.session, null);
});

await check("callback stránka: rozhodnutie z modulu, recovery → /reset-hesla, nikdy router.replace(\"/\")", () => {
  const page = read("app/auth/callback/page.tsx");
  assert.match(page, /decideEmailCallback\(window\.location\.search, window\.location\.hash\)/);
  assert.match(page, /destinationAfterVerifiedLink\("recovery"\)/);
  assert.match(page, /verifyOtp\(\{\s*token_hash: tokenHash,\s*type,\s*\}\)/);
  assert.doesNotMatch(page, /router\.replace\("\/"\)/);
  assert.match(page, /expiredDescription/);
});
await check("root /: auth odkaz sa odovzdá callbacku PRED session presmerovaním", () => {
  const page = read("app/page.tsx");
  const forward = page.indexOf("isStrayAuthLanding(window.location.search, window.location.hash)");
  const session = page.indexOf("resolveStartupSession(() => supabase.auth.getSession())");
  assert.ok(forward > 0 && session > forward);
});
await check("/reset-hesla: formulár iba s verified=1 + session, updateUser({ password }), až potom odhlásenie a /login", () => {
  const page = read("app/reset-hesla/page.tsx");
  assert.match(page, /get\("verified"\) === "1"/);
  assert.match(page, /supabase\.auth\.updateUser\(\{\s*password: newPassword,?\s*\}\)/);
  const upd = page.indexOf("updateUser(");
  assert.ok(page.indexOf("signOutOnThisDevice()") > upd && page.indexOf('router.push("/login")') > upd);
  for (const gate of ["app/components/LegalAcceptanceGate.tsx", "app/components/CompanyDpaGate.tsx"]) assert.match(read(gate), /"\/reset-hesla"/);
});
await check("login: resetPasswordForEmail redirectTo = vlastný origin + flow=recovery", () => {
  const page = read("app/login/page.tsx");
  assert.match(page, /redirectTo: recoveryRedirectTo\(IS_MOBILE_BUILD \? mobileApiOrigin\(\) : window\.location\.origin\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
