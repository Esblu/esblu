import { createClient } from "@supabase/supabase-js";

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
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { flowType: "pkce" },
});
