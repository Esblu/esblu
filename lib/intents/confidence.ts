import { normalizeSpz } from "@/lib/normalize-spz";
import type { ParsedIntent } from "@/lib/intents/types";

// =============================================================================
// Esblu — Intent Engine: úroveň istoty rozpoznania (J8, 2026-10-25).
// =============================================================================
// Čistá funkcia nad výsledkom parsera — NEMENÍ, čo sa vykoná. Pomenúva iba
// to, čo architektúra už vynucuje:
//
//   HIGH   — deterministický intent bez voľného textu, alebo s cieľom
//            daným presnou ŠPZ. Vykoná sa priamo (read) / cez potvrdenie
//            (write) — rovnako ako doteraz.
//   MEDIUM — deterministický intent s voľným menom (stroj, položka,
//            partner, priečinok). Meno sa VŽDY overí proti dátam firmy
//            (RLS); pri viacerých zhodách sa handler spýta, pri žiadnej
//            povie „nenašiel som". Žiadna tichá zlá akcia.
//   LOW    — parser si nie je istý → AI fallback iba klasifikuje (allowlist,
//            sanitizeAiIntent, brána oprávnení, potvrdenie zápisov). Keď ani
//            AI nič nevráti, odpoveď je „Nerozumel som" — nikdy hádanie.
//
// Úroveň sa nikde neukladá s textom príkazu; telemetria počíta iba triedy
// (lib/intents/command-telemetry.ts).
// =============================================================================

export type IntentConfidence = "HIGH" | "MEDIUM" | "LOW";

const PLATE = /^[A-Z]{2,3}\d{3}[A-Z]{2}$/;
const FREE_TEXT_ARGS = ["query", "entityName", "folderName", "categoryName", "partnerQuery"] as const;

export function intentConfidence(intent: ParsedIntent | null, _rawText?: string): IntentConfidence {
  if (!intent) return "LOW";
  if (intent.source === "ai") return "MEDIUM";
  const free = FREE_TEXT_ARGS.map((key) => intent.args[key]).filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (free.length === 0) return "HIGH";
  return free.every((value) => PLATE.test(normalizeSpz(value) ?? "")) ? "HIGH" : "MEDIUM";
}
