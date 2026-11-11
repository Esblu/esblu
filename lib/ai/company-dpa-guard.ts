// =============================================================================
// DPA brána pre AI endpointy (J10 CLIA GDPR reconciliation, 2026-11-10)
// =============================================================================
// Manuál CLIA (09.11.2026) čl. 3.1.2: DPA musí byť uzatvorená „najneskôr pred
// začatím príslušného spracúvania“. Odoslanie obrazu dokumentu, hlasovej
// nahrávky alebo textového príkazu firmy externému sprostredkovateľovi
// (OpenAI) je spracúvanie v mene Zákazníka (DPA príloha č. 1, písm. g).
//
// Doteraz DB triggre blokovali až ULOŽENIE výsledku, ale samotný prenos do
// OpenAI prebehol aj bez prijatej DPA. Táto brána to uzatvára:
//   • stav sa číta cez esblu_get_my_company_dpa_status() user-scoped klientom
//     (aktívna firma odvodená v DB z JWT, nikdy z tela požiadavky),
//   • fail CLOSED — chyba RPC / chýbajúci riadok = žiadne odoslanie do AI.
//
// Nemení právny model DPA (kto a ako ju uzatvára — LEGAL CONFIRMATION
// REQUIRED), iba vynucuje existujúci model aj pre prenos do AI.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";

export type CompanyDpaGuardDecision =
  | { ok: true }
  | { ok: false; status: 403 | 503; code: "ESBLU_COMPANY_DPA_NOT_ACCEPTED" | "ESBLU_NO_ACTIVE_COMPANY" | "ESBLU_DPA_STATUS_UNAVAILABLE" };

type DpaStatusRow = { has_current_acceptance?: unknown } | null | undefined;

/** Čisté rozhodnutie (testovateľné bez DB). */
export function decideCompanyDpaGuard(data: unknown, error: unknown): CompanyDpaGuardDecision {
  if (error) return { ok: false, status: 503, code: "ESBLU_DPA_STATUS_UNAVAILABLE" };
  const row = (Array.isArray(data) ? data[0] : data) as DpaStatusRow;
  if (!row || typeof row !== "object") return { ok: false, status: 403, code: "ESBLU_NO_ACTIVE_COMPANY" };
  if (row.has_current_acceptance !== true) return { ok: false, status: 403, code: "ESBLU_COMPANY_DPA_NOT_ACCEPTED" };
  return { ok: true };
}

export async function checkCompanyDpaForAi(db: SupabaseClient): Promise<CompanyDpaGuardDecision> {
  try {
    const { data, error } = await db.rpc("esblu_get_my_company_dpa_status");
    return decideCompanyDpaGuard(data, error);
  } catch (error) {
    return decideCompanyDpaGuard(null, error ?? new Error("rpc_failed"));
  }
}

/** Varianta pre routy bez vlastného user-scoped klienta (napr. hlas): token z hlavičky. */
export async function checkCompanyDpaForRequest(req: Request): Promise<CompanyDpaGuardDecision> {
  const bearer = req.headers.get("authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length).trim() : "";
  if (!token) return { ok: false, status: 403, code: "ESBLU_NO_ACTIVE_COMPANY" };
  return checkCompanyDpaForAi(getUserScopedSupabaseClient(token));
}

/** Prekladový kľúč pre odmietnutie (sk/en/de slovníky). */
export function companyDpaGuardMessageKey(decision: Exclude<CompanyDpaGuardDecision, { ok: true }>): string {
  if (decision.code === "ESBLU_COMPANY_DPA_NOT_ACCEPTED") return "companyDpaGate.aiBlocked";
  if (decision.code === "ESBLU_NO_ACTIVE_COMPANY") return "inbox.errors.scanNoActiveCompany";
  return "inbox.errors.scanFailedGeneric";
}
