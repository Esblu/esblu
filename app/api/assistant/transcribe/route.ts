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
// -----------------------------------------------------------------------------

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

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

    // Bezpečný diagnostický log (zadanie, bod 7) — VÝHRADNE metadáta
    // (MIME, veľkosť), NIKDY obsah audia.
    console.log("api/assistant/transcribe: prijaté audio:", {
      rawMimeType: audioValue.type,
      normalizedMimeType: baseMimeType(audioValue.type),
      size: audioValue.size,
    });

    const resolvedMimeType = resolveAllowedMimeType(audioValue);
    if (!resolvedMimeType) {
      console.warn(
        "api/assistant/transcribe: nepodporovaný MIME typ po normalizácii:",
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

    // 3) Prepis — jazyk appky je iba HINT pre model (zadanie, sekcia B:
    //    "spoľahlivé auto-detection ak API podporuje, inak reuse
    //    existujúceho jazyka appky ako language hint"). Appka dnes nemá
    //    overený spoľahlivý auto-detect flow pre tento presný endpoint,
    //    preto sa vždy posiela aktuálny locale appky (rovnaký princíp ako
    //    getRequestLocale() pre textový Intent Engine) — `locale` je vždy
    //    "sk"/"de"/"en" (lib/i18n/locales.ts), teda platný ISO-639-1 hint.
    let transcription: { text: string };
    try {
      transcription = await client.audio.transcriptions.create({
        file: audioValue,
        model: "gpt-4o-mini-transcribe",
        language: locale,
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

    console.log("api/assistant/transcribe: prepis dokončený:", {
      textLength: text.length,
    });

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
