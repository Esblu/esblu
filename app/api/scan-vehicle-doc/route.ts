import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { normalizeSpz } from "@/lib/normalize-spz";
import { normalizeAndValidateWeights } from "@/lib/weight-utils";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { finalizeAiProcessing, guardAiProcessing } from "@/lib/entitlements-server";

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

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Rovnaký magic-byte vzor ako app/api/scan-vehicle-registration/route.ts —
// klientom deklarovaný Content-Type sa dá ľahko sfalšovať, skutočný obsah
// súboru nie. Pridané po security audite (scan-vehicle-doc mal doteraz iba
// slabšiu kontrolu `type.startsWith("image/")` bez allowlistu a bez overenia
// obsahu).
function hasValidImageSignature(bytes: Uint8Array, type: string) {
  if (type === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (type === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((value, index) => bytes[index] === value);
  }

  if (type === "image/webp") {
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }

  return false;
}

const AI_EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentType: {
      type: ["string", "null"],
      enum: ["vážny lístok", "dodací list", "other", null],
    },
    movementType: {
      type: ["string", "null"],
      enum: ["dovoz", "vývoz", null],
    },
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
    documentLanguage: {
      type: ["string", "null"],
      enum: ["sk", "cs", "de", "en", "iné", null],
    },
    confidenceScore: {
      type: ["number", "null"],
      minimum: 0,
      maximum: 1,
    },
    sourceLocation: { type: ["string", "null"] },
    destinationLocation: { type: ["string", "null"] },
    reviewStatus: {
      type: ["string", "null"],
      enum: ["confirmed", "needs_review", "pending", null],
    },
    quantity: { type: ["number", "null"], minimum: 0 },
    unit: { type: ["string", "null"], enum: ["kg", "t", null] },
    brutto: { type: ["number", "null"], minimum: 0 },
    tara: { type: ["number", "null"], minimum: 0 },
    netto: { type: ["number", "null"], minimum: 0 },
    documentDate: { type: ["string", "null"] },
    documentTime: { type: ["string", "null"] },
    rawText: { type: ["string", "null"] },
  },
  required: [
    "documentType",
    "movementType",
    "spz",
    "supplier",
    "customer",
    "constructionSite",
    "documentNumber",
    "material",
    "materialOriginal",
    "materialCategory",
    "documentLanguage",
    "confidenceScore",
    "sourceLocation",
    "destinationLocation",
    "reviewStatus",
    "quantity",
    "unit",
    "brutto",
    "tara",
    "netto",
    "documentDate",
    "documentTime",
    "rawText",
  ],
} as const;

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

const SPZ_FALLBACK_CONFIDENCE_THRESHOLD = 0.8;

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

const AI_EVIDENCE_PROMPT = `
Si asistent na čítanie firemných dokumentov zo Slovenska, Česka, Nemecka a
anglicky hovoriacich krajín. Prednostne spracúvaj vážne lístky a dodacie listy.
Iný typ označ ako "other". Nie si viazaný na konkrétnu firmu ani rozloženie.

ZÁSADA MAPOVANIA
- Pole neurčuj iba podľa pozície textu na stránke. Použi význam labelu, jeho
  susednú hodnotu, vizuálnu väzbu label -> hodnota a kontext dokumentu.
- Vždy uprednostni explicitný label a jeho hodnotu pred inferenciou.
- Nevymýšľaj chýbajúce hodnoty, názvy firiem, SPZ ani materiál. Pri neistote
  vráť null a nastav reviewStatus na "needs_review".
- Dopravca, vodič, vlastník vozidla ani stavba nie sú automaticky supplier alebo
  customer. movementType nikdy nepouži na prehodenie supplier a customer.

SPZ / EČV
- Hľadaj najmä pri labeloch: SPZ, EČV, Evidenčné číslo vozidla, Vozidlo;
  SPZ, RZ, Registrační značka; Kennzeichen, Kfz-Kennzeichen, Pol. Kennzeichen,
  Fahrzeug-Kennzeichen; License plate, Registration number, Vehicle registration.
- "Fahrzeug-Nr." použi iba vtedy, keď label, hodnota a kontext jasne ukazujú,
  že ide o registračnú značku, nie interné číslo vozidla.
- Uprednostni hodnotu pri explicitnom označení registračnej značky. Náhodný
  alfanumerický kód, číslo dokladu, zákazníka, objednávky, váženia alebo VIN
  nepovažuj za SPZ. Pri viacerých kódoch nevyberaj SPZ odhadom.
- Nehádať nečitateľné znaky O/0, I/1, B/8. Neistú alebo neúplnú SPZ vráť null.

CUSTOMER
- Mapuj iba firmu alebo osobu pri zákazníckej roli: Zákazník, Odberateľ,
  Príjemca; Zákazník, Odběratel, Příjemce; Kunde, Anlieferer / Kunde, Abnehmer,
  Empfänger; Customer, Client, Consignee, Recipient.
- Pri kombinovanom labele "Anlieferer / Kunde" mapuj názov firmy na customer,
  pokiaľ kontext jednoznačne neurčuje inú rolu.

SUPPLIER
- Mapuj vystavujúcu alebo dodávateľskú firmu pri labeloch: Dodávateľ,
  Predávajúci, Prevádzkovateľ váhy; Dodavatel, Prodejce; Lieferant, Lieferwerk,
  Betreiber, Abgeber; Supplier, Vendor, Seller.
- Jasne identifikovaná firma v hlavičke, ktorá dokument vystavila alebo
  prevádzkuje váhu, môže byť supplier. Ak jej rola nie je jasná, vráť null.

STAVBA / MIESTO / PÔVOD
- constructionSite hľadaj pri labeloch: Stavba, Miesto stavby, Pôvod, Miesto
  pôvodu, Prevádzka; Stavba, Místo stavby, Původ; Baustelle, Herkunft,
  Baustelle / Abfallerzeuger, Abfallerzeuger, Einsatzort; Construction site,
  Site, Origin, Source location, Job site.
- "Baustelle / Abfallerzeuger" typicky označuje stavbu, miesto alebo pôvod.
  Materiál nevkladaj do constructionSite iba preto, že je vytlačený blízko.

MATERIÁL
- Hľadaj pri labeloch: Materiál, Druh materiálu, Komodita, Produkt; Materiál,
  Druh materiálu, Produkt; Material, Sorte, Sorte Nr., Baustoff, Stoff,
  Abfallart; Material, Material type, Product, Commodity.
- materialOriginal je čo najpresnejší pôvodný názov z dokumentu.
- material musí zachovať konkrétnu identifikáciu materiálu. Ak dokument uvádza
  "AC 32 TS (B 50 / 70)", material nesmie byť iba "asfalt".
- materialCategory môže byť všeobecnejšia hodnota povolená schémou, ale nesmie
  nahradiť presný material ani materialOriginal.

ČÍSLO DOKLADU
- documentNumber hľadaj pri labeloch: Číslo dokladu, Číslo vážneho lístka,
  Dodací list č., Vážny lístok č.; Číslo dokladu, Váženka č., Dodací list č.;
  Lieferschein Nr., Lieferschein-Nr., Wiegeschein Nr., Beleg-Nr.; Document
  number, Ticket number, Weighbridge ticket number, Delivery note number.

HMOTNOSTI A MNOŽSTVO — KRITICKÉ PRAVIDLÁ
- brutto čítaj pri Brutto, Gross alebo Gross weight; tara pri Tara, Tare alebo
  Tare weight; netto pri Netto, Net alebo Net weight. Nezamieňaj tieto polia.
- quantity, brutto, tara a netto musia byť JSON číslo bez jednotky alebo null.
- unit je samostatne iba "kg", "t" alebo null. Čítaj ju priamo pri quantity
  alebo hmotnostiach; neodhaduj ju podľa veľkosti čísla ani iného kontextu.
- Hodnotu a jednotku neoddeľ spôsobom, ktorý zmení význam. Tisícové medzery
  odstráň a desatinnú čiarku interpretuj podľa kontextu dokumentu.
- Hodnoty nikdy nekonvertuj medzi kg a t.
- "Brutto 31 480 kg", "Tara 13 260 kg", "Netto 18 220 kg" znamená brutto
  31480, tara 13260, netto 18220 a unit "kg".
- "Netto 18,56 t" znamená netto 18.56 a unit "t". Nejednoznačné "1,000" bez
  dostatočného kontextu vráť ako null.
- Vytlačené netto zachovaj; nenahrádzaj ho vlastným výpočtom. Ak sú uvedené
  brutto, tara aj netto, skontroluj brutto - tara ≈ netto. Pri nesúlade hodnoty
  neopravuj a nastav reviewStatus na "needs_review".

DÁTUM, ČAS A OSTATNÉ POLIA
- documentDate a documentTime sú hlavný dátum a čas váženia, vystavenia alebo
  dodania. Uprednostni ich pred dátumom tlače, podpisu alebo technickým dátumom.
- documentDate vráť ako YYYY-MM-DD alebo null, documentTime ako HH:MM alebo null.
- movementType je "dovoz", "vývoz" alebo null.
- documentLanguage je jazyk dokumentu; confidenceScore je číslo 0 až 1 alebo null.
- rawText zachová čo najviac relevantného textu vrátane labelov a ich hodnôt,
  aby bolo možné výsledok neskôr manuálne skontrolovať.
- confirmed použi iba pri jasných a logicky súladných hlavných údajoch.
- needs_review použi pri nečitateľnosti, neistote, chýbajúcej jednotke pri
  hmotnosti alebo matematickom nesúlade.
`;

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseStructuredOutput(outputText: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(outputText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI vrátila neplatnú štruktúru odpovede.");
  }
  return parsed as Record<string, unknown>;
}

function normalizeAiEvidenceData(data: Record<string, unknown>) {
  const weights = normalizeAndValidateWeights({
    quantity: data.quantity,
    brutto: data.brutto,
    tara: data.tara,
    netto: data.netto,
    unit: data.unit,
  });

  const requestedReviewStatus = nullableText(data.reviewStatus);
  const reviewStatus = weights.needsReview
    ? "needs_review"
    : requestedReviewStatus || "pending";

  return {
    documentType: nullableText(data.documentType),
    movementType: nullableText(data.movementType),
    spz: normalizeSpz(data.spz),
    supplier: nullableText(data.supplier),
    customer: nullableText(data.customer),
    constructionSite: nullableText(data.constructionSite),
    documentNumber: nullableText(data.documentNumber),
    material: nullableText(data.material),
    materialOriginal: nullableText(data.materialOriginal),
    materialCategory: nullableText(data.materialCategory),
    documentLanguage: nullableText(data.documentLanguage),
    confidenceScore:
      typeof data.confidenceScore === "number" &&
      Number.isFinite(data.confidenceScore)
        ? data.confidenceScore
        : null,
    sourceLocation: nullableText(data.sourceLocation),
    destinationLocation: nullableText(data.destinationLocation),
    reviewStatus,
    quantity: weights.quantity,
    unit: weights.unit,
    brutto: weights.brutto,
    tara: weights.tara,
    netto: weights.netto,
    documentDate: nullableText(data.documentDate),
    documentTime: nullableText(data.documentTime),
    rawText: nullableText(data.rawText),
  };
}

export async function POST(req: Request) {
  try {
    const authorization = req.headers.get("authorization");
    const accessToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

    if (!accessToken) {
      return Response.json(
        { success: false, error: "Na AI spracovanie musíš byť prihlásený." },
        { status: 401 }
      );
    }

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(accessToken);

    if (authError || !user) {
      return Response.json(
        { success: false, error: "Prihlásenie vypršalo. Prihlás sa znova." },
        { status: 401 }
      );
    }

    const formData = await req.formData();
    const fileValue = formData.get("file");

    if (!(fileValue instanceof File)) {
      return Response.json(
        { success: false, error: "Nebola nahraná žiadna fotografia." },
        { status: 400 }
      );
    }

    if (fileValue.size === 0) {
      return Response.json(
        { success: false, error: "Nahraný súbor je prázdny." },
        { status: 400 }
      );
    }

    if (!ALLOWED_IMAGE_TYPES.has(fileValue.type)) {
      return Response.json(
        {
          success: false,
          error: "Nahrať je možné iba obrázok vo formáte JPEG, PNG alebo WebP.",
        },
        { status: 415 }
      );
    }

    if (fileValue.size > MAX_IMAGE_SIZE) {
      return Response.json(
        { success: false, error: "Obrázok môže mať najviac 10 MB." },
        { status: 413 }
      );
    }

    const fileBytes = new Uint8Array(await fileValue.arrayBuffer());

    if (!hasValidImageSignature(fileBytes, fileValue.type)) {
      return Response.json(
        { success: false, error: "Súbor nemá platný obsah obrázka." },
        { status: 400 }
      );
    }

    const base64Image = Buffer.from(fileBytes).toString("base64");
    const imageUrl = `data:${fileValue.type};base64,${base64Image}`;

    // Legacy endpoint (appka ho dnes nevolá — Inbox používa /api/scan-document).
    // Kým existuje, má rovnakú bránu: firma, abuse limit, AI kvóta/nárok.
    const db = getUserScopedSupabaseClient(accessToken);
    const guard = await guardAiProcessing(db, req, getRequestLocale(req), "scan-vehicle-doc", fileBytes);
    if (!guard.ok) return guard.response;

    let response;
    try {
      response = await client.responses.create({
      model: "gpt-5.6-terra",
      store: false,
      reasoning: { effort: "none" },
      text: {
        format: {
          type: "json_schema",
          name: "ai_evidence_document",
          strict: true,
          schema: AI_EVIDENCE_SCHEMA,
        },
      },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: AI_EVIDENCE_PROMPT },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        },
      ],
    });
    } catch (aiError) {
      await finalizeAiProcessing(db, guard.usageId, false);
      throw aiError;
    }
    await finalizeAiProcessing(db, guard.usageId, true);

    if (!response.output_text) {
      throw new Error("AI nevrátila žiadne štruktúrované údaje.");
    }

    const mainData = parseStructuredOutput(response.output_text);
    const mainSpzRaw = nullableText(mainData.spz);
    const mainSpzNormalized = normalizeSpz(mainSpzRaw);
    const vehicleData = normalizeAiEvidenceData(mainData);
    vehicleData.spz = mainSpzNormalized;

    let fallbackTriggered = false;
    let fallbackSpzRaw: string | null = null;
    let fallbackSpzNormalized: string | null = null;
    let fallbackEvidenceText: string | null = null;
    let fallbackConfidence: number | null = null;
    let spzSource: SpzSource = mainSpzNormalized ? "main" : "none";

    if (!mainSpzNormalized) {
      fallbackTriggered = true;
      vehicleData.reviewStatus = "needs_review";

      const spzResponse = await client.responses.create({
        model: "gpt-4.1",
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "vehicle_registration_fallback",
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
        const spzData = parseStructuredOutput(spzResponse.output_text);
        fallbackSpzRaw = nullableText(spzData.spz);
        fallbackSpzNormalized = normalizeSpz(fallbackSpzRaw);
        fallbackEvidenceText = nullableText(spzData.evidenceText);
        fallbackConfidence =
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

        if (canAcceptFallback) {
          vehicleData.spz = fallbackSpzNormalized;
          spzSource = "fallback";
        } else {
          vehicleData.spz = null;
          spzSource = "none";
        }
      } catch (spzError) {
        console.error("SPZ FALLBACK ERROR:", spzError);
        vehicleData.spz = null;
        spzSource = "none";
      }
    }

    if (process.env.NODE_ENV !== "production") {
      console.info("SPZ FALLBACK DEBUG", {
        mainSpzRaw,
        mainSpzNormalized,
        fallbackTriggered,
        fallbackSpzRaw,
        fallbackSpzNormalized,
        fallbackEvidenceText,
        fallbackConfidence,
        finalSpz: vehicleData.spz,
        spzSource,
      });
    }

    return Response.json({ success: true, data: vehicleData });
  } catch (error) {
    console.error("OPENAI ERROR:", error);
    return Response.json(
      { success: false, error: "AI spracovanie zlyhalo." },
      { status: 500 }
    );
  }
}
