import type { SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// Krátkodobý konverzačný kontext — tenká vrstva nad tromi RPC.
//
// Tento súbor ZÁMERNE neobsahuje žiadnu autorizačnú logiku. Kto smie
// kontext čítať a zapisovať, rozhodujú SECURITY DEFINER funkcie v
// migrácii 20260924100000: vnútri si samy overujú auth.uid() aj aktívnu
// firmu volajúceho. Keby sa tá istá kontrola opakovala aj tu, vznikli by
// dve definície toho istého pravidla — a pri budúcej zmene by sa zmenila
// iba jedna.
//
// Aplikácia teda nikdy nevolá `.from("assistant_conversation_contexts")`
// priamo a tabuľka pre rolu `authenticated` ani nemá grant.
// =============================================================================

/** Musí sedieť s CHECK-om `assistant_conversation_contexts_conversation_shape`. */
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{16,64}$/;

export function isValidConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

/** 10 minút. Databáza si hodnotu aj tak zastropuje na 15 (viď migrácia). */
const CONTEXT_TTL_SECONDS = 10 * 60;

export type LoadedConversationContext = {
  pendingIntent: string;
  slots: Record<string, unknown>;
  missingFields: string[];
  turnCount: number;
};

export async function loadConversationContext(
  supabase: SupabaseClient,
  conversationId: string
): Promise<LoadedConversationContext | null> {
  if (!isValidConversationId(conversationId)) return null;

  const { data, error } = await supabase
    .rpc("esblu_load_conversation_context", { p_conversation_id: conversationId })
    .maybeSingle();

  if (error || !data) return null;

  const row = data as {
    pending_intent: string;
    slots: Record<string, unknown> | null;
    missing_fields: string[] | null;
    turn_count: number | null;
  };

  return {
    pendingIntent: row.pending_intent,
    slots: row.slots ?? {},
    missingFields: Array.isArray(row.missing_fields) ? row.missing_fields : [],
    turnCount: typeof row.turn_count === "number" ? row.turn_count : 0,
  };
}

/**
 * Uloží rozpracovaný stav. Vracia počet krokov, ktorý spočítala DATABÁZA —
 * nie aplikácia. Vďaka tomu sa strop dialógu nedá obísť tým, že by volajúci
 * posielal stále prvý krok.
 *
 * Pri zlyhaní vracia `null`; volajúci z toho urobí koniec dialógu, nie
 * pokračovanie bez pamäte. Dialóg, ktorý si nepamätá, čo už povedal, by
 * sa donekonečna pýtal na to isté.
 */
export async function saveConversationContext(
  supabase: SupabaseClient,
  conversationId: string,
  pendingIntent: string,
  slots: Record<string, unknown>,
  missingFields: string[]
): Promise<number | null> {
  if (!isValidConversationId(conversationId)) return null;

  const { data, error } = await supabase.rpc("esblu_upsert_conversation_context", {
    p_conversation_id: conversationId,
    p_pending_intent: pendingIntent,
    p_slots: slots,
    p_missing_fields: missingFields,
    p_expires_at_epoch: Math.floor(Date.now() / 1000) + CONTEXT_TTL_SECONDS,
  });

  if (error) {
    console.error("esblu_upsert_conversation_context zlyhalo:", error.message);
    return null;
  }

  return typeof data === "number" ? data : null;
}

/**
 * Atomicky uplatní dialóg a vráti jeho obsah — alebo `null`, keď ho už
 * uplatnil niekto iný.
 *
 * TOTO JE OCHRANA PROTI DUPLICITNÉMU DOKLADU.
 *
 * Doterajší tok bol `load → vytvor → clear`, čo má medzi prvým a tretím
 * krokom okno: dve požiadavky s tým istým conversationId (zopakované
 * volanie, obnovená sieť, dvojité ťuknutie) našli kontext nedotknutý a
 * vytvorili dva doklady. Zamykanie tlačidla v UI to nerieši, pretože
 * opakovanie prichádza zo siete.
 *
 * Funkcia interne robí jeden `UPDATE ... WHERE consumed_at IS NULL
 * RETURNING`, takže riadok získa práve jeden volajúci. Poradie v toku je
 * teraz `claim → vytvor`; keď claim neuspeje, nevytvára sa nič.
 *
 * Rovnaký vzor ako `esblu_claim_action_confirmation` pri potvrdzovaní
 * rizikových akcií.
 */
export async function claimConversationContext(
  supabase: SupabaseClient,
  conversationId: string
): Promise<LoadedConversationContext | null> {
  if (!isValidConversationId(conversationId)) return null;

  const { data, error } = await supabase
    .rpc("esblu_claim_conversation_context", { p_conversation_id: conversationId })
    .maybeSingle();

  if (error || !data) return null;

  const row = data as {
    pending_intent: string;
    slots: Record<string, unknown> | null;
    missing_fields: string[] | null;
    turn_count: number | null;
  };

  return {
    pendingIntent: row.pending_intent,
    slots: row.slots ?? {},
    missingFields: Array.isArray(row.missing_fields) ? row.missing_fields : [],
    turnCount: typeof row.turn_count === "number" ? row.turn_count : 0,
  };
}

/**
 * Zruší dialóg.
 *
 * Používa sa na ukončenie dialógu, ktorý sa nedokončil (napr. priveľa
 * krokov). Dokončenie ide cez `claimConversationContext` — tam je
 * podstatné, aby sa riadok nezmazal, ale označil: prázdne miesto sa nedá
 * odlíšiť od dialógu, ktorý nikdy neexistoval, a zopakovaná požiadavka by
 * ho vytvorila znova.
 */
export async function clearConversationContext(
  supabase: SupabaseClient,
  conversationId: string
): Promise<void> {
  if (!isValidConversationId(conversationId)) return;

  const { error } = await supabase.rpc("esblu_clear_conversation_context", {
    p_conversation_id: conversationId,
  });

  if (error) {
    console.error("esblu_clear_conversation_context zlyhalo:", error.message);
  }
}

/** Po koľkých krokoch sa dialóg vzdá. Zhodné so stropom v databáze. */
export const MAX_CONVERSATION_TURNS = 12;
