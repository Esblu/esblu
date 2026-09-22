import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { IntentResult } from "@/lib/intents/types";
import type { ResolvedUiEntity } from "@/lib/intents/ui-context";

// =============================================================================
// Príkazy nad PRÁVE OTVORENOU entitou.
//
// Entita sem prichádza UŽ OVEROVANÁ serverom (lib/intents/ui-context.ts —
// existuje, patrí do aktívnej firmy volajúceho a volajúci ju smie čítať,
// čo napokon rozhodla RLS). Tento súbor preto neautorizuje entitu znova,
// ale rozhoduje o DVOCH ďalších veciach, ktoré RLS nevie:
//
//   1. či je dokument na danú operáciu vôbec spôsobilý,
//   2. či má volajúci na tú operáciu oprávnenie (finančná správa).
//
// Nič tu nezapisuje do databázy. Výsledkom je vždy iba navigácia na
// existujúcu obrazovku.
// =============================================================================

/**
 * „Spracuj tento dokument ako prijatú faktúru."
 *
 * ČO TO ROBÍ A ČO NIE
 * -------------------
 * Otvorí existujúcu obrazovku kontroly prijatej faktúry nad otvoreným
 * dokumentom. NEVYTVÁRA doklad, NEFINALIZUJE ho a NEZAKLADÁ dodávateľa —
 * to všetko zostáva na človeku v tej obrazovke, presne ako keď sa k nej
 * dostane klikaním. Hlas tu iba skracuje cestu, nemení pravidlá.
 *
 * SPÔSOBILOSŤ DOKUMENTU
 * ---------------------
 * Vyžaduje sa `document_type = 'invoice'` a neprázdne `extracted_fields`.
 * Prvé preto, že prepisovať typ dokladu je účtovné rozhodnutie a nie je
 * to vec hlasového príkazu — bločok sa na faktúru „nepreklopí" mlčky.
 * Druhé preto, že bez rozpoznaných polí by sa otvorila prázdna obrazovka
 * a používateľ by prepisoval celý doklad ručne; vtedy je poctivejšie
 * povedať, že z tohto dokumentu kandidát nie je.
 */
export function handleProcessCurrentDocumentAsReceivedInvoice(
  locale: Locale,
  entity: ResolvedUiEntity | null,
  financeManage: boolean
): IntentResult {
  // Bez otvoreného dokumentu sa „tento" nedá určiť. Appka to prizná a
  // poprosí o otvorenie — neodvodzuje ho z „posledného nahraného".
  if (!entity || entity.entityType !== "document") {
    return {
      kind: "not_found",
      text: translate(locale, "search.voice.context.noOpenDocument"),
    };
  }

  // Oprávnenie sa kontroluje PRED čímkoľvek ďalším. Zamestnanec nemá
  // dostať ani informáciu o tom, či je dokument spôsobilý — to by už
  // vypovedalo o obsahu finančného dokladu.
  if (!financeManage) {
    return { kind: "error", text: translate(locale, "search.voice.states.denied") };
  }

  const documentType = typeof entity.row.document_type === "string" ? entity.row.document_type : "";

  if (documentType !== "invoice") {
    // Iný typ dokladu sa NEPREKLOPÍ mlčky. Presné pomenovanie toho, čo je
    // otvorené, pomáha používateľovi pochopiť, prečo to nešlo.
    return {
      kind: "not_found",
      text: translate(locale, "search.voice.context.documentNotInvoice"),
    };
  }

  const fields = entity.row.extracted_fields;
  const hasFields =
    fields !== null &&
    typeof fields === "object" &&
    Object.keys(fields as Record<string, unknown>).length > 0;

  if (!hasFields) {
    return {
      kind: "not_found",
      text: translate(locale, "search.voice.context.documentWithoutExtraction"),
    };
  }

  // Navigácia na existujúcu obrazovku. `processReceived=1` iba požiada
  // Inbox, aby nad TÝMTO dokumentom otvoril kontrolu prijatej faktúry;
  // samotné otvorenie si Inbox robí z dokumentu, ktorý si sám načíta cez
  // RLS, takže identifikátor v adrese nič neodomyká.
  return {
    kind: "navigate",
    entity: {
      type: "document",
      id: entity.entityId,
      label: translate(locale, "search.voice.context.openReceivedReview"),
      href: `/ai-evidencia?openDocument=${encodeURIComponent(entity.entityId)}&processReceived=1`,
    },
  };
}

/**
 * Bezpečné označenie otvorenej entity na zobrazenie v hlasovom paneli.
 *
 * Zámerne nikdy nevracia interný identifikátor — používateľovi nič
 * nepovie a v rozhraní vyzerá ako chyba. Keď entita označenie nemá,
 * použije sa všeobecný názov typu.
 */
export function describeUiEntity(locale: Locale, entity: ResolvedUiEntity): string {
  if (entity.label) return entity.label;
  return translate(locale, `search.voice.context.entityType.${entity.entityType}`);
}
