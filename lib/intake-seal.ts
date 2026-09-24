import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// =============================================================================
// Zapečatený výsledok skenu pre PRÍJEM finančného dokladu bez čítania.
//
// PREČO
// -----
// Zamestnanec smie bloček, faktúru či dodací list odfotiť a odoslať na
// spracovanie, ale nesmie čítať finančný register — ani vyťažené údaje
// z vlastnej fotky (sumy, dodávateľ, číslo dokladu). Účtovníčka ich však
// potrebuje, aby doklad nemusela prepisovať.
//
// Riešenie: /api/scan-document výsledok extrakcie NEVRÁTI v čitateľnej
// podobe. Zašifruje ho (AES-256-GCM, kľúč iba na serveri) a viaže na
// používateľa a čas. Prehliadač drží iba nepriehľadný reťazec a pošle ho
// späť na /api/inbox/intake, ktorý ho rozšifruje a uloží dokument pod
// identitou zamestnanca (RLS insert). Odpoveď je iba „odoslané".
//
// Kľúč je odvodený z ESBLU_ACTION_CONFIRMATION_SECRET s oddelením domény —
// iný účel, iný kľúč. Bez tajomstva sa nič nezapečatí (fail closed: doklad
// sa prijme bez vyťažených údajov, nikdy sa neukážu).
// =============================================================================

const SEAL_VERSION = 1;
/** Ako dlho po skene sa dá doklad odoslať. */
export const INTAKE_SEAL_TTL_SECONDS = 30 * 60;

export const INTAKE_DOCUMENT_TYPES = ["invoice", "receipt", "delivery_note"] as const;
export type IntakeDocumentType = (typeof INTAKE_DOCUMENT_TYPES)[number];

export function isIntakeDocumentType(value: unknown): value is IntakeDocumentType {
  return typeof value === "string" && (INTAKE_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export type IntakeExtraction = {
  documentType: IntakeDocumentType;
  confidenceScore: number | null;
  reviewStatus: string | null;
  rawText: string | null;
  documentLanguage: string | null;
  fieldConfidence: unknown;
  fields: Record<string, unknown> | null;
};

type SealedEnvelope = {
  v: number;
  uid: string;
  exp: number;
  data: IntakeExtraction;
};

function sealKey(secret: string | undefined = process.env.ESBLU_ACTION_CONFIRMATION_SECRET): Buffer | null {
  const trimmed = secret?.trim();
  if (!trimmed || trimmed.length < 32) return null;
  return createHash("sha256").update(`esblu-intake-seal-v1:${trimmed}`).digest();
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** `null` = tajomstvo chýba; volajúci pokračuje bez vyťažených údajov. */
export function sealIntakeExtraction(
  data: IntakeExtraction,
  userId: string,
  options: { secret?: string; now?: number } = {}
): string | null {
  const key = sealKey(options.secret);
  if (!key) return null;
  const envelope: SealedEnvelope = {
    v: SEAL_VERSION,
    uid: userId,
    exp: Math.floor((options.now ?? Date.now()) / 1000) + INTAKE_SEAL_TTL_SECONDS,
    data,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(Buffer.concat([iv, tag, ciphertext]));
}

/**
 * Rozšifruje a overí: autentifikovaný (GCM), patrí tomuto používateľovi,
 * neexpiroval. Čokoľvek iné = `null`.
 */
export function unsealIntakeExtraction(
  token: string,
  userId: string,
  options: { secret?: string; now?: number } = {}
): IntakeExtraction | null {
  const key = sealKey(options.secret);
  if (!key || typeof token !== "string" || token.length < 40 || token.length > 200_000) return null;
  try {
    const raw = fromB64url(token);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const envelope = JSON.parse(plain) as SealedEnvelope;
    if (envelope.v !== SEAL_VERSION || envelope.uid !== userId) return null;
    if (Math.floor((options.now ?? Date.now()) / 1000) > envelope.exp) return null;
    if (!isIntakeDocumentType(envelope.data?.documentType)) return null;
    return envelope.data;
  } catch {
    return null;
  }
}

/** Cesta v Storage musí byť vo vlastnom priečinku volajúceho a bez `..`. */
export function isOwnStoragePath(path: unknown, userId: string): path is string {
  if (typeof path !== "string" || path.length > 400) return false;
  if (!path.startsWith(`${userId}/`)) return false;
  if (path.includes("..") || path.includes("\\") || path.includes("//")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(path);
}
