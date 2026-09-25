"use client";

import { MAX_RECORDING_SECONDS } from "@/lib/voice-config";
import { createVad, DEFAULT_VAD } from "@/lib/voice/vad";

// =============================================================================
// Mikrofón pre súvislý hlasový režim — jedna veta na jedno počúvanie.
//
//   open()     vyžiada mikrofón (getUserMedia). Volá sa pri každom kole
//              ZNOVA — počas reči Esblu je mikrofón uvoľnený (release()),
//              takže nahrávka nikdy nezachytí hlas Esblu.
//   listen()   spustí MediaRecorder HNEĎ (prvá slabika krátkeho „áno" sa
//              neoreže) a vetu ukončí sám podľa ticha (lib/voice/vad.ts).
//   release()  zastaví všetky stopy mikrofónu — indikátor v prehliadači zhasne.
//   close()    koniec relácie: uvoľní mikrofón aj AudioContext.
//
// AudioContext sa vytvára pri ťuknutí (používateľské gesto) a žije počas
// celej relácie — mobilné prehliadače ho mimo gesta nechajú „suspended".
// =============================================================================

export type CaptureOutcome =
  | { kind: "speech"; blob: Blob; mimeType: string }
  | { kind: "no_speech" }
  | { kind: "too_long" }
  | { kind: "aborted" }
  | { kind: "error" };

/** Frekvencia merania hlasitosti. Vzorkovanie, nie oneskorenie. */
const SAMPLE_MS = 50;

type AudioContextCtor = typeof AudioContext;

export function voiceSessionSupported(): boolean {
  if (typeof window === "undefined") return false;
  const ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined;
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined" && Boolean(ctor);
}

export class MicSession {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private abortCurrent: (() => void) | null = null;
  /** Mikrofón zmizol (odobraté povolenie, odpojené zariadenie, OS ho vzal). */
  onTrackEnded: (() => void) | null = null;

  /** Musí sa zavolať synchrónne v obsluhe ťuknutia (gesto). */
  prime(): void {
    if (this.context) return;
    const ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor;
    this.context = new ctor();
    void this.context.resume().catch(() => undefined);
  }

  /** Zvýši ho každé release() — oneskorené getUserMedia potom mikrofón hneď pustí. */
  private openToken = 0;

  async open(): Promise<"ready" | "denied" | "unsupported" | "cancelled"> {
    if (!voiceSessionSupported()) return "unsupported";
    this.release();
    const token = this.openToken;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Medzitým zastavené (stop, pozadie, nové kolo) → mikrofón nesmie ostať zapnutý.
      if (token !== this.openToken || this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        return "cancelled";
      }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (this.stream === stream) this.onTrackEnded?.();
        });
      }
      if (this.context?.state === "suspended") await this.context.resume().catch(() => undefined);
      return "ready";
    } catch {
      return "denied";
    }
  }

  get isOpen(): boolean {
    return Boolean(this.stream?.getAudioTracks().some((track) => track.readyState === "live"));
  }

  /** Nahrá JEDNU vetu. Končí tichom po reči, prázdnym tichom, stropom alebo abort(). */
  listen(): Promise<CaptureOutcome> {
    const stream = this.stream;
    const context = this.context;
    if (!stream || !context) return Promise.resolve({ kind: "error" });

    return new Promise<CaptureOutcome>((resolve) => {
      let settled = false;
      const chunks: Blob[] = [];
      const mimeType = ["audio/webm", "audio/mp4", "audio/ogg"].find(
        (type) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(type)
      );
      let recorder: MediaRecorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        resolve({ kind: "error" });
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const vad = createVad({ ...DEFAULT_VAD, maxMs: MAX_RECORDING_SECONDS * 1000 });
      const startedAt = performance.now();

      const cleanup = () => {
        clearInterval(timer);
        try {
          source.disconnect();
        } catch {
          // nič
        }
        this.abortCurrent = null;
      };

      const finish = (verdict: "speech" | "no_speech" | "too_long" | "aborted" | "error") => {
        if (settled) return;
        settled = true;
        cleanup();
        if (verdict !== "speech") {
          recorder.onstop = null;
          if (recorder.state !== "inactive") recorder.stop();
          resolve({ kind: verdict });
          return;
        }
        // Posledné dáta prídu v `dataavailable` pred `stop` — čaká sa na
        // skutočnú udalosť, nie na časovač.
        recorder.onstop = () => {
          const type = recorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(chunks, { type });
          resolve(blob.size > 0 ? { kind: "speech", blob, mimeType: type } : { kind: "error" });
        };
        if (recorder.state !== "inactive") recorder.stop();
        else recorder.onstop?.(new Event("stop"));
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => finish("error");
      this.abortCurrent = () => finish("aborted");

      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        const verdict = vad.push(Math.sqrt(sum / buffer.length), performance.now() - startedAt);
        if (verdict === "end") finish("speech");
        else if (verdict === "no_speech") finish("no_speech");
        else if (verdict === "too_long") finish("too_long");
      }, SAMPLE_MS);

      try {
        // Časové úseky po 250 ms — pri náhlom konci (OS vezme mikrofón) už
        // máme väčšinu zvuku.
        recorder.start(250);
      } catch {
        finish("error");
      }
    });
  }

  abortListen(): void {
    this.abortCurrent?.();
  }

  release(): void {
    this.openToken += 1;
    this.abortListen();
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach((track) => track.stop());
  }

  private closed = false;

  close(): void {
    this.closed = true;
    this.release();
    const context = this.context;
    this.context = null;
    void context?.close().catch(() => undefined);
  }
}
