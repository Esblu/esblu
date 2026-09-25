// =============================================================================
// Diagnostika hlasového režimu — IBA v pamäti tohto prehliadača, bez obsahu.
//
// Zaznamenáva hranice kola (stav, efekt, výsledok nahrávky, prepisu, servera
// a syntézy reči) s generáciou kola. NIKDY text prepisu, odpovede ani zvuk.
// Nič sa neposiela na server. Na Android zariadení sa dá prečítať cez
// chrome://inspect → konzola: `window.__esbluVoice.events`.
//
// Účel: keď Esblu „prestane hovoriť", vidno, či syntéza skončila `error`,
// `skipped` (vypnuté odpovede) alebo sa vôbec nespustila (`retried`).
// =============================================================================

export type VoiceDiagnostic = { t: number; kind: string; name: string; gen: number };

const MAX_EVENTS = 200;
const events: VoiceDiagnostic[] = [];
const counts: Record<string, number> = {};

export function recordVoiceDiagnostic(entry: Omit<VoiceDiagnostic, "t">): void {
  const item = { t: Date.now(), ...entry };
  events.push(item);
  if (events.length > MAX_EVENTS) events.shift();
  const key = `${entry.kind}:${entry.name}`;
  counts[key] = (counts[key] ?? 0) + 1;
  if (typeof window !== "undefined") {
    (window as unknown as { __esbluVoice?: unknown }).__esbluVoice = { events, counts };
  }
}

export function voiceDiagnostics(): { events: readonly VoiceDiagnostic[]; counts: Readonly<Record<string, number>> } {
  return { events, counts };
}
