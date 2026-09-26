import OpenAI from "openai";
import { isIntakeDocumentType, sealIntakeExtraction } from "@/lib/intake-seal";
import { createClient } from "@supabase/supabase-js";
import { normalizeSpz } from "@/lib/normalize-spz";
import { normalizeAndValidateWeights } from "@/lib/weight-utils";
import {
  entitlementDenialResponse,
  finalizeAiProcessing,
  reserveAiProcessing,
  resolveIdempotencyKey,
  sha256Hex,
} from "@/lib/entitlements-server";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";

// -----------------------------------------------------------------------------
// Univerzálny AI Inbox scan endpoint.
//
// Toto je NOVÝ, samostatný endpoint. Nemení a nevolá /api/scan-vehicle-doc.
// SPZ fallback logika nižšie je preto ZÁMERNE DUPLIKOVANÁ z toho endpointu
// (rovnaká schéma, rovnaký prah, rovnaká validácia dôkazu), namiesto
// refaktoru do zdieľaného helpera — akýkoľvek refaktor existujúceho,
// produkčného /api/scan-vehicle-doc by niesol regresné riziko pre AI
// Evidenciu, ktorá musí zostať bezo zmeny. Bezpečnosť existujúcej produkcie
// má prednosť pred DRY.
//
// Endpoint iba ANALYZUJE dokument a vracia výsledok. Nič sa tu neukladá do
// documents, neuploaduje do ai-inbox-documents, nevytvára document_links ani
// document_review_log — to je práca budúceho, samostatného save flow.
// -----------------------------------------------------------------------------

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabaseAuth = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// Rovnaký limit ako dnešný /api/scan-vehicle-doc.
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// PDF sa zámerne NEPRIJÍMA — pozri report bod J. Dnešný AI flow v projekte
// (scan-vehicle-doc aj scan-vehicle-registration) pracuje výhradne s
// input_image / data URL obrázkami, nikde v projekte nie je otestovaná ani
// implementovaná bezpečná PDF cesta (input_file a pod.). Vymýšľať ju tu by
// bolo v rozpore so zadaním.
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const ALLOWED_DOCUMENT_TYPES = [
  "weigh_ticket",
  "delivery_note",
  "invoice",
  "receipt",
  "insurance",
  "service_document",
  "other",
] as const;

type DocumentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];

// documentLanguage bol súčasťou pôvodnej ai_evidence schémy a audit zistil,
// že v prvej verzii tohto endpointu chýbal. Ide o jednoduché top-level
// nullable pole nezávislé od *Fields objektov, takže ho možno pridať bez
// komplikovania "presne jeden fields objekt" architektúry.
const ALLOWED_DOCUMENT_LANGUAGES = ["sk", "cz", "de", "en"] as const;

type DocumentLanguage = (typeof ALLOWED_DOCUMENT_LANGUAGES)[number];

// Konzervatívne prahy — pozri report bod G pre zdôvodnenie hodnôt.
const MAIN_CONFIDENCE_THRESHOLD = 0.7;
const CRITICAL_FIELD_CONFIDENCE_THRESHOLD = 0.6;
const SPZ_FALLBACK_CONFIDENCE_THRESHOLD = 0.8;

// Ktoré pole je pre daný typ dokumentu "kritické" na účely bodu 11
// ("dôležité pole má nízku confidence"). Prázdny zoznam = žiadne pole sa
// z tohto dôvodu osobitne nekontroluje pre daný typ.
const CRITICAL_FIELDS_BY_TYPE: Record<DocumentType, readonly string[]> = {
  weigh_ticket: ["netto"],
  delivery_note: [],
  invoice: ["totalAmount"],
  receipt: ["totalAmount"],
  insurance: ["policyNumber"],
  service_document: [],
  other: [],
};

const FIELDS_KEY_BY_TYPE: Record<DocumentType, string> = {
  weigh_ticket: "weighTicketFields",
  delivery_note: "deliveryNoteFields",
  invoice: "invoiceFields",
  receipt: "receiptFields",
  insurance: "insuranceFields",
  service_document: "serviceDocumentFields",
  other: "otherFields",
};

const ALL_FIELDS_KEYS = Object.values(FIELDS_KEY_BY_TYPE);

// -----------------------------------------------------------------------------
// Structured output schéma — vnorené fields objekty per typ dokumentu.
// Presne jeden z nich smie byť vyplnený; ostatné musia byť null. Toto
// pravidlo sa vynucuje promptom (nižšie) AJ server-side validáciou po parse
// (bod "3. STRUCTURED OUTPUT" zo zadania) — nikdy sa ticho neakceptuje
// nekonzistentný output.
// -----------------------------------------------------------------------------

const WEIGH_TICKET_FIELDS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    spz: { type: ["string", "null"] },
    supplier: { type: ["string", "null"] },
    customer: { type: ["string", "null"] },
    constructionSite: { type: ["string", "null"] },
    documentNumber: { type: ["string", "null"] },
    material: { type: ["string", "null"] },
    materialOriginal: { type: ["string", "null"] },
    materialCategory: {
      type: ["string", "null"],
      enum: [
        "piesok",
        "kamenivo",
        "asfalt",
        "stavebný odpad",
        "zemina",
        "betón",
        "iné",
        null,
      ],
    },
    movementType: { type: ["string", "null"], enum: ["dovoz", "vývoz", null] },
    quantity: { type: ["number", "null"], minimum: 0 },
    unit: { type: ["string", "null"], enum: ["kg", "t", null] },
    brutto: { type: ["number", "null"], minimum: 0 },
    tara: { type: ["number", "null"], minimum: 0 },
    netto: { type: ["number", "null"], minimum: 0 },
    documentDate: { type: ["string", "null"] },
    documentTime: { type: ["string", "null"] },
    sourceLocation: { type: ["string", "null"] },
    destinationLocation: { type: ["string", "null"] },
  },
  required: [
    "spz",
    "supplier",
    "customer",
    "constructionSite",
    "documentNumber",
    "material",
    "materialOriginal",
    "materialCategory",
    "movementType",
    "quantity",
    "unit",
    "brutto",
    "tara",
    "netto",
    "documentDate",
    "documentTime",
    "sourceLocation",
    "destinationLocation",
  ],
} as const;

const DELIVERY_NOTE_FIELDS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    spz: { type: ["string", "null"] },
    supplier: { type: ["string", "null"] },
    customer: { type: ["string", "null"] },
    constructionSite: { type: ["string", "null"] },
    documentNumber: { type: ["string", "null"] },
    material: { type: ["string", "null"] },
    quantity: { type: ["number", "null"], minimum: 0 },
    unit: { type: ["string", "null"], enum: ["kg", "t", null] },
    brutto: { type: ["number", "null"], minimum: 0 },
    tara: { type: ["number", "null"], minimum: 0 },
    netto: { type: ["number", "null"], minimum: 0 },
    documentDate: { type: ["string", "null"] },
    documentTime: { type: ["string", "null"] },
    sourceLocation: { type: ["string", "null"] },
    destinationLocation: { type: ["string", "null"] },
  },
  required: [
    "spz",
    "supplier",
    "customer",
    "constructionSite",
    "documentNumber",
    "material",
    "quantity",
    "unit",
    "brutto",
    "tara",
    "netto",
    "documentDate",
    "documentTime",
    "sourceLocation",
    "destinationLocation",
  ],
} as const;

// Riadková položka faktúry. VAT kategória a unit code sú NÁVRHY — model ich
// smie vyplniť len keď sú na doklade explicitne uvedené, a canonical zápis
// ich prevezme až po potvrdení používateľom (lib/invoicing/received-candidate.ts).
const INVOICE_LINE_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: ["string", "null"] },
    quantity: { type: ["number", "null"], minimum: 0 },
    unit: { type: ["string", "null"] },
    unitCode: { type: ["string", "null"] },
    unitPrice: { type: ["number", "null"], minimum: 0 },
    vatCategoryCode: { type: ["string", "null"], enum: ["S", "Z", "E", "AE", null] },
    vatRate: { type: ["number", "null"], minimum: 0 },
  },
  required: ["description", "quantity", "unit", "unitCode", "unitPrice", "vatCategoryCode", "vatRate"],
} as const;

const INVOICE_FIELDS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    supplier: { type: ["string", "null"] },
    supplierIco: { type: ["string", "null"] },
    supplierDic: { type: ["string", "null"] },
    supplierVatId: { type: ["string", "null"] },
    supplierAddress: { type: ["string", "null"] },
    supplierCity: { type: ["string", "null"] },
    supplierPostalCode: { type: ["string", "null"] },
    supplierCountryCode: { type: ["string", "null"] },
    supplierEmail: { type: ["string", "null"] },
    customer: { type: ["string", "null"] },
    customerIco: { type: ["string", "null"] },
    customerDic: { type: ["string", "null"] },
    customerVatId: { type: ["string", "null"] },
    customerAddress: { type: ["string", "null"] },
    customerCity: { type: ["string", "null"] },
    customerPostalCode: { type: ["string", "null"] },
    customerCountryCode: { type: ["string", "null"] },
    customerEmail: { type: ["string", "null"] },
    invoiceNumber: { type: ["string", "null"] },
    issueDate: { type: ["string", "null"] },
    dueDate: { type: ["string", "null"] },
    deliveryDate: { type: ["string", "null"] },
    taxPointDate: { type: ["string", "null"] },
    subtotalAmount: { type: ["number", "null"], minimum: 0 },
    totalAmount: { type: ["number", "null"], minimum: 0 },
    currency: { type: ["string", "null"] },
    vatAmount: { type: ["number", "null"], minimum: 0 },
    iban: { type: ["string", "null"] },
    bic: { type: ["string", "null"] },
    variableSymbol: { type: ["string", "null"] },
    paymentReference: { type: ["string", "null"] },
    buyerReference: { type: ["string", "null"] },
    purchaseOrderReference: { type: ["string", "null"] },
    lineItems: { type: ["array", "null"], items: INVOICE_LINE_ITEM_SCHEMA },
    description: { type: ["string", "null"] },
  },
  required: [
    "supplier",
    "supplierIco",
    "supplierDic",
    "supplierVatId",
    "supplierAddress",
    "supplierCity",
    "supplierPostalCode",
    "supplierCountryCode",
    "supplierEmail",
    "customer",
    "customerIco",
    "customerDic",
    "customerVatId",
    "customerAddress",
    "customerCity",
    "customerPostalCode",
    "customerCountryCode",
    "customerEmail",
    "invoiceNumber",
    "issueDate",
    "dueDate",
    "deliveryDate",
    "taxPointDate",
    "subtotalAmount",
    "totalAmount",
    "currency",
    "vatAmount",
    "iban",
    "bic",
    "variableSymbol",
    "paymentReference",
    "buyerReference",
    "purchaseOrderReference",
    "lineItems",
    "description",
  ],
} as const;

const RECEIPT_FIELDS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    merchant: { type: ["string", "null"] },
    purchaseDate: { type: ["string", "null"] },
    totalAmount: { type: ["number", "null"], minimum: 0 },
    currency: { type: ["string", "null"] },
    paymentMethod: { type: ["string", "null"] },
    category: { type: ["string", "null"] },
  },
  required: [
    "merchant",
    "purchaseDate",
    "totalAmount",
    "currency",
    "paymentMethod",
    "category",
  ],
} as const;

const INSURANCE_FIELDS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    provider: { type: ["string", "null"] },
    policyNumber: { type: ["string", "null"] },
    insuranceType: { type: ["string", "null"] },
    vehicleIdentifier: { type: ["string", "null"] },
    // VIN — samostatné pole (odlíšené od vehicleIdentifier/SPZ nižšie), aby
    // appka mohla PZP deterministicky spárovať s existujúcim vozidlom podľa
    // VIN ako prvej voľby (spoľahlivejší identifikátor než SPZ), presne ako
    // pri technickom preukaze. Pridané ako čisto ADITÍVNE rozšírenie schémy —
    // vehicleIdentifier ostáva bezo zmeny (naďalej SPZ/sériové číslo stroja).
    vin: { type: ["string", "null"] },
    validFrom: { type: ["string", "null"] },
    validTo: { type: ["string", "null"] },
    premiumAmount: { type: ["number", "null"], minimum: 0 },
    currency: { type: ["string", "null"] },
  },
  required: [
    "provider",
    "policyNumber",
    "insuranceType",
    "vehicleIdentifier",
    "vin",
    "validFrom",
    "validTo",
    "premiumAmount",
    "currency",
  ],
} as const;

const SERVICE_DOCUMENT_FIELDS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    provider: { type: ["string", "null"] },
    serviceDate: { type: ["string", "null"] },
    vehicleOrMachineIdentifier: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    cost: { type: ["number", "null"], minimum: 0 },
    currency: { type: ["string", "null"] },
    nextServiceDate: { type: ["string", "null"] },
  },
  required: [
    "provider",
    "serviceDate",
    "vehicleOrMachineIdentifier",
    "description",
    "cost",
    "currency",
    "nextServiceDate",
  ],
} as const;

const OTHER_FIELDS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    summary: { type: ["string", "null"] },
  },
  required: ["summary"],
} as const;

const FIELD_CONFIDENCE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      field: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["field", "confidence"],
  },
} as const;

const DOCUMENT_SCAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentType: {
      type: "string",
      enum: [...ALLOWED_DOCUMENT_TYPES],
    },
    confidenceScore: { type: ["number", "null"], minimum: 0, maximum: 1 },
    reviewStatus: {
      type: "string",
      enum: ["confirmed_candidate", "needs_review"],
    },
    rawText: { type: ["string", "null"] },
    documentLanguage: {
      type: ["string", "null"],
      enum: ["sk", "cz", "de", "en", null],
    },
    fieldConfidence: FIELD_CONFIDENCE_SCHEMA,
    weighTicketFields: WEIGH_TICKET_FIELDS_SCHEMA,
    deliveryNoteFields: DELIVERY_NOTE_FIELDS_SCHEMA,
    invoiceFields: INVOICE_FIELDS_SCHEMA,
    receiptFields: RECEIPT_FIELDS_SCHEMA,
    insuranceFields: INSURANCE_FIELDS_SCHEMA,
    serviceDocumentFields: SERVICE_DOCUMENT_FIELDS_SCHEMA,
    otherFields: OTHER_FIELDS_SCHEMA,
  },
  required: [
    "documentType",
    "confidenceScore",
    "reviewStatus",
    "rawText",
    "documentLanguage",
    "fieldConfidence",
    "weighTicketFields",
    "deliveryNoteFields",
    "invoiceFields",
    "receiptFields",
    "insuranceFields",
    "serviceDocumentFields",
    "otherFields",
  ],
} as const;

const DOCUMENT_SCAN_PROMPT = `
Si asistent na čítanie firemných dokumentov zo Slovenska, Česka, Nemecka a
anglicky hovoriacich krajín. Najprv urč typ dokumentu, potom vyplň IBA JEDEN
zodpovedajúci fields objekt. Nie si viazaný na konkrétnu firmu ani rozloženie.

TYPY DOKUMENTOV
- weigh_ticket: vážny lístok z váhy (brutto/tara/netto, SPZ vozidla).
- delivery_note: dodací list (materiál, množstvo, SPZ; môže byť aj bez
  uvedených hmotností).
- invoice: faktúra (dodávateľ, odberateľ, suma, splatnosť). Neurčuj, či je
  vydaná alebo prijatá — tvojou úlohou je len prečítať, kto je dodávateľ a
  kto odberateľ. O smere rozhoduje používateľ v aplikácii.
- receipt: pokladničný bloček (obchod, suma, dátum nákupu).
- insurance: poistná zmluva alebo poistný certifikát vozidla/stroja (PZP,
  havarijné poistenie a pod.) — poisťovňa, číslo zmluvy, platnosť, poistné.
- service_document: servisný doklad vozidla alebo stroja (fotografia/sken
  dokladu, nie interný formulár).
- other: dokument, ktorý jednoznačne nezapadá do žiadneho z vyššie uvedených.

KRITICKÉ PRAVIDLO — PRESNE JEDEN FIELDS OBJEKT
Vyplň iba ten fields objekt, ktorý zodpovedá documentType (weighTicketFields
pre weigh_ticket, deliveryNoteFields pre delivery_note, invoiceFields pre
invoice, receiptFields pre receipt, insuranceFields pre insurance,
serviceDocumentFields pre service_document, otherFields pre other). Všetkých
ostatných šesť fields objektov MUSÍ byť null. Nikdy nevypĺňaj viac než jeden
naraz.

ZÁSADA MAPOVANIA (platí pre všetky typy)
- Pole neurčuj iba podľa pozície textu na stránke. Použi význam labelu, jeho
  susednú hodnotu, vizuálnu väzbu label -> hodnota a kontext dokumentu.
- Vždy uprednostni explicitný label a jeho hodnotu pred inferenciou.
- Nevymýšľaj chýbajúce hodnoty, názvy firiem, SPZ ani materiál. Pri neistote
  vráť pre dané pole null.
- Dopravca, vodič, vlastník vozidla ani stavba nie sú automaticky supplier
  alebo customer.
- fieldConfidence vráť iba pre polia, ktoré si v zvolenom fields objekte
  skutočne vyplnil (nie pre polia s hodnotou null), s číslom 0 až 1
  vyjadrujúcim tvoju istotu pre dané konkrétne pole. Názov poľa v
  fieldConfidence musí presne zodpovedať názvu kľúča vo fields objekte
  (napr. "netto", "totalAmount", "supplier").

== WEIGH_TICKET a DELIVERY_NOTE — spoločné pravidlá ==
Nasledujúce sekcie (SPZ, CUSTOMER, SUPPLIER, STAVBA/MIESTO, MATERIÁL, ČÍSLO
DOKLADU, DÁTUM) platia pre oba typy rovnako, okrem toho, kde je výslovne
uvedené inak. delivery_note nemá vlastné polia materialOriginal,
materialCategory ani movementType — tie sa vypĺňajú iba pri weigh_ticket.

SPZ / EČV
- Hľadaj najmä pri labeloch: SPZ, EČV, Evidenčné číslo vozidla, Vozidlo;
  SPZ, RZ, Registrační značka; Kennzeichen, Kfz-Kennzeichen, Pol. Kennzeichen,
  Fahrzeug-Kennzeichen; License plate, Registration number, Vehicle registration.
- "Fahrzeug-Nr." nepovažuj automaticky za SPZ. Použi ho ako SPZ iba vtedy,
  keď label, hodnota a kontext jasne ukazujú, že ide o registračnú značku,
  nie o interné číslo vozidla.
- Uprednostni hodnotu pri explicitnom označení registračnej značky. Náhodný
  alfanumerický kód, číslo dokladu, zákazníka, objednávky, váženia alebo VIN
  nepovažuj za SPZ. Pri viacerých kódoch/číslach na dokumente SPZ nehádaj a
  nevyberaj odhadom.
- Nehádaj nečitateľné znaky O/0, I/1, B/8. Neistú alebo neúplnú SPZ vráť null.

CUSTOMER
- Mapuj iba firmu alebo osobu pri zákazníckej roli: Zákazník, Odberateľ,
  Príjemca; Zákazník, Odběratel, Příjemce; Kunde, Anlieferer / Kunde, Abnehmer,
  Empfänger; Customer, Client, Consignee, Recipient.
- Pri kombinovanom labele "Anlieferer / Kunde" mapuj názov firmy na customer,
  pokiaľ kontext jednoznačne neurčuje inú rolu.
- Rozšírený kombinovaný label "Abfallerzeuger / Abbruchfirma bzw.
  Anlieferer / Kunde (Name/Anschrift)" (typicky s poľom Name/Anschrift pod
  ním alebo vedľa neho) označuje rovnakú zákaznícku rolu ako samotné
  "Anlieferer / Kunde" — firmu/meno a adresu uvedené priamo pod alebo pri
  tomto labele čítaj ako customer, ak z kontextu dokumentu ide o
  zákazníka, príjemcu alebo objednávateľa. Mapuj podľa labelu a role, nie
  podľa toho, že hodnota je vizuálne vzdialenejšia od nadpisu alebo nižšie
  na strane.
- Ak sa tento (alebo iný zákaznícky) label opakuje vo viacerých stĺpcoch či
  blokoch dokumentu a iba jeden z nich je reálne vyplnený menom/adresou,
  použi ten vyplnený blok; prázdne opakovania labelu ignoruj.
- Firmu spárovanú s "Abfallerzeuger / Abbruchfirma bzw. Anlieferer / Kunde"
  nikdy nezamieňaj so supplierom ani s prevádzkovateľom váhy — ide o
  oddelené role aj keď sú na dokumente blízko seba.
- Rozlišuj dodávateľa a zákazníka podľa labelu a role, nikdy iba podľa toho,
  kde sú na dokumente vytlačení. movementType (dovoz/vývoz) nikdy nepoužívaj
  na prehodenie supplier a customer. Pri neistote, ku ktorej role firma pod
  labelom patrí, vráť customer null — nehádaj.

SUPPLIER
- Mapuj vystavujúcu alebo dodávateľskú firmu pri labeloch: Dodávateľ,
  Predávajúci, Prevádzkovateľ váhy; Dodavatel, Prodejce; Lieferant, Lieferwerk,
  Betreiber, Abgeber; Supplier, Vendor, Seller.
- Jasne identifikovaná firma v hlavičke, ktorá dokument vystavila alebo
  prevádzkuje váhu, môže byť supplier. Prevádzkovateľ váhy automaticky
  neznamená supplier ani customer — over rolu z kontextu. Ak rola nie je
  jasná, vráť null namiesto hádania.

STAVBA / MIESTO / PÔVOD
- constructionSite hľadaj pri labeloch: Stavba, Miesto stavby, Pôvod, Miesto
  pôvodu, Prevádzka; Stavba, Místo stavby, Původ; Baustelle, Herkunft,
  Baustelle / Abfallerzeuger, Abfallerzeuger, Einsatzort; Construction site,
  Site, Origin, Source location, Job site.
- constructionSite musí byť skutočná stavba alebo miesto zákazky.
  "Baustelle / Abfallerzeuger" typicky označuje stavbu, miesto alebo pôvod.
  Materiál ani názov produktu nevkladaj do constructionSite iba preto, že je
  vytlačený blízko. Pri neistote vráť null.

MATERIÁL
- Hľadaj pri labeloch: Materiál, Druh materiálu, Komodita, Produkt; Materiál,
  Druh materiálu, Produkt; Material, Sorte, Sorte Nr., Baustoff, Stoff,
  Abfallart; Material, Material type, Product, Commodity.
- material musí zachovať čo najkonkrétnejšiu identifikáciu materiálu. Ak
  dokument uvádza "AC 32 TS (B 50 / 70)", material nesmie byť skrátený na
  všeobecné "asfalt". Normalizuj iba tam, kde to nestráca význam.
- Iba pre weigh_ticket: materialOriginal je čo najpresnejší pôvodný názov z
  dokumentu (zachováva pôvodné znenie). materialCategory môže byť
  všeobecnejšia hodnota povolená schémou, ale nesmie nahradiť presný
  material ani materialOriginal.

ČÍSLO DOKLADU
- documentNumber hľadaj pri labeloch: Číslo dokladu, Číslo vážneho lístka,
  Dodací list č., Vážny lístok č.; Číslo dokladu, Váženka č., Dodací list č.;
  Lieferschein Nr., Lieferschein-Nr., Wiegeschein Nr., Beleg-Nr.; Document
  number, Ticket number, Weighbridge ticket number, Delivery note number.
  Hodnotu čítaj podľa labelu a susedného kontextu, nie podľa pevnej pozície.

HMOTNOSTI (weigh_ticket vždy, delivery_note iba ak sú reálne uvedené)
- brutto čítaj pri Brutto, Gross alebo Gross weight; tara pri Tara, Tare
  alebo Tare weight; netto pri Netto, Net alebo Net weight — rozlišuj ich
  podľa labelu, nikdy podľa poradia na dokumente. Nezamieňaj tieto polia.
- quantity, brutto, tara a netto musia byť JSON číslo bez jednotky alebo null.
- unit je samostatne iba "kg", "t" alebo null. Čítaj ju priamo pri quantity
  alebo hmotnostiach; neodhaduj ju podľa veľkosti čísla ani iného kontextu.
- Tisícové medzery odstráň a desatinnú čiarku alebo bodku interpretuj podľa
  kontextu dokumentu. Hodnoty nikdy nekonvertuj medzi kg a t (jednotku
  neprerátavaj potichu).
- "Brutto 31 480 kg", "Tara 13 260 kg", "Netto 18 220 kg" znamená brutto
  31480, tara 13260, netto 18220 a unit "kg".
- "Netto 18,56 t" znamená netto 18.56 a unit "t". Nejednoznačné "1,000" bez
  dostatočného kontextu vráť ako null.
- Vytlačené netto zachovaj; nenahrádzaj ho vlastným výpočtom. Pri neistote
  ktorejkoľvek hmotnosti vráť null namiesto odhadu — server-side validácia
  matematický súlad brutto/tara/netto skontroluje nezávisle.
- Dodací list bez uvedených hmotností je úplne v poriadku — nechaj tieto
  polia null, nie je to chyba ani dôvod znižovať istotu iných polí.

DÁTUM A ČAS
- documentDate a documentTime sú hlavný dátum a čas váženia alebo dodania,
  podľa hlavného dátumového labelu dokumentu. Neuprednostňuj automaticky
  dátum tlače, podpisu alebo generovania dokumentu, ak je na ňom jasne
  uvedený dátum váženia/dodania.
- documentDate vráť ako YYYY-MM-DD alebo null, documentTime ako HH:MM alebo
  null. Pri neistote, ktorý dátum je ten hlavný, vráť null.

MULTILINGUAL
Vyššie uvedené labely explicitne pokrývajú slovenčinu (SK), češtinu (CZ),
nemčinu (DE) aj angličtinu (EN). Dokument môže kombinovať viac jazykov
naraz — mapuj podľa významu labelu v ktoromkoľvek z týchto jazykov, nie iba
podľa toho, v akom jazyku je zvyšok dokumentu.

== INVOICE / RECEIPT / SERVICE_DOCUMENT ==
- issueDate, dueDate, purchaseDate, serviceDate, nextServiceDate vráť ako
  YYYY-MM-DD, alebo null pri nejednoznačnom dátume.
- totalAmount, vatAmount, cost vráť ako číslo bez symbolu meny, alebo null.
- currency vráť ako 3-písmenový kód (napr. EUR), iba ak je jednoznačne
  čitateľný, inak null.
- vehicleOrMachineIdentifier vráť iba ak dokument jasne odkazuje na
  konkrétne vozidlo (SPZ) alebo stroj (sériové číslo); inak null.

== INVOICE — STRANY ==
- supplier je ten, KTO doklad VYSTAVIL (dodávateľ, predávajúci, Lieferant,
  Supplier). customer je ten, KOMU je vystavený (odberateľ, príjemca faktúry,
  Kunde, Bill to).
- Rozlíš ich podľa labelu, nie podľa pozície na stránke a nie podľa toho,
  ktorý je vytlačený väčším písmom. Hlavička dokladu nie je automaticky
  dodávateľ.
- Ak sa z dokladu nedá jednoznačne určiť, ktorá strana je dodávateľ a ktorá
  odberateľ, vráť pre OBE strany null. Prehodené strany sú horšie než žiadne
  strany — používateľ by zaevidoval faktúru na nesprávneho partnera.
- supplierIco/customerIco je IČO (IČ, Company ID, Firmenbuchnummer).
  supplierDic/customerDic je DIČ (daňové identifikačné číslo).
  supplierVatId/customerVatId je IČ DPH / VAT ID / USt-IdNr. (spravidla
  začína kódom krajiny, napr. SK2020…, DE123…). Tieto tri polia NIKDY
  nezamieňaj — na SK doklade stoja bežne vedľa seba a líšia sa len labelom.
- supplierCountryCode/customerCountryCode vráť ako 2-písmenový ISO kód iba
  ak je krajina na doklade uvedená alebo jednoznačne vyplýva z adresy; inak
  null. Nikdy ho neodvodzuj z jazyka dokladu.

== INVOICE — ČÍSLA, DÁTUMY, PLATBA ==
- invoiceNumber je číslo dokladu tak, ako ho pridelil DODÁVATEĽ, presne v
  tvare, v akom je vytlačené (vrátane vedúcich núl a oddeľovačov).
- deliveryDate je dátum dodania, taxPointDate je dátum dodania na účely DPH
  (dátum zdaniteľného plnenia, DUZP, Leistungsdatum). Ak doklad uvádza len
  jeden z nich, vyplň len ten a druhý nechaj null.
- subtotalAmount je základ dane (suma bez DPH), vatAmount je DPH, totalAmount
  je suma na úhradu. Vráť len tie, ktoré sú na doklade skutočne vytlačené —
  chýbajúcu hodnotu NEDOPOČÍTAVAJ.
- iban a bic vráť iba ak sú na doklade uvedené. variableSymbol je SK/CZ
  variabilný symbol; paymentReference je referencia platby, ak je uvedená
  samostatne. buyerReference a purchaseOrderReference vráť iba ak doklad
  explicitne uvádza referenciu odberateľa / číslo objednávky.

== INVOICE — RIADKOVÉ POLOŽKY ==
- lineItems vyplň iba ak má doklad čitateľnú tabuľku položiek. Ak položky
  nie sú čitateľné, vráť null — jeden vymyslený súhrnný riadok je horší než
  žiadny, pretože vyzerá ako prečítaný údaj.
- description je text položky. quantity a unitPrice sú čísla bez jednotky a
  bez meny. unit je jednotka presne ako na doklade ("ks", "hod", "m3").
- unitCode vyplň IBA ak je na doklade vytlačený kanonický kód jednotky
  (napr. H87, HUR, MTQ). NIKDY ho neodvodzuj z textu v unit.
- vatCategoryCode vyplň IBA ak doklad kategóriu explicitne uvádza alebo je
  jednoznačná zo sadzby a sprievodného textu:
    S  = bežná zdaňovaná sadzba
    Z  = nulová sadzba
    E  = oslobodené od dane
    AE = prenesenie daňovej povinnosti (reverse charge, Reverse-Charge,
         "daň odvedie odberateľ")
  Pri akejkoľvek pochybnosti vráť null. Kategóriu DPH, právny dôvod
  oslobodenia ani dôvod prenesenia daňovej povinnosti NIKDY neurčuj sám —
  potvrdzuje ich používateľ.
- vatRate je percentuálna sadzba z dokladu ako číslo (napr. 23). Vyplň ju aj
  keď vatCategoryCode nevieš určiť. Sadzbu nikdy nevymýšľaj podľa krajiny.

== INSURANCE ==
- provider je názov poisťovne (napr. Allianz, Generali, Kooperativa); inak
  null.
- policyNumber je číslo poistnej zmluvy/certifikátu presne tak, ako je
  vytlačené (Číslo zmluvy, Číslo poistky, Policy number, Vertragsnummer);
  inak null.
- insuranceType je druh poistenia tak, ako je uvedený na dokumente (napr.
  "PZP", "havarijné poistenie", "Kasko"); nevymýšľaj skratku, ak nie je na
  dokumente uvedená.
- vehicleIdentifier vráť iba ak dokument jasne odkazuje na konkrétne
  vozidlo (SPZ) alebo stroj (sériové/výrobné číslo); inak null.
- vin vráť IBA ak je na dokumente jasne vytlačené identifikačné číslo
  vozidla (VIN / číslo karosérie, presne 17 znakov, písmená a čísla, bez
  písmen I/O/Q) — samostatne od vehicleIdentifier/SPZ vyššie; ak VIN na
  dokumente nie je uvedený alebo je nečitateľný, vráť null (nikdy si ho
  nevymýšľaj ani neodvodzuj z iného poľa).
- validFrom a validTo (platnosť poistenia "od"/"do") vráť ako YYYY-MM-DD,
  alebo null pri nejednoznačnom dátume.
- premiumAmount je výška poistného (celkové alebo splátka podľa toho, čo je
  na dokumente jasne označené ako suma poistného) ako číslo bez symbolu
  meny, alebo null. currency vráť ako 3-písmenový kód, iba ak je jednoznačne
  čitateľný, inak null.

VŠEOBECNÉ
- rawText zachová čo najviac relevantného textu vrátane labelov a hodnôt,
  aby bolo možné výsledok neskôr manuálne skontrolovať.
- documentLanguage je hlavný jazyk dokumentu: "sk", "cz", "de", "en" alebo
  null, ak sa nedá jednoznačne určiť.
- confidenceScore je tvoja celková istota (0 až 1) za celý dokument.
- reviewStatus je tvoj odhad ("confirmed_candidate" alebo "needs_review");
  server výsledok môže nezávisle prehodnotiť.
`;

// -----------------------------------------------------------------------------
// SPZ fallback — zámerne duplikované z /api/scan-vehicle-doc (pozri poznámku
// na začiatku súboru). Rovnaká schéma, rovnaký prah 0.8, rovnaká validácia
// explicitného dôkazu.
// -----------------------------------------------------------------------------

const SPZ_FALLBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    spz: { type: ["string", "null"] },
    evidenceText: { type: ["string", "null"] },
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
  required: ["spz", "evidenceText", "confidence"],
} as const;

const SPZ_EVIDENCE_LABEL_PATTERNS = [
  /\bspz\b/,
  /\becv\b/,
  /evidencne\s+cislo/,
  /\brz\b/,
  /registracni\s+znacka/,
  /\bkennzeichen\b/,
  /kfz[\s-]*kennzeichen/,
  /pol\.?\s*kennzeichen/,
  /fahrzeug[\s-]*kennzeichen/,
  /license\s+plate/,
  /registration\s+number/,
  /vehicle\s+registration/,
] as const;

type SpzSource = "main" | "fallback" | "none";

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitSpzEvidence(
  evidenceText: string | null,
  normalizedSpz: string | null
): boolean {
  if (!evidenceText || !normalizedSpz) return false;

  const normalizedEvidenceText = normalizeEvidenceText(evidenceText);
  const hasExplicitLabel = SPZ_EVIDENCE_LABEL_PATTERNS.some((pattern) =>
    pattern.test(normalizedEvidenceText)
  );
  const normalizedEvidenceValue = normalizeSpz(evidenceText);
  const containsCandidate =
    normalizedEvidenceValue?.includes(normalizedSpz) ?? false;

  return hasExplicitLabel && containsCandidate;
}

async function resolveSpzFallback(imageUrl: string): Promise<{
  spz: string | null;
  source: SpzSource;
}> {
  const spzResponse = await client.responses.create({
    model: "gpt-4.1",
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "document_spz_fallback",
        strict: true,
        schema: SPZ_FALLBACK_SCHEMA,
      },
    },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Nájdi iba celé evidenčné číslo vozidla, ktoré je priamo
viazané na explicitný label registračnej značky.

Hľadaj najmä tieto labely:
- SK: SPZ, EČV, Evidenčné číslo
- CZ: SPZ, RZ, Registrační značka
- DE: Kennzeichen, Kfz-Kennzeichen, Pol. Kennzeichen, Fahrzeug-Kennzeichen
- EN: License plate, Registration number, Vehicle registration

Fahrzeug-Nr. nie je automaticky SPZ. Číslo dokumentu, číslo zákazníka,
interné číslo vozidla ani VIN nie sú SPZ. Ak pri kandidátovi nie je explicitný
label alebo je väzba label -> hodnota nejasná, vráť spz null.

evidenceText musí obsahovať konkrétny label aj hodnotu presne tak, ako sú
viditeľné na dokumente, napríklad "Kennzeichen: AA-714KI". Ak takýto dôkaz
nemáš, vráť evidenceText null a spz null.

confidence je číslo 0 až 1 vyjadrujúce istotu, že kandidát je registračná
značka viazaná na explicitný label, nie iba istotu OCR čitateľnosti.`,
          },
          { type: "input_image", image_url: imageUrl, detail: "high" },
        ],
      },
    ],
  });

  try {
    const spzData = parseStructuredOutput(spzResponse.output_text ?? "");
    const fallbackSpzRaw = nullableText(spzData.spz);
    const fallbackSpzNormalized = normalizeSpz(fallbackSpzRaw);
    const fallbackEvidenceText = nullableText(spzData.evidenceText);
    const fallbackConfidence =
      typeof spzData.confidence === "number" &&
      Number.isFinite(spzData.confidence)
        ? spzData.confidence
        : null;

    const hasEvidence = hasExplicitSpzEvidence(
      fallbackEvidenceText,
      fallbackSpzNormalized
    );
    const canAcceptFallback =
      fallbackSpzNormalized !== null &&
      fallbackConfidence !== null &&
      fallbackConfidence >= SPZ_FALLBACK_CONFIDENCE_THRESHOLD &&
      hasEvidence;

    return canAcceptFallback
      ? { spz: fallbackSpzNormalized, source: "fallback" }
      : { spz: null, source: "none" };
  } catch (spzError) {
    console.error("DOCUMENT SCAN SPZ FALLBACK ERROR:", spzError);
    return { spz: null, source: "none" };
  }
}

// -----------------------------------------------------------------------------
// Server-side normalizácia a validácia po parse.
// -----------------------------------------------------------------------------

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toFiniteNumberOrNull(
  value: unknown,
  options?: { min?: number; max?: number }
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (options?.min !== undefined && value < options.min) return null;
  if (options?.max !== undefined && value > options.max) return null;
  return value;
}

function toDocumentLanguageOrNull(value: unknown): DocumentLanguage | null {
  return typeof value === "string" &&
    (ALLOWED_DOCUMENT_LANGUAGES as readonly string[]).includes(value)
    ? (value as DocumentLanguage)
    : null;
}

function parseStructuredOutput(outputText: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(outputText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI vrátila neplatnú štruktúru odpovede.");
  }
  return parsed as Record<string, unknown>;
}

type FieldConfidenceEntry = { field: string; confidence: number };

function normalizeFieldConfidence(value: unknown): FieldConfidenceEntry[] {
  if (!Array.isArray(value)) return [];

  const result: FieldConfidenceEntry[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;
    const field = nullableText(record.field);
    const confidence = toFiniteNumberOrNull(record.confidence, {
      min: 0,
      max: 1,
    });

    if (field !== null && confidence !== null) {
      result.push({ field, confidence });
    }
  }

  return result;
}

function getFieldConfidence(
  fieldConfidence: FieldConfidenceEntry[],
  fieldName: string
): number | null {
  const entry = fieldConfidence.find((item) => item.field === fieldName);
  return entry?.confidence ?? null;
}

function normalizeWeighTicketFields(data: Record<string, unknown>) {
  return {
    spz: normalizeSpz(data.spz),
    supplier: nullableText(data.supplier),
    customer: nullableText(data.customer),
    constructionSite: nullableText(data.constructionSite),
    documentNumber: nullableText(data.documentNumber),
    material: nullableText(data.material),
    materialOriginal: nullableText(data.materialOriginal),
    materialCategory: nullableText(data.materialCategory),
    movementType: nullableText(data.movementType),
    quantity: toFiniteNumberOrNull(data.quantity, { min: 0 }),
    unit: nullableText(data.unit),
    brutto: toFiniteNumberOrNull(data.brutto, { min: 0 }),
    tara: toFiniteNumberOrNull(data.tara, { min: 0 }),
    netto: toFiniteNumberOrNull(data.netto, { min: 0 }),
    documentDate: nullableText(data.documentDate),
    documentTime: nullableText(data.documentTime),
    sourceLocation: nullableText(data.sourceLocation),
    destinationLocation: nullableText(data.destinationLocation),
  };
}

function normalizeDeliveryNoteFields(data: Record<string, unknown>) {
  return {
    spz: normalizeSpz(data.spz),
    supplier: nullableText(data.supplier),
    customer: nullableText(data.customer),
    constructionSite: nullableText(data.constructionSite),
    documentNumber: nullableText(data.documentNumber),
    material: nullableText(data.material),
    quantity: toFiniteNumberOrNull(data.quantity, { min: 0 }),
    unit: nullableText(data.unit),
    brutto: toFiniteNumberOrNull(data.brutto, { min: 0 }),
    tara: toFiniteNumberOrNull(data.tara, { min: 0 }),
    netto: toFiniteNumberOrNull(data.netto, { min: 0 }),
    documentDate: nullableText(data.documentDate),
    documentTime: nullableText(data.documentTime),
    sourceLocation: nullableText(data.sourceLocation),
    destinationLocation: nullableText(data.destinationLocation),
  };
}

const ALLOWED_VAT_CATEGORY_CODES = new Set(["S", "Z", "E", "AE"]);

/** Poistka proti patologickému výstupu modelu (stovky riadkov na review). */
const MAX_INVOICE_LINE_ITEMS = 200;

/**
 * Normalizácia jedného riadku faktúry.
 *
 * vatCategoryCode sa prepustí IBA ak je to jedna zo štyroch kategórií, ktoré
 * canonical model pozná. Čokoľvek iné (vrátane kategórií z Peppol code listu,
 * ktoré Esblu zatiaľ nepodporuje) sa zahodí na null — návrh mimo nášho
 * modelu je horší než žiadny návrh, lebo by používateľa tlačil potvrdiť
 * hodnotu, ktorú DB aj tak odmietne.
 *
 * Riadok bez popisu sa zahodí celý: prázdny riadok v review obrazovke je
 * práca navyše, nie informácia.
 */
function normalizeInvoiceLineItems(raw: unknown) {
  if (!Array.isArray(raw)) return null;

  const items = raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const description = nullableText(row.description);
      if (!description) return null;

      const rawCategory = nullableText(row.vatCategoryCode)?.toUpperCase() ?? null;

      return {
        description,
        quantity: toFiniteNumberOrNull(row.quantity, { min: 0 }),
        unit: nullableText(row.unit),
        unitCode: nullableText(row.unitCode),
        unitPrice: toFiniteNumberOrNull(row.unitPrice, { min: 0 }),
        vatCategoryCode:
          rawCategory && ALLOWED_VAT_CATEGORY_CODES.has(rawCategory) ? rawCategory : null,
        vatRate: toFiniteNumberOrNull(row.vatRate, { min: 0 }),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return items.slice(0, MAX_INVOICE_LINE_ITEMS);
}

function normalizeInvoiceFields(data: Record<string, unknown>) {
  return {
    supplier: nullableText(data.supplier),
    supplierIco: nullableText(data.supplierIco),
    supplierDic: nullableText(data.supplierDic),
    supplierVatId: nullableText(data.supplierVatId),
    supplierAddress: nullableText(data.supplierAddress),
    supplierCity: nullableText(data.supplierCity),
    supplierPostalCode: nullableText(data.supplierPostalCode),
    supplierCountryCode: nullableText(data.supplierCountryCode),
    supplierEmail: nullableText(data.supplierEmail),
    customer: nullableText(data.customer),
    customerIco: nullableText(data.customerIco),
    customerDic: nullableText(data.customerDic),
    customerVatId: nullableText(data.customerVatId),
    customerAddress: nullableText(data.customerAddress),
    customerCity: nullableText(data.customerCity),
    customerPostalCode: nullableText(data.customerPostalCode),
    customerCountryCode: nullableText(data.customerCountryCode),
    customerEmail: nullableText(data.customerEmail),
    invoiceNumber: nullableText(data.invoiceNumber),
    issueDate: nullableText(data.issueDate),
    dueDate: nullableText(data.dueDate),
    deliveryDate: nullableText(data.deliveryDate),
    taxPointDate: nullableText(data.taxPointDate),
    subtotalAmount: toFiniteNumberOrNull(data.subtotalAmount, { min: 0 }),
    totalAmount: toFiniteNumberOrNull(data.totalAmount, { min: 0 }),
    currency: nullableText(data.currency),
    vatAmount: toFiniteNumberOrNull(data.vatAmount, { min: 0 }),
    iban: nullableText(data.iban),
    bic: nullableText(data.bic),
    variableSymbol: nullableText(data.variableSymbol),
    paymentReference: nullableText(data.paymentReference),
    buyerReference: nullableText(data.buyerReference),
    purchaseOrderReference: nullableText(data.purchaseOrderReference),
    lineItems: normalizeInvoiceLineItems(data.lineItems),
    description: nullableText(data.description),
  };
}

function normalizeReceiptFields(data: Record<string, unknown>) {
  return {
    merchant: nullableText(data.merchant),
    purchaseDate: nullableText(data.purchaseDate),
    totalAmount: toFiniteNumberOrNull(data.totalAmount, { min: 0 }),
    currency: nullableText(data.currency),
    paymentMethod: nullableText(data.paymentMethod),
    category: nullableText(data.category),
  };
}

function normalizeInsuranceFields(data: Record<string, unknown>) {
  return {
    provider: nullableText(data.provider),
    policyNumber: nullableText(data.policyNumber),
    insuranceType: nullableText(data.insuranceType),
    vehicleIdentifier: nullableText(data.vehicleIdentifier),
    vin: nullableText(data.vin),
    validFrom: nullableText(data.validFrom),
    validTo: nullableText(data.validTo),
    premiumAmount: toFiniteNumberOrNull(data.premiumAmount, { min: 0 }),
    currency: nullableText(data.currency),
  };
}

function normalizeServiceDocumentFields(data: Record<string, unknown>) {
  return {
    provider: nullableText(data.provider),
    serviceDate: nullableText(data.serviceDate),
    vehicleOrMachineIdentifier: nullableText(data.vehicleOrMachineIdentifier),
    description: nullableText(data.description),
    cost: toFiniteNumberOrNull(data.cost, { min: 0 }),
    currency: nullableText(data.currency),
    nextServiceDate: nullableText(data.nextServiceDate),
  };
}

function normalizeOtherFields(data: Record<string, unknown>) {
  return {
    summary: nullableText(data.summary),
  };
}

function isAllowedDocumentType(value: unknown): value is DocumentType {
  return (
    typeof value === "string" &&
    (ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(value)
  );
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  try {
    // 1) Autentifikácia MUSÍ prebehnúť pred akýmkoľvek OpenAI volaním.
    const authorization = req.headers.get("authorization");
    const accessToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

    if (!accessToken) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.aiProcessingLoginRequired"),
        },
        { status: 401 }
      );
    }

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(accessToken);

    if (authError || !user) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.sessionExpired"),
        },
        { status: 401 }
      );
    }

    // 1b) Firemný kontext + abuse guard — MUSÍ prebehnúť pred nahratím
    // obsahu do pamäte aj pred akýmkoľvek OpenAI volaním.
    //
    // Platný token sám osebe doteraz stačil na neobmedzené volanie drahého AI
    // endpointu: route overovala iba to, že JWT je platný, nie že používateľ
    // má aktívne členstvo vo firme.
    //
    // esblu_consume_ai_scan_quota() rieši oboje naraz a fail-closed:
    //   • odvodí company_id z auth.uid() — NIKDY ho nepreberá od volajúceho,
    //   • bez aktívneho členstva vyhodí ESBLU_NO_ACTIVE_COMPANY,
    //   • atomicky (pg_advisory_xact_lock) započíta volanie a nad technickým
    //     stropom vyhodí ESBLU_AI_SCAN_RATE_LIMIT.
    //
    // Klient sa volá s tokenom používateľa (nie service_role), takže RLS a
    // SECURITY DEFINER kontroly platia rovnako ako v /api/invoices/[id]/pdf.
    const userClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      }
    );

    const { error: quotaError } = await userClient.rpc("esblu_consume_ai_scan_quota", {
      p_endpoint: "scan-document",
    });

    if (quotaError) {
      const message = `${quotaError.message ?? ""} ${quotaError.hint ?? ""}`;

      if (message.includes("ESBLU_AI_SCAN_RATE_LIMIT")) {
        return Response.json(
          {
            success: false,
            error: translate(locale, "inbox.errors.scanRateLimited"),
          },
          { status: 429 }
        );
      }

      if (
        message.includes("ESBLU_NO_ACTIVE_COMPANY") ||
        message.includes("ESBLU_NOT_AUTHENTICATED")
      ) {
        return Response.json(
          {
            success: false,
            error: translate(locale, "inbox.errors.scanNoActiveCompany"),
          },
          { status: 403 }
        );
      }

      // Neznáma chyba guardu = fail-closed. Nikdy nepokračovať k OpenAI len
      // preto, že sa kontrola nepodarila vyhodnotiť.
      console.error("scan-document: abuse guard zlyhal:", quotaError.code, quotaError.message);
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.scanFailedGeneric"),
        },
        { status: 503 }
      );
    }

    // 2) Validácia vstupu — až po overení používateľa a firemného kontextu.
    const formData = await req.formData();
    const imageValue = formData.get("image");

    if (!(imageValue instanceof File)) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.noImageUploaded"),
        },
        { status: 400 }
      );
    }

    if (!ALLOWED_MIME_TYPES.has(imageValue.type)) {
      return Response.json(
        {
          success: false,
          error: translate(
            locale,
            "inbox.errors.unsupportedImageFormatPdfNote"
          ),
        },
        { status: 400 }
      );
    }

    if (imageValue.size > MAX_IMAGE_SIZE) {
      return Response.json(
        {
          success: false,
          error: translate(locale, "inbox.errors.imageTooLarge10MB"),
        },
        { status: 413 }
      );
    }

    const imageBytes = await imageValue.arrayBuffer();
    const base64Image = Buffer.from(imageBytes).toString("base64");
    const imageUrl = `data:${imageValue.type};base64,${base64Image}`;

    // 2b) AI spracovanie je kvóta/nárok firmy (ai_documents): 14-dňový trial
    //     = 5 spracovaní spolu, potom iba s aktívnym modulom. Rezervuje sa
    //     AŽ TU — po autentifikácii, firme a validácii vstupu, tesne pred
    //     prvým volaním modelu. Retry s rovnakým Idempotency-Key a rovnakým
    //     obsahom nespotrebuje ďalší kredit. Uloženie dokumentu bez AI sa
    //     nepočíta a zmazanie dokumentu kredit nevracia (ledger v DB).
    const reservation = await reserveAiProcessing(
      userClient,
      "scan-document",
      resolveIdempotencyKey(req),
      await sha256Hex(imageBytes)
    );
    if (!reservation.ok) {
      if (reservation.denial) return entitlementDenialResponse(locale, reservation.denial);
      console.error("scan-document: rezervácia AI spracovania zlyhala:", reservation.code ?? "unknown");
      return Response.json(
        { success: false, error: translate(locale, "inbox.errors.scanFailedGeneric") },
        { status: reservation.code === "ESBLU_AI_IDEMPOTENCY_CONFLICT" ? 409 : 503 }
      );
    }

    // 3) Hlavné AI volanie — klasifikácia + extrakcia v jednom kroku.
    //    Zlyhanie modelu (bez odpovede) sa neúčtuje; odpoveď modelu sa
    //    účtuje aj vtedy, ak ju ďalej odmietne validácia (AI už prebehlo).
    let response: Awaited<ReturnType<typeof client.responses.create>>;
    try {
      response = await client.responses.create({
        model: "gpt-5.6-terra",
        store: false,
        reasoning: { effort: "none" },
        text: {
          format: {
            type: "json_schema",
            name: "document_scan",
            strict: true,
            schema: DOCUMENT_SCAN_SCHEMA,
          },
        },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: DOCUMENT_SCAN_PROMPT },
              { type: "input_image", image_url: imageUrl, detail: "high" },
            ],
          },
        ],
      });
    } catch (aiError) {
      await finalizeAiProcessing(userClient, reservation.usageId, false);
      throw aiError;
    }
    await finalizeAiProcessing(userClient, reservation.usageId, true);

    if (!response.output_text) {
      throw new Error("AI nevrátila žiadne štruktúrované údaje.");
    }

    const rawData = parseStructuredOutput(response.output_text);

    // 4) Defenzívna validácia documentType (schéma by ju už mala garantovať,
    // ale nikdy sa ticho nespolieha iba na to).
    if (!isAllowedDocumentType(rawData.documentType)) {
      return Response.json(
        {
          success: false,
          error: "AI_INCONSISTENT_OUTPUT",
          message: translate(locale, "inbox.errors.aiUnknownDocumentType"),
        },
        { status: 422 }
      );
    }

    const documentType = rawData.documentType;
    const expectedFieldsKey = FIELDS_KEY_BY_TYPE[documentType];

    // 5) Presne jeden fields objekt smie byť vyplnený a musí zodpovedať
    // documentType. Nekonzistentný output sa nikdy ticho neakceptuje.
    const filledFieldsKeys = ALL_FIELDS_KEYS.filter(
      (key) => rawData[key] !== null && rawData[key] !== undefined
    );

    if (filledFieldsKeys.length > 1) {
      return Response.json(
        {
          success: false,
          error: "AI_INCONSISTENT_OUTPUT",
          message: translate(locale, "inbox.errors.aiMultipleFieldsFilled"),
        },
        { status: 422 }
      );
    }

    if (
      filledFieldsKeys.length === 1 &&
      filledFieldsKeys[0] !== expectedFieldsKey
    ) {
      return Response.json(
        {
          success: false,
          error: "AI_INCONSISTENT_OUTPUT",
          message: translate(locale, "inbox.errors.aiFieldsMismatchType"),
        },
        { status: 422 }
      );
    }

    const zeroFieldsFilled = filledFieldsKeys.length === 0;

    // 6) Normalizácia — čísla musia byť finite, confidence 0..1, prázdne
    // stringy sa menia na null.
    const confidenceScore = toFiniteNumberOrNull(rawData.confidenceScore, {
      min: 0,
      max: 1,
    });
    const rawText = nullableText(rawData.rawText);
    const documentLanguage = toDocumentLanguageOrNull(rawData.documentLanguage);
    const fieldConfidence = normalizeFieldConfidence(rawData.fieldConfidence);

    let weighTicketFields =
      documentType === "weigh_ticket"
        ? normalizeWeighTicketFields(
            (rawData.weighTicketFields as Record<string, unknown>) ?? {}
          )
        : null;
    let deliveryNoteFields =
      documentType === "delivery_note"
        ? normalizeDeliveryNoteFields(
            (rawData.deliveryNoteFields as Record<string, unknown>) ?? {}
          )
        : null;
    const invoiceFields =
      documentType === "invoice"
        ? normalizeInvoiceFields(
            (rawData.invoiceFields as Record<string, unknown>) ?? {}
          )
        : null;
    const receiptFields =
      documentType === "receipt"
        ? normalizeReceiptFields(
            (rawData.receiptFields as Record<string, unknown>) ?? {}
          )
        : null;
    const insuranceFields =
      documentType === "insurance"
        ? normalizeInsuranceFields(
            (rawData.insuranceFields as Record<string, unknown>) ?? {}
          )
        : null;
    const serviceDocumentFields =
      documentType === "service_document"
        ? normalizeServiceDocumentFields(
            (rawData.serviceDocumentFields as Record<string, unknown>) ?? {}
          )
        : null;
    const otherFields =
      documentType === "other"
        ? normalizeOtherFields(
            (rawData.otherFields as Record<string, unknown>) ?? {}
          )
        : null;

    // 7) Weight validation — iba weigh_ticket vždy; delivery_note iba ak sú
    // reálne prítomné hmotnostné hodnoty (dodací list bez váh sa nesmie
    // penalizovať).
    let weightNeedsReview = false;

    if (documentType === "weigh_ticket" && weighTicketFields) {
      const weights = normalizeAndValidateWeights({
        quantity: weighTicketFields.quantity,
        brutto: weighTicketFields.brutto,
        tara: weighTicketFields.tara,
        netto: weighTicketFields.netto,
        unit: weighTicketFields.unit,
      });

      weighTicketFields = {
        ...weighTicketFields,
        quantity: weights.quantity,
        brutto: weights.brutto,
        tara: weights.tara,
        netto: weights.netto,
        unit: weights.unit,
      };
      weightNeedsReview = weights.needsReview;
    }

    if (documentType === "delivery_note" && deliveryNoteFields) {
      const hasWeightValue =
        deliveryNoteFields.quantity !== null ||
        deliveryNoteFields.brutto !== null ||
        deliveryNoteFields.tara !== null ||
        deliveryNoteFields.netto !== null;

      if (hasWeightValue) {
        const weights = normalizeAndValidateWeights({
          quantity: deliveryNoteFields.quantity,
          brutto: deliveryNoteFields.brutto,
          tara: deliveryNoteFields.tara,
          netto: deliveryNoteFields.netto,
          unit: deliveryNoteFields.unit,
        });

        deliveryNoteFields = {
          ...deliveryNoteFields,
          quantity: weights.quantity,
          brutto: weights.brutto,
          tara: weights.tara,
          netto: weights.netto,
          unit: weights.unit,
        };
        weightNeedsReview = weights.needsReview;
      }
    }

    // 8) SPZ fallback — iba pre weigh_ticket/delivery_note, iba ak hlavný
    // model SPZ nenašiel, rovnaký prah 0.8 ako dnešný scan-vehicle-doc.
    let spzSource: SpzSource = "none";

    if (documentType === "weigh_ticket" && weighTicketFields) {
      spzSource = weighTicketFields.spz ? "main" : "none";

      if (!weighTicketFields.spz) {
        const fallback = await resolveSpzFallback(imageUrl);
        weighTicketFields = { ...weighTicketFields, spz: fallback.spz };
        spzSource = fallback.source;
      }
    }

    if (documentType === "delivery_note" && deliveryNoteFields) {
      spzSource = deliveryNoteFields.spz ? "main" : "none";

      if (!deliveryNoteFields.spz) {
        const fallback = await resolveSpzFallback(imageUrl);
        deliveryNoteFields = { ...deliveryNoteFields, spz: fallback.spz };
        spzSource = fallback.source;
      }
    }

    // 9) Kontrola dôležitého poľa s nízkou confidence.
    const activeFields =
      weighTicketFields ??
      deliveryNoteFields ??
      invoiceFields ??
      receiptFields ??
      insuranceFields ??
      serviceDocumentFields ??
      otherFields;

    const criticalFieldLowConfidence = CRITICAL_FIELDS_BY_TYPE[
      documentType
    ].some((fieldName) => {
      const value = (activeFields as Record<string, unknown> | null)?.[
        fieldName
      ];
      if (value === null || value === undefined) return false;

      const fieldScore = getFieldConfidence(fieldConfidence, fieldName);
      return fieldScore === null || fieldScore < CRITICAL_FIELD_CONFIDENCE_THRESHOLD;
    });

    // 10) Server-side autoritatívny reviewStatus — nikdy sa nespolieha iba
    // na to, čo si o sebe myslel model.
    const needsReview =
      confidenceScore === null ||
      confidenceScore < MAIN_CONFIDENCE_THRESHOLD ||
      documentType === "other" ||
      weightNeedsReview ||
      zeroFieldsFilled ||
      criticalFieldLowConfidence;

    const reviewStatus = needsReview ? "needs_review" : "confirmed_candidate";

    if (process.env.NODE_ENV !== "production") {
      console.info("DOCUMENT SCAN DEBUG", {
        documentType,
        documentLanguage,
        confidenceScore,
        reviewStatus,
        zeroFieldsFilled,
        weightNeedsReview,
        criticalFieldLowConfidence,
        spzSource,
      });
    }

    // ---------------------------------------------------------------------
    // 11) Príjem finančného dokladu BEZ čítania.
    //
    // Kto nemá finance.view (zamestnanec, admin bez financií), smie bloček,
    // faktúru či dodací list odoslať na spracovanie, ale nesmie vidieť ich
    // obsah — ani vyťažený z vlastnej fotky. Údaje preto neodchádzajú v
    // čitateľnej podobe: zapečatia sa (lib/intake-seal.ts) a uloží ich až
    // /api/inbox/intake pod identitou používateľa. Klient dostane iba typ.
    // ---------------------------------------------------------------------
    if (isIntakeDocumentType(documentType)) {
      const { data: financeView } = await userClient.rpc("esblu_my_finance_view");
      if (financeView !== true) {
        const sealedExtraction = sealIntakeExtraction(
          {
            documentType,
            confidenceScore,
            reviewStatus,
            rawText,
            documentLanguage,
            fieldConfidence,
            fields: (invoiceFields ?? receiptFields ?? deliveryNoteFields ?? null) as Record<string, unknown> | null,
          },
          user.id
        );
        return Response.json({
          success: true,
          data: { documentType, intakeOnly: true, sealedExtraction },
        });
      }
    }

    return Response.json({
      success: true,
      data: {
        documentType,
        confidenceScore,
        reviewStatus,
        rawText,
        documentLanguage,
        fieldConfidence,
        weighTicketFields,
        deliveryNoteFields,
        invoiceFields,
        receiptFields,
        insuranceFields,
        serviceDocumentFields,
        otherFields,
      },
    });
  } catch (error) {
    console.error("DOCUMENT SCAN ERROR:", error);
    return Response.json(
      {
        success: false,
        error: translate(locale, "inbox.errors.scanFailedGeneric"),
      },
      { status: 500 }
    );
  }
}
