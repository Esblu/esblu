// =============================================================================
// R3 (P1-4, P1-5): doklad adresovaný INÉMU účastníkovi (RECIPIENT_MISMATCH) nie je údajom firmy, do ktorej
// schránky ho poskytovateľ doručil — môže patriť inému zákazníkovi Esblu alebo tretej osobe. Firma ho nikdy
// nevidí: UI/detail/stiahnutie (kód), Data API (RLS 20261125100000), Storage (bucket bez klientskych politík),
// export firmy a účtovný balík (tento filter), odtlačok exportu (DB 20261127100000).
// Jediné miesto pravidla v kóde — všetky serverové čítania cez service role ho musia použiť.
// =============================================================================

export const RECIPIENT_MISMATCH = "RECIPIENT_MISMATCH";

export function visibleToCompany(row: { last_error_code?: string | null }): boolean {
  return row.last_error_code !== RECIPIENT_MISMATCH;
}

type Row = Record<string, unknown>;

/**
 * Filter pre serverové čítanie (service role obchádza RLS): prijaté doklady bez R3 a udalosti iba viditeľných
 * dokladov (udalosti odoslaných faktúr bez zmeny). Vracia aj počty skrytých riadkov (manifest exportu).
 */
export function filterCompanyVisibleEinvoice(input: { inbound: Row[]; events: Row[] }): {
  inbound: Row[];
  events: Row[];
  hidden: { einvoice_inbound: number; einvoice_events: number };
} {
  const hiddenIds = new Set(input.inbound.filter((r) => !visibleToCompany(r as { last_error_code?: string | null })).map((r) => String(r.id)));
  const inbound = input.inbound.filter((r) => !hiddenIds.has(String(r.id)));
  const events = input.events.filter((e) => !(e.inbound_id !== null && e.inbound_id !== undefined && hiddenIds.has(String(e.inbound_id))));
  return {
    inbound,
    events,
    hidden: { einvoice_inbound: input.inbound.length - inbound.length, einvoice_events: input.events.length - events.length },
  };
}
