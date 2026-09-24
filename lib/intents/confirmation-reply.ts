// =============================================================================
// Hlasová odpoveď na otázku „Naozaj?" pri čakajúcom potvrdení.
//
// PREČO
// -----
// Po náhľade rizikovej akcie (napr. zmazanie priečinka) používateľ často
// POVIE „Áno, zmaž ho" namiesto ťuknutia na tlačidlo. Predtým sa taký prepis
// poslal ako NOVÝ príkaz: náhľad sa zahodil, veta sa nerozpoznala a
// asistent odpovedal „Nič sa nenašlo." — mazanie sa hlasom nedalo dokončiť.
//
// Toto je čistá funkcia bez stavu. O tom, ČO sa potvrdí, nerozhoduje text:
// klient pošle na /api/assistant/action/execute iba confirmationId z práve
// zobrazeného náhľadu; server ho viaže na používateľa, firmu, intent a
// presné ID (HMAC, jednorazové, časovo obmedzené) a oprávnenie overí znova.
//
// Konzervatívne: iba jednoznačný súhlas alebo odmietnutie. Čokoľvek iné
// (`null`) je bežný nový príkaz.
// =============================================================================

export type ConfirmationReply = "confirm" | "cancel" | null;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.!?,;:„“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATIVE = [
  "nie", "nezmaz", "nemaz", "nevymaz", "neodstran", "nepotvrdzujem", "zrus", "zrusit", "stop", "prestan", "netreba",
  "no", "not", "dont", "don t", "cancel", "abort",
  "nein", "nicht", "abbrechen", "stopp",
];

const AFFIRMATIVE = [
  "ano", "hej", "jasne", "urcite", "potvrdzujem", "potvrd", "potvrdit", "suhlasim", "ok", "okej", "dobre", "mozes", "pokracuj",
  "yes", "yeah", "yep", "sure", "confirm", "confirmed", "go ahead", "do it",
  "ja", "jawohl", "genau", "bestatige", "bestaetige", "bestatigen", "bestaetigen", "mach es", "mach das",
];

/** „Zmaž ho", „Vymaž to", „Delete it", „Lösch ihn" — sloveso + zámeno bez ďalšieho obsahu. */
const VERB_PRONOUN = /^(zmaz|vymaz|odstran|vytvor|pridaj|uloz|delete|remove|create|add|losch|losche|loesch|loesche|entferne|erstelle)\w*( (ho|ju|to|ich|it|them|ihn|sie|es|den|die|das|ordner|priecinok))?( (prosim|please|bitte))?$/;

function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^| )${phrase}( |$)`).test(text);
}

export function classifyConfirmationReply(raw: string): ConfirmationReply {
  const text = normalize(raw);
  if (!text || text.length > 60) return null;

  if (NEGATIVE.some((word) => hasPhrase(text, word))) {
    // „Nie" + súhlas v jednej vete je nejasné → odmietnutie je bezpečnejšie.
    return "cancel";
  }

  if (AFFIRMATIVE.some((word) => hasPhrase(text, word))) {
    // „Áno, zmaž priečinok Test2" pomenúva INÝ cieľ, než ukazuje náhľad →
    // nie je to potvrdenie, ale nový príkaz.
    const rest = AFFIRMATIVE.reduce((acc, word) => acc.replace(new RegExp(`(^| )${word}( |$)`, "g"), " "), text)
      .replace(/\s+/g, " ")
      .trim();
    if (!rest || VERB_PRONOUN.test(rest) || /^(prosim|please|bitte|danke|dakujem)$/.test(rest)) return "confirm";
    return null;
  }

  if (VERB_PRONOUN.test(text) && /( (ho|ju|to|it|them|ihn|sie|es))( |$)/.test(` ${text} `)) return "confirm";
  return null;
}
