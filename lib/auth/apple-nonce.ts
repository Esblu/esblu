// =============================================================================
// Sign in with Apple — nonce (Mobile Platform 2026-10-08).
// Apple dostane SHA-256 hash (hex) nonce; Supabase signInWithIdToken dostane
// surový nonce a overí, že identityToken.nonce == sha256(raw). Zabraňuje
// prehratiu cudzieho/starého identity tokenu.
// =============================================================================

export async function createAppleNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const raw = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { raw, hashed };
}
