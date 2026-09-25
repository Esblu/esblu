import type { IntentResult } from "../intents/types.ts";

// =============================================================================
// Čo Esblu nahlas povie po hlasovom príkaze.
//
// Presne ten text, ktorý je na obrazovke (otázka, odpoveď, náhľad, výsledok),
// nie nový obsah. Súhrny s položkami a sumami (hotový draft faktúry) sa NEČÍTAJÚ
// — iba nadpis a poznámka; detaily sú na obrazovke. Zoznamy a reporty sa
// nečítajú celé, iba nadpis. Modul je čistý (bez prehliadača) kvôli testom.
// =============================================================================

const MAX_SPOKEN_LENGTH = 400;

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_SPOKEN_LENGTH ? `${clean.slice(0, MAX_SPOKEN_LENGTH - 1)}…` : clean;
}

/**
 * `confirmPrompt` — v súvislom hlasovom režime sa za náhľad zápisu pridá
 * otázka („Potvrdiť? Povedzte áno alebo nie."), aby používateľ vedel, že
 * stačí odpovedať hlasom.
 */
/**
 * `found` — v hlasovej relácii šablóna „Našiel som „{{name}}“." pre výsledok,
 * ktorý je iba odkazom (navigácia). Každé hlasové kolo tak niečo povie.
 */
export function spokenTextFor(result: IntentResult | null | undefined, options: { confirmPrompt?: string; found?: string } = {}): string | null {
  if (!result) return null;
  switch (result.kind) {
    case "clarify":
      return clip(result.question);
    case "answer":
    case "not_found":
    case "error":
    case "action_result":
      return clip(result.text);
    case "partner_review":
      return clip(result.text);
    case "action_preview":
      return options.confirmPrompt ? `${clip(result.summary)} ${options.confirmPrompt}` : clip(result.summary);
    case "draft_created":
      // Bez riadkov a súm — tie si používateľ skontroluje na obrazovke.
      return clip(`${result.title}. ${result.note}`);
    case "navigate":
      return options.found ? clip(options.found.replace("{{name}}", result.entity.label)) : null;
    case "list":
    case "deadline_list":
    case "document_list":
      return clip(result.title);
    default:
      return null;
  }
}

/** BCP-47 jazyk hlasu pre jazyk aplikácie (CZ best effort cez „cs"). */
export function speechLangFor(locale: string): string {
  switch (locale) {
    case "de":
      return "de-DE";
    case "en":
      return "en-GB";
    case "cs":
      return "cs-CZ";
    default:
      return "sk-SK";
  }
}
