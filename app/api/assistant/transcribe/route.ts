import OpenAI from "openai";
import { verifyRequestUser } from "@/lib/server-auth";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { MAX_AUDIO_SIZE_BYTES, ALLOWED_VOICE_AUDIO_MIME_TYPES } from "@/lib/voice-config";

// -----------------------------------------------------------------------------
// POST /api/assistant/transcribe
//
// Prevádza nahraný hlasový záznam na text — TENKÁ vstupná vrstva NAD
// existujúcim Intent Enginom (zadanie, sekcia B/G): "VOICE → audio input →
// speech-to-text transcript → EXISTUJÚCI textový Intent Engine → permission
// check → allowlisted handler". Tento endpoint SÁM osebe nič
// neinterpretuje, nevykonáva žiadny intent, nevolá parseIntentDeterministic
// ani executeIntent — vracia VÝHRADNE holý prepis textu. Klient
// (app/components/Dashboard.tsx) potom tento text vloží do PRESNE TOHO
// ISTÉHO textového vstupného poľa/flow ako pri písaní (rovnaký POST
// /api/assistant/intent), takže hlas NIKDY neobchádza
// parser/allowlist/RLS — nie je to nový, paralelný hlasový intent systém.
//
// PRIVACY/BEZPEČNOSŤ (zadanie, sekcia D):
//  - žiadne dlhodobé ukladanie audia — spracúva sa VÝHRADNE in-memory počas
//    tohto jedného requestu (Buffer v pamäti servera), nikde sa neukladá do
//    Storage/DB/logov, žiadny audio URL sa nikde neperzistuje;
//  - žiadny prepis (transkript) sa tu tiež neukladá — vracia sa iba v
//    HTTP odpovedi tohto jedného requestu (appka ho následne posiela ako
//    obyčajný text do /api/assistant/intent, presne ako pri písaní);
//  - žiadny client-side OpenAI kľúč — volanie beží VÝHRADNE tu, na
//    serveri (rovnaký vzor ako app/api/scan-document, app/api/scan-vehicle-doc);
//  - MIME allowlist + max veľkosť súboru (lib/voice-config.ts) — appka dnes
//    nemá vlastnú rate-limiting infraštruktúru (overené: `grep -rniE
//    "rate.?limit"` naprieč lib/ a app/ nenašiel nič), toto je najbližší
//    existujúci precedens (MAX_IMAGE_SIZE v app/api/scan-document/route.ts);
//  - transkripčný endpoint OpenAI SDK (`audio.transcriptions.create`) NEMÁ
//    `store` parameter (overené v nainštalovaných TypeScript typoch balíka
//    `openai`, resources/audio/transcriptions.ts) — na rozdiel od Responses
//    API použitého v lib/intents/ai-fallback.ts a app/api/scan-document,
//    kde `store: false` je explicitné. Tu preto NIE JE aplikovateľné —
//    čestne zaznamenané v reporte namiesto tichého vynechania.
//
// PRESNOSŤ TRANSKRIPCIE (audit tejto verzie — nainštalovaný balík `openai`
// v6.45.0, resources/audio/transcriptions.ts / audio.ts):
//  - MODEL: nainštalované SDK typy (AudioModel) potvrdzujú presne tieto
//    transkripčné modely: 'whisper-1' | 'gpt-4o-transcribe' |
//    'gpt-4o-mini-transcribe' | 'gpt-4o-mini-transcribe-2025-12-15' |
//    'gpt-4o-transcribe-diarize'. Model s názvom "gpt-transcribe" (bez
//    "4o") NEEXISTUJE — appka predtým používala 'gpt-4o-mini-transcribe'
//    (rýchlejší/lacnejší "mini" variant); teraz prešla na plnohodnotný
//    'gpt-4o-transcribe' (rovnaký "4o" vs "4o-mini" vzor ako pri ostatných
//    OpenAI modeloch appky) — pre appku, kde presnosť hlasových príkazov
//    (ŠPZ, STK/EK/PZP skratky) je dôležitejšia než minimálny rozdiel v
//    cene/latencii jedného krátkeho (max. 20s) príkazu.
//  - LANGUAGE HINT: SDK dokumentácia priamo pri `language` parametri
//    (transcriptions.ts) uvádza: "Supplying the input language in
//    ISO-639-1 format will improve accuracy and latency." — appka preto
//    naďalej posiela `language: locale` (sk/de/en), NIE auto-detect.
//  - PROMPT/CONTEXT: `prompt` parameter JE podporovaný pre
//    'gpt-4o-transcribe' (SDK komentár: "This field is not supported when
//    using gpt-4o-transcribe-diarize" — teda pre bežný non-diarize model
//    JE podporovaný). Appka preto posiela krátky, doménovo-neutrálny
//    kontext Esblu (pozri DOMAIN_CONTEXT_PROMPT_BY_LOCALE nižšie) — ŽIADNE
//    konkrétne firemné/používateľské dáta z DB, iba všeobecné doménové
//    výrazy appky.
// -----------------------------------------------------------------------------

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Prompt pre OpenAI transcription `prompt` parameter (zadanie, dodatok bod
// 7) — PRIMÁRNY cieľ je explicitne vynútiť ÚPLNÝ, doslovný prepis celej
// vety, NIE extrakciu kľúčových slov. Toto je zámerne PRVÁ vec v prompte:
// speech-to-text vrstva NIE JE intent classifier (dodatok bod 1) — o tom,
// čo transcript ZNAMENÁ, rozhoduje výhradne existujúci Intent Engine
// (parser + AI fallback klasifikátor), nikdy transkripčný model. Doménový
// slovník je zámerne AŽ DRUHÁ, kratšia časť a je formulovaný ako zoznam
// výrazov, ktoré sa MÔŽU vyskytnúť — nie ako inštrukcia vynechávať iné
// slová (dodatok bod 7: "slovník nesmie tlačiť model k vypusteniu ostatných
// slov"). VÝHRADNE všeobecné výrazy appky, ŽIADNE konkrétne
// SPZ/mená/používateľské dáta. Podľa OpenAI SDK dokumentácie by mal prompt
// zodpovedať jazyku audia, preto je per-locale.
const DOMAIN_CONTEXT_PROMPT_BY_LOCALE: Record<"sk" | "de" | "en", string> = {
  sk: "Prepíš celý hovorený príkaz presne a úplne, slovo po slove. Nevynechávaj žiadne slová ani časti vety, nezjednodušuj a neredukuj vetu iba na kľúčové slová alebo identifikátory. Zachovaj celé znenie vrátane čísel, názvov, skratiek a identifikátorov. Ide o firemnú aplikáciu Esblu pre vozidlá, stroje, sklad a dokumenty; v reči sa môžu vyskytnúť výrazy ako STK, EK, PZP, EČV, ŠPZ, vozidlo, stroj, bager, servis, sklad, bloček, faktúra, vážny lístok, dodací list, technický preukaz, dokument, report, export.",
  de: "Transkribiere den gesamten gesprochenen Befehl genau und vollständig, Wort für Wort. Lasse keine Wörter oder Satzteile aus und kürze den Satz nicht auf Schlüsselwörter oder Kennungen. Erhalte den vollständigen Wortlaut einschließlich Zahlen, Namen, Abkürzungen und Kennungen. Es handelt sich um die Firmenanwendung Esblu für Fahrzeuge, Baumaschinen, Lager und Dokumente; es können Begriffe wie HU, AU, Kennzeichen, Fahrzeug, Baumaschine, Bagger, Service, Lager, Rechnung, Beleg, Fahrzeugschein, Dokument, Bericht, Export vorkommen.",
  en: "Transcribe the entire spoken command exactly and completely, word for word. Do not omit any words or parts of the sentence, and do not shorten it to just keywords or identifiers. Preserve the full wording including numbers, names, abbreviations and identifiers. This is the Esblu company app for vehicles, machines, inventory and documents; terms like inspection, registration, license plate, vehicle, machine, excavator, service, warehouse, invoice, receipt, vehicle registration, document, report, export may occur.",
};

const ALLOWED_AUDIO_MIME_TYPES = new Set<string>(ALLOWED_VOICE_AUDIO_MIME_TYPES);

// RUNTIME BUG FIX: reálne prehliadače (najmä Chrome na Androide) bežne
// hlásia MediaRecorder.mimeType/Blob.type S codec parametrom, napr.
// "audio/webm;codecs=opus" namiesto holého "audio/webm". Pôvodný kód tu
// robil PRESNÉ porovnanie (`Set.has(audioValue.type)`), takže takéto
// bežné, plne legitímne audio bolo vždy zamietnuté ako "unsupportedFormat"
// — to bol koreň nahláseného bugu. Preto sa pred validáciou MIME typ vždy
// normalizuje na "base" tvar (časť pred prvým ";").
function baseMimeType(rawType: string): string {
  return rawType.split(";")[0]?.trim().toLowerCase() ?? "";
}

// Druhotná, bezpečná poistka: ak by Content-Type Blobu z nejakého dôvodu
// chýbal/bol neznámy (zriedkavé, ale pozorované na niektorých mobilných
// WebView), appka na strane klienta VŽDY sama nastavuje príponu súboru
// podľa toho, čo skutočne nahrala (Dashboard.tsx: `voice-command.<ext>`).
// Táto prípona je preto spoľahlivejší signál než chýbajúci/nejasný MIME —
// použije sa iba ak samotný MIME typ nie je v allowliste.
const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  webm: "audio/webm",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function resolveAllowedMimeType(file: File): string | null {
  const normalized = baseMimeType(file.type);
  if (ALLOWED_AUDIO_MIME_TYPES.has(normalized)) return normalized;

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const fromExtension = EXTENSION_TO_MIME_TYPE[extension];
  if (fromExtension && ALLOWED_AUDIO_MIME_TYPES.has(fromExtension)) {
    return fromExtension;
  }

  return null;
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  try {
    // 1) Autentifikácia MUSÍ prebehnúť pred akýmkoľvek OpenAI volaním
    //    (rovnaký vzor ako app/api/scan-document, app/api/assistant/intent).
    const { user, error: authError } = await verifyRequestUser(req, locale);
    if (authError || !user) {
      return Response.json({ success: false, error: authError }, { status: 401 });
    }

    // 2) Validácia vstupu — až po overení používateľa.
    const formData = await req.formData().catch(() => null);
    const audioValue = formData?.get("audio");

    if (!(audioValue instanceof File)) {
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.noAudio") },
        { status: 400 }
      );
    }

    const resolvedMimeType = resolveAllowedMimeType(audioValue);
    if (!resolvedMimeType) {
      // Production-safe: iba MIME/veľkosť, nikdy obsah audia.
      console.warn(
        "api/assistant/transcribe: nepodporovaný MIME typ:",
        baseMimeType(audioValue.type) || "(prázdny)"
      );
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.unsupportedFormat") },
        { status: 400 }
      );
    }

    if (audioValue.size === 0) {
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
        { status: 400 }
      );
    }

    if (audioValue.size > MAX_AUDIO_SIZE_BYTES) {
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.recordingTooLong") },
        { status: 413 }
      );
    }

    // 3) Prepis.
    //    - `language: locale` — SDK dokumentácia potvrdzuje zlepšenie
    //      presnosti/latencie pri ISO-639-1 hinte, appka preto NEROBÍ
    //      auto-detect (pozri audit v hlavičke súboru).
    //    - `prompt` — krátky doménový kontext appky (žiadne konkrétne
    //      firemné/používateľské dáta), pomáha modelu s doménovými
    //      skratkami ako STK/EK/PZP/ŠPZ namiesto ich foneticky podobnej
    //      domnienky.
    //    - `model: "gpt-4o-transcribe"` — plnohodnotný (nie "mini")
    //      transkripčný model, presnosť uprednostnená pred minimálnou
    //      cenou/latenciou (zadanie, bod 1).
    let transcription: { text: string };
    try {
      transcription = await client.audio.transcriptions.create({
        file: audioValue,
        model: "gpt-4o-transcribe",
        language: locale,
        prompt: DOMAIN_CONTEXT_PROMPT_BY_LOCALE[locale],
      });
    } catch (transcriptionError) {
      console.error(
        "api/assistant/transcribe: OpenAI volanie zlyhalo:",
        transcriptionError instanceof Error ? transcriptionError.message : transcriptionError
      );
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
        { status: 502 }
      );
    }

    const text = transcription.text?.trim() || "";

    // Nespoľahlivý/prázdny prepis NIKDY automaticky nespúšťa žiadny intent
    // (zadanie, sekcia F: "ak transkripcia zlyhá... žiadny fallback, ktorý
    // by spustil intent z nejasného textu... appka nerobí nič bez
    // spoľahlivého transkriptu") — appka iba vráti bezpečnú chybu, klient
    // (Dashboard.tsx) potom nič nevloží do search poľa.
    if (!text) {
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
        { status: 422 }
      );
    }

    return Response.json({ success: true, text });
  } catch (error) {
    console.error(
      "api/assistant/transcribe: neočakávaná chyba:",
      error instanceof Error ? error.message : error
    );
    return Response.json(
      { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
      { status: 500 }
    );
  }
}
