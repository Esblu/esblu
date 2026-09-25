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

export type VoiceEvent =
  | { type: "START" }
  | { type: "MIC_READY" }
  | { type: "MIC_FAILED"; reason: "denied" | "unsupported" }
  | { type: "UTTERANCE_CAPTURED" }
  | { type: "NO_SPEECH" }
  | { type: "CAPTURE_FAILED" }
  | { type: "TRANSCRIPT"; text: string }
  | { type: "TRANSCRIBE_FAILED" }
  | { type: "TURN_RESULT"; spoken: string | null; endSession?: boolean }
  | { type: "TURN_FAILED" }
  | { type: "SPEECH_DONE" }
  | { type: "USER_TAP" }
  | { type: "MANUAL_TURN"; text: string }
  | { type: "STOP"; reason: StopReason };

export const INITIAL_VOICE_SESSION: VoiceSessionState = { status: "idle", turn: 0 };

export function isSessionActive(status: VoiceStatus): boolean {
  return status !== "idle" && status !== "stopped" && status !== "error";
}

/** Relácia sa zastaví: uvoľní mikrofón, preruší reč a nič nenaplánuje. */
function stop(state: VoiceSessionState, reason: StopReason, noticeKey?: string): { state: VoiceSessionState; effects: VoiceEffect[] } {
  const effects: VoiceEffect[] = [{ type: "cancelListen" }, { type: "releaseMic" }, { type: "cancelSpeech" }];
  if (noticeKey) effects.push({ type: "speakNotice", key: noticeKey });
  return { state: { status: "stopped", turn: state.turn, stopReason: reason, noticeKey }, effects };
}

/** Esblu povie text; mikrofón je v tej chvíli vždy uvoľnený. */
function speakThenListen(state: VoiceSessionState, text: string, noticeKey?: string): { state: VoiceSessionState; effects: VoiceEffect[] } {
  return {
    state: { status: "speaking", turn: state.turn, noticeKey },
    effects: [{ type: "releaseMic" }, noticeKey ? { type: "speakNotice", key: noticeKey } : { type: "speak", text }],
  };
}

function listenAgain(state: VoiceSessionState): { state: VoiceSessionState; effects: VoiceEffect[] } {
  return { state: { status: "starting", turn: state.turn + 1 }, effects: [{ type: "acquireMic" }] };
}

export function voiceSessionReducer(
  state: VoiceSessionState,
  event: VoiceEvent
): { state: VoiceSessionState; effects: VoiceEffect[] } {
  const same = { state, effects: [] as VoiceEffect[] };
  const s = state.status;

  switch (event.type) {
    case "START":
      if (isSessionActive(s)) return same;
      return { state: { status: "starting", turn: 0 }, effects: [{ type: "cancelSpeech" }, { type: "acquireMic" }] };

    case "MIC_READY":
      if (s !== "starting") return { state, effects: [{ type: "releaseMic" }] }; // oneskorené — mikrofón hneď pustiť
      return { state: { status: "listening", turn: state.turn }, effects: [{ type: "listen" }] };

    case "MIC_FAILED":
      if (s !== "starting") return same;
      return {
        state: { status: "error", turn: state.turn, stopReason: "mic_lost", noticeKey: event.reason === "denied" ? "micDenied" : "unsupported" },
        effects: [{ type: "releaseMic" }],
      };

    case "UTTERANCE_CAPTURED":
      if (s !== "listening") return same;
      return { state: { status: "transcribing", turn: state.turn }, effects: [{ type: "releaseMic" }, { type: "transcribe" }] };

    case "NO_SPEECH":
      if (s !== "listening") return same;
      // Nikto nehovorí → mikrofón sa vypne (nie je to trvalé počúvanie).
      return stop(state, "no_speech", "noSpeech");

    case "CAPTURE_FAILED":
      if (s !== "listening") return same;
      return speakThenListen(state, "", "asrRetry");

    case "TRANSCRIPT": {
      if (s !== "transcribing") return same;
      const text = event.text.trim();
      if (!text) return speakThenListen(state, "", "asrRetry");
      if (isVoiceStopCommand(text)) return stop(state, "phrase", "stopped");
      return { state: { status: "waiting_server", turn: state.turn }, effects: [{ type: "sendTurn", text }] };
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
      if (s !== "speaking") return same; // po zastavení sa nič nereštartuje
      return listenAgain(state);

    case "USER_TAP":
      if (s === "speaking") {
        // Barge-in: používateľ úmyselne preruší Esblu → reč stop, hneď počúvať.
        return { state: { status: "starting", turn: state.turn + 1 }, effects: [{ type: "cancelSpeech" }, { type: "acquireMic" }] };
      }
      if (isSessionActive(s)) return stop(state, "user");
      return voiceSessionReducer(state, { type: "START" });

    case "MANUAL_TURN":
      // Ťuknutie na „Áno"/„Nie"/„Potvrdiť" počas relácie — tá istá cesta ako hlas.
      if (!isSessionActive(s) || s === "waiting_server" || s === "transcribing") return same;
      return {
        state: { status: "waiting_server", turn: state.turn },
        effects: [{ type: "cancelListen" }, { type: "releaseMic" }, { type: "cancelSpeech" }, { type: "sendTurn", text: event.text }],
      };

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
