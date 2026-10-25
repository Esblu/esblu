#!/usr/bin/env python3
"""Esblu unit economics model (read-only helper, no network, no secrets).

Reads docs/unit-economics/esblu-unit-economics-assumptions-2026-10-22.json and prints
markdown tables used in docs/esblu-unit-economics-2026-10-22.md.
Usage: python3 scripts/unit-economics-model.py [assumptions.json]
All money in EUR excl. VAT. USD costs converted with fx.usd_per_eur.
"""
import json, math, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "docs", "unit-economics", "esblu-unit-economics-assumptions-2026-10-22.json")
A = json.load(open(PATH))
FX = A["fx"]["usd_per_eur"]
def eur(usd): return usd / FX

OA = A["openai_cost_per_action_usd"]
SB = A["supabase"]; VC = A["vercel"]; EI = A["einvoice_efaktura"]; PAY = A["payments"]; CH = A["chat"]

# ---------------------------------------------------------------- per action
def scan_blend(level):
    return 0.85 * OA["scan_document"][level] + 0.10 * OA["scan_vehicle_doc"][level] + 0.05 * OA["scan_vehicle_registration"][level]

def text_command(level):
    """1 písaný príkaz do Intent Engine: deterministický parser je zadarmo; OpenAI
    sa volá iba pri fallbacku (podiel × cena jedného klasifikačného volania)."""
    return OA["text_command_fallback_share"][level] * OA["intent_fallback_call"][level]

def voice_min(level):
    t = A["openai_prices_usd_per_1m"]["gpt-4o-transcribe_per_min"]
    return t + OA["voice_commands_per_audio_min"][level] * OA["voice_fallback_share"][level] * OA["intent_fallback_call"]["typical" if level == "low" else level]

def einv_tx_price(case="worst"):
    return EI["price_per_tx_eur"][case] * EI["monthly_program_multiplier"]

# ---------------------------------------------------------------- chat
def chat(users, rate):
    msgs = users * rate * CH["workdays"]
    fan = CH["connected_share_during_workday"] * users + CH["open_conversation_views_per_msg"]
    rt_msgs = msgs * fan
    recipients = CH["company_channel_share"] * (users - 1) + (1 - CH["company_channel_share"]) * 1
    deliveries = msgs * recipients
    msg_gb = msgs * CH["msg_row_kb_incl_indexes"] / 1024 / 1024
    # notification_deliveries: chat dedupe riadky sa po CH["dedupe_retention_days"] dňoch mažú (telemetry-maintenance)
    dedupe_steady_gb = deliveries * min(1.0, CH["dedupe_retention_days"] / 30) * CH["notification_delivery_row_kb"] / 1024 / 1024
    db_gb = msg_gb + deliveries * CH["notification_delivery_row_kb"] / 1024 / 1024
    rt_egress_gb = rt_msgs * CH["realtime_payload_kb"] / 1024 / 1024
    # push: príjemcovia v paralelných dávkach (lib/push/dispatch.ts, PUSH_USER_CONCURRENCY)
    wall = CH["push_wall_s_base"] + math.ceil(recipients / CH["push_concurrency"]) * CH["push_wall_s_per_recipient"]
    cpu = CH["push_cpu_s_base"] + recipients * CH["push_cpu_s_per_recipient"]
    push_usd = msgs * (wall * VC["function_memory_gb"] / 3600 * VC["provisioned_memory_usd_per_gb_h"]
                       + cpu / 3600 * VC["active_cpu_usd_per_h"]) + msgs / 1e6 * VC["invocations_usd_per_m"]
    o = SB["overage_usd"]
    rt_usd = rt_msgs / 1e6 * o["realtime_per_m_msgs"]
    db_usd = (msg_gb + dedupe_steady_gb) * o["disk_per_gb"]
    eg_usd = rt_egress_gb * o["egress_per_gb"]
    att_gb = msgs * CH["attachment_share"] * CH["attachment_mb"] / 1024
    return dict(msgs=msgs, rt_msgs=rt_msgs, deliveries=deliveries, db_gb=db_gb, msg_gb=msg_gb, dedupe_steady_gb=dedupe_steady_gb, rt_egress_gb=rt_egress_gb,
                att_gb=att_gb, rt_eur=eur(rt_usd), db_eur=eur(db_usd), egress_eur=eur(eg_usd), push_eur=eur(push_usd),
                total_eur=eur(rt_usd + db_usd + eg_usd + push_usd))

# ---------------------------------------------------------------- profile cost (marginal, above included pools)
def profile_cost(p, level="typical", einv_case="worst"):
    o = SB["overage_usd"]
    c = chat(p["users"], p["chat_rate"])
    ai = eur(p["ai_scans"] * scan_blend(level))
    asst = eur(p["text_commands"] * text_command(level))
    voice = eur(p["voice_min"] * voice_min(level))
    storage = eur(p["storage_gb"] * o["storage_per_gb"])
    egress = eur(p["storage_gb"] * p["egress_ratio"] * o["egress_per_gb"])
    einv = p["einvoice_tx"] * einv_tx_price(einv_case)
    vercel = eur(p["vercel_usd"])
    parts = dict(ai_scans=ai, text_commands=asst, voice=voice, chat=c["total_eur"], storage=storage, egress=egress,
                 einvoice=einv, vercel=vercel)
    parts["total"] = sum(parts.values())
    return parts

def fees(price, channel, apple_case="small_business_program_or_after_year1"):
    s = PAY["stripe"]
    if channel == "web":
        pct = s["eea_standard_pct"] * (1 - s["b2b_premium_card_share"]) + s["eea_premium_pct"] * s["b2b_premium_card_share"]
        return price * s["gross_vat_factor"] * pct + s["fixed_eur"] + price * s["gross_vat_factor"] * s["billing_pct"]
    if channel == "google_play":
        return price * PAY["google_play_eea_subscription_pct"]
    if channel == "apple":
        return price * PAY["apple_eu_iap_subscription_pct"][apple_case]
    raise ValueError(channel)

def blended_fee(price):
    return sum(share * fees(price, ch) for ch, share in A["channel_mix"].items())

# ---------------------------------------------------------------- fleet model
def compute_tier(n):
    for limit, tier in A["fixed_scaling_supabase_compute"]:
        if n <= limit: return tier
    return "large"

def apply_caps(p, caps):
    if not caps: return p
    q = dict(p)
    for k, v in caps.items():
        if v is not None and k in q: q[k] = min(q[k], v)
    return q

def addon_packs(p, lp):
    """Koľko add-on balíkov firma potrebuje, ak čerpá nad zahrnuté množstvo (Komplet)."""
    inc = lp["included"]; ad = lp["addons"]
    out = {}
    for key, usage_key in (("ai_scans", "ai_scans"), ("voice_min", "voice_min"), ("users", "users")):
        over = max(0, p[usage_key] - inc[usage_key])
        out[key] = math.ceil(over / ad[key]["units"]) if over > 0 else 0
    return out

def fleet(n, price, mix_name="baseline", level="typical", einv_case="worst", overhead=0.0, users_override=None, ai_mult=1.0, einv_mult=1.0, caps=None, buy_addons=False):
    mix = A["mixes"][mix_name]
    o = SB["overage_usd"]; inc = SB["included"]
    tot = dict(ai=0, cmds_voice=0, einv_var=0, storage_gb=0, egress_gb=0, rt_msgs=0, db_gb=0, push=0, vercel=0, peak_conn=0)
    for pname, share in mix.items():
        p = dict(A["profiles"][pname]); k = n * share
        if users_override: p["users"] = users_override
        p["ai_scans"] *= ai_mult; p["text_commands"] *= ai_mult; p["voice_min"] *= ai_mult
        p["einvoice_tx"] *= einv_mult
        if buy_addons:
            lp = A["launch_pricing"]
            packs = addon_packs(p, lp)
            addon_rev = sum(packs[k] * lp["addons"][k]["eur"] for k in packs)
            tot["addon_rev"] = tot.get("addon_rev", 0) + k * addon_rev
            # eFaktúra nie je live: tx sa do kompletu nepočítajú (0 v cene) — modelujeme ich mimo (einv_mult=0 pri launch)
        p = apply_caps(p, caps)
        c = chat(p["users"], p["chat_rate"])
        tot["ai"] += k * eur(p["ai_scans"] * scan_blend(level))
        tot["cmds_voice"] += k * eur(p["text_commands"] * text_command(level) + p["voice_min"] * voice_min(level))
        tot["einv_var"] += k * p["einvoice_tx"] * einv_tx_price(einv_case)
        tot["storage_gb"] += k * p["storage_gb"]
        tot["egress_gb"] += k * (p["storage_gb"] * p["egress_ratio"] + c["rt_egress_gb"])
        tot["rt_msgs"] += k * c["rt_msgs"]
        tot["db_gb"] += k * (c["msg_gb"] * 12 + c["dedupe_steady_gb"])  # 1 rok správ chatu (bez retencie) + ustálený stav dedupe riadkov (7 dní)
        tot["push"] += k * c["push_eur"]
        tot["vercel"] += k * eur(p["vercel_usd"])
        tot["peak_conn"] += k * p["users"] * CH["connected_share_during_workday"]
    storage = eur(max(0, tot["storage_gb"] - inc["storage_gb"]) * o["storage_per_gb"])
    egress = eur(max(0, tot["egress_gb"] - inc["egress_gb"]) * o["egress_per_gb"])
    realtime = eur(max(0, tot["rt_msgs"] / 1e6 - inc["realtime_msgs_m"]) * o["realtime_per_m_msgs"]
                   + max(0, tot["peak_conn"] - inc["realtime_peak_conn"]) / 1000 * o["realtime_per_1000_peak_conn"])
    disk = eur(max(0, tot["db_gb"] + 0.5 + n * 0.02 - inc["disk_gb"]) * o["disk_per_gb"])
    vercel_usage = max(0, tot["vercel"] + tot["push"] - eur(VC["included_credit_usd"]))
    einv = max(EI["minimum_eur_month"], tot["einv_var"])
    tier = compute_tier(n)
    sb_fixed = eur(SB["pro_plan_usd"] + SB["compute_usd"][tier] + SB["compute_usd"]["micro"] - SB["compute_credit_usd"])
    vc_fixed = eur(VC["pro_usd"] * VC["seats"])
    mrr = n * price + tot.get("addon_rev", 0)
    pay = n * blended_fee(price) + tot.get("addon_rev", 0) * 0.06
    variable = tot["ai"] + tot["cmds_voice"] + storage + egress + realtime + disk + vercel_usage
    cogs = variable + einv + pay
    fixed = sb_fixed + vc_fixed
    contribution = mrr - cogs - fixed - overhead
    return dict(n=n, mrr=mrr, fixed=fixed, tier=tier, ai=tot["ai"], cmds_voice=tot["cmds_voice"], einv=einv,
                storage_egress=storage + egress + disk, realtime=realtime, vercel_usage=vercel_usage, pay=pay,
                variable=variable, contribution=contribution, margin=contribution / mrr if mrr else 0)

def break_even(price, mix="baseline", overhead=0.0, **kw):
    for n in range(1, 5001):
        if fleet(n, price, mix, overhead=overhead, **kw)["contribution"] >= 0: return n
    return None

def fmt(x, d=2): return f"{x:,.{d}f}".replace(",", " ")

# ---------------------------------------------------------------- output
def main():
    out = []
    P = A["prices_eur"]
    out.append("### OpenAI cost per action (USD / EUR)\n")
    out.append("| action | low USD | typical USD | high USD | typical EUR |\n|---|---|---|---|---|")
    rows = [("AI scan blended (85 % doc / 10 % vehicle doc / 5 % TP)", scan_blend),
            ("text command (intent fallback share × call)", text_command),
            ("voice: 1 audio min full chain (transcribe + intents)", voice_min)]
    for name, f in rows:
        out.append(f"| {name} | {f('low'):.4f} | {f('typical'):.4f} | {f('high'):.4f} | {eur(f('typical')):.4f} |")
    for k in ["scan_document", "scan_vehicle_doc", "scan_vehicle_registration", "intent_fallback_call"]:
        v = OA[k]; out.append(f"| {k} (single call chain) | {v['low']:.4f} | {v['typical']:.4f} | {v['high']:.4f} | {eur(v['typical']):.4f} |")
    out.append(f"| voice 5 min full chain | {5*voice_min('low'):.3f} | {5*voice_min('typical'):.3f} | {5*voice_min('high'):.3f} | {eur(5*voice_min('typical')):.3f} |")

    out.append("\n### Internal company chat — monthly cost per company (EUR)\n")
    out.append("| users | usage | msgs/mo | Realtime msgs | push deliveries | message rows MB/mo | dedupe rows steady MB (7 d) | Realtime € | DB € | egress € | push fn € | **total €** |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
    for u in [5, 10, 20]:
        for lbl, r in [("LIGHT 10", 10), ("NORMAL 30", 30), ("HEAVY 100", 100)]:
            c = chat(u, r)
            out.append(f"| {u} | {lbl} | {fmt(c['msgs'],0)} | {fmt(c['rt_msgs'],0)} | {fmt(c['deliveries'],0)} | {c['msg_gb']*1024:.1f} | {c['dedupe_steady_gb']*1024:.1f} | {c['rt_eur']:.3f} | {c['db_eur']:.3f} | {c['egress_eur']:.3f} | {c['push_eur']:.3f} | **{c['total_eur']:.2f}** |")


    out.append("\n### Realtime authorization fan-out — before vs after company filter (platform-wide, per month)\n")
    out.append("Before: every INSERT into chat_messages was evaluated for EVERY connected subscriber of the platform (RLS decided at the end). After: only subscribers of the same company (filter company_id=eq.<active company>).\n")
    out.append("| companies | platform msgs/mo | peak connected | checks before (msgs × all connected) | checks after (Σ company msgs × company connected) | reduction |\n|---|---|---|---|---|---|")
    for n in A["company_counts"]:
        msgs = conn = after = 0.0
        for pname, share in A["mixes"]["baseline"].items():
            p = A["profiles"][pname]; k = n * share
            c = chat(p["users"], p["chat_rate"]); cc = p["users"] * CH["connected_share_during_workday"]
            msgs += k * c["msgs"]; conn += k * cc; after += k * c["msgs"] * cc
        before = msgs * conn
        out.append(f"| {n} | {fmt(msgs,0)} | {fmt(conn,0)} | {before:,.0f} | {after:,.0f} | {before/after:,.0f}× |".replace(",", " "))

    out.append("\n### Profile cost per company / month (EUR, marginal above included pools, typical level, eInvoice worst price)\n")
    keys = ["ai_scans", "text_commands", "voice", "chat", "storage", "egress", "einvoice", "vercel", "total"]
    out.append("| profile | " + " | ".join(keys) + " | total HIGH level |\n|" + "---|" * (len(keys) + 2))
    for pn, p in A["profiles"].items():
        c = profile_cost(p); h = profile_cost(p, "high")
        out.append(f"| {pn} | " + " | ".join(f"{c[k]:.2f}" for k in keys) + f" | {h['total']:.2f} |")

    out.append("\n### Margin per single company by profile and price (web channel, typical) — EUR\n")
    out.append("| profile | cost € | " + " | ".join(f"{p} € margin" for p in P) + " | 9.90 € margin |\n|---|---|" + "---|" * (len(P) + 1))
    for pn, p in A["profiles"].items():
        c = profile_cost(p)["total"]
        cells = []
        for price in P + [A["second_company_price_eur"]]:
            m = price - c - fees(price, "web"); cells.append(f"{m:.2f} ({m/price*100:.0f} %)")
        out.append(f"| {pn} | {c:.2f} | " + " | ".join(cells) + " |")

    out.append("\n### 20-person company (EUR / month)\n")
    variants = {
        "20 users LIGHT":  dict(users=20, ai_scans=25,  text_commands=440,  voice_min=30,  storage_gb=2,  chat_rate=10,  einvoice_tx=10,  egress_ratio=0.3, vercel_usd=0.40),
        "20 users NORMAL": dict(users=20, ai_scans=100, text_commands=1320, voice_min=120, storage_gb=5,  chat_rate=30,  einvoice_tx=50,  egress_ratio=0.3, vercel_usd=0.80),
        "20 users HEAVY":  dict(users=20, ai_scans=300, text_commands=4400, voice_min=500, storage_gb=10, chat_rate=100, einvoice_tx=250, egress_ratio=0.3, vercel_usd=1.20),
    }
    out.append("| variant | cost typical € | cost high € | margin @14.90 web (typ) | @16.90 | @19.90 |\n|---|---|---|---|---|---|")
    for name, p in variants.items():
        c = profile_cost(p)["total"]; h = profile_cost(p, "high")["total"]
        cells = [f"{pr - c - fees(pr,'web'):.2f}" for pr in P]
        out.append(f"| {name} | {c:.2f} | {h:.2f} | " + " | ".join(cells) + " |")
    out.append("\nSame 20-user variants without voice and without eInvoice (core + AI scans + text commands + chat):\n")
    out.append("| variant | cost typical € | margin @14.90 web |\n|---|---|---|")
    for name, p in variants.items():
        q = dict(p, voice_min=0, einvoice_tx=0); c = profile_cost(q)["total"]
        out.append(f"| {name} | {c:.2f} | {14.90 - c - fees(14.90,'web'):.2f} |")

    out.append("\n### Payment / store fee per company per month (EUR)\n")
    out.append("| price | web Stripe | Google Play 15 % | Apple 15 % (SBP / yr 2+) | Apple 26 % (std yr 1) | blended 80/15/5 |\n|---|---|---|---|---|---|")
    for pr in P + [A["second_company_price_eur"]]:
        out.append(f"| {pr:.2f} | {fees(pr,'web'):.2f} | {fees(pr,'google_play'):.2f} | {fees(pr,'apple'):.2f} | {fees(pr,'apple','standard_year1'):.2f} | {blended_fee(pr):.2f} |")

    out.append("\n### eInvoice cost per company (EUR / month, variable part; partner minimum EUR 10 is fixed and shared)\n")
    out.append("| tx / month | best (0.0194 × 1.2) | worst (0.055 × 1.2) | annual prepay worst (0.055) |\n|---|---|---|---|")
    for t in [10, 25, 50, 100, 250, 500, 1000]:
        out.append(f"| {t} | {t*einv_tx_price('best'):.2f} | {t*einv_tx_price('worst'):.2f} | {t*EI['price_per_tx_eur']['worst']:.2f} |")

    for mix in ["baseline", "conservative"]:
        for pr in P:
            out.append(f"\n### Fleet model — price {pr:.2f} €, mix {mix} ({A['mixes'][mix]}) — EUR / month, overhead excluded\n")
            out.append("| companies | MRR | fixed infra | AI scans | text cmds + voice | eInvoice | storage/egress/disk | realtime | Vercel usage | payment fees | contribution | margin |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
            for n in A["company_counts"]:
                f = fleet(n, pr, mix)
                out.append(f"| {n} | {fmt(f['mrr'])} | {fmt(f['fixed'])} ({f['tier']}) | {fmt(f['ai'])} | {fmt(f['cmds_voice'])} | {fmt(f['einv'])} | {fmt(f['storage_egress'])} | {fmt(f['realtime'])} | {fmt(f['vercel_usage'])} | {fmt(f['pay'])} | {fmt(f['contribution'])} | {f['margin']*100:.1f} % |")

    out.append("\n### Price comparison summary (baseline mix, typical; overhead 0)\n")
    out.append("| price | break-even (infra) | BE +50 € overhead | BE +150 € overhead | margin @50 | @100 | @500 | @1000 | @100 conservative mix |\n|---|---|---|---|---|---|---|---|---|")
    for pr in P:
        m = {n: fleet(n, pr)["margin"] * 100 for n in [50, 100, 500, 1000]}
        out.append(f"| {pr:.2f} | {break_even(pr)} | {break_even(pr, overhead=50)} | {break_even(pr, overhead=150)} | {m[50]:.1f} % | {m[100]:.1f} % | {m[500]:.1f} % | {m[1000]:.1f} % | {fleet(100, pr, 'conservative')['margin']*100:.1f} % |")

    out.append("\n### Sensitivity at 100 companies (baseline mix) — gross margin\n")
    out.append("| scenario | 14.90 | 16.90 | 19.90 |\n|---|---|---|---|")
    scen = [("base (typical)", {}),
            ("AI at HIGH cost per action", dict(level="high")),
            ("AI usage ×2 (scans, text commands, voice)", dict(ai_mult=2.0)),
            ("AI usage ×2 at HIGH cost", dict(ai_mult=2.0, level="high")),
            ("every company has 20 users", dict(users_override=20)),
            ("eInvoice usage ×3", dict(einv_mult=3.0)),
            ("eInvoice best price", dict(einv_case="best")),
            ("conservative mix", dict(mix_name="conservative"))]
    for name, kw in scen:
        cells = []
        for pr in P:
            kw2 = dict(kw); mixn = kw2.pop("mix_name", "baseline")
            cells.append(f"{fleet(100, pr, mixn, **kw2)['margin']*100:.1f} %")
        out.append(f"| {name} | " + " | ".join(cells) + " |")


    caps = A["recommended_caps"]
    out.append(f"\n### Recommended fair-use caps applied (no add-on revenue counted) — caps {caps}\n")
    out.append("| price | mix | margin @50 | @100 | @500 | @1000 | break-even (infra) | BE +150 € overhead | @100 AI HIGH cost | @100 eInvoice worst ×3 |\n|---|---|---|---|---|---|---|---|---|---|")
    for pr in P:
        for mixn in ["baseline", "conservative"]:
            m = [fleet(n, pr, mixn, caps=caps)["margin"]*100 for n in [50, 100, 500, 1000]]
            be = break_even(pr, mixn, caps=caps); be150 = break_even(pr, mixn, overhead=150, caps=caps)
            hi = fleet(100, pr, mixn, level="high", caps=caps)["margin"]*100
            e3 = fleet(100, pr, mixn, einv_mult=3.0, caps=caps)["margin"]*100
            out.append(f"| {pr:.2f} | {mixn} | " + " | ".join(f"{x:.1f} %" for x in m) + f" | {be} | {be150} | {hi:.1f} % | {e3:.1f} % |")
    out.append("\nPer-profile cost with caps (typical / high), and margin at 14.90 / 9.90 web:\n")
    out.append("| profile | capped cost typ € | capped cost high € | margin 14.90 typ | margin 14.90 high | margin 9.90 typ | margin 9.90 high |\n|---|---|---|---|---|---|---|")
    for pn, p in A["profiles"].items():
        q = apply_caps(p, caps); c = profile_cost(q)["total"]; h = profile_cost(q, "high")["total"]
        out.append(f"| {pn} | {c:.2f} | {h:.2f} | {14.90-c-fees(14.90,'web'):.2f} | {14.90-h-fees(14.90,'web'):.2f} | {9.90-c-fees(9.90,'web'):.2f} | {9.90-h-fees(9.90,'web'):.2f} |")
    out.append("\n20-user variants with caps:\n")
    out.append("| variant | capped cost typ € | capped cost high € | margin 14.90 typ | margin 14.90 high |\n|---|---|---|---|---|")
    for name, p in variants.items():
        q = apply_caps(p, caps); c = profile_cost(q)["total"]; h = profile_cost(q, "high")["total"]
        out.append(f"| {name} | {c:.2f} | {h:.2f} | {14.90-c-fees(14.90,'web'):.2f} | {14.90-h-fees(14.90,'web'):.2f} |")


    out.append("\n### Lever: prompt caching on the intent-fallback prompt (NOT implemented — recommendation only)\n")
    saved = dict(OA["intent_fallback_call"])
    out.append("| price | mix | margin @100 with caps, no caching | with caching | 20 users HEAVY capped cost typ € no cache → cache |\n|---|---|---|---|---|")
    for pr in P:
        for mixn in ["baseline", "conservative"]:
            a = fleet(100, pr, mixn, caps=caps)["margin"]*100
            c0 = profile_cost(apply_caps(variants["20 users HEAVY"], caps))["total"]
            OA["intent_fallback_call"]["typical"] = OA["intent_fallback_call"]["low"]
            b = fleet(100, pr, mixn, caps=caps)["margin"]*100
            c1 = profile_cost(apply_caps(variants["20 users HEAVY"], caps))["total"]
            OA["intent_fallback_call"].update(saved)
            out.append(f"| {pr:.2f} | {mixn} | {a:.1f} % | {b:.1f} % | {c0:.2f} → {c1:.2f} |")


    # ------------------------------------------------------------------ launch pricing 15.90 (2026-10-26)
    lp = A["launch_pricing"]
    inc = lp["included"]
    launch_caps = {"ai_scans": inc["ai_scans"], "voice_min": inc["voice_min"], "storage_gb": inc["storage_gb"], "einvoice_tx": inc["einvoice_tx"], "users": None, "chat_rate": None, "text_commands": None}
    out.append(f"\n### Launch pricing — Esblu Komplet {lp['complete_eur']:.2f} € (included: {inc}) — margin by mix\n")
    out.append("A) excess usage blocked (hard stop, no add-on revenue); B) excess bought as add-on packs (AI 40 / 3,90 €, voice 60 min / 3,90 €, users 25 / 4,90 €). eFaktúra not live → 0 tx.\n")
    out.append("| mix | mode | margin @50 | @100 | @500 | @1000 | break-even (infra) | BE +150 € overhead | @100 AI HIGH cost |\n|---|---|---|---|---|---|---|---|---|")
    for mixn in ["baseline", "conservative"]:
        for mode, kw in (("A hard stop", dict(caps=launch_caps)), ("B add-ons bought", dict(caps=None, buy_addons=True))):
            m = [fleet(n, lp["complete_eur"], mixn, einv_mult=0.0, **kw)["margin"]*100 for n in [50, 100, 500, 1000]]
            be = next((n for n in range(1, 3001) if fleet(n, lp["complete_eur"], mixn, einv_mult=0.0, **kw)["contribution"] >= 0), None)
            be150 = next((n for n in range(1, 3001) if fleet(n, lp["complete_eur"], mixn, einv_mult=0.0, overhead=150, **kw)["contribution"] >= 0), None)
            hi = fleet(100, lp["complete_eur"], mixn, level="high", einv_mult=0.0, **kw)["margin"]*100
            out.append(f"| {mixn} | {mode} | " + " | ".join(f"{x:.1f} %" for x in m) + f" | {be} | {be150} | {hi:.1f} % |")
    out.append("\nPer profile at 15,90 € (web, typical): cost with hard stop vs. with add-ons bought (revenue includes add-ons)\n")
    out.append("| profile | cost hard-stop € | margin hard-stop € | add-on packs (AI/voice/users) | add-on revenue € | cost full usage € | margin with add-ons € |\n|---|---|---|---|---|---|---|")
    for pn, p in list(A["profiles"].items()) + [(k, dict(v)) for k, v in variants.items()]:
        q = dict(p, einvoice_tx=0)
        capped = profile_cost(apply_caps(q, launch_caps))["total"]
        packs = addon_packs(q, lp)
        rev = sum(packs[k] * lp["addons"][k]["eur"] for k in packs)
        full = profile_cost(q)["total"]
        price = lp["complete_eur"]
        m_cap = price - capped - fees(price, "web")
        m_add = price + rev - full - fees(price + rev, "web")
        out.append(f"| {pn} | {capped:.2f} | {m_cap:.2f} | {packs['ai_scans']}/{packs['voice_min']}/{packs['users']} | {rev:.2f} | {full:.2f} | {m_add:.2f} |")
    out.append(f"\nSecondary company at {lp['secondary_complete_eur']:.2f} € (web, typical, hard stop):\n")
    out.append("| profile | cost € | margin € | margin % |\n|---|---|---|---|")
    for pn, p in A["profiles"].items():
        c = profile_cost(apply_caps(dict(p, einvoice_tx=0), launch_caps))["total"]; pr = lp["secondary_complete_eur"]
        out.append(f"| {pn} | {c:.2f} | {pr - c - fees(pr, 'web'):.2f} | {(pr - c - fees(pr, 'web'))/pr*100:.0f} % |")


    # ------------------------------------------------------------------ J7 corrections (2026-10-26)
    out.append("\n### J7 corrections — Documents-only customer (3,90 €, 10 AI included, +40 AI / 3,90 €)\n")
    out.append("Cost = AI scans (typical / high) + storage/egress pool share + Stripe fee. Users 25 / 5 GB like every paid plan; no voice.\n")
    out.append("| AI scans / month | mode | AI packs | revenue € | cost typ € | margin typ € | margin high € |\n|---|---|---|---|---|---|---|")
    for scans in [5, 10, 25, 50, 100]:
        for mode in ("hard stop", "add-ons bought"):
            packs = 0 if mode == "hard stop" else (math.ceil(max(0, scans - 10) / 40))
            used = min(scans, 10) if mode == "hard stop" else scans
            rev = 3.90 + packs * 3.90
            base = profile_cost(dict(users=3, ai_scans=0, text_commands=50, voice_min=0, storage_gb=1, chat_rate=10, einvoice_tx=0, egress_ratio=0.3, vercel_usd=0.05))["total"]
            ct = base + eur(used * scan_blend("typical")); ch = base + eur(used * scan_blend("high"))
            fee = fees(rev, "web")
            out.append(f"| {scans} | {mode} | {packs} | {rev:.2f} | {ct:.2f} | {rev - ct - fee:.2f} | {rev - ch - fee:.2f} |")
    out.append("\nComplete 15,90 € / secondary 12,90 € allowances are unchanged by the J7 corrections (Komplet 40 AI, 60 min); the launch tables above still apply. Modular plans carry no voice cost (voice only via paid add-on). Expired-trial companies without a plan generate no new storage (0 new uploads).\n")

    # ------------------------------------------------------------------ J8 intent fallback optimization (2026-10-25)
    J = A["intent_fallback_j8"]
    tk = J["tokens_per_call"]; hit = J["cache_hit_rate_estimate"]
    def call_usd(model, inp, cached_hit_rate=0.0, prefix=0):
        pr = J["prices_usd_per_1m"][model]
        out_c = tk["output"] * pr["output"]
        miss = (prefix * pr["cache_write_30m"] + (inp - prefix) * pr["input"]) if cached_hit_rate > 0 else inp * pr["input"]
        hitc = prefix * pr["cached_input"] + (inp - prefix) * pr["input"]
        return (cached_hit_rate * (hitc + out_c) + (1 - cached_hit_rate) * (miss + out_c)) / 1e6
    fs = J["fallback_share"]
    scen = [
        ("A  baseline (model assumption 2026-10-25)", fs["A_model_assumption_2026_10_25"], OA["intent_fallback_call"]["typical"]),
        ("A* baseline re-measured (holdout share, v1 tokens)", fs["A_measured_holdout"], call_usd("gpt-5.6-terra", tk["input_prompt_v1"])),
        ("B  parser fix (holdout share)", fs["B_measured_holdout"], call_usd("gpt-5.6-terra", tk["input_prompt_v1"])),
        ("C  + prompt v2 / output cap", fs["B_measured_holdout"], call_usd("gpt-5.6-terra", tk["input_prompt_v2"])),
        ("D  + prompt caching (80 % hit, write premium on miss)", fs["B_measured_holdout"], call_usd("gpt-5.6-terra", tk["input_prompt_v2"], hit, tk["cacheable_prefix_v2"])),
        ("E  option: gpt-5.6-luna + caching (NOT adopted, benchmark pending)", fs["B_measured_holdout"], call_usd("gpt-5.6-luna", tk["input_prompt_v2"], hit, tk["cacheable_prefix_v2"])),
    ]
    out.append("\n### J8 intent fallback optimization — scenarios (Komplet 15,90 €, web, typical, hard stop)\n")
    out.append("Fallback share applies to written commands AND voice commands (same parser). Heavy = 20 users HEAVY (4 400 written commands, voice capped at 60 min × 12 commands).\n")
    out.append("| scenario | fallback share | USD / call | fallback calls / mo (heavy) | intent cost € / mo (heavy) | heavy total cost € | heavy margin € | C_HEAVY margin € | baseline mix margin @100 |\n|---|---|---|---|---|---|---|---|---|")
    saved_call = dict(OA["intent_fallback_call"]); saved_t = dict(OA["text_command_fallback_share"]); saved_v = dict(OA["voice_fallback_share"])
    heavy = dict(variants["20 users HEAVY"], einvoice_tx=0)
    price = lp["complete_eur"]
    for name, share, call in scen:
        OA["intent_fallback_call"]["typical"] = call
        OA["text_command_fallback_share"]["typical"] = share
        OA["voice_fallback_share"]["typical"] = share
        q = apply_caps(heavy, launch_caps)
        calls = q["text_commands"] * share + q["voice_min"] * OA["voice_commands_per_audio_min"]["typical"] * share
        cost = profile_cost(q)["total"]
        m = price - cost - fees(price, "web")
        ch = profile_cost(apply_caps(dict(A["profiles"]["C_HEAVY"], einvoice_tx=0), launch_caps))["total"]
        fm = fleet(100, price, "baseline", einv_mult=0.0, caps=launch_caps)["margin"] * 100
        out.append(f"| {name} | {share*100:.1f} % | {call:.5f} | {calls:.0f} | {eur(calls*call):.2f} | {cost:.2f} | {m:.2f} | {price - ch - fees(price, 'web'):.2f} | {fm:.1f} % |")
        OA["intent_fallback_call"].update(saved_call); OA["text_command_fallback_share"].update(saved_t); OA["voice_fallback_share"].update(saved_v)
    rest = profile_cost(dict(apply_caps(heavy, launch_caps), text_commands=0, voice_min=0))["total"]
    out.append(f"\nHeavy 20-user cost without written commands and voice: {rest:.2f} € (AI scans 40, chat, storage, egress, Vercel) — the floor no intent optimization can remove.\n")

    out.append("\n### Add-on economics (EUR, typical / high cost)\n")
    out.append("| add-on | unit | cost typical | cost high | proposed price | margin typical | margin high |\n|---|---|---|---|---|---|---|")
    addons = [("+100 AI scans", eur(100*scan_blend('typical')), eur(100*scan_blend('high')), 6.90),
              ("Voice +120 min", eur(120*voice_min('typical')), eur(120*voice_min('high')), 7.90),
              ("Storage +25 GB", eur(25*0.0213 + 25*0.3*0.09), eur(25*0.0213 + 25*1.0*0.09), 2.90),
              ("eInvoice Basic (50 tx)", 50*einv_tx_price('best'), 50*einv_tx_price('worst'), 4.90),
              ("eInvoice Plus (250 tx)", 250*einv_tx_price('best'), 250*einv_tx_price('worst'), 14.90)]
    for name, ct, ch, pr in addons:
        net = pr - fees(pr, "web") + PAY["stripe"]["fixed_eur"]  # add-on billed on same Stripe invoice: no extra fixed fee
        out.append(f"| {name} | 1 | {ct:.2f} | {ch:.2f} | {pr:.2f} | {(net-ct)/pr*100:.0f} % | {(net-ch)/pr*100:.0f} % |")

    out.append("\n### Multi-company: second company at 9.90 € (web, typical)\n")
    out.append("| profile of 2nd company | cost € | fee € | margin € | margin % |\n|---|---|---|---|---|")
    for pn, p in A["profiles"].items():
        c = profile_cost(p)["total"]; fe = fees(9.90, "web")
        out.append(f"| {pn} | {c:.2f} | {fe:.2f} | {9.90-c-fe:.2f} | {(9.90-c-fe)/9.90*100:.0f} % |")
    print("\n".join(out))

if __name__ == "__main__":
    main()
