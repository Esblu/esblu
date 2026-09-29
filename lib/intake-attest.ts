import { createHash, createHmac } from "node:crypto";

// =============================================================================
// Podpis servera pre vyťažené údaje príjmu (M1 authz, 2026-09-28).
//
// Zamestnanec (a admin bez finance.manage) vkladá doklad do `documents`
// alebo dodací list do `ai_evidence` sám, IBA v počiatočnom tvare bez
// vyťažených polí (RLS 20260930130000 / 20260930135000). Údaje zo
// zapečateného skenu pripoja až
//   public.esblu_attach_intake_extraction           (documents)
//   public.esblu_attach_evidence_intake_extraction  (ai_evidence)
// a tie ich prijmú IBA s týmto podpisom. Kľúč pozná len server
// (ESBLU_INTAKE_ATTEST_SECRET — bez NEXT_PUBLIC_, teda nikdy v klientskom
// bundli) a DB (Vault `esblu_intake_attest_key`). Klient ho nevidí, preto
// údaje podvrhnúť nevie, hoci RPC volá pod vlastným JWT.
//
// FORMÁT SPRÁVY v3 — musí presne zodpovedať SQL helperu
// public.esblu_intake_attestation_consume (20260930125000):
//   pole(x)  = "<počet UTF-8 bajtov x>:<x>;"
//   správa   = pole("esblu-intake-v3") pole(target) pole(row_id)
//              pole(user_id) pole(kind) pole(content_sha256)
//              pole(expires_epoch) pole(sha256_hex(payload))
// content_sha256 = SHA-256 bajtov ORIGINÁLU (zo skenu, overený v Storage);
// DB ho do správy berie z riadku, nie od volajúceho.
// Dĺžkový prefix robí skladanie jednoznačným (žiadna hodnota nemôže
// „posunúť" hranicu poľa). Hash dát = SHA-256 presných UTF-8 bajtov textu,
// ktorý DB dostane a parsuje — kanonikalizácia JSON preto nie je potrebná.
// HMAC-SHA256, hex; kľúč = UTF-8 bajty tajomstva.
// =============================================================================

export const INTAKE_ATTEST_VERSION = "esblu-intake-v3";
/** Platnosť podpisu. DB aj tak odmietne viac než 600 s do budúcnosti. */
export const INTAKE_ATTEST_TTL_SECONDS = 300;

export type IntakeAttestTarget = "documents" | "ai_evidence";

export function intakeAttestationSecret(): string | null {
  const value = process.env.ESBLU_INTAKE_ATTEST_SECRET?.trim() ?? "";
  return value.length >= 32 ? value : null;
}

function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value};`;
}

export function intakeAttestationMessage(input: {
  target: IntakeAttestTarget;
  rowId: string;
  userId: string;
  kind: string;
  contentSha256: string;
  expiresAt: number;
  payloadSha256Hex: string;
}): string {
  return [
    INTAKE_ATTEST_VERSION,
    input.target,
    input.rowId.toLowerCase(),
    input.userId.toLowerCase(),
    input.kind,
    input.contentSha256.toLowerCase(),
    String(Math.trunc(input.expiresAt)),
    input.payloadSha256Hex.toLowerCase(),
  ]
    .map(field)
    .join("");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 presných bajtov súboru (originálu). */
export function sha256HexBytes(bytes: Uint8Array | ArrayBuffer): string {
  return createHash("sha256").update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).digest("hex");
}

export function signIntakeAttestation(input: {
  target: IntakeAttestTarget;
  rowId: string;
  userId: string;
  kind: string;
  contentSha256: string;
  expiresAt: number;
  payloadText: string;
  secret: string;
}): string {
  const message = intakeAttestationMessage({
    target: input.target,
    rowId: input.rowId,
    userId: input.userId,
    kind: input.kind,
    contentSha256: input.contentSha256,
    expiresAt: input.expiresAt,
    payloadSha256Hex: sha256Hex(input.payloadText),
  });
  return createHmac("sha256", Buffer.from(input.secret, "utf8")).update(Buffer.from(message, "utf8")).digest("hex");
}
