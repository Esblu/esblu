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
  // [DIAG-D] — dočasná runtime diagnostika (na žiadosť: "nehádaj ďalšiu
  // opravu, over presne KDE sa produkčný flow pokazí"). VÝHRADNE technické
  // metadáta nižšie — nikdy audio obsah, transcript text, secrets.
  const requestReceivedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log("[voice][D][server] POST /api/assistant/transcribe — request prijatý", {
    requestId,
    ts: requestReceivedAt,
  });

  try {
    // 1) Autentifikácia MUSÍ prebehnúť pred akýmkoľvek OpenAI volaním
    //    (rovnaký vzor ako app/api/scan-document, app/api/assistant/intent).
    const { user, error: authError } = await verifyRequestUser(req, locale);
    if (authError || !user) {
      console.log("[voice][D][server] autentifikácia zlyhala", { requestId, authError });
      return Response.json({ success: false, error: authError }, { status: 401 });
    }

    // 2) Validácia vstupu — až po overení používateľa.
    const formData = await req.formData().catch((formDataError) => {
      console.error("[voice][D][server] req.formData() zlyhalo", {
        requestId,
        errorMessage: formDataError instanceof Error ? formDataError.message : String(formDataError),
      });
      return null;
    });
    const audioValue = formData?.get("audio");

    if (!(audioValue instanceof File)) {
      console.log("[voice][D][server] chýba 'audio' File v FormData", {
        requestId,
        formDataParsed: formData !== null,
      });
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.noAudio") },
        { status: 400 }
      );
    }

    // [DIAG-D] presne body A/D zadania: received file.size, raw MIME,
    // normalized MIME, filename — VŠETKO čo treba na zistenie, či appka na
    // mobile posiela iný MIME/veľkosť než sa očakáva.
    console.log("[voice][D][server] prijaté audio — metadáta:", {
      requestId,
      filename: audioValue.name,
      rawMimeType: audioValue.type,
      normalizedMimeType: baseMimeType(audioValue.type),
      sizeBytes: audioValue.size,
      maxAllowedSizeBytes: MAX_AUDIO_SIZE_BYTES,
    });

    const resolvedMimeType = resolveAllowedMimeType(audioValue);
    if (!resolvedMimeType) {
      console.warn("[voice][C][server] nepodporovaný MIME typ po normalizácii — appka vracia 'unsupportedFormat', NIE 'recordingTooLong'", {
        requestId,
        normalizedMimeType: baseMimeType(audioValue.type) || "(prázdny)",
        filename: audioValue.name,
      });
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.unsupportedFormat") },
        { status: 400 }
      );
    }

    if (audioValue.size === 0) {
      console.log("[voice][C][server] audio má 0 bajtov — appka vracia 'transcriptionFailed', NIE 'recordingTooLong'", { requestId });
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
        { status: 400 }
      );
    }

    if (audioValue.size > MAX_AUDIO_SIZE_BYTES) {
      // [DIAG-C] — TOTO je jediné miesto na SERVERI, ktoré môže vrátiť
      // presne "recordingTooLong" (413). Pre krátku nahrávku (rádovo
      // desiatky/stovky KB) je tento stav prakticky nedosiahnuteľný — log
      // tu jednoznačne potvrdí/vyvráti, či produkčný bug prechádza TÝMTO
      // konkrétnym vetvením.
      console.warn("[voice][C][server] KRITICKÉ: audio.size prekročilo MAX_AUDIO_SIZE_BYTES — server vracia 413 'recordingTooLong'", {
        requestId,
        sizeBytes: audioValue.size,
        maxAllowedSizeBytes: MAX_AUDIO_SIZE_BYTES,
      });
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
    console.log("[voice][D][server] status pred OpenAI requestom: validácia OK, volám OpenAI transcriptions.create", {
      requestId,
      resolvedMimeType,
      language: locale,
      msSinceRequestReceived: Date.now() - requestReceivedAt,
    });

    let transcription: { text: string };
    const openAiStartedAt = Date.now();
    try {
      transcription = await client.audio.transcriptions.create({
        file: audioValue,
        model: "gpt-4o-mini-transcribe",
        language: locale,
      });
      console.log("[voice][D][server] OpenAI transcriptions.create — success", {
        requestId,
        openAiDurationMs: Date.now() - openAiStartedAt,
      });
    } catch (transcriptionError) {
      console.error("[voice][D][server] OpenAI transcriptions.create — error", {
        requestId,
        openAiDurationMs: Date.now() - openAiStartedAt,
        errorName: transcriptionError instanceof Error ? transcriptionError.name : typeof transcriptionError,
        errorMessage:
          transcriptionError instanceof Error ? transcriptionError.message : String(transcriptionError),
      });
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
        { status: 502 }
      );
    }

    const text = transcription.text?.trim() || "";

    console.log("[voice][D][server] prepis dokončený (transcript OBSAH sa NEloguje)", {
      requestId,
      textLength: text.length,
      totalRequestDurationMs: Date.now() - requestReceivedAt,
    });

    // Nespoľahlivý/prázdny prepis NIKDY automaticky nespúšťa žiadny intent
    // (zadanie, sekcia F: "ak transkripcia zlyhá... žiadny fallback, ktorý
    // by spustil intent z nejasného textu... appka nerobí nič bez
    // spoľahlivého transkriptu") — appka iba vráti bezpečnú chybu, klient
    // (Dashboard.tsx) potom nič nevloží do search poľa.
    if (!text) {
      console.log("[voice][C][server] prázdny transcript — appka vracia 'transcriptionFailed', NIE 'recordingTooLong'", { requestId });
      return Response.json(
        { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
        { status: 422 }
      );
    }

    console.log("[voice][D][server] POST /api/assistant/transcribe — 200 OK", {
      requestId,
      totalRequestDurationMs: Date.now() - requestReceivedAt,
    });
    return Response.json({ success: true, text });
  } catch (error) {
    console.error("[voice][D][server] neočakávaná chyba (vonkajší catch)", {
      requestId,
      totalRequestDurationMs: Date.now() - requestReceivedAt,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: translate(locale, "search.voice.errors.transcriptionFailed") },
      { status: 500 }
    );
  }
}
