import { createHash } from "node:crypto";
import type { ParsedIntent } from "@/lib/intents/types";

// =============================================================================
// Esblu — Intent Engine: poistka proti duplicitnému AI volaniu (J8).
// =============================================================================
// Dvojité odoslanie tej istej vety (dvojklik, opakovaný prepis z hlasu,
// retry klienta po timeoute) nesmie spustiť dve platené klasifikácie.
//
// Iba v pamäti inštancie servera, nikdy v DB ani v logu:
//   - kľúč = SHA-256(firma | používateľ | normalizovaný text) — jednosmerný
//     hash, text príkazu sa nikde neukladá,
//   - hodnota = prebiehajúci / práve dokončený výsledok klasifikácie
//     (už validovaný allowlist intent), platnosť DEDUPE_TTL_MS,
//   - firma + používateľ v kľúči: výsledok jednej firmy nikdy nedostane
//     iná firma ani iný používateľ.
// Serverless inštancie si pamäť nezdieľajú — je to best-effort úspora,
// nie bezpečnostná hranica. Oprávnenia, RLS a potvrdenie zápisov sa
// vyhodnocujú pri KAŽDEJ požiadavke znova (orchestrátor), dedupe šetrí
// iba samotné volanie modelu.
// =============================================================================

export const DEDUPE_TTL_MS = 10_000;
const MAX_ENTRIES = 500;

type Entry = { expiresAt: number; value: Promise<ParsedIntent | null> };
const entries = new Map<string, Entry>();

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function dedupeKey(companyId: string, userId: string, rawText: string): string {
  return createHash("sha256").update(`${companyId}\u0000${userId}\u0000${normalize(rawText)}`).digest("hex");
}

function prune(now: number): void {
  for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/**
 * Spustí `classify` najviac raz pre rovnakú (firma, používateľ, veta) v okne
 * DEDUPE_TTL_MS; súbežná alebo zopakovaná požiadavka dostane ten istý
 * výsledok. Chyba sa necacheuje (ďalší pokus zavolá model znova).
 */
export function classifyOnce(
  scope: { companyId: string; userId: string },
  rawText: string,
  classify: () => Promise<ParsedIntent | null>,
  now: () => number = Date.now
): Promise<ParsedIntent | null> {
  const key = dedupeKey(scope.companyId, scope.userId, rawText);
  const t = now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > t) return hit.value;
  prune(t);
  const value = classify().catch((error) => {
    entries.delete(key);
    throw error;
  });
  entries.set(key, { expiresAt: t + DEDUPE_TTL_MS, value });
  return value;
}

/** Iba testy. */
export function resetClassifyOnceForTests(): void {
  entries.clear();
}
