#!/usr/bin/env python3
"""Esblu — porovnanie platobných kanálov (2026-11-18).

Read-only prepočet bez siete a bez secrets. Spustenie:
    python3 scripts/payment-channel-economics.py            # markdown tabuľky
    python3 scripts/payment-channel-economics.py --check    # sebatest (assert)

Všetky sumy v EUR. Esblu s.r.o. je registrovaná pre DPH iba podľa § 7a (od 16. 11. 2026):
- na vlastný predaj DPH neúčtuje (cena 15,90 € je konečná pre SK B2B),
- z prijatých zdaniteľných služieb od dodávateľa z EÚ (prenesenie daňovej povinnosti) odvádza
  23 % DPH a NEMÁ nárok na odpočet → DPH na poplatkoch je náklad.
Pri sporných položkách (je spracovanie platby oslobodené podľa § 39 / čl. 135 smernice?) počítame
dva scenáre: VAT_ALL (všetky poplatky zdaniteľné) a VAT_BILLING_ONLY (iba Billing/softvér).
Zdroje cien: docs/payment-channels-economics-2026-11-18.md § 1 (stiahnuté 2026-11-18).
"""
from __future__ import annotations

import argparse
import math

VAT = 0.23
PRICE_KOMPLET = 15.90
PRICE_MODULE = 3.90
COMPANIES = (10, 50, 100)

# Variabilný prevádzkový náklad na firmu/mesiac bez platobných poplatkov — odvodené z
# docs/esblu-unit-economics-2026-10-22.md § 22 (marža pri 1000 firmách, hard stop):
# baseline 65,6 % → 5,47 € celkom − 0,05 € fix − 0,81 € platba ≈ 4,60 €; konzervatívny 55,7 % ≈ 6,20 €.
OPS_BASELINE = 4.60
OPS_CONSERVATIVE = 6.20
# Fix: Supabase Pro + staging compute + Vercel Pro ≈ 55 $ ≈ 50 € (§ 3 toho istého dokumentu, overené plány 2026-11-18).
FIX_INFRA = 50.00
# Overhead scenár (GitHub, Claude/Anthropic, schránka, doména, Apple 99 $/rok …) — doklady chýbajú, preto scenár.
FIX_OVERHEAD = 150.00
APPLE_DEV_MONTHLY = 99 / 1.10 / 12  # 99 USD/rok, 1 € = 1,10 $ (konzervatívne)


def stripe_card(price: float, premium_share: float = 0.5) -> dict:
    """Stripe Payments (karta EHP) + Stripe Billing 0,7 %."""
    pct = 0.015 * (1 - premium_share) + 0.028 * premium_share
    processing = price * pct + 0.25
    billing = price * 0.007
    return {"processing": processing, "software": billing}


def stripe_sepa_dd(price: float) -> dict:
    return {"processing": 0.35, "software": price * 0.007}


def stripe_card_no_billing(price: float, premium_share: float = 0.5) -> dict:
    """Vlastný engine Esblu + Stripe PaymentIntents off-session (bez Billing 0,7 %)."""
    d = stripe_card(price, premium_share)
    return {"processing": d["processing"], "software": 0.0}


def comgate_easy(price: float, business_share: float = 0.5) -> dict:
    """Comgate Easy: EÚ spotrebiteľské karty 1 %, firemné 2 %, 4 €/mes. (odpustené nad 4 000 € obratu)."""
    pct = 0.01 * (1 - business_share) + 0.02 * business_share
    return {"processing": price * pct, "software": 0.0}


def sepa_transfer(price: float) -> dict:
    """Prevod na účet + párovanie faktúr. Poplatok banky 0 (Fio); čas sa ukazuje zvlášť."""
    return {"processing": 0.0, "software": 0.0}


def store_net(price_gross: float, commission: float, vat_rate: float = VAT) -> dict:
    """Obchod je predajca spotrebiteľovi: z ceny s DPH odvedie DPH krajiny kupujúceho, potom provízia."""
    net_of_vat = price_gross / (1 + vat_rate)
    fee = net_of_vat * commission
    return {"store_vat": price_gross - net_of_vat, "commission": fee, "payout": net_of_vat - fee}


def vat_on_fees(fees: dict, scenario: str) -> float:
    if scenario == "VAT_ALL":
        return (fees["processing"] + fees["software"]) * VAT
    if scenario == "VAT_BILLING_ONLY":
        return fees["software"] * VAT
    if scenario == "NONE":
        return 0.0
    raise ValueError(scenario)


def channel_row(name: str, price: float, fees: dict, monthly_fixed: float = 0.0) -> dict:
    fee = fees["processing"] + fees["software"]
    return {
        "name": name,
        "fee": fee,
        "vat_all": vat_on_fees(fees, "VAT_ALL"),
        "vat_billing": vat_on_fees(fees, "VAT_BILLING_ONLY"),
        "payout": price - fee,
        "fixed": monthly_fixed,
    }


def channels(price: float) -> list[dict]:
    rows = [
        channel_row("Stripe karta (50 % firemné) + Billing", price, stripe_card(price)),
        channel_row("Stripe karta (100 % firemné) + Billing", price, stripe_card(price, 1.0)),
        channel_row("Stripe SEPA inkaso + Billing", price, stripe_sepa_dd(price)),
        channel_row("Stripe karta bez Billing (vlastný engine)", price, stripe_card_no_billing(price)),
        channel_row("Comgate Easy (50 % firemné)", price, comgate_easy(price), 4.0),
        channel_row("SEPA prevod + faktúra (Fio)", price, sepa_transfer(price)),
    ]
    return rows


def contribution(row: dict, vat_key: str, ops: float) -> float:
    return row["payout"] - row[vat_key] - ops


def break_even(contrib: float, fixed: float) -> int | None:
    if contrib <= 0:
        return None
    return math.ceil(fixed / contrib)


def fmt(x: float) -> str:
    return f"{x:,.2f}".replace(",", " ").replace(".", ",")


def table_per_payment(price: float) -> str:
    out = [f"| kanál (cena {fmt(price)} €) | poplatok € | % z ceny | výplata € | DPH na popl. (všetko) € | DPH (iba softvér) € | fix €/mes. |",
           "|---|---|---|---|---|---|---|"]
    for r in channels(price):
        out.append(f"| {r['name']} | {fmt(r['fee'])} | {fmt(100 * r['fee'] / price)} % | {fmt(r['payout'])} | {fmt(r['vat_all'])} | {fmt(r['vat_billing'])} | {fmt(r['fixed'])} |")
    for label, comm in (("Google Play (15 %, cena 15,90 s DPH)", 0.15), ("App Store SBP (15 %, cena 15,90 s DPH)", 0.15), ("App Store 1. rok bez SBP (26 %)", 0.26)):
        s = store_net(price, comm)
        out.append(f"| {label} | provízia {fmt(s['commission'])} + DPH obchodu {fmt(s['store_vat'])} | {fmt(100 * (price - s['payout']) / price)} % | {fmt(s['payout'])} | 0,00 (?) | 0,00 (?) | 0,00 |")
    return "\n".join(out)


def table_volume() -> str:
    out = ["| kanál | firmy | hrubé € | poplatky € | DPH na popl. € (všetko / softvér) | čistá výplata € | prevádzka € (baseline) | fix € (infra / +overhead) | výsledok € (infra, DPH všetko) | výsledok € (+overhead) | marža % (infra) |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in channels(PRICE_KOMPLET)[:1] + [channels(PRICE_KOMPLET)[2], channels(PRICE_KOMPLET)[5]]:
        for n in COMPANIES:
            gross = PRICE_KOMPLET * n
            fees = r["fee"] * n + r["fixed"]
            vat_all = r["vat_all"] * n
            vat_b = r["vat_billing"] * n
            payout = gross - fees
            ops = OPS_BASELINE * n
            res = payout - vat_all - ops - FIX_INFRA
            res_o = res - FIX_OVERHEAD
            out.append(f"| {r['name']} | {n} | {fmt(gross)} | {fmt(fees)} | {fmt(vat_all)} / {fmt(vat_b)} | {fmt(payout)} | {fmt(ops)} | {fmt(FIX_INFRA)} / {fmt(FIX_INFRA + FIX_OVERHEAD)} | {fmt(res)} | {fmt(res_o)} | {fmt(100 * res / gross)} % |")
    for label, comm in (("Google Play 15 %", 0.15), ("App Store SBP 15 %", 0.15)):
        s = store_net(PRICE_KOMPLET, comm)
        extra = APPLE_DEV_MONTHLY if "App Store" in label else 0.0
        for n in COMPANIES:
            gross = PRICE_KOMPLET * n
            payout = s["payout"] * n
            ops = OPS_BASELINE * n
            res = payout - ops - FIX_INFRA - extra
            out.append(f"| {label} (cena s DPH) | {n} | {fmt(gross)} | {fmt((PRICE_KOMPLET - s['payout']) * n)} | 0 / 0 (?) | {fmt(payout)} | {fmt(ops)} | {fmt(FIX_INFRA + extra)} / {fmt(FIX_INFRA + extra + FIX_OVERHEAD)} | {fmt(res)} | {fmt(res - FIX_OVERHEAD)} | {fmt(100 * res / gross)} % |")
    return "\n".join(out)


def table_break_even() -> str:
    out = ["| kanál | príspevok/firma € (baseline, DPH všetko) | BE infra 50 € | BE +150 € overhead | príspevok konzervatívny € | BE konzerv. (+overhead) |",
           "|---|---|---|---|---|---|"]
    rows = channels(PRICE_KOMPLET)
    for r in rows:
        c = contribution(r, "vat_all", OPS_BASELINE)
        cc = contribution(r, "vat_all", OPS_CONSERVATIVE)
        fixed = FIX_INFRA + r["fixed"]
        out.append(f"| {r['name']} | {fmt(c)} | {break_even(c, fixed)} | {break_even(c, fixed + FIX_OVERHEAD)} | {fmt(cc)} | {break_even(cc, fixed + FIX_OVERHEAD)} |")
    for label, comm, extra in (("Google Play 15 %", 0.15, 0.0), ("App Store SBP 15 %", 0.15, APPLE_DEV_MONTHLY)):
        s = store_net(PRICE_KOMPLET, comm)
        c = s["payout"] - OPS_BASELINE
        cc = s["payout"] - OPS_CONSERVATIVE
        out.append(f"| {label} | {fmt(c)} | {break_even(c, FIX_INFRA + extra)} | {break_even(c, FIX_INFRA + extra + FIX_OVERHEAD)} | {fmt(cc)} | {break_even(cc, FIX_INFRA + extra + FIX_OVERHEAD)} |")
    return "\n".join(out)


def table_module() -> str:
    out = ["| kanál (modul 3,90 €) | poplatok € | z toho fixná časť € | % z ceny | výplata € | DPH všetko € |",
           "|---|---|---|---|---|---|"]
    fixed_part = {"Stripe karta (50 % firemné) + Billing": 0.25, "Stripe karta (100 % firemné) + Billing": 0.25,
                  "Stripe SEPA inkaso + Billing": 0.35, "Stripe karta bez Billing (vlastný engine)": 0.25,
                  "Comgate Easy (50 % firemné)": 0.0, "SEPA prevod + faktúra (Fio)": 0.0}
    for r in channels(PRICE_MODULE):
        out.append(f"| {r['name']} | {fmt(r['fee'])} | {fmt(fixed_part[r['name']])} | {fmt(100 * r['fee'] / PRICE_MODULE)} % | {fmt(r['payout'])} | {fmt(r['vat_all'])} |")
    # ročná platba modulu (12 × 3,90) kartou
    annual = PRICE_MODULE * 12
    a = channel_row("ročne", annual, stripe_card(annual))
    out.append(f"| Stripe karta ročne (46,80 €) | {fmt(a['fee'])} | 0,25 | {fmt(100 * a['fee'] / annual)} % | {fmt(a['payout'])} | {fmt(a['vat_all'])} |")
    return "\n".join(out)


def crossover() -> str:
    stripe = channels(PRICE_KOMPLET)[0]
    stripe_cost = stripe["fee"] + stripe["vat_all"]
    comgate = channels(PRICE_KOMPLET)[4]
    saving = stripe_cost - (comgate["fee"] + comgate["vat_all"])
    impl = 1500.0  # ESTIMATE jednorazová integrácia + právna/účtovná príprava druhého providera
    lines = [
        f"- Stripe (karta 50/50 + Billing + DPH 23 % na celý poplatok) stojí {fmt(stripe_cost)} € na platbu "
        f"= {fmt(stripe_cost / (20 / 60))} min práce pri 20 €/h. Ručné párovanie prevodu nad ~{fmt(stripe_cost / (20 / 60))} min/platbu je drahšie než Stripe.",
        f"- Comgate Easy ušetrí oproti Stripe ~{fmt(saving)} € na platbu (pred fixom 4 €/mes.). Pri odhadovanej jednorazovej "
        f"integrácii {fmt(impl)} € je návratnosť: " + ", ".join(
            f"{n} firiem → {fmt(impl / (saving * n - 4))} mes." for n in (50, 100, 300, 500)),
        f"- Vypustenie Stripe Billing (vlastný engine Esblu + uložená karta off-session) ušetrí {fmt(PRICE_KOMPLET * 0.007 * (1 + VAT))} € na platbu "
        f"(≈ {fmt(PRICE_KOMPLET * 0.007 * (1 + VAT) * 100)} € mesačne pri 100 firmách) — oplatí sa až pri stovkách firiem.",
    ]
    return "\n".join(lines)


def self_check() -> None:
    s = stripe_card(15.90)
    assert abs(s["processing"] - (15.90 * 0.0215 + 0.25)) < 1e-9
    assert abs(s["software"] - 0.1113) < 1e-4
    g = store_net(15.90, 0.15)
    assert abs(g["payout"] - 15.90 / 1.23 * 0.85) < 1e-9
    assert break_even(10.0, 50.0) == 5
    assert break_even(-1.0, 50.0) is None
    print("self-check OK")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        self_check()
        return
    print("### A. Jedna platba — Komplet 15,90 €\n")
    print(table_per_payment(PRICE_KOMPLET))
    print("\n### B. Modul 3,90 € — dopad fixného poplatku\n")
    print(table_module())
    print("\n### C. 10 / 50 / 100 platiacich firiem (mesačne)\n")
    print(table_volume())
    print("\n### D. Bod zvratu (počet firiem)\n")
    print(table_break_even())
    print("\n### E. Kedy sa poradie mení\n")
    print(crossover())


if __name__ == "__main__":
    main()
