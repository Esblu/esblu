// =============================================================================
// Esblu — zdieľané limity a nastavenia pre hlasové ovládanie (zadanie,
// sekcia B–H: hlasové vyhľadávanie ako TENKÁ vstupná vrstva nad existujúcim
// Intent Enginom).
// =============================================================================
// JEDEN zdroj pravdy pre KLIENTA (app/components/Dashboard.tsx — klientský
// časovač zastaví nahrávanie natvrdo po MAX_RECORDING_SECONDS, bod D
// zadania: "safe max recording duration") AJ SERVER
// (app/api/assistant/transcribe/route.ts — MAX_AUDIO_SIZE_BYTES je DRUHÁ,
// nezávislá poistka pre prípad, že klientske obmedzenie zlyhá/obíde sa,
// bod D zadania: "safe max file size"), aby sa tieto dve hranice nikdy
// nerozišli. Žiadne tajomstvá/kľúče — iba čísla a MIME zoznam, preto je
// bezpečné zdieľať tento modul medzi client aj server kódom.
// =============================================================================

// Krátky hlasový príkaz ("ukáž dokumenty TT123AB", "kedy končí STK
// TT123AB") nikdy nepotrebuje viac než pár sekúnd zvuku.
export const MAX_RECORDING_SECONDS = 20;

// Štedrá rezerva aj pre nekomprimovaný formát pri MAX_RECORDING_SECONDS
// zázname.
export const MAX_AUDIO_SIZE_BYTES = 8 * 1024 * 1024;

// MediaRecorder v prehliadači/Capacitor WebView bežne produkuje audio/webm
// (Chrome/Android) alebo audio/mp4 (Safari/iOS) — obe sú medzi podporovanými
// formátmi OpenAI transkripčného modelu. audio/wav a audio/ogg sú tu navyše
// ako bezpečný, širšie kompatibilný fallback.
export const ALLOWED_VOICE_AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
] as const;
