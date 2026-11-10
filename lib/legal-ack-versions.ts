// =============================================================================
// J10 CLIA (manuál 2.2.4): pri registrácii sa eviduje dátum, čas a OZNAČENIE
// VERZIE Privacy Policy, ktorá bola Používateľovi SPRÍSTUPNENÁ.
//
// Pri e-mailovej registrácii s potvrdením e-mailu sa acceptance zapisuje až
// pri prvom vstupe do onboardingu. Doteraz sa zapisovala verzia aktuálna v
// tom čase — ak sa medzitým verzia zmenila, záznam by uvádzal verziu, ktorú
// používateľ pri odškrtnutí nevidel. Preto sa verzie zobrazené pri
// odškrtnutí uložia do user_metadata pri signUp() a onboarding zapíše práve
// tie. Ak je zapísaná staršia verzia, LegalAcceptanceGate si aktuálnu
// vyžiada (DB funkcia akceptuje iba publikované verzie).
// =============================================================================

import { REQUIRED_ACCEPTANCE_DOCUMENTS, type LegalDocumentType } from "@/lib/legal-config";

export const LEGAL_ACK_METADATA_KEY = "esblu_legal_ack";

const VERSION_SHAPE = /^\d{1,3}\.\d{1,3}$/;

/** Verzie, ktoré sú na registračnej obrazovke zobrazené práve teraz. */
export function currentLegalAckMetadata(): Record<LegalDocumentType, string> {
  const out = {} as Record<LegalDocumentType, string>;
  for (const doc of REQUIRED_ACCEPTANCE_DOCUMENTS) out[doc.type] = doc.version;
  return out;
}

/**
 * Verzie na zápis registračnej acceptance: z user_metadata (zobrazené pri
 * odškrtnutí), inak aktuálne (registrácia so session hneď — zhodné).
 */
export function registrationAckVersions(
  userMetadata: unknown
): { type: LegalDocumentType; version: string }[] {
  const meta =
    userMetadata && typeof userMetadata === "object"
      ? (userMetadata as Record<string, unknown>)[LEGAL_ACK_METADATA_KEY]
      : null;
  const recorded = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

  return REQUIRED_ACCEPTANCE_DOCUMENTS.map((doc) => {
    const shown = recorded[doc.type];
    return {
      type: doc.type,
      version: typeof shown === "string" && VERSION_SHAPE.test(shown) ? shown : doc.version,
    };
  });
}
