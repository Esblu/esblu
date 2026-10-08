// =============================================================================
// Google OAuth — aplikačná logika (bez siete, bez Supabase).
//
// Pokrýva rozhodnutia, ktoré robí Esblu po návrate z Google:
//   - kam presmerovať (iba pevné cesty, žiadny open redirect),
//   - odmietnutie uzavretou betou vs. zrušenie vs. chyba,
//   - súhlas s právnymi dokumentmi iba ak naozaj zaznel,
//   - iba Google (Apple sa neponúkne ani pri omylom zapnutej konfigurácii),
//   - Android (Capacitor) a iOS PWA: OAuth sa neponúka,
//   - PKCE v klientovi a lokalizované texty SK/EN/DE.
// Serverové brány (Auth hook, ensure_my_owner_company, accept_company_invite)
// overuje scripts/google-oauth-pglite-tests.ts nad skutočným PostgreSQL.
//
// SPUSTENIE
//   npm run test:google-oauth
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const oauth = await import("@/lib/auth/oauth-routing");
const { translate } = await import("@/lib/i18n/translate");

type Pending = import("@/lib/auth/oauth-routing").OAuthPending;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const TOKEN = "a".repeat(64);
const pending = (over: Partial<Pending> = {}): Pending => ({ provider: "google", mode: "login", legalAccepted: false, at: Date.now(), ...over });
const ok = { providerError: null, hasSession: true } as const;

// --- A–D: existujúci používateľ (owner/admin/accountant/employee) ----------
await check("A–D existujúci člen firmy (akákoľvek rola) → domov, žiadny onboarding ani druhá firma", () => {
  // Rola sa v klientovi nerozhoduje — o prístupe rozhoduje RLS podľa členstva.
  for (const mode of ["login", "register"] as const) {
    assert.equal(oauth.decideOAuthDestination({ ...ok, hasActiveMembership: true, pending: pending({ mode }) }), "/");
  }
  assert.equal(oauth.decideOAuthDestination({ ...ok, hasActiveMembership: true, pending: null }), "/");
});

// --- E/F: nový owner ------------------------------------------------------
await check("E nový používateľ bez členstva → owner onboarding (server overí allowlist)", () => {
  assert.equal(oauth.decideOAuthDestination({ ...ok, hasActiveMembership: false, pending: pending({ mode: "register", legalAccepted: true }) }), "/onboarding/company");
});

await check("F odmietnutie Auth hookom uzavretej bety → lokalizovaná beta správa, nie „zrušené“", () => {
  const description = "Esblu je momentálne v uzavretej beta verzii. Ak máte schválený beta prístup, kontaktujte nás na info@esblu.com.";
  assert.equal(oauth.decideOAuthDestination({ providerError: "access_denied", providerErrorDescription: description, hasSession: false, hasActiveMembership: false, pending: pending() }), "/login?oauth=beta");
  assert.equal(oauth.decideOAuthDestination({ providerError: "server_error", providerErrorDescription: description, hasSession: false, hasActiveMembership: false, pending: null }), "/login?oauth=beta");
});

await check("zrušenie u Google → „zrušené“; iná chyba → „chyba“; bez session → „chyba“", () => {
  assert.equal(oauth.decideOAuthDestination({ providerError: "access_denied", providerErrorDescription: "The user denied access", hasSession: false, hasActiveMembership: false, pending: null }), "/login?oauth=cancelled");
  assert.equal(oauth.decideOAuthDestination({ providerError: "server_error", hasSession: false, hasActiveMembership: false, pending: null }), "/login?oauth=error");
  assert.equal(oauth.decideOAuthDestination({ providerError: null, hasSession: false, hasActiveMembership: false, pending: pending() }), "/login?oauth=error");
});

// --- G–J: pozvánka ----------------------------------------------------------
await check("G platná pozvánka → späť na /invite/<token> (prijatie overí server: e-mail, platnosť, jednorazovosť)", () => {
  assert.equal(oauth.decideOAuthDestination({ ...ok, hasActiveMembership: false, pending: pending({ mode: "invite", inviteToken: TOKEN }) }), `/invite/${TOKEN}`);
});

await check("H–J pozvánkový token mimo presného tvaru sa zahodí (žiadny podvrh cesty)", () => {
  for (const bad of ["../../evil", "https://evil.example/x", TOKEN.toUpperCase(), `${TOKEN}/../x`, "a".repeat(63)]) {
    assert.equal(oauth.readOAuthPending({ provider: "google", mode: "invite", inviteToken: bad, legalAccepted: false, at: Date.now() }), null);
  }
});

await check("pending záznam: vypršaný (15 min) alebo z budúcnosti sa neprijme", () => {
  const now = Date.now();
  assert.equal(oauth.readOAuthPending({ provider: "google", mode: "login", legalAccepted: false, at: now - 16 * 60 * 1000 }, now), null);
  assert.equal(oauth.readOAuthPending({ provider: "google", mode: "login", legalAccepted: false, at: now + 5 * 60 * 1000 }, now), null);
  assert.equal(oauth.readOAuthPending({ provider: "evil", mode: "login", legalAccepted: false, at: now }, now), null);
});

// --- K: rovnaký e-mail ako existujúci účet ---------------------------------
await check("K existujúci e-mailový účet + Google (Supabase prepojí identitu) → domov; súhlas sa nezapíše znova bez dôvodu", () => {
  // Prepojený účet má členstvo → domov; do onboardingu (zápis súhlasu) nejde.
  assert.equal(oauth.decideOAuthDestination({ ...ok, hasActiveMembership: true, pending: pending() }), "/");
});

// --- L: open redirect ------------------------------------------------------
await check("L výsledok je VŽDY jedna z pevných interných ciest", () => {
  const allowed = /^(\/|\/onboarding\/company|\/login\?oauth=(cancelled|error|beta)|\/invite\/[0-9a-f]{64})$/;
  const errors = [null, "access_denied", "server_error", "//evil.example"];
  for (const providerError of errors) {
    for (const hasSession of [true, false]) {
      for (const hasActiveMembership of [true, false]) {
        for (const p of [null, pending(), pending({ mode: "invite", inviteToken: TOKEN })]) {
          const dest = oauth.decideOAuthDestination({ providerError, providerErrorDescription: "https://evil.example", hasSession, hasActiveMembership, pending: p });
          assert.match(dest, allowed, `neočakávaný cieľ ${dest}`);
        }
      }
    }
  }
});

await check("L callback nečíta next/returnTo/redirectTo a OAuth redirect ide iba na /auth/callback", () => {
  const callback = readFileSync("app/auth/callback/page.tsx", "utf8");
  for (const param of ['"next"', '"returnTo"', '"redirectTo"', '"redirect_to"']) {
    assert.ok(!callback.includes(`searchParams.get(${param})`), `callback číta ${param}`);
  }
  const client = readFileSync("lib/auth/oauth-client.ts", "utf8");
  assert.match(client, /redirectTo: `\$\{publicWebUrl\("\/auth\/callback"\)\}\?oauth=\$\{provider\}`/);
});

// --- súhlas s právnymi dokumentmi ------------------------------------------
await check("legal: súhlas pri registrácii iba ak bol zaškrtnutý pred Google; inak LegalAcceptanceGate", () => {
  assert.equal(oauth.mayRecordRegistrationConsent(pending({ mode: "register", legalAccepted: true }), "google"), true);
  assert.equal(oauth.mayRecordRegistrationConsent(pending({ mode: "login", legalAccepted: false }), "google"), false);
  assert.equal(oauth.mayRecordRegistrationConsent(null, "google"), false);
  assert.equal(oauth.mayRecordRegistrationConsent(null, "email"), true);
});

// --- Google + Apple (Apple iba pri výslovnej konfigurácii) ----------------
await check("Apple sa ponúkne IBA pri výslovnej konfigurácii; neznáme hodnoty sa ignorujú", () => {
  assert.deepEqual(oauth.parseEnabledOAuthProviders("google,apple"), ["google", "apple"]);
  assert.deepEqual(oauth.parseEnabledOAuthProviders(" Google "), ["google"]);
  assert.deepEqual(oauth.parseEnabledOAuthProviders("apple"), ["apple"]);
  assert.deepEqual(oauth.parseEnabledOAuthProviders("facebook,apple-x"), []);
  assert.deepEqual(oauth.parseEnabledOAuthProviders(""), []);
  assert.deepEqual(oauth.parseEnabledOAuthProviders(undefined), []);
  assert.deepEqual([...oauth.SUPPORTED_OAUTH_PROVIDERS], ["google", "apple"]);
});

// --- R: Android / iOS PWA --------------------------------------------------
await check("R Android (Capacitor) a iOS PWA: OAuth sa neponúka; prehliadač áno", () => {
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: true, isIos: false, isStandalone: false }), false);
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: false, isIos: true, isStandalone: true }), false);
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: false, isIos: false, isStandalone: false }), true);
  assert.equal(oauth.oauthAllowedInRuntime({ isCapacitorBuild: false, isIos: true, isStandalone: false }), true);
});

// --- session bezpečnosť ----------------------------------------------------
await check("PKCE: klient je v režime pkce (žiadne tokeny v URL, podvrhnutý #access_token sa neprijme)", () => {
  const src = readFileSync("lib/supabase.ts", "utf8");
  assert.match(src, /flowType:\s*"pkce"/);
});

await check("callback pri zlyhanej výmene kódu nepokračuje na staršej session", () => {
  const src = readFileSync("app/auth/callback/page.tsx", "utf8");
  assert.match(src, /const \{ error: initError \} = await supabase\.auth\.initialize\(\);/);
  assert.match(src, /hasSession = !initError && !userError/);
});

await check("žiadne provider tokeny ani tajomstvá v klientskom kóde a logoch", () => {
  for (const file of ["lib/auth/oauth-client.ts", "lib/auth/oauth-routing.ts", "app/auth/callback/page.tsx", "app/components/auth/SocialAuthButtons.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!/provider_token|provider_refresh_token|client_secret|GOOGLE_CLIENT_SECRET/i.test(src.replace(/\/\/.*$/gm, "")), `${file} pracuje s provider tokenom/secretom`);
    assert.ok(!/console\.(log|info|debug)\(/.test(src), `${file} loguje`);
  }
});

// --- M–O: lokalizácia ------------------------------------------------------
await check("M–O SK/EN/DE: tlačidlo, presmerovanie, beta odmietnutie, zrušenie, chyba", () => {
  const expected = { sk: "Pokračovať cez Google", en: "Continue with Google", de: "Mit Google fortfahren" } as const;
  for (const locale of ["sk", "en", "de"] as const) {
    assert.equal(translate(locale, "auth.oauth.google"), expected[locale]);
    for (const key of ["auth.oauth.redirecting", "auth.oauth.betaRequired", "auth.oauth.cancelled", "auth.oauth.failed", "auth.oauth.startFailed"]) {
      const text = translate(locale, key);
      assert.ok(text && text !== key, `${locale}: chýba ${key}`);
    }
  }
});

console.log(`google-oauth: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
