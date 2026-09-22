import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { IntentResult } from "@/lib/intents/types";
import {
  loadConversationContext,
  saveConversationContext,
  claimConversationContext,
  clearConversationContext,
  MAX_CONVERSATION_TURNS,
} from "@/lib/intents/conversation";
import {
  applyAnswer,
  buildQuestion,
  createInvoiceDraftFromSlots,
  extractInvoiceSlotsFromText,
  missingInvoiceFields,
  readPartnerLabels,
  readSlots,
  resolvePartnerCandidates,
  serializeSlots,
  appendItemFromAnswer,
  looksLikeItemAppend,
  buildItemPriceQuestion,
  type InvoiceDraftField,
  type InvoiceDraftSlots,
  type PartnerCandidate,
} from "@/lib/intents/invoice-draft";

// =============================================================================
// Viackrokový dialóg pre hlasové vytvorenie draftu faktúry.
//
// AKO TO BEŽÍ
// -----------
// Každá požiadavka je stále samostatná a bezstavová — stav je uložený v
// databáze a číta sa podľa conversationId, ktoré klient posiela späť.
// Server sa nikdy nespolieha na to, že "si pamätá" predchádzajúci krok, a
// nikdy neverí tomu, čo klient o predchádzajúcom kroku tvrdí: intent, už
// vyplnené sloty aj poradie otázok si načíta z databázy.
//
// PREČO SA ODPOVEĎ VIAŽE NA POLOŽENÚ OTÁZKU
// -----------------------------------------
// "300" znamená niečo iné ako odpoveď na otázku o sume a niečo iné ako
// odpoveď na otázku o DPH. Bez väzby na to, čo sa práve pýtalo, by sa
// asistent musel domýšľať — a pri fakturácii je domýšľanie to, čomu sa
// celý tento návrh vyhýba. Preto sa vždy vyhodnocuje odpoveď na PRVÉ
// chýbajúce pole a poradie polí je pevné.
//
// ZA ČO TÁTO VRSTVA NEZODPOVEDÁ
// -----------------------------
// Za oprávnenia. Tie sa kontrolujú v route (finance manage) a napokon ich
// vynucuje RLS pri samotnom zápise. Tu sa zámerne neduplikujú.
// =============================================================================

const PENDING_INTENT = "CREATE_INVOICE_DRAFT";

export type InvoiceDraftFlowContext = {
  companyId: string;
  userId: string;
  conversationId: string;
  /**
   * Kalendárny deň používateľa pre TÚTO požiadavku — už overený
   * serverom. Berie sa z aktuálneho kroku, nie z uloženého kontextu:
   * rozhoduje deň, kedy doklad naozaj vzniká, a dialóg môže prebiehať
   * cez polnoc.
   *
   * `null` znamená, že sa deň nedal spoľahlivo určiť. Doklad sa vtedy
   * NEVYTVORÍ — pozri `continueFlow`.
   */
  issueDate: string | null;
};

/**
 * Prvý krok — používateľ vyslovil "vytvor faktúru ...".
 *
 * Z vety sa vyberie všetko, čo v nej je, a doplní sa partner, ak sa dá
 * jednoznačne určiť. Čo chýba, stane sa otázkou.
 */
export async function startInvoiceDraftFlow(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: InvoiceDraftFlowContext,
  rawText: string,
  partnerQuery: string | undefined,
  descriptionHint: string | undefined,
  amountHint: number | undefined
): Promise<IntentResult> {
  const slots = extractInvoiceSlotsFromText(rawText);

  // Model môže popis/sumu rozpoznať lepšie než deterministická extrakcia
  // (napr. keď veta nemá "za"). Použijú sa IBA keď z vety nevyšla ani
  // jedna položka — nikdy neprepíšu to, čo sa z textu dalo prečítať
  // priamo, a nikdy nedoplnia druhý riadok k už rozpoznaným.
  if ((slots.items?.length ?? 0) === 0 && descriptionHint?.trim()) {
    slots.items = [
      {
        description: descriptionHint.trim().slice(0, 200),
        ...(typeof amountHint === "number" && amountHint >= 0
          ? { unitPrice: amountHint }
          : {}),
      },
    ];
  }

  if (partnerQuery?.trim()) {
    const resolution = await resolvePartnerCandidates(supabase, partnerQuery.trim());

    if (resolution.autoResolvable) {
      // Presná alebo silná zhoda a práve jeden kandidát.
      slots.partnerId = resolution.candidates[0].id;
    } else if (resolution.candidates.length > 0) {
      // Viac kandidátov, alebo len čiastočná zhoda. V oboch prípadoch sa
      // asistent pýta — aj keď je kandidát jediný. „Podobný názov" nie je
      // to isté ako „ten názov".
      slots.partnerCandidateIds = resolution.candidates.map((candidate) => candidate.id);
    } else {
      // Nenašiel sa — a NEZALOŽÍ sa. Nový obchodný partner je záznam s
      // fakturačnými a daňovými údajmi; vyrobiť ho z jedného vysloveného
      // mena by znamenalo doklad na firmu, ktorú nikto nezadal.
      return {
        kind: "not_found",
        text: translate(locale, "search.voice.invoice.partnerNotFound", {
          name: partnerQuery.trim(),
        }),
      };
    }
  }

  return continueFlow(supabase, locale, ctx, slots);
}

/**
 * Ďalší krok — používateľ odpovedal na otázku.
 *
 * Vráti `null`, keď pre daný dialóg žiadny uložený stav nie je (vypršal,
 * patrí inému používateľovi alebo inej firme). Volajúci to spracuje ako
 * bežný nový príkaz, nie ako chybu — používateľ nemá dôvod rozumieť tomu,
 * že mu medzitým vypršala pamäť.
 */
export async function continueInvoiceDraftFlow(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: InvoiceDraftFlowContext,
  rawAnswer: string
): Promise<IntentResult | null> {
  const stored = await loadConversationContext(supabase, ctx.conversationId);
  if (!stored || stored.pendingIntent !== PENDING_INTENT) return null;

  if (stored.turnCount >= MAX_CONVERSATION_TURNS) {
    await clearConversationContext(supabase, ctx.conversationId);
    return { kind: "error", text: translate(locale, "search.voice.invoice.tooManyTurns") };
  }

  const slots = readSlots(stored.slots);

  // Na čo sa práve pýtalo. Berie sa z ULOŽENÉHO stavu, nie z tela
  // požiadavky — inak by klient mohol tvrdiť, že odpovedá na inú otázku,
  // než aká zaznela, a podsunúť tak hodnotu do iného poľa.
  const field = readField(stored.missingFields[0]);
  if (!field) {
    await clearConversationContext(supabase, ctx.conversationId);
    return null;
  }

  // Meno partnera je jediná odpoveď, ktorá vyžaduje dotaz do databázy —
  // ostatné sa dajú prečítať z textu.
  if (field === "partner") {
    const resolution = await resolvePartnerCandidates(supabase, rawAnswer.trim());

    if (resolution.candidates.length === 0) {
      return askAgain(supabase, locale, ctx, slots, {
        kind: "not_found",
        text: translate(locale, "search.voice.invoice.partnerNotFound", {
          name: rawAnswer.trim(),
        }),
      });
    }

    if (resolution.autoResolvable) slots.partnerId = resolution.candidates[0].id;
    else slots.partnerCandidateIds = resolution.candidates.map((candidate) => candidate.id);

    return continueFlow(supabase, locale, ctx, slots);
  }

  // „Pridaj ešte dopravu 50 eur." — doplnenie ďalšieho riadka počas
  // rozpracovanej faktúry. Vyhodnocuje sa PRED `applyAnswer`, pretože
  // odpoveď na otázku o DPH a doplnenie položky vyzerajú inak a nesmú si
  // konkurovať: bez tejto vetvy by „pridaj dopravu 50" pri otázke o DPH
  // skončilo ako sadzba 50 %.
  if (looksLikeItemAppend(rawAnswer) && (slots.items?.length ?? 0) > 0) {
    const appended = appendItemFromAnswer(slots, rawAnswer);

    if (!appended) {
      // Zámer bol zrejmý, ale položka sa z odpovede nedala prečítať.
      // Pôvodné riadky zostávajú nedotknuté a asistent sa spýta znova.
      return askAgain(supabase, locale, ctx, slots, {
        kind: "clarify",
        question: translate(locale, "search.voice.invoice.appendUnclear"),
        conversationId: ctx.conversationId,
      });
    }

    return continueFlow(supabase, locale, ctx, appended);
  }

  const candidates =
    field === "partnerChoice"
      ? await readPartnerLabels(supabase, slots.partnerCandidateIds ?? [])
      : [];

  const updated = applyAnswer(slots, field, rawAnswer, candidates);

  // Odpoveď, z ktorej sa nedalo nič prečítať, nesmie posunúť dialóg ďalej —
  // inak by sa otázka stratila a chýbajúca hodnota by sa dopĺňala inde.
  return continueFlow(supabase, locale, ctx, updated);
}

/**
 * Spoločné pokračovanie: buď sa spýta na prvé chýbajúce pole, alebo — keď
 * už nechýba nič — založí draft a dialóg zruší.
 */
async function continueFlow(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: InvoiceDraftFlowContext,
  slots: InvoiceDraftSlots
): Promise<IntentResult> {
  const missing = missingInvoiceFields(slots);

  if (missing.length === 0) {
    // FAIL CLOSED NA DÁTUME.
    //
    // Toto je jediné miesto, kde doklad vzniká, a preto jediné miesto,
    // kde sa dátum kontroluje. Keď sa kalendárny deň používateľa nedá
    // spoľahlivo určiť — klient ho neposlal, poslal nezmysel alebo deň
    // mimo možného rozsahu časových pásiem — doklad sa NEVYTVORÍ.
    //
    // Skoršia verzia v tomto prípade dosadila UTC dnešok. Znelo to
    // zhovievavo, ale o polnoci stredoeurópskeho času by to znamenalo
    // ticho vystavený doklad s včerajším dátumom. Odmietnutý príkaz
    // používateľ vidí a zopakuje; nesprávny dátum na daňovom doklade sa
    // nájde až pri kontrole.
    //
    // Platí to aj pre ručne poskladanú požiadavku, ktorá `localDate`
    // vynechá zámerne — jediná cesta k dokladu vedie cez túto kontrolu.
    if (!ctx.issueDate) {
      await clearConversationContext(supabase, ctx.conversationId);
      return {
        kind: "error",
        text: translate(locale, "search.voice.invoice.localDateRequired"),
      };
    }

    // OCHRANA PROTI DUPLICITNÉMU DOKLADU.
    //
    // Dialóg sa najprv ATOMICKY uplatní a až potom vzniká doklad. Keď tú
    // istú požiadavku pošle klient dvakrát — zopakované volanie, obnovená
    // sieť, dvojité ťuknutie — druhý claim nájde riadok už spotrebovaný,
    // vráti `null` a druhá faktúra nevznikne.
    //
    // Poradie je podstatné. Keby sa doklad vytvoril pred uplatnením,
    // ochrana by neexistovala; presne to bola medzera pred Phase 3A.
    //
    // Stav sa uloží vždy (aj pri prvom kroku s úplnou vetou), aby vôbec
    // bolo čo uplatniť a aby zopakovanie narazilo na spotrebovaný riadok.
    const stored = await saveConversationContext(
      supabase,
      ctx.conversationId,
      PENDING_INTENT,
      serializeSlots(slots),
      []
    );
    if (stored === null) {
      return { kind: "error", text: translate(locale, "search.errors.generic") };
    }

    const claimed = await claimConversationContext(supabase, ctx.conversationId);
    if (!claimed) {
      // Niekto (alebo zopakovaná požiadavka) tento dialóg už uplatnil.
      return {
        kind: "answer",
        text: translate(locale, "search.voice.invoice.alreadyCreated"),
      };
    }

    // Sloty sa čítajú z UPLATNENÉHO riadka, nie z pamäte procesu —
    // rovnaký princíp ako pri potvrdzovaní akcií: autoritou je to, čo je
    // v databáze, nie to, čo drží požiadavka.
    const claimedSlots = readSlots(claimed.slots);

    return createInvoiceDraftFromSlots(
      supabase,
      locale,
      ctx.companyId,
      ctx.userId,
      claimedSlots,
      ctx.issueDate
    );
  }

  const saved = await saveConversationContext(
    supabase,
    ctx.conversationId,
    PENDING_INTENT,
    serializeSlots(slots),
    missing
  );

  if (saved === null) {
    // Bez pamäte sa dialóg viesť nedá — a pýtať sa donekonečna na to isté
    // je horšie než povedať, že to teraz nejde.
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  if (saved >= MAX_CONVERSATION_TURNS) {
    await clearConversationContext(supabase, ctx.conversationId);
    return { kind: "error", text: translate(locale, "search.voice.invoice.tooManyTurns") };
  }

  const candidates: PartnerCandidate[] =
    missing[0] === "partnerChoice"
      ? await readPartnerLabels(supabase, slots.partnerCandidateIds ?? [])
      : [];

  const question = buildQuestion(locale, missing[0], candidates);

  // Pri viacerých položkách musí otázka pomenovať TÚ, ktorej chýba cena —
  // inak používateľ priradí sumu k nesprávnemu riadku.
  const questionText =
    missing[0] === "itemPrice" ? buildItemPriceQuestion(locale, slots) : question.question;

  return {
    kind: "clarify",
    question: questionText,
    conversationId: ctx.conversationId,
    choices: question.choices,
  };
}

/** Zachová stav a vráti iné oznámenie než otázku (napr. "partnera nepoznám"). */
async function askAgain(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: InvoiceDraftFlowContext,
  slots: InvoiceDraftSlots,
  result: IntentResult
): Promise<IntentResult> {
  const missing = missingInvoiceFields(slots);
  await saveConversationContext(
    supabase,
    ctx.conversationId,
    PENDING_INTENT,
    serializeSlots(slots),
    missing
  );
  void locale;
  return result;
}

const FIELDS: InvoiceDraftField[] = [
  "partner",
  "partnerChoice",
  "items",
  "itemPrice",
  "vat",
];

function readField(value: unknown): InvoiceDraftField | null {
  return typeof value === "string" && (FIELDS as string[]).includes(value)
    ? (value as InvoiceDraftField)
    : null;
}
