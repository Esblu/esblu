import { createClient } from "@supabase/supabase-js";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { createAuthStorage, loadSecureStoragePlugin, type AuthStorage } from "@/lib/mobile/secure-storage";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Google OAuth (2026-10-04): PKCE namiesto implicit flow.
//   - Návrat z Google nesie iba jednorazový `?code=`, ktorý sa dá vymeniť za
//     session IBA s code_verifierom uloženým v TOMTO prehliadači pri štarte
//     prihlásenia. Podvrhnutý odkaz s cudzími tokenmi (`#access_token=…`,
//     login CSRF / session fixation) klient v PKCE režime neprijme.
//   - Tokeny (Supabase aj Google provider token) sa neobjavia v adrese ani
//     v histórii prehliadača.
// E-mailové toky sa NEMENIA: potvrdenie registrácie aj reset hesla idú cez
// token_hash + verifyOtp() (app/auth/callback/page.tsx), ktoré nezávisí od
// flowType; e-mail + heslo (signInWithPassword) tiež nie.
//
// Mobile Platform (2026-10-08): v natívnej appke sa session a PKCE
// code_verifier ukladajú do Android Keystore / iOS Keychain
// (lib/mobile/secure-storage.ts) s bezpečnou migráciou zo starého
// localStorage. Web build: nezmenené (predvolené localStorage).
export const mobileAuthStorage: AuthStorage | null = IS_MOBILE_BUILD
  ? createAuthStorage({
      plugin: loadSecureStoragePlugin,
      legacy: () => (typeof window !== "undefined" ? window.localStorage : null),
    })
  : null;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: mobileAuthStorage ? { flowType: "pkce", storage: mobileAuthStorage } : { flowType: "pkce" },
});
