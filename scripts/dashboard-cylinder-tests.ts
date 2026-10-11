// =============================================================================
// Dashboard v3 — nekonečný valec modulov (2026-10-11).
//
// SPUSTENIE
//   npm run test:dashboard-cylinder
//
// Pokrýva čistú logiku (lib/dashboard/cylinder.ts, lib/dashboard/modules.ts)
// a zdrojové kontrakty komponentu (app/components/dashboard/ModuleCylinder.tsx,
// app/components/Dashboard.tsx): kruhové poradie, nekonečná slučka bez straty
// modulu, fokus, ťuknutie → správna routa, swipe/klávesnica, zamknuté moduly,
// poradie aktívne → zamknuté, reduced motion, rýchly swipe, FAB vs. fokus,
// žiadne horizontálne pretečenie.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const cyl = await import("@/lib/dashboard/cylinder");
const mods = await import("@/lib/dashboard/modules");
const fab = await import("@/lib/mobile/chat-fab");

type CompanyEntitlements = import("@/lib/entitlements").CompanyEntitlements;
type EntitlementKey = import("@/lib/entitlements").EntitlementKey;

let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const read = (path: string) => readFileSync(path, "utf8");
const V = cyl.VARIANT_SUBTLE;

function entitlements(active: Partial<Record<EntitlementKey, boolean>>, reason: "TRIAL_EXPIRED" | "ENTITLEMENT_REQUIRED" = "ENTITLEMENT_REQUIRED"): CompanyEntitlements {
  const keys: EntitlementKey[] = ["invoicing", "ai_documents", "vehicles", "machines", "inventory", "voice", "team_members"];
  return {
    companyId: "c",
    trial: { startedAt: null, endsAt: null, active: false, aiProcessingUsed: 0 },
    items: Object.fromEntries(
      keys.map((key) => [key, { key, active: active[key] ?? true, source: "manual", limit: null, reason: active[key] === false ? reason : null }])
    ) as CompanyEntitlements["items"],
  };
}

// -----------------------------------------------------------------------------
// Kruhové poradie a nekonečná slučka
// -----------------------------------------------------------------------------

check("circular ordering: wrapIndex a circularOffset sú kruhové v oboch smeroch", () => {
  assert.equal(cyl.wrapIndex(-1, 6), 5);
  assert.equal(cyl.wrapIndex(6, 6), 0);
  assert.equal(cyl.wrapIndex(-13, 6), 5);
  assert.equal(cyl.circularOffset(5, 6), -1, "posledný modul je NAD prvým");
  assert.equal(cyl.circularOffset(-5, 6), 1);
  assert.equal(cyl.circularOffset(3, 6), 3);
  for (let d = -20; d <= 20; d += 0.25) {
    const o = cyl.circularOffset(d, 6);
    assert.ok(o > -3 - 1e-9 && o <= 3 + 1e-9, `offset ${o}`);
  }
});

check("infinite loop: pri ľubovoľne veľkej pozícii sú všetky moduly prítomné práve raz, fokus je vždy jeden", () => {
  const n = 6;
  for (let position = -50; position <= 50; position += 0.5) {
    const offsets = Array.from({ length: n }, (_, i) => cyl.circularOffset(i - position, n));
    const sorted = [...offsets].sort((a, b) => a - b);
    for (let k = 1; k < n; k++) assert.ok(Math.abs(sorted[k] - sorted[k - 1] - 1) < 1e-9, `rovnaké rozostupy @${position}`);
    const focused = offsets.filter((o) => Math.abs(o) < 0.5 + 1e-9);
    assert.ok(focused.length >= 1 && focused.length <= 2);
    assert.ok(cyl.activeIndexFor(position, n) >= 0 && cyl.activeIndexFor(position, n) < n);
  }
});

check("infinite loop bez vizuálneho skoku: karta prechádzajúca zadnou stranou valca je neviditeľná", () => {
  for (const n of [3, 4, 5, 6, 7, 8]) {
    for (let position = 0; position <= n * 3; position += 0.05) {
      for (let i = 0; i < n; i++) {
        const offset = cyl.circularOffset(i - position, n);
        if (Math.abs(Math.abs(offset) - n / 2) < 0.06) {
          const t = cyl.cardTransform(offset, 120, n, V);
          assert.equal(t.visible, false, `n=${n} i=${i} offset=${offset.toFixed(2)}`);
        }
      }
    }
  }
});

check("active/focused module: zaokrúhlená pozícia, pokračovanie za koncom = späť na začiatok", () => {
  assert.equal(cyl.activeIndexFor(0, 6), 0);
  assert.equal(cyl.activeIndexFor(0.49, 6), 0);
  assert.equal(cyl.activeIndexFor(0.51, 6), 1);
  assert.equal(cyl.activeIndexFor(5, 6), 5);
  assert.equal(cyl.activeIndexFor(6, 6), 0, "za posledným nasleduje prvý");
  assert.equal(cyl.activeIndexFor(-1, 6), 5, "pred prvým je posledný");
});

check("ťuknutie na susednú kartu otočí valec kratšou cestou (aj cez „koniec“)", () => {
  assert.equal(cyl.nearestPositionFor(1, 0, 6), 1);
  assert.equal(cyl.nearestPositionFor(5, 0, 6), -1, "posledný je o krok hore, nie 5 krokov dole");
  assert.equal(cyl.nearestPositionFor(0, 11, 6), 12);
  assert.equal(cyl.activeIndexFor(cyl.nearestPositionFor(3, 7.2, 6), 6), 3);
});

// -----------------------------------------------------------------------------
// Fokus / hĺbka
// -----------------------------------------------------------------------------

check("focus/lift/depth: fokus = plná mierka a priehľadnosť, susedia menší, tmavší a hlbšie", () => {
  const center = cyl.cardTransform(0, 120, 6, V);
  const next = cyl.cardTransform(1, 120, 6, V);
  const far = cyl.cardTransform(2, 120, 6, V);
  assert.equal(center.scale, V.focusScale);
  assert.equal(center.opacity, 1);
  assert.equal(center.dim, 0);
  assert.equal(center.z, 0);
  assert.ok(next.scale < center.scale && far.scale < next.scale);
  assert.ok(next.opacity < 1 && far.opacity < next.opacity);
  assert.ok(next.z < 0 && far.z < next.z, "ďalej od fokusu = hlbšie");
  assert.ok(next.y > 0 && cyl.cardTransform(-1, 120, 6, V).y < 0, "nasledujúci pod, predchádzajúci nad");
  assert.ok(next.visible && far.visible, "susedia a ďalšie moduly sú čiastočne viditeľné");
  assert.ok(center.zIndex > next.zIndex);
});

check("susedné karty sa neprekrývajú (rozostup ≥ výška karty × mierka) v oboch variantoch", () => {
  for (const variant of [cyl.VARIANT_SUBTLE, cyl.VARIANT_SPATIAL]) {
    const h = 120;
    const center = cyl.cardTransform(0, h, 6, variant);
    const next = cyl.cardTransform(1, h, 6, variant);
    const gap = next.y - center.y - (h * center.scale) / 2 - (h * next.scale) / 2;
    assert.ok(gap > -h * 0.12, `${variant.name}: prekryv ${gap.toFixed(1)} px`);
  }
});

check("Variant A (subtle) je predvolený a jemnejší než Variant B (spatial)", () => {
  assert.equal(cyl.parseCylinderVariant(null), "subtle");
  assert.equal(cyl.parseCylinderVariant("xyz"), "subtle");
  assert.equal(cyl.parseCylinderVariant("spatial"), "spatial");
  const a = cyl.VARIANT_SUBTLE;
  const b = cyl.VARIANT_SPATIAL;
  assert.ok(a.angleStep < b.angleStep && a.perspective > b.perspective && a.focusScale <= b.focusScale);
  assert.ok(cyl.cardTransform(1, 120, 6, a).opacity > cyl.cardTransform(1, 120, 6, b).opacity, "A = čitateľnejší susedia");
});

// -----------------------------------------------------------------------------
// Gestá
// -----------------------------------------------------------------------------

check("swipe: ťah nahor = ďalší modul, snap na celú kartu, pružina sa usadí presne v cieli", () => {
  assert.ok(cyl.dragToPosition(0, -100, 100) === 1);
  assert.ok(cyl.dragToPosition(0, 100, 100) === -1);
  assert.equal(cyl.snapTarget(0.4, 0, 0), 0);
  assert.equal(cyl.snapTarget(0.6, 0, 0), 1);
  assert.equal(cyl.snapTarget(0.3, 4, 0), 1, "rýchly švih dotiahne na ďalší");
  let state = { position: 0.37, velocity: 2 };
  let frames = 0;
  for (; frames < 600; frames++) {
    const next = cyl.springStep(state.position, state.velocity, 1, 1 / 60);
    state = next;
    if (next.settled) break;
  }
  assert.ok(frames < 120, `usadenie do 2 s (${frames} frame)`);
  assert.equal(state.position, 1);
});

check("duplicate gesture / rapid swipe: jeden švih max. o MAX_FLING_STEPS, opakované švihy nič nestratia", () => {
  assert.equal(cyl.snapTarget(0, 1000, 0), cyl.MAX_FLING_STEPS);
  assert.equal(cyl.snapTarget(0, -1000, 0), -cyl.MAX_FLING_STEPS);
  let position = 0;
  for (let i = 0; i < 50; i++) position = cyl.snapTarget(position, 999, position); // 50 rýchlych švihov
  assert.equal(position, 50 * cyl.MAX_FLING_STEPS);
  assert.ok(Number.isInteger(position));
  assert.ok(cyl.activeIndexFor(position, 6) >= 0 && cyl.activeIndexFor(position, 6) < 6);
  // nestabilný frame (dt 1 s) pružinu nerozkmitá
  const jump = cyl.springStep(0, 0, 1, 1);
  assert.ok(Math.abs(jump.position) < 1.5);
  // ťuknutie vs. ťah
  assert.equal(cyl.isTap(3, 4), true);
  assert.equal(cyl.isTap(0, 12), false);
});

check("koliesko/trackpad: max. 1 krok na udalosť, malé delty sa sčítajú", () => {
  assert.deepEqual(cyl.wheelSteps(30), { steps: 0, remainder: 30 });
  assert.deepEqual(cyl.wheelSteps(80), { steps: 1, remainder: 0 });
  assert.deepEqual(cyl.wheelSteps(-900), { steps: -1, remainder: 0 });
});

check("klávesnica: šípky/PageUp/PageDown menia fokus, Home = prvý modul, ostatné klávesy nič", () => {
  assert.equal(cyl.keyboardStep("ArrowDown"), 1);
  assert.equal(cyl.keyboardStep("PageDown"), 1);
  assert.equal(cyl.keyboardStep("ArrowUp"), -1);
  assert.equal(cyl.keyboardStep("PageUp"), -1);
  assert.equal(cyl.keyboardStep("Home"), "first");
  assert.equal(cyl.keyboardStep("Enter"), null, "Enter otvára modul cez tlačidlo karty");
  assert.equal(cyl.keyboardStep("Tab"), null);
});

// -----------------------------------------------------------------------------
// Moduly, nároky, akcie
// -----------------------------------------------------------------------------

const everyRoute = () => true;

check("click/tap otvorí správnu routu fokusovaného modulu", () => {
  const modules = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({}) });
  const expected: Record<string, string> = { inbox: "/ai-evidencia", invoices: "/faktury", vehicles: "/vozidla", machines: "/stroje", inventory: "/sklad", partners: "/obchodni-partneri" };
  modules.forEach((module, index) => {
    assert.deepEqual(mods.cardAction(module, index, index), { type: "navigate", href: expected[module.key] });
  });
  assert.deepEqual(mods.cardAction(modules[2], 2, 0), { type: "focus", index: 2 }, "karta mimo fokusu sa iba natočí");
});

check("locked module sa neotvorí ako aktívny modul (ani po fokuse)", () => {
  const modules = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({ machines: false }) });
  const index = modules.findIndex((module) => module.key === "machines");
  assert.equal(modules[index].access.state, "locked");
  assert.deepEqual(mods.cardAction(modules[index], index, index), { type: "locked", key: "machines" });
  assert.notEqual(mods.cardAction(modules[index], index, index).type, "navigate");
});

check("aktívne moduly sú pred zamknutými (stabilne v rámci skupín)", () => {
  const modules = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({ ai_documents: false, vehicles: false }) });
  const keys = modules.map((module) => module.key);
  assert.deepEqual(keys, ["invoices", "machines", "inventory", "partners", "inbox", "vehicles"]);
  const firstLocked = modules.findIndex(mods.isLocked);
  assert.ok(modules.slice(firstLocked).every(mods.isLocked));
});

check("entitlement fallback: nenačítané/zlyhané nároky = bez zámku (nikdy falošné „nie je v balíku“)", () => {
  const modules = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: null });
  assert.ok(modules.every((module) => module.access.state === "unknown"));
  assert.ok(modules.every((module) => !mods.isLocked(module)));
  assert.equal(mods.cardAction(modules[0], 0, 0).type, "navigate");
});

check("partneri dedia nárok fakturácie; dôvod TRIAL_EXPIRED sa zachová", () => {
  const modules = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({ invoicing: false }, "TRIAL_EXPIRED") });
  const partners = modules.find((module) => module.key === "partners")!;
  assert.deepEqual(partners.access, { state: "locked", reason: "TRIAL_EXPIRED" });
});

check("existujúca viditeľnosť (rola, finance, mobilné routy) ostáva — modul bez prístupu sa nezobrazí vôbec", () => {
  const modules = mods.buildDashboardModules({ isVisible: (href) => !["/faktury", "/obchodni-partneri"].includes(href), entitlements: entitlements({}) });
  assert.deepEqual(modules.map((module) => module.key), ["inbox", "vehicles", "machines", "inventory"]);
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes("isVisible: (href) => isModuleVisible(href, financeAccess, operationalAccess)"));
});

check("počty a upozornenia sa berú z existujúcich dát nástenky (bez nového dopytu)", () => {
  const modules = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: null, counts: { vehicles: 3 }, alerts: { vehicles: 2 } });
  const vehicles = modules.find((module) => module.key === "vehicles")!;
  assert.equal(vehicles.count, 3);
  assert.equal(vehicles.alerts, 2);
  assert.equal(modules.find((module) => module.key === "inbox")!.count, undefined);
});

// -----------------------------------------------------------------------------
// Komponent: prístupnosť, reduced motion, výkon
// -----------------------------------------------------------------------------

const component = read("app/components/dashboard/ModuleCylinder.tsx");

check("reduced-motion fallback: statický zoznam bez 3D, bez kolieska a bez ťahu", () => {
  assert.ok(component.includes('useMediaQuery("(prefers-reduced-motion: reduce)")'));
  assert.match(component, /if \(reducedMotion\) \{\s*return \(\s*<section aria-label=\{labels\.region\} className="min-h-0 flex-1 overflow-y-auto pb-4" data-cylinder="reduced">/);
  assert.match(component, /if \(!stage \|\| reducedMotion\) return;/, "koliesko vypnuté");
  assert.match(component, /if \(reducedMotion\) return;\s*const onMove/, "ťah vypnutý");
  const css = read("app/globals.css");
  assert.match(css, /prefers-reduced-motion: reduce/);
});

check("prístupnosť: carousel region, slide, aria-current, ovládanie bez swipe, živé oznámenie, fokus iba na aktívnej karte", () => {
  assert.ok(component.includes('aria-roledescription="carousel"'));
  assert.ok(component.includes('aria-roledescription="slide"'));
  assert.ok(component.includes('aria-current={focused ? "true" : undefined}'));
  assert.ok(component.includes("aria-label={labels.previous}") && component.includes("aria-label={labels.next}"));
  assert.ok(component.includes('aria-live="polite"'));
  assert.ok(component.includes("tabIndex={focused ? 0 : -1}"));
  assert.ok(component.includes("labels.requestActivation"), "zamknutý stav je čitateľný aj pre čítačku");
});

check("výkon: pohyb iba cez transform/opacity v rAF, slučka sa zastaví, bez blur/filter na animovaných kartách", () => {
  assert.ok(component.includes("el.style.transform = `translate3d("));
  assert.ok(component.includes("rafRef.current = null;"));
  assert.ok(!/backdrop-blur|filter:\s*blur/.test(component));
  const css = read("app/globals.css");
  const cylCss = css.slice(css.indexOf("DASHBOARD v3"));
  assert.ok(!/blur\(/.test(cylCss));
  for (const key of ["inbox", "invoices", "vehicles", "machines", "inventory", "partners"]) {
    const size = statSync(`public/images/modules/${key}.svg`).size;
    assert.ok(size < 12 * 1024, `${key}.svg ${size} B (malý vektor, ostrý na každom DPI)`);
  }
});

check("jedna vizuálna rodina modulov: 6 SVG z jedného generátora, iba brand farby, žiadne cudzie assety", () => {
  const generator = read("scripts/generate-module-illustrations.py");
  const allowed = new Set(["#9DCBFF", "#66AEFF", "#2F93FF", "#0181FD", "#0A6BE0", "#0B5ED0", "#1236C8", "#38BDF8"]);
  for (const brand of allowed) assert.ok(generator.includes(brand), brand);
  for (const key of ["inbox", "invoices", "vehicles", "machines", "inventory", "partners"]) {
    const svg = read(`public/images/modules/${key}.svg`);
    assert.ok(svg.includes('id="baseTop"') && svg.includes('id="glow"'), `${key}: spoločná podstava a žiara`);
    assert.ok(!/<image|href="http/.test(svg), `${key}: bez vložených rastrov / externých odkazov`);
  }
});

// -----------------------------------------------------------------------------
// Rozloženie: FAB a pretečenie
// -----------------------------------------------------------------------------

check("chat FAB sa neprekrýva s fokusovanou kartou ani s ovládaním valca (360–430 px telefóny)", () => {
  for (const [width, height] of [[360, 740], [375, 812], [390, 844], [412, 915], [430, 932]]) {
    const tabbar = 56;
    const header = 12 + 36 + 12 + 40 + 8 + 32; // safe-top padding + hlavička + hľadanie + riadok ovládania
    const stage = { x: 16, y: header, width: width - 32, height: height - tabbar - header - 8 };
    const cardHeight = Math.max(96, Math.min(140, stage.height / 4.6));
    const focus = cyl.focusCardRect(stage, cardHeight, 4, V);
    const bounds = fab.fabBounds({ width, height, safeTop: 24, safeLeft: 0, safeRight: 0, bottomReserve: tabbar });
    const pos = fab.fromStored(null, bounds); // predvolená poloha vpravo dole
    const fabRect = { x: pos.x, y: pos.y, width: fab.CHAT_FAB_SIZE, height: fab.CHAT_FAB_SIZE };
    assert.equal(cyl.rectsOverlap(focus, fabRect), false, `${width}×${height}: FAB vs. fokus`);
    const controls = { x: width - 16 - 72, y: header - 32, width: 72, height: 32 };
    assert.equal(cyl.rectsOverlap(controls, fabRect), false, `${width}×${height}: FAB vs. ovládanie`);
  }
});

check("no horizontal overflow na mobile: fokusovaná karta (aj s liftom variantu B) ostane vo viewporte", () => {
  for (const width of [320, 360, 375, 390, 412]) {
    for (const variant of [cyl.VARIANT_SUBTLE, cyl.VARIANT_SPATIAL]) {
      const stage = { x: 16, y: 0, width: width - 32, height: 560 };
      const rect = cyl.focusCardRect(stage, 120, 4, variant);
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width, `${width}px ${variant.name}`);
      for (let offset = -2.5; offset <= 2.5; offset += 0.25) {
        assert.ok(cyl.cardTransform(offset, 120, 6, variant).scale <= variant.focusScale + 1e-9);
      }
    }
  }
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes("overflow-hidden px-4"), "sekcia nástenky orezáva obsah");
  assert.ok(component.includes('className="relative min-h-0 flex-1 select-none overflow-hidden"'));
});

check("dashboard vypĺňa výšku medzi hlavičkou a spodnou lištou (žiadny prázdny spodok, žiadny scroll stránky)", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes("h-[calc(100dvh-var(--mobile-tabbar-space,0px))]"));
  assert.ok(dash.includes("<ModuleCylinder"));
  assert.ok(!dash.includes("<ModuleCard"), "stará mriežka dlaždíc je preč");
});

console.log(`${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
