// =============================================================================
// Kanonické cesty medzi Inboxom a Faktúrami.
//
// PREČO TENTO SÚBOR EXISTUJE
// --------------------------
// Inbox je PRÍJEM. Faktúry sú účtovný modul. Medzi nimi vedie jediná cesta
// a tá je odteraz pomenovaná tu. Predtým sa URL skladala priamo v hlasovom
// handleri a druhýkrát v UI, takže „?processReceived=1" bolo de facto
// rozhranie, ktoré nikde nebolo napísané — a pri zmene by sa jedna strana
// opravila a druhá nie.
//
// Modul nemá žiadne importy, takže ho môže použiť klient, server aj test.
// =============================================================================

/** Základ Inboxu. Jediné miesto, kde je táto cesta napísaná. */
const INBOX_PATH = "/ai-evidencia";

/**
 * Otvorenie zdrojového dokumentu v Inboxe — bez akéhokoľvek spracovania.
 *
 * Toto je cesta „ukáž mi originál", ktorou sa z faktúry dostaneš k
 * naskenovanej predlohe. Nič nezakladá a nič nemení.
 */
export function sourceDocumentRoute(documentId: string): string {
  return `${INBOX_PATH}?openDocument=${encodeURIComponent(documentId)}`;
}

/**
 * Otvorenie KONTROLY prijatej faktúry nad zdrojovým dokumentom.
 *
 * Výsledkom je obrazovka na kontrolu, nie doklad: samotná faktúra vzniká
 * až potvrdením človekom, tou istou cestou ako pri kliknutí v UI. Preto
 * sem smie viesť aj hlasový príkaz — neobchádza tým nič.
 */
export function receivedInvoiceRoute(documentId: string): string {
  return `${sourceDocumentRoute(documentId)}&processReceived=1`;
}

/** Detail kanonickej faktúry. */
export function invoiceRoute(invoiceId: string): string {
  return `/faktury/${encodeURIComponent(invoiceId)}`;
}
