// =============================================================================
// Kanonický pricing engine (lib/pricing.ts) + LIMIT_REACHED kontrakt — bez DB.
// DB parita a nároky: scripts/pricing-entitlements-pglite-tests.ts.
//
//   npm run test:pricing-engine
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const P = await import("@/lib/pricing");
const E = await import("@/lib/entitlements");
const { billableVoiceSeconds } = await import("@/lib/voice/billable-seconds");
const { entitlementDenialResponse } = await import("@/lib/entitlements-server");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ") : String(error)}`);
  }
}
const eur = (c: number) => c / 100;
const FOUR = ["vehicles", "machines", "inventory", "invoicing"] as const;

await check("A–E zo zadania: 2 moduly 7,80; 4 moduly 15,60; 5 → Komplet 15,90; Komplet + AI 19,80; secondary 4 moduly → 12,90", () => {
  assert.equal(eur(P.quote({ modules: ["vehicles", "machines"], tier: "primary" }).totalCents), 7.8);
  const b = P.quote({ modules: FOUR, tier: "primary" });
  assert.equal(eur(b.totalCents), 15.6);
  assert.equal(b.plan, "modular");
  const c = P.quote({ modules: [...FOUR, "documents"], tier: "primary" });
  assert.equal(eur(c.totalCents), 15.9);
  assert.equal(c.plan, "complete");
  assert.equal(c.modulesSubtotalCents, 1950);
  const d = P.quote({ modules: [], complete: true, tier: "primary", addons: { ai_40: 1 } });
  assert.equal(eur(d.totalCents), 19.8);
  assert.equal(eur(d.baseCents), 15.9);
  const e = P.quote({ modules: FOUR, tier: "secondary" });
  assert.equal(eur(e.totalCents), 12.9);
  assert.equal(e.plan, "complete");
  assert.equal(e.lines[0].id, "complete_secondary");
});

await check("cap invariant: zákazník NIKDY neplatí za základné moduly viac než Komplet (všetky kombinácie × tier)", () => {
  const all = P.sellableModules(false);
  for (let mask = 0; mask < 1 << all.length; mask++) {
    const mods = all.filter((_, i) => mask & (1 << i));
    for (const tier of ["primary", "secondary"] as const) {
      const q = P.quote({ modules: mods, tier });
      assert.ok(q.baseCents <= P.completePriceCents(tier), `${mods.join("+")} ${tier}`);
      assert.equal(q.baseCents, Math.min(mods.length * 390, P.completePriceCents(tier)));
    }
  }
});

await check("secondary: strop 12,90 (3 moduly 11,70 ostávajú moduly; 4 → Komplet 12,90)", () => {
  assert.equal(P.quote({ modules: ["vehicles", "machines", "inventory"], tier: "secondary" }).plan, "modular");
  assert.equal(eur(P.quote({ modules: ["vehicles", "machines", "inventory"], tier: "secondary" }).totalCents), 11.7);
  assert.equal(eur(P.quote({ modules: [], complete: true, tier: "secondary" }).totalCents), 12.9);
});

await check("previewAddModule: 4 moduly + piaty → súčet 19,50 > 15,90 → odporúčanie Kompletu (nič sa neprepína samo)", () => {
  const p = P.previewAddModule({ modules: FOUR, tier: "primary" }, "documents");
  assert.equal(p.modulesSumAfterCents, 1950);
  assert.equal(p.exceedsCap, true);
  assert.equal(p.completeCents, 1590);
  assert.equal(p.before.plan, "modular");
  assert.equal(p.after.upgradeToCompleteRecommended, true);
  assert.equal(P.previewAddModule({ modules: ["vehicles"], tier: "primary" }, "machines").exceedsCap, false);
});

await check("add-ony: AI 3,90/40, hlas 3,90/60 min, users 4,90/25, eFaktúra 4,90/40 a 9,90/100; mimo stropu; AI bez modulu Dokumenty sa nezapočíta", () => {
  assert.deepEqual(Object.values(P.ADDONS).map((a) => [a.id, a.priceCents, a.units]),
    [["ai_40", 390, 40], ["voice_60", 390, 60], ["users_25", 490, 25], ["einvoice_40", 490, 40], ["einvoice_100", 990, 100]]);
  const q = P.quote({ modules: FOUR, tier: "primary", addons: { users_25: 1, voice_60: 2 } });
  assert.equal(eur(q.totalCents), 15.6 + 4.9 + 7.8);
  const noDocs = P.quote({ modules: ["vehicles"], tier: "primary", addons: { ai_40: 1 } });
  assert.deepEqual(noDocs.rejectedAddons, ["ai_40"]);
  assert.equal(noDocs.totalCents, 390);
  const einvoiceNotLive = P.quote({ modules: [], complete: true, tier: "primary", addons: { einvoice_40: 1 } });
  assert.deepEqual(einvoiceNotLive.rejectedAddons, ["einvoice_40"], "eFaktúra add-on bez live eFaktúry");
  assert.equal(P.quote({ modules: [], complete: true, tier: "primary", addons: { ai_40: 999 } }).addonLines[0].quantity, P.MAX_ADDON_PACKS);
});

await check("eFaktúra: nepredajná, kým nie je live (modul aj Komplet bez eFaktúry); po sprístupnení 20 tx + balíky", () => {
  assert.equal(P.sellableModules().includes("einvoice"), false);
  assert.equal(P.quote({ modules: ["einvoice"], tier: "primary" }).totalCents, 0);
  const keys = P.entitlementTargets({ plan: "complete", modules: [] }).map((t) => t.key);
  assert.equal(keys.includes("einvoice"), false);
  const live = P.entitlementTargets({ plan: "complete", modules: [], einvoiceAvailable: true, addons: { einvoice_40: 1, einvoice_100: 1 } });
  assert.equal(live.find((t) => t.key === "einvoice_transactions")?.limit, 160);
});

await check("limity per firma: Komplet 25 / 40 / 60 / 5 GB; modulárny plán bez hlasu (iba add-on), AI iba s Dokumentmi", () => {
  const t = Object.fromEntries(P.entitlementTargets({ plan: "complete", modules: [] }).map((x) => [x.key, x.limit]));
  assert.deepEqual(t, { ai_documents: 40, inventory: null, invoicing: null, machines: null, storage_mb: 5120, team_members: 25, vehicles: null, voice: null, voice_minutes: 60 });
  const m = Object.fromEntries(P.entitlementTargets({ plan: "modular", modules: ["vehicles"] }).map((x) => [x.key, x.limit]));
  assert.deepEqual(m, { storage_mb: 5120, team_members: 25, vehicles: null });
});

await check("registry: A (5 predajných + eFaktúra), B (súčasti), C (kvóty), D (core: chat, …); chat nie je predajný modul", () => {
  const byCat = (c: string) => P.MODULE_REGISTRY.filter((r) => r.category === c).map((r) => r.id);
  assert.deepEqual(byCat("A_base_module"), ["vehicles", "machines", "inventory", "invoicing", "documents", "einvoice"]);
  assert.ok(byCat("D_core").includes("chat"));
  assert.ok(byCat("C_usage").includes("voice"));
  for (const r of P.MODULE_REGISTRY.filter((x) => x.category === "B_part_of_module")) assert.ok(r.partOf, r.id);
  for (const r of P.MODULE_REGISTRY) for (const route of r.routes) {
    const m = /^\/([a-z-]+)/.exec(route);
    if (m) assert.ok(statSync(path.join("app", m[1])).isDirectory(), `route ${route} existuje`);
  }
});

await check("trial: 14 dní, 25 users, 10 AI, 15 min, 1 GB, bez live eFaktúry, dáta sa nemažú", () => {
  assert.deepEqual(P.TRIAL_OFFER.limits, { users: 25, aiProcessings: 10, voiceMinutes: 15, storageMb: 1024 });
  assert.equal(P.TRIAL_OFFER.days, 14);
  assert.equal(P.TRIAL_OFFER.einvoiceLiveTransactions, false);
  assert.equal(P.TRIAL_OFFER.dataDeletedAfterTrial, false);
});

await check("formát: bez textu o DPH; 15,90 € (sk) / €15.90 (en)", () => {
  assert.equal(P.PRICING_VAT_DISPLAY, "none");
  assert.match(P.formatEurCents(1590, "sk").replace(/\s/g, " "), /^15,90 €$/);
  assert.equal(P.formatEurCents(1590, "en"), "€15.90");
});

await check("jediný pricing engine: v app/ ani lib/ mimo lib/pricing.ts nie sú ceny ani výpočet stropu", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const f = path.join(dir, n);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (/\.(ts|tsx)$/.test(n)) out.push(f);
    }
    return out;
  };
  for (const f of [...walk("app"), ...walk("lib")]) {
    if (f === path.join("lib", "pricing.ts") || f.includes(`${path.sep}i18n${path.sep}`)) continue;
    const src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\b(1590|1290|390)\b\s*[,;)]/, `${f}: hard-coded cena`);
    assert.doesNotMatch(src, /15[.,]90|12[.,]90|3[.,]90/, `${f}: hard-coded cena`);
  }
});

await check("LIMIT_REACHED: DB detail (limit/current) → stav pre UI s ponukou add-onu; nie-limitné odmietnutie = null", () => {
  const err = { message: "ENTITLEMENT_DENIED:AI_PROCESSING_LIMIT_REACHED:ai_documents", details: '{"reason":"AI_PROCESSING_LIMIT_REACHED","key":"ai_documents","limit":40,"current":40}' };
  const d = E.parseEntitlementDenial(err);
  assert.deepEqual(E.limitReachedFrom(d), { code: "LIMIT_REACHED", reason: "AI_PROCESSING_LIMIT_REACHED", key: "ai_documents", used: 40, included: 40,
    addon: { id: "ai_40", units: 40, priceCents: 390 } });
  const v = E.limitReachedFrom(E.parseEntitlementDenial({ message: "ENTITLEMENT_DENIED:VOICE_LIMIT_REACHED:voice_minutes", details: '{"limit":60,"current":60}' }));
  assert.equal(v?.addon?.id, "voice_60");
  const u = E.limitReachedFrom(E.parseEntitlementDenial({ message: "ENTITLEMENT_DENIED:USER_LIMIT_REACHED:team_members", details: '{"limit":25,"current":25}' }));
  assert.equal(u?.addon?.priceCents, 490);
  assert.equal(E.limitReachedFrom(E.parseEntitlementDenial({ message: "ENTITLEMENT_DENIED:ENTITLEMENT_REQUIRED:vehicles" })), null);
  assert.equal(E.parseEntitlementDenial({ message: "ENTITLEMENT_DENIED:X:y" }), null);
});

await check("HTTP 403: entitlementDenialResponse nesie limitReached (čerpanie / zahrnuté / add-on) — žiadne tiché zlyhanie", async () => {
  const res = entitlementDenialResponse("sk", { code: "ENTITLEMENT_DENIED", reason: "VOICE_LIMIT_REACHED", key: "voice_minutes", limit: 60, current: 60 });
  assert.equal(res.status, 403);
  const body = await res.json() as { limitReached?: { used: number; included: number; addon: { id: string } } ; error: string };
  assert.equal(body.limitReached?.used, 60);
  assert.equal(body.limitReached?.included, 60);
  assert.equal(body.limitReached?.addon.id, "voice_60");
  assert.match(body.error, /minúty hlasového ovládania/);
});

await check("hlas: započítané sekundy = usage duration, inak odhad z veľkosti, ohraničené [1, 20] s", () => {
  assert.equal(billableVoiceSeconds({ usageSeconds: 4.25, audioBytes: 999_999 }), 4.25);
  assert.equal(billableVoiceSeconds({ audioBytes: 40_000 }), 10);
  assert.equal(billableVoiceSeconds({ audioBytes: 10 }), 1);
  assert.equal(billableVoiceSeconds({ audioBytes: 8_000_000 }), 20);
});

await check("transcribe route: kvóta minút pred čítaním audia a pred OpenAI; po prepise sa započíta", () => {
  const src = readFileSync("app/api/assistant/transcribe/route.ts", "utf8");
  const cap = src.indexOf("requireVoiceCapacity(req)");
  assert.ok(cap > 0 && cap < src.indexOf("req.formData()") && cap < src.indexOf("client.audio.transcriptions.create("));
  assert.ok(src.indexOf("recordVoiceUsage(") > src.indexOf("client.audio.transcriptions.create("));
});

await check("úložisko: každý klientsky upload do firemného bucketu má predkontrolu kapacity", () => {
  const files = ["app/components/chat/ChatMessageView.tsx", "app/stroje/MachineDetailView.tsx", "app/stroje/page.tsx", "app/ai-evidencia/page.tsx",
    "app/vozidla/VehicleDetailView.tsx", "app/vozidla/page.tsx", "app/sklad/page.tsx", "app/nastavenia/page.tsx"];
  let uploads = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.upload\(/g)) {
      uploads++;
      const before = src.slice(Math.max(0, m.index! - 260), m.index!);
      assert.match(before, /await assertStorageCapacity\(\);/, `${f}@${m.index}`);
    }
  }
  assert.equal(uploads, 14);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
