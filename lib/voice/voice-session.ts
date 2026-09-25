import { classifyConfirmationReply } from "../intents/confirmation-reply.ts";

// =============================================================================
// Súvislý hlasový režim — ČISTÝ stavový automat (bez prehliadača, testovaný v Node).
//
// PREČO
// -----
// Predtým musel používateľ ťuknúť na mikrofón pred KAŽDOU odpoveďou a
// ťuknúť znova, aby nahrávanie ukončil. Hlasový dialóg („Koľko kusov?" —
// „Päť." — „Potvrdiť?" — „Áno.") bol tak iba sériou ťuknutí.
//
// AKO
// ---
// Jedno ťuknutie spustí RELÁCIU. Automat striktne strieda reč používateľa a
// reč Esblu (turn-taking, žiadny full duplex):
//
//   IDLE ─START→ STARTING ─MIC_READY→ LISTENING ─UTTERANCE_CAPTURED→ TRANSCRIBING
//     ─TRANSCRIPT→ WAITING_SERVER ─TURN_RESULT→ SPEAKING ─SPEECH_DONE→ STARTING …
//
// Po dohovorení Esblu sa mikrofón zapne znova (STARTING = „počúvam znova").
//
// NIKDY NEPOČÚVA SÁM SEBA: mikrofón sa uvoľní HNEĎ po zachytení vety
// (UTTERANCE_CAPTURED → releaseMic) a znova sa vyžiada až po skutočnom
// konci reči (SPEECH_DONE z onend/onerror syntézy). Stav SPEAKING a
// LISTENING/STARTING sa nikdy neprekrývajú; `speak` sa vydá iba vtedy, keď
// je mikrofón uvoľnený. Oneskorené udalosti z predchádzajúceho stavu (napr.
// SPEECH_DONE po zastavení) sa IGNORUJÚ — zastavená relácia sa nikdy sama
// nereštartuje.
//
// Obchodný stav (rozpracovaná faktúra, zapečatená otázka, náhľad) sem
// NEPATRÍ — ten drží server a komponent. Relácia sa smie zastaviť, kým
// úloha ostáva rozpracovaná, a pokračovať písaním.
// =============================================================================

export type VoiceStatus =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "waiting_server"
  | "speaking"
  | "stopped"
  | "error";

export type StopReason =
  | "user"          // ťuknutie na aktívny mikrofón / tlačidlo ukončenia
  | "phrase"        // „koniec", „ukonči hlas", „stop" …
  | "no_speech"     // nikto nehovoril — mikrofón nesmie ostať zapnutý
  | "hidden"        // karta na pozadí, zamknutý telefón
  | "navigation"    // odchod zo stránky / zatvorenie panela / odmontovanie
  | "manual"        // používateľ začal písať — ručný režim
  | "offline"       // výpadok siete
  | "mic_lost"      // odobraté povolenie / odpojený mikrofón
  | "session_end";  // odhlásenie / vypršané prihlásenie

export type VoiceSessionState = {
  status: VoiceStatus;
  /** Poradie odpovede používateľa v relácii (0 = prvá veta). */
  turn: number;
  /**
   * GENERÁCIA: zvýši sa pri každom prijatom prechode. Asynchrónne dokončenia
   * (mikrofón, nahrávka, prepis, server, reč) nesú generáciu, v ktorej
   * vznikli — oneskorené dokončenie staršieho kola (starý onend syntézy,
   * starý MediaRecorder, stará odpoveď servera) sa ignoruje a nemôže
   * zastaviť ani reštartovať novšie kolo.
   */
  gen: number;
  /** Počet po sebe idúcich tichých okien počúvania (bez vety). */
  idleWindows: number;
  stopReason?: StopReason;
  /** Kľúč prekladu pre zobrazenú/vyslovenú správu (bez obsahu dát). */
  noticeKey?: string;
};

export type VoiceEffect =
  | { type: "acquireMic" }
  | { type: "listen" }
  | { type: "cancelListen" }
  | { type: "releaseMic" }
  | { type: "transcribe" }
  | { type: "sendTurn"; text: string }
  | { type: "speak"; text: string }
  | { type: "speakNotice"; key: string }
  | { type: "cancelSpeech" };

/** Dokončenie asynchrónnej práce — nesie generáciu, v ktorej práca vznikla. */
type Completion = { gen?: number };

export type VoiceEvent =
  | { type: "START" }
  | ({ type: "MIC_READY" } & Completion)
  | ({ type: "MIC_FAILED"; reason: "denied" | "unsupported" } & Completion)
  | ({ type: "UTTERANCE_CAPTURED" } & Completion)
  | ({ type: "NO_SPEECH" } & Completion)
  | ({ type: "CAPTURE_FAILED" } & Completion)
  | ({ type: "TRANSCRIPT"; text: string } & Completion)
  | ({ type: "TRANSCRIBE_FAILED" } & Completion)
  | ({ type: "TURN_RESULT"; spoken: string | null; endSession?: boolean } & Completion)
  | ({ type: "TURN_FAILED" } & Completion)
  | ({ type: "SPEECH_DONE" } & Completion)
  | { type: "USER_TAP" }
  | { type: "MANUAL_TURN"; text: string }
  | { type: "STOP"; reason: StopReason };

export const INITIAL_VOICE_SESSION: VoiceSessionState = { status: "idle", turn: 0, gen: 0, idleWindows: 0 };

// -----------------------------------------------------------------------------
// POLITIKA NEČINNOSTI
//
// Jedno tiché okno počúvania = DEFAULT_VAD.noSpeechMs (8 s, lib/voice/vad.ts).
// Predtým jediné tiché okno ukončilo celú reláciu („Nič som nepočul, hlasový
// režim som ukončil.") — používateľ, ktorý chvíľu rozmýšľal alebo čakal na
// odpoveď, prišiel o hlasový režim.
//
//   krátke ticho  (okná 1–3, do ~24 s)  → počúvam ďalej, bez slova
//   dlhšie ticho  (okno 4,  ~32 s)      → jedna krátka pripomienka
//                                          („Som tu. Povedzte príkaz …")
//   veľmi dlhé    (okno 15, ~2 min)     → koniec relácie, mikrofón uvoľnený
//
// Hranica 2 min: prirodzená pauza v rozhovore (hľadanie čísla dokladu,
// telefonát) sa zmestí; zabudnutý mikrofón na stole nepočúva donekonečna.
// Akákoľvek zachytená veta počítadlo nuluje.
// -----------------------------------------------------------------------------

export const IDLE_PROMPT_AFTER_WINDOWS = 4;
export const IDLE_STOP_AFTER_WINDOWS = 15;

export function isSessionActive(status: VoiceStatus): boolean {
  return status !== "idle" && status !== "stopped" && status !== "error";
}

type Step = { state: VoiceSessionState; effects: VoiceEffect[] };

function next(state: VoiceSessionState, patch: Omit<Partial<VoiceSessionState>, "gen">, effects: VoiceEffect[]): Step {
  return {
    state: {
      status: patch.status ?? state.status,
      turn: patch.turn ?? state.turn,
      gen: state.gen + 1,
      idleWindows: patch.idleWindows ?? state.idleWindows,
      ...(patch.stopReason ? { stopReason: patch.stopReason } : {}),
      ...(patch.noticeKey ? { noticeKey: patch.noticeKey } : {}),
    },
    effects,
  };
}

/** Relácia sa zastaví: uvoľní mikrofón, preruší reč a nič nenaplánuje. */
function stop(state: VoiceSessionState, reason: StopReason, noticeKey?: string): Step {
  const effects: VoiceEffect[] = [{ type: "cancelListen" }, { type: "releaseMic" }, { type: "cancelSpeech" }];
  if (noticeKey) effects.push({ type: "speakNotice", key: noticeKey });
  return next(state, { status: "stopped", stopReason: reason, noticeKey, idleWindows: 0 }, effects);
}

/** Esblu povie text; mikrofón je v tej chvíli vždy uvoľnený. */
function speakThenListen(state: VoiceSessionState, text: string, noticeKey?: string, idleWindows = 0): Step {
  return next(state, { status: "speaking", noticeKey, idleWindows }, [
    { type: "cancelListen" },
    { type: "releaseMic" },
    noticeKey ? { type: "speakNotice", key: noticeKey } : { type: "speak", text },
  ]);
}

function listenAgain(state: VoiceSessionState): Step {
  return next(state, { status: "starting", turn: state.turn + 1 }, [{ type: "acquireMic" }]);
}

const COMPLETIONS = new Set(["MIC_READY", "MIC_FAILED", "UTTERANCE_CAPTURED", "NO_SPEECH", "CAPTURE_FAILED", "TRANSCRIPT", "TRANSCRIBE_FAILED", "TURN_RESULT", "TURN_FAILED", "SPEECH_DONE"]);

export function voiceSessionReducer(state: VoiceSessionState, event: VoiceEvent): Step {
  const same: Step = { state, effects: [] };
  const s = state.status;

  // Oneskorené dokončenie staršieho kola nič nezmení.
  if (COMPLETIONS.has(event.type)) {
    const gen = (event as Completion).gen;
    // (Neskoro otvorený mikrofón uvoľní sám MicSession — release() zneplatní
    // prebiehajúce open().)
    if (gen !== undefined && gen !== state.gen) return same;
  }

  switch (event.type) {
    case "START":
      if (isSessionActive(s)) return same;
      return next({ ...state, stopReason: undefined, noticeKey: undefined }, { status: "starting", turn: 0, idleWindows: 0 }, [{ type: "cancelSpeech" }, { type: "acquireMic" }]);

    case "MIC_READY":
      if (s !== "starting") return same;
      return next(state, { status: "listening" }, [{ type: "listen" }]);

    case "MIC_FAILED":
      if (s !== "starting") return same;
      return next(state, { status: "error", stopReason: "mic_lost", noticeKey: event.reason === "denied" ? "micDenied" : "unsupported" }, [{ type: "releaseMic" }]);

    case "UTTERANCE_CAPTURED":
      if (s !== "listening") return same;
      return next(state, { status: "transcribing", idleWindows: 0 }, [{ type: "releaseMic" }, { type: "transcribe" }]);

    case "NO_SPEECH": {
      if (s !== "listening") return same;
      const idle = state.idleWindows + 1;
      if (idle >= IDLE_STOP_AFTER_WINDOWS) return stop(state, "no_speech", "noSpeech");
      if (idle === IDLE_PROMPT_AFTER_WINDOWS) return speakThenListen(state, "", "idlePrompt", idle);
      // Krátke ticho: mikrofón ostáva, počúva sa ďalšie okno.
      return next(state, { status: "listening", idleWindows: idle }, [{ type: "listen" }]);
    }

    case "CAPTURE_FAILED":
      if (s !== "listening") return same;
      return speakThenListen(state, "", "asrRetry");

    case "TRANSCRIPT": {
      if (s !== "transcribing") return same;
      const text = event.text.trim();
      if (!text) return speakThenListen(state, "", "asrRetry");
      if (isVoiceStopCommand(text)) return stop(state, "phrase", "stopped");
      return next(state, { status: "waiting_server" }, [{ type: "sendTurn", text }]);
    }

    case "TRANSCRIBE_FAILED":
      if (s !== "transcribing") return same;
      return speakThenListen(state, "", "asrRetry");

    case "TURN_RESULT":
      if (s !== "waiting_server") return same;
      if (event.endSession) return stop(state, "session_end");
      if (event.spoken && event.spoken.trim()) return speakThenListen(state, event.spoken.trim());
      return listenAgain(state);

    case "TURN_FAILED":
      // Chybová veta sa NIKDY nepošle ako nový príkaz — iba sa povie.
      if (s !== "waiting_server") return same;
      return speakThenListen(state, "", "networkRetry");

    case "SPEECH_DONE":
      // Koniec aj chyba syntézy vedú späť na počúvanie (relácia neuviazne).
      if (s !== "speaking") return same; // po zastavení sa nič nereštartuje
      return listenAgain({ ...state, noticeKey: undefined });

    case "USER_TAP":
      if (s === "speaking") {
        // Barge-in: používateľ úmyselne preruší Esblu → reč stop, hneď počúvať.
        return next(state, { status: "starting", turn: state.turn + 1, idleWindows: 0 }, [{ type: "cancelSpeech" }, { type: "acquireMic" }]);
      }
      if (isSessionActive(s)) return stop(state, "user");
      return voiceSessionReducer(state, { type: "START" });

    case "MANUAL_TURN":
      // Ťuknutie na „Áno"/„Nie"/„Potvrdiť" počas relácie — tá istá cesta ako hlas.
      if (!isSessionActive(s) || s === "waiting_server" || s === "transcribing") return same;
      return next(state, { status: "waiting_server", idleWindows: 0 }, [
        { type: "cancelListen" },
        { type: "releaseMic" },
        { type: "cancelSpeech" },
        { type: "sendTurn", text: event.text },
      ]);

    case "STOP":
      if (!isSessionActive(s)) return same;
      return stop(state, event.reason, event.reason === "phrase" ? "stopped" : undefined);
  }
}

// -----------------------------------------------------------------------------
// Ukončenie hlasom — iba CELÁ krátka veta, nikdy slovo uprostred príkazu.
// -----------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.!?,;:„“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_PHRASES = [
  "koniec", "koniec hlasu", "ukonci", "ukonci hlas", "ukonci hlasovy rezim", "ukonci pocuvanie", "prestan pocuvat",
  "prestan", "stop", "stopni", "vypni hlas", "vypni mikrofon", "vypni pocuvanie", "to je vsetko", "dakujem to je vsetko",
  "end", "end voice", "stop listening", "stop voice", "that s all", "that is all", "turn off voice",
  "stopp", "ende", "beenden", "sprachmodus beenden", "hor auf", "hoer auf", "hor auf zuzuhoren", "hoer auf zuzuhoeren", "das ist alles",
];

export function isVoiceStopCommand(rawText: string): boolean {
  const text = normalize(rawText)
    .replace(/^(esblu|hej esblu|ok esblu)\s+/, "")
    .replace(/\s+(prosim|please|bitte|dakujem|thanks|danke)$/, "")
    .trim();
  return STOP_PHRASES.includes(text);
}

// -----------------------------------------------------------------------------
// Hlasová odpoveď pri čakajúcom potvrdení (náhľad zápisu)
// -----------------------------------------------------------------------------

export type VoiceConfirmationDecision = "confirm" | "cancel" | "ask_again" | "new_command";

/**
 * „Áno" → potvrdiť (tá istá jednorazová podpísaná cesta ako tlačidlo),
 * „Nie" → zrušiť. Nejasná krátka veta („áno?", „hm", skomolený prepis) sa
 * NIKDY nepovažuje za súhlas — Esblu sa spýta znova. Dlhšia veta je nový
 * príkaz (náhľad sa zahodí, nič sa nevykoná).
 */
const COMMAND_VERB = /^(ukaz|zobraz|otvor|najdi|hladaj|vytvor|pridaj|zaloz|zmaz|vymaz|zniz|zvys|nastav|premenuj|stiahni|kolko|kedy|show|open|find|create|add|delete|list|zeig|offne|oeffne|finde|erstell|losch|loesch)/;

export function decideVoiceConfirmation(rawText: string): VoiceConfirmationDecision {
  const words = normalize(rawText).split(" ").filter(Boolean);
  const reply = rawText.includes("?") ? null : classifyConfirmationReply(rawText);
  if (reply === "confirm") return "confirm";
  if (reply === "cancel") return "cancel";
  // Krátka nejasná veta bez slovesa príkazu = pravdepodobne skomolené „áno/nie".
  if (words.length <= 3 && !COMMAND_VERB.test(words[0] ?? "")) return "ask_again";
  return "new_command";
}
