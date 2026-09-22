// =============================================================================
// Testy členenia registra faktúr a smerovania Inbox → Faktúry.
//
// SPUSTENIE
//   npm run test:register
//
// PREČO EXISTUJÚ
// --------------
// Z produkčného mobilu: register hlásil „Všetky 3", vykreslil dva doklady a
// tretí — koncept — nebolo ako otvoriť. Číslo a zoznam popisovali dve rôzne
// množiny. Testy nižšie preto neoverujú jednotlivé filtre osve, ale ich
// VZŤAH: počet pri záložke sa musí rovnať počtu riadkov po kliknutí.
//
// Druhá polovica súboru stráži, že naskenovaná faktúra nezostane v Inboxe
// ako večne „nepriradená" potom, čo z nej už vznikol doklad.
// =============================================================================

import assert from "node:assert/strict";
import {
  matchesDirection,
  matchesSection,
  visibleInvoices,
  DIRECTION_ORDER,
  SECTION_ORDER,
  type DirectionFilter,
  type SectionKey,
} from "../lib/invoicing/invoice-register-filters.ts";
import {
  receivedInvoiceRoute,
  sourceDocumentRoute,
  invoiceRoute,
} from "../lib/invoicing/received-invoice-route.ts";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed++;
  } catch {
    failed++;
    console.error(
      `FAIL  ${label}\n      dostal: ${JSON.stringify(actual)}\n      čakal:  ${JSON.stringify(expected)}`
    );
  }
}

// -----------------------------------------------------------------------------
// Vzorka presne podľa produkcie v čase hlásenia (plus dnešný koncept)
// -----------------------------------------------------------------------------
type Row = {
  id: string;
  direction: string;
  kind: string;
  document_status: string;
  payment_status: string;
  overdue: boolean;
};

const FA = {
  id: "FA20260001",
  direction: "issued",
  kind: "regular_invoice",
  document_status: "finalized",
  payment_status: "paid",
  overdue: false,
};
const PRIJATA = {
  id: "TEST-2026-002",
  direction: "received",
  kind: "regular_invoice",
  document_status: "finalized",
  payment_status: "unpaid",
  overdue: false,
};
const KONCEPT_STARY = {
  id: "koncept-21",
  direction: "issued",
  kind: "regular_invoice",
  document_status: "draft",
  payment_status: "unpaid",
  overdue: false,
};
const KONCEPT_PRIJATY = {
  id: "koncept-prijaty",
  direction: "received",
  kind: "regular_invoice",
  document_status: "draft",
  payment_status: "unpaid",
  overdue: false,
};
const PO_SPLATNOSTI = {
  id: "po-splatnosti",
  direction: "issued",
  kind: "regular_invoice",
  document_status: "finalized",
  payment_status: "unpaid",
  overdue: true,
};
const DOBROPIS = {
  id: "dobropis",
  direction: "issued",
  kind: "credit_note",
  document_status: "finalized",
  payment_status: "paid",
  overdue: false,
};

const isOverdue = (row: Row) => row.overdue;
const ALL: Row[] = [FA, PRIJATA, KONCEPT_STARY, KONCEPT_PRIJATY, PO_SPLATNOSTI, DOBROPIS];

// -----------------------------------------------------------------------------
// 1. Presne to, čo používateľ videl na mobile
// -----------------------------------------------------------------------------
{
  // Tri doklady, ako ich register mal v čase snímky obrazovky.
  const snapshot: Row[] = [FA, PRIJATA, KONCEPT_STARY];

  check(
    "východiskový pohľad ukáže VŠETKY tri, vrátane konceptu",
    visibleInvoices(snapshot, "all", "all", isOverdue).map((r) => r.id),
    ["FA20260001", "TEST-2026-002", "koncept-21"]
  );
  check(
    "koncept je medzi vydanými",
    visibleInvoices(snapshot, "all", "issued", isOverdue).map((r) => r.id),
    ["FA20260001", "koncept-21"]
  );
  check(
    "prijaté zostávajú jeden",
    visibleInvoices(snapshot, "all", "received", isOverdue).map((r) => r.id),
    ["TEST-2026-002"]
  );
}

// -----------------------------------------------------------------------------
// 2. Počet == počet riadkov. Pre KAŽDÚ kombináciu, nie pre vybrané.
//
// Toto je vlastne celý zmysel súboru: nech sa v budúcnosti pridá
// akákoľvek sekcia, tento test padne, ak sa počet od zoznamu odtrhne.
// -----------------------------------------------------------------------------
{
  let mismatches = 0;
  for (const section of SECTION_ORDER) {
    const sectionScoped = ALL.filter((row) => matchesSection(row, section, isOverdue));
    for (const direction of DIRECTION_ORDER) {
      const count = sectionScoped.filter((row) => matchesDirection(row, direction)).length;
      const rows = visibleInvoices(ALL, section, direction, isOverdue).length;
      if (count !== rows) {
        mismatches++;
        console.error(`  nesúlad: sekcia=${section} smer=${direction} počet=${count} riadkov=${rows}`);
      }
    }
  }
  check("počet pri záložke sa rovná počtu riadkov vo VŠETKÝCH kombináciách", mismatches, 0);
}

// -----------------------------------------------------------------------------
// 3. Jednotlivé sekcie
// -----------------------------------------------------------------------------
check(
  "koncepty: oba smery",
  visibleInvoices(ALL, "drafts", "all", isOverdue).map((r) => r.id),
  ["koncept-21", "koncept-prijaty"]
);
check(
  "koncepty + prijaté",
  visibleInvoices(ALL, "drafts", "received", isOverdue).map((r) => r.id),
  ["koncept-prijaty"]
);
check(
  "vystavené = finalizované riadne doklady, nikdy koncept",
  visibleInvoices(ALL, "issued", "all", isOverdue).map((r) => r.id),
  ["FA20260001", "TEST-2026-002", "po-splatnosti"]
);
check(
  "po splatnosti iba finalizované",
  visibleInvoices(ALL, "overdue", "all", isOverdue).map((r) => r.id),
  ["po-splatnosti"]
);
check(
  "opravné doklady",
  visibleInvoices(ALL, "corrections", "all", isOverdue).map((r) => r.id),
  ["dobropis"]
);
// Dobropis je uhradený finalizovaný doklad, takže sem patrí. Sekcia
// "Uhradené" je o stave platby, nie o druhu dokladu.
check(
  "uhradené nezahŕňajú koncept s payment_status=unpaid",
  visibleInvoices(ALL, "paid", "all", isOverdue).map((r) => r.id),
  ["FA20260001", "dobropis"]
);
// Koncept má payment_status 'unpaid', ale neuhradený doklad je až ten
// finalizovaný — inak by sa nedokončený koncept tváril ako pohľadávka.
check(
  "neuhradené nezahŕňajú koncepty",
  visibleInvoices(ALL, "unpaid", "all", isOverdue).map((r) => r.id),
  ["TEST-2026-002", "po-splatnosti"]
);

// Žiadna sekcia ani smer nesmie doklad stratiť úplne: každý riadok musí byť
// vidieť aspoň v jednom pohľade, inak by sa stal osirelým záznamom.
{
  const seen = new Set<string>();
  for (const section of SECTION_ORDER) {
    for (const row of visibleInvoices(ALL, section, "all", isOverdue)) seen.add(row.id);
  }
  check("žiadny doklad nezostane neviditeľný vo všetkých sekciách", seen.size, ALL.length);
}

// -----------------------------------------------------------------------------
// 4. Smerovanie Inbox → Faktúry
//
// Jedna funkcia, jedno miesto. Kým sa URL skladala ručne na dvoch miestach,
// bolo „?processReceived=1" nepísané rozhranie medzi hlasom a Inboxom.
// -----------------------------------------------------------------------------
const DOC = "58f1d765-55fe-45fc-8613-200b87bdb836";

check(
  "cesta na kontrolu prijatej faktúry",
  receivedInvoiceRoute(DOC),
  `/ai-evidencia?openDocument=${DOC}&processReceived=1`
);
check("cesta na originál", sourceDocumentRoute(DOC), `/ai-evidencia?openDocument=${DOC}`);
check("kontrola vychádza z tej istej cesty", receivedInvoiceRoute(DOC).startsWith(sourceDocumentRoute(DOC)), true);
check("detail faktúry", invoiceRoute("94e07ff6-1d78-4f63-9c27-4a3534e4bdd0"), "/faktury/94e07ff6-1d78-4f63-9c27-4a3534e4bdd0");

// Identifikátor sa do adresy vkladá zakódovaný — v adrese nič neodomyká,
// ale ani ju nesmie rozbiť.
check(
  "podivný identifikátor sa zakóduje",
  receivedInvoiceRoute("a b&c=1"),
  "/ai-evidencia?openDocument=a%20b%26c%3D1&processReceived=1"
);

// -----------------------------------------------------------------------------
// 5. Kedy faktúra v Inboxe ešte čaká a kedy už nie
//
// Rovnaké pravidlo, aké používa Inbox: rozhoduje väzba s invoice_id, nie
// poradie riadkov vo väzbách.
// -----------------------------------------------------------------------------
type DocRow = {
  document_type: string | null;
  custom_category_id: string | null;
  document_links?: {
    vehicle_id: string | null;
    machine_id: string | null;
    invoice_id?: string | null;
  }[];
};

function documentInvoiceId(doc: DocRow): string | null {
  const links = Array.isArray(doc?.document_links) ? doc.document_links : [];
  for (const link of links) {
    if (link?.invoice_id) return link.invoice_id;
  }
  return null;
}

function isPending(doc: DocRow): boolean {
  const link = Array.isArray(doc?.document_links) ? doc.document_links[0] : null;
  const assigned = Boolean(link && (link.vehicle_id || link.machine_id));
  return (
    doc.document_type === "invoice" &&
    !documentInvoiceId(doc) &&
    !assigned &&
    !doc.custom_category_id
  );
}

check(
  "nespracovaná faktúra čaká",
  isPending({ document_type: "invoice", custom_category_id: null }),
  true
);
check(
  "spracovaná faktúra už nečaká",
  isPending({
    document_type: "invoice",
    custom_category_id: null,
    document_links: [{ vehicle_id: null, machine_id: null, invoice_id: "inv-1" }],
  }),
  false
);
// Dokument môže byť priradený k vozidlu A ZÁROVEŇ byť predlohou faktúry;
// poradie väzieb nie je zaručené, preto sa prechádzajú všetky.
check(
  "väzba s faktúrou sa nájde aj na druhom mieste",
  documentInvoiceId({
    document_type: "invoice",
    custom_category_id: null,
    document_links: [
      { vehicle_id: "v-1", machine_id: null, invoice_id: null },
      { vehicle_id: null, machine_id: null, invoice_id: "inv-2" },
    ],
  }),
  "inv-2"
);
check(
  "bloček medzi čakajúce faktúry nepatrí",
  isPending({ document_type: "receipt", custom_category_id: null }),
  false
);
check(
  "faktúra vo vlastnej zložke má svoj domov",
  isPending({ document_type: "invoice", custom_category_id: "kat-1" }),
  false
);
// Kto na faktúry nevidí, nedostane väzbu z RLS — a dokument sa mu zobrazí
// ako čakajúci. Je to správne: nedozvie sa z Inboxu nič o doklade, ktorý
// nesmie vidieť.
check(
  "bez viditeľnej väzby sa dokument tvári ako čakajúci",
  isPending({ document_type: "invoice", custom_category_id: null, document_links: [] }),
  true
);

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
