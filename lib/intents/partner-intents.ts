import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { IntentResult, ParsedIntent } from "@/lib/intents/types";
import { matchPartnersByName } from "@/lib/partner-matching";

// =============================================================================
// Nový obchodný partner hlasom — PRÍPRAVA formulára, nie zápis.
//
// STAVY (PARTNER CREATION STATE MACHINE)
// --------------------------------------
//   PARTNER_WAITING_NAME   veta bez mena → „Ako sa volá nový obchodný partner?"
//                          (zapečatená otázka, slot `partner_name`)
//   PARTNER_DUPLICATE      v aktuálnej firme už je partner s rovnakým IČO
//                          alebo menom → „Partner „X" už existuje. Chcete ho
//                          otvoriť?" (kandidát v zapečatenej otázke)
//                            „Áno" → otvorí existujúceho partnera
//                            „Nie" → pokračuje sa na PARTNER_REVIEW
//   PARTNER_REVIEW         vyplnený formulár (iba vyslovené údaje) — uloží
//                          ho človek existujúcou cestou v UI
//
// Povinné pole je podľa modelu iba názov (validateBusinessPartnerForm).
// IČO, DIČ, IČ DPH ani adresa sa preto NEVYŽADUJÚ a nepýtajú — doplní ich
// človek vo formulári, kde ich vidí. Nič sa nedopĺňa z verejných registrov:
// Esblu dnes nemá funkciu na obohatenie údajov z registra, a vymyslieť
// firemné údaje nesmie.
//
// PREČO BEZ ZÁPISU
// ----------------
// Partner je finančný kmeňový záznam. Formulár ho validuje (IČO duplicitu
// zachytí aj DB unique constraint) a zobrazí všetky polia. Priamy zápis
// hlasom by potreboval rozšírenie allowlistu potvrdení v DB (migrácia) a
// nič by nepridal k bezpečnosti — človek musí údaje aj tak skontrolovať.
//
// OPRÁVNENIE
// ----------
// finance.manage — overené bránou v orchestrátore PRED týmto handlerom a
// PRED akýmkoľvek dotazom. Kontrola duplicít beží pod RLS volajúceho a
// navyše s explicitným filtrom na aktívnu firmu.
// =============================================================================

type PartnerRow = { id: string; legal_name: string | null; ico: string | null };

function label(row: PartnerRow): string {
  return row.ico ? `${row.legal_name ?? ""} · ${row.ico}` : row.legal_name ?? "";
}

export async function handlePartnerCreate(
  db: SupabaseClient,
  locale: Locale,
  intent: ParsedIntent,
  ctx: { companyId: string }
): Promise<IntentResult> {
  const t = (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
  const name = intent.args.entityName?.trim() ?? "";
  const ico = intent.args.partnerIco?.replace(/\s/g, "") || undefined;

  // „Áno" na otázku o existujúcom partnerovi → otvor TOHO, ktorého server
  // ponúkol (entityId prichádza výhradne zo zapečatenej otázky). Overí sa
  // znova pod RLS a vo firme volajúceho.
  if (intent.args.entityId) {
    const { data } = await db
      .from("business_partners")
      .select("id, legal_name, ico")
      .eq("company_id", ctx.companyId)
      .eq("id", intent.args.entityId)
      .maybeSingle();
    const row = data as PartnerRow | null;
    if (!row) return { kind: "not_found", text: t("businessPartners.empty") };
    return {
      kind: "navigate",
      entity: { type: "document", id: row.id, label: label(row), href: `/obchodni-partneri/${row.id}` },
    };
  }

  // PARTNER_WAITING_NAME
  if (!name) {
    return { kind: "answer", text: t("assistant.partner.askName"), awaiting: { slot: "partner_name" } };
  }

  // PARTNER_DUPLICATE — IBA partneri aktuálnej firmy (RLS + explicitný filter).
  if (!intent.args.confirmedNew) {
    const { data, error } = await db
      .from("business_partners")
      .select("id, legal_name, ico")
      .eq("company_id", ctx.companyId)
      .order("legal_name", { ascending: true })
      .limit(1000);
    if (error) return { kind: "error", text: t("search.errors.generic") };
    const rows = (data as PartnerRow[] | null) ?? [];

    // Duplicita = rovnaké IČO alebo rovnaký názov (presná / silná zhoda —
    // „Tester 1" = „Tester1"). Iba „podobný" názov („Tester2" vs. „Tester1")
    // duplicitou nie je: sú to dve rôzne firmy a nový partner sa pripraví.
    const byIco = ico ? rows.find((row) => (row.ico ?? "").replace(/[\s.\-/]/g, "") === ico) : undefined;
    const byName = byIco ? null : matchPartnersByName(name, rows, (row) => row.legal_name);
    const sameName = byName && (byName.tier === "exact" || byName.tier === "strong") ? byName.matches[0] : undefined;
    const existing = byIco ?? sameName;
    if (existing) {
      return {
        kind: "answer",
        text: t("assistant.partner.exists", { name: label(existing) }),
        awaiting: { slot: "partner_name", candidate: { id: existing.id, label: label(existing) } },
      };
    }
  }

  // PARTNER_REVIEW — formulár s vyslovenými údajmi; nič sa neukladá.
  const prefill: Extract<IntentResult, { kind: "partner_review" }>["prefill"] = { legal_name: name };
  if (ico) prefill.ico = ico;
  if (intent.args.partnerDic) prefill.dic = intent.args.partnerDic;
  if (intent.args.partnerIcDph) prefill.ic_dph = intent.args.partnerIcDph;
  if (intent.args.partnerKind) prefill.kind = intent.args.partnerKind;
  return {
    kind: "partner_review",
    text: t("assistant.partner.review", { name, details: ico ? t("assistant.partner.reviewIco", { ico }) : "" }),
    openLabel: t("assistant.partner.openForm"),
    href: "/obchodni-partneri?new=1",
    prefill,
  };
}
