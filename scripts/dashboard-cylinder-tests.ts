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
  assert.equal(cyl.cylinderMode({ n: 6, reducedMotion: true, geometryOk: true }), "list");
  assert.ok(component.includes("const isCylinder = mode === \"cylinder\";"));
  assert.ok(component.includes("const motion = isCylinder && !paused;"));
  assert.ok(component.includes("if (!isCylinder) {"), "zoznam namiesto valca");
  assert.ok(component.includes('data-cylinder={reducedMotion ? "reduced" : mode === "single" ? "single" : n === 2 ? "pair" : "fallback"}'));
  assert.match(component, /if \(!stage \|\| !motion\) return;\s*const onWheel/, "koliesko vypnuté");
  assert.match(component, /if \(!motion\) return;\s*const onMove/, "ťah vypnutý");
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
  assert.ok(component.includes("el.style.transform = cardCss(tr);"));
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
  assert.ok(component.includes('className="relative isolate min-h-[180px] flex-1 select-none overflow-hidden"'));
});

check("dashboard vypĺňa výšku medzi hlavičkou a spodnou lištou (žiadny prázdny spodok, žiadny scroll stránky)", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes('className="dash-screen flex w-full min-w-0 flex-none flex-col overflow-hidden'));
  assert.ok(dash.includes("<ModuleCylinder"));
  assert.ok(!dash.includes("<ModuleCard"), "stará mriežka dlaždíc je preč");
});

// -----------------------------------------------------------------------------
// ANDROID REGRESIA 2026-10-11 (build 745c833: všetky karty neviditeľné)
// -----------------------------------------------------------------------------

check("ROOT CAUSE guard: sekcia nástenky nemá na mobile flex-1 (flex-basis 0% by prebil height → plocha valca 0 px)", () => {
  const dash = read("app/components/Dashboard.tsx");
  const match = /<section\s+className="(dash-screen[^"]*)"/.exec(dash);
  assert.ok(match, "sekcia s .dash-screen");
  const classes = match![1].split(/\s+/);
  assert.ok(!classes.includes("flex-1"), "žiadne flex-1 na mobile");
  assert.ok(classes.includes("flex-none") && classes.includes("lg:flex-1"));
  assert.ok(!classes.some((c) => c.startsWith("h-[")), "výška iba cez .dash-screen");
  const css = read("app/globals.css");
  assert.match(css, /\.dash-screen \{\s*height: calc\(100vh - var\(--mobile-tabbar-space, 0px\)\);\s*\}/, "100vh fallback pre WebView bez dvh");
  assert.match(css, /@supports \(height: 100dvh\) \{\s*\.dash-screen \{\s*height: calc\(100dvh - var\(--mobile-tabbar-space, 0px\)\);/);
});

check("Android WebView safe: valec je 2D projekcia — žiadne perspective/preserve-3d/translateZ/rotateX/backface", () => {
  assert.ok(!/preserve-3d|backfaceVisibility|backface-visibility|perspective:|rotateX\(/.test(component));
  for (let offset = -3; offset <= 3; offset += 0.5) {
    const css = cyl.cardCss(cyl.cardTransform(offset, 120, 6, V));
    assert.match(css, /^translate3d\(0px, -?\d+(\.\d+)?px, 0px\) scale\(\d+\.\d+, \d+\.\d+\)$/, css);
    assert.ok(!/NaN|Infinity|rotate/.test(css), css);
  }
});

check("focused card je vždy viditeľná: opacity 1, visible, mierka ≥ 1·focusScale, v strede (y = 0), konečné hodnoty", () => {
  for (const variant of [cyl.VARIANT_SUBTLE, cyl.VARIANT_SPATIAL]) {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      for (const h of [96, 120, 140, 176]) {
        const tr = cyl.cardTransform(0, h, n, variant);
        assert.ok(cyl.isFiniteTransform(tr));
        assert.equal(tr.opacity, 1, `${variant.name} n=${n}`);
        assert.equal(tr.visible, true);
        assert.equal(tr.y, 0);
        assert.equal(tr.scale, variant.focusScale);
        assert.match(cyl.cardCss(tr), /^translate3d\(0px, 0\.00px, 0px\)/);
      }
    }
  }
});

check("Android viewporty 360–430 px: kladná výška plochy, platná geometria, fokus celý v ploche, žiadna karta úplne orezaná", () => {
  for (const [width, height] of [[360, 640], [360, 740], [375, 667], [390, 844], [412, 915], [430, 932]]) {
    const tabbar = 56;
    const fixedTop = 12 + 36 + 12 + 40 + 8 + 32; // padding + hlavička + hľadanie + riadok ovládania
    const stageHeight = height - tabbar - fixedTop - 8;
    assert.ok(stageHeight > 0, `${width}×${height}`);
    const cardHeight = Math.round(Math.max(96, Math.min(140, stageHeight / 4.6)));
    const check = cyl.validateCylinderGeometry({ stageHeight, cardHeight, n: 6, variant: V });
    assert.deepEqual(check, { ok: true }, `${width}×${height}: ${JSON.stringify(check)}`);
    const stage = { x: 16, y: 0, width: width - 32, height: stageHeight };
    const focus = { x: 20, y: stageHeight / 2 - cardHeight / 2, width: width - 40, height: cardHeight };
    assert.equal(cyl.visibleRatio(focus, stage), 1);
    for (let offset = -1; offset <= 1; offset++) {
      const tr = cyl.cardTransform(offset, cardHeight, 6, V);
      const scaleY = tr.scale * (0.55 + 0.45 * tr.foreshorten);
      const rect = { x: 20, y: stageHeight / 2 + tr.y - (cardHeight * scaleY) / 2, width: width - 40, height: cardHeight * scaleY };
      assert.ok(cyl.visibleRatio(rect, stage) > 0.5, `${width}×${height} offset ${offset}`);
    }
  }
});

check("fallback pri neplatnej geometrii: 0 px / NaN / príliš nízka plocha / karta vyššia než plocha → bezpečný zoznam", () => {
  assert.deepEqual(cyl.validateCylinderGeometry({ stageHeight: 0, cardHeight: 96, n: 6, variant: V }), { ok: false, reason: "stage_height" });
  assert.deepEqual(cyl.validateCylinderGeometry({ stageHeight: Number.NaN, cardHeight: 96, n: 6, variant: V }), { ok: false, reason: "stage_height" });
  assert.deepEqual(cyl.validateCylinderGeometry({ stageHeight: 120, cardHeight: 96, n: 6, variant: V }), { ok: false, reason: "stage_height" });
  assert.deepEqual(cyl.validateCylinderGeometry({ stageHeight: 400, cardHeight: Number.POSITIVE_INFINITY, n: 6, variant: V }), { ok: false, reason: "card_height" });
  assert.deepEqual(cyl.validateCylinderGeometry({ stageHeight: 400, cardHeight: 500, n: 6, variant: V }), { ok: false, reason: "card_height" });
  assert.equal(cyl.visibleRatio({ x: 0, y: 500, width: 300, height: 100 }, { x: 0, y: 0, width: 300, height: 0 }), 0, "plocha 0 px → karta neviditeľná");
  assert.equal(cyl.visibleRatio({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 300, height: 300 }), 0);
  // komponent: fallback pri chybe geometrie, nekonečných hodnotách aj DOM kontrole fokusu
  assert.ok(component.includes("const check = validateCylinderGeometry({ stageHeight: height, cardHeight: next, n, variant: config });"));
  assert.ok(component.includes('enterFallback("non_finite")'));
  assert.ok(component.includes("if (ratio < 0.6 || !(opacity > 0.5)) {"));
  assert.ok(component.includes('className="relative isolate min-h-[240px] flex-1 overflow-y-auto pb-4 lg:max-w-3xl"'), "zoznam má vlastnú min. výšku");
});

// =============================================================================
// FINÁLNY POLISH 2026-10-11 — produkčné stavy a hrany
// =============================================================================

const fakeModules = (keys: Array<"inbox" | "invoices" | "vehicles" | "machines" | "inventory" | "partners">) =>
  mods.buildDashboardModules({ isVisible: (href) => keys.some((key) => mods.MODULE_ROUTES[key] === href), entitlements: entitlements({}) });

check("1 modul: statická jedna karta (žiadny nekonečný pohyb), tap otvorí modul", () => {
  assert.equal(cyl.cylinderMode({ n: 1, reducedMotion: false, geometryOk: true }), "single");
  const one = fakeModules(["inbox"]);
  assert.equal(one.length, 1);
  assert.deepEqual(mods.cardAction(one[0], 0, 0), { type: "navigate", href: "/ai-evidencia" });
});

check("2 moduly: statický zoznam bez klonov (obe karty viditeľné), 3+ = valec", () => {
  assert.equal(cyl.cylinderMode({ n: 2, reducedMotion: false, geometryOk: true }), "list");
  assert.equal(cyl.cylinderMode({ n: 3, reducedMotion: false, geometryOk: true }), "cylinder");
  assert.equal(cyl.cylinderMode({ n: 6, reducedMotion: false, geometryOk: true }), "cylinder");
  assert.equal(cyl.cylinderMode({ n: 0, reducedMotion: false, geometryOk: true }), "empty");
  // 3 moduly vo valci: obaja susedia viditeľní, žiadny „klon"
  const t1 = cyl.cardTransform(1, 120, 3, V);
  const tm1 = cyl.cardTransform(-1, 120, 3, V);
  assert.ok(t1.visible && tm1.visible);
});

check("všetko zamknuté: valec funguje, nič sa neotvorí ako aktívne, nástenka ukáže CTA", () => {
  const all = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({ invoicing: false, ai_documents: false, vehicles: false, machines: false, inventory: false }) });
  assert.equal(mods.allLocked(all), true);
  all.forEach((module, index) => assert.equal(mods.cardAction(module, index, index).type, "locked"));
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes("{accessReady && everythingLocked && ("));
  assert.ok(dash.includes('t("dashboard.cylinder.allLocked")'));
});

check("mix zamknuté/odomknuté: zamknuté až za aktívnymi; v slučke sa objavia iba po poslednom aktívnom", () => {
  const modules = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({ machines: false }) });
  const lockedIndex = modules.findIndex(mods.isLocked);
  assert.equal(lockedIndex, modules.length - 1, "jediný zamknutý je posledný");
  // fokus štartuje na aktívnom module, nie na zamknutom
  assert.equal(mods.isLocked(modules[cyl.activeIndexFor(0, modules.length)]), false);
  assert.equal(mods.allLocked(modules), false);
});

check("stavy karty: locked vs trial (odlíšené), pending pri načítaní nárokov, loading/error počtov, count", () => {
  const ctx = { entitlementsLoading: false, countsLoading: false, dataError: false };
  assert.deepEqual(mods.moduleStatus({ key: "inbox", access: { state: "locked", reason: "ENTITLEMENT_REQUIRED" } }, ctx), { kind: "locked" });
  assert.deepEqual(mods.moduleStatus({ key: "inbox", access: { state: "locked", reason: "TRIAL_EXPIRED" } }, ctx), { kind: "trial" });
  assert.deepEqual(mods.moduleStatus({ key: "inbox", access: { state: "unknown" } }, { ...ctx, entitlementsLoading: true }), { kind: "pending" }, "načítavanie = neutrálne, nie zámok");
  assert.deepEqual(mods.moduleStatus({ key: "vehicles", access: { state: "active" }, count: 3 }, { ...ctx, countsLoading: true }), { kind: "loading" });
  assert.deepEqual(mods.moduleStatus({ key: "vehicles", access: { state: "active" }, count: 0 }, { ...ctx, dataError: true }), { kind: "error" }, "chyba ≠ „0 vozidiel“");
  assert.deepEqual(mods.moduleStatus({ key: "vehicles", access: { state: "active" }, count: 3 }, ctx), { kind: "count", count: 3 });
  assert.deepEqual(mods.moduleStatus({ key: "invoices", access: { state: "active" } }, ctx), { kind: "none" });
  // chyba počtov nezamkne modul — karta ostáva použiteľná
  const vehicles = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({}) }).find((m) => m.key === "vehicles")!;
  assert.equal(mods.cardAction(vehicles, 0, 0).type, "navigate");
});

check("entitlement loading/error: nikdy falošný zámok; chyba má tichý retry", () => {
  const loading = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: null });
  assert.ok(loading.every((m) => m.access.state === "unknown"));
  const hook = read("hooks/use-company-entitlements.ts");
  assert.ok(hook.includes("error: boolean") && hook.includes("retry: () => {"));
  assert.ok(hook.includes("if (result.error && cache?.promise === promise) cache = null;"), "chyba sa necachuje");
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes("{entitlements.error && ("));
  assert.ok(dash.includes("onClick={entitlements.retry}"));
  assert.ok(dash.includes("entitlements: entitlements.loading ? null : entitlements.snapshot"));
});

check("count loading bez layout shiftu: skeleton s pevnou šírkou a riadok stavu má min. výšku", () => {
  assert.ok(component.includes('className="inline-flex h-5 w-24 animate-pulse rounded-full'));
  assert.ok(component.includes('className="mt-0.5 flex min-h-5 flex-wrap items-center gap-1.5"'));
});

check("rola sa ešte načítava: skeleton (žiadny záblesk 1 modulu), prázdny stav pre rolu bez modulov", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes("{!accessReady ? ("));
  assert.ok(dash.includes('aria-busy="true"'));
  assert.ok(dash.includes('t("dashboard.cylinder.empty")'));
  assert.ok(dash.includes("setAccessReady(true);"));
});

check("zachovanie fokusu: návrat z modulu a zmena poradia nárokov nechajú rovnaký modul", () => {
  const before = fakeModules(["inbox", "invoices", "vehicles", "machines", "inventory", "partners"]);
  const reordered = mods.buildDashboardModules({ isVisible: everyRoute, entitlements: entitlements({ ai_documents: false }) });
  const focusKey = before[3].key; // machines
  const index = mods.focusIndexForKey(reordered, focusKey);
  assert.equal(reordered[index].key, focusKey);
  assert.equal(mods.focusIndexForKey(reordered, "neexistuje"), 0);
  assert.equal(mods.focusIndexForKey(reordered, null), 0);
  assert.equal(mods.isDashboardModuleKey("vehicles"), true);
  assert.equal(mods.isDashboardModuleKey("javascript:alert(1)"), false, "sessionStorage hodnota sa validuje");
  assert.ok(component.includes("const previousKey = keysRef.current[activeRef.current] ?? initialFocusKey;"));
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes('const DASHBOARD_FOCUS_KEY = "esblu.dashboard.focus.v1";'));
  assert.ok(dash.includes("window.sessionStorage.setItem(DASHBOARD_FOCUS_KEY, key);"), "iba session, žiadna DB");
});

check("viewport resize / klávesnica: ResizeObserver prepočíta kartu bez resetu fokusu; fallback sa vracia iba po resize", () => {
  assert.ok(component.includes("const next = cardHeightFor(height, { large, fontScale });"));
  assert.ok(!/useLayoutEffect\(\(\) => \{[^}]*positionRef\.current = 0;/.test(component), "resize nevynuluje pozíciu");
  assert.ok(component.includes('window.addEventListener("resize", retry);'));
  assert.ok(component.includes("timer = setTimeout(exitFallback, 180);"));
  // malá výška po otvorení klávesnice → zoznam; po zatvorení platná geometria
  assert.equal(cyl.validateCylinderGeometry({ stageHeight: 150, cardHeight: cyl.cardHeightFor(150), n: 6, variant: V }).ok, false);
  assert.equal(cyl.validateCylinderGeometry({ stageHeight: 560, cardHeight: cyl.cardHeightFor(560), n: 6, variant: V }).ok, true);
});

check("130 % písmo: karta vyššia (×≤1.3), stále vojde fokus + susedia; nízka karta skryje popis", () => {
  for (const stage of [420, 532, 640, 724]) {
    const normal = cyl.cardHeightFor(stage, { fontScale: 1 });
    const big = cyl.cardHeightFor(stage, { fontScale: 1.3 });
    assert.ok(big >= normal && big <= normal * 1.3 + 1);
    assert.ok(big <= Math.max(96, stage / 3.4) + 1, `${stage}: ${big}`);
    assert.equal(cyl.validateCylinderGeometry({ stageHeight: stage, cardHeight: big, n: 6, variant: V }).ok, true, `stage ${stage}`);
  }
  assert.equal(cyl.isCompactCard(100, 1), true);
  assert.equal(cyl.isCompactCard(130, 1.3), true, "130 % písmo na 130 px karte = kompaktná");
  assert.equal(cyl.isCompactCard(130, 1), false);
  assert.ok(component.includes("text-[1.0625rem]") && component.includes("text-[0.78rem]"), "písmo karty v rem (škáluje s nastavením)");
});

check("dlhé názvy firmy aj preložené popisy SK/DE/EN: orezanie/clamp, popisy modulov ≤ 70 znakov", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes('className="truncate text-[11px] font-medium leading-4 text-muted-esblu">{companyName}</p>'));
  assert.ok(component.includes("line-clamp-2 min-w-0 break-words font-semibold"), "názov modulu max 2 riadky");
  for (const lang of ["sk", "de", "en"]) {
    const dict = read(`lib/i18n/dictionaries/${lang}.ts`);
    const desc = dict.slice(dict.indexOf("      desc: {"), dict.indexOf("      },", dict.indexOf("      desc: {")));
    for (const match of desc.matchAll(/: "([^"]+)"/g)) assert.ok(match[1].length <= 70, `${lang}: ${match[1]}`);
  }
});

check("rýchly swipe a tap vs swipe: max. MAX_FLING_STEPS, vodorovné gesto valec neovláda, ťah neotvorí modul", () => {
  assert.equal(cyl.MAX_FLING_STEPS, 2);
  assert.equal(cyl.snapTarget(0.2, 50, 0), 2);
  assert.equal(cyl.dragAxis(2, 3), null, "pod prahom = ťuknutie");
  assert.equal(cyl.dragAxis(4, 30), "vertical");
  assert.equal(cyl.dragAxis(30, 6), "horizontal");
  assert.ok(component.includes('if (drag.axis === "horizontal") return;'));
  assert.ok(component.includes("suppressClickRef.current = true; // ťah nikdy neotvorí modul"));
});

check("tap na susednú kartu ju privedie dopredu (s haptikou iba pri dotykovom snape), tap na fokus otvorí modul", () => {
  const modules = fakeModules(["inbox", "invoices", "vehicles", "machines", "inventory", "partners"]);
  assert.deepEqual(mods.cardAction(modules[1], 1, 0), { type: "focus", index: 1 });
  assert.deepEqual(mods.cardAction(modules[0], 0, 0), { type: "navigate", href: "/ai-evidencia" });
  assert.ok(component.includes('if (touchSnapRef.current && activeRef.current !== startIndex) haptic("start");'));
  assert.ok(!/onWheel[\s\S]{0,400}touchSnapRef\.current = true/.test(component), "koliesko bez haptiky");
});

check("chat FAB obíde fokusovanú kartu a ovládanie; zostane v hraniciach nad spodnou lištou", () => {
  const bounds = fab.fabBounds({ width: 390, height: 844, safeTop: 24, safeLeft: 0, safeRight: 0, bottomReserve: 56 });
  const bands = [{ top: 380, bottom: 510 }, { top: 140, bottom: 176 }];
  const y = fab.avoidBandsY(420, bands, bounds);
  assert.ok(y + fab.CHAT_FAB_SIZE <= 380 - 8 || y >= 510 + 8, `y=${y}`);
  assert.ok(y >= bounds.minY && y <= bounds.maxY);
  assert.equal(fab.avoidBandsY(bounds.maxY, bands, bounds), bounds.maxY, "predvolená poloha dole je voľná");
  // veľmi malý viewport: nezmestí sa nikam → bezpečne dole (nie cez kartu mimo hraníc)
  const tiny = fab.fabBounds({ width: 320, height: 420, safeTop: 0, safeLeft: 0, safeRight: 0, bottomReserve: 56 });
  const ty = fab.avoidBandsY(200, [{ top: 60, bottom: 400 }], tiny);
  assert.ok(ty >= tiny.minY && ty <= tiny.maxY);
  const fabSrc = read("app/components/mobile/MobileChatFab.tsx");
  assert.ok(fabSrc.includes("window.addEventListener(FAB_AVOID_EVENT, relayout);"));
  assert.ok(fabSrc.includes("setPointerCapture"), "ťah FAB je zachytený na tlačidle — nekoliduje s ťahom valca");
  assert.ok(component.includes("return () => setFabAvoidBands([]);"), "po odchode z nástenky sa zóny zrušia");
});

check("spodná lišta: obsah nástenky nikdy pod ňou (výška = viewport − lišta), safe-area hore", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.dash-screen \{\s*height: calc\(100vh - var\(--mobile-tabbar-space, 0px\)\);/);
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes('style={{ paddingTop: "calc(var(--esblu-safe-top, 0px) + 12px)" }}'));
});

check("hľadanie: vymazanie, Esc späť na valec, Enter zavrie klávesnicu, indikátor načítania, výsledky nahradia valec", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.ok(dash.includes('aria-label={t("dashboard.cylinder.clearSearch")}'));
  assert.ok(dash.includes('if (e.key === "Escape") {'));
  assert.ok(dash.includes("e.currentTarget.blur();"));
  assert.ok(dash.includes("{intentLoading && query.length >= 2 && ("));
  assert.ok(dash.includes("{!query && ("), "valec sa pri hľadaní skryje (výsledky v tej istej ploche)");
  assert.ok(dash.includes('t("dashboard.noResults")'));
});

check("hlas v hľadaní: stavy počúva / spracúva / chyba; jediná implementácia (useVoiceSession)", () => {
  const control = read("app/components/voice/VoiceSessionControl.tsx");
  assert.ok(control.includes('session.status === "error"') && control.includes("SpinnerGlyph"));
  const dash = read("app/components/Dashboard.tsx");
  assert.equal((dash.match(/useVoiceSession\(/g) ?? []).length, 1);
});

check("role-based visibility: valec renderuje IBA moduly povolené rolou (žiadne finančné moduly pre zamestnanca)", () => {
  const employee = mods.buildDashboardModules({ isVisible: (href) => !["/faktury", "/obchodni-partneri", "/priecinky"].includes(href), entitlements: entitlements({}) });
  assert.ok(!employee.some((m) => m.key === "invoices" || m.key === "partners"));
  const accountant = mods.buildDashboardModules({ isVisible: (href) => !["/vozidla", "/stroje", "/sklad"].includes(href), entitlements: entitlements({}) });
  assert.deepEqual(accountant.map((m) => m.key), ["inbox", "invoices", "partners"]);
});

check("bezpečnosť: žiadne analytics/tracking, debug log iba s dôvodom fallbacku (bez dát firmy)", () => {
  const dash = read("app/components/Dashboard.tsx");
  for (const src of [component, dash]) assert.ok(!/gtag|analytics|posthog|mixpanel|segment\.|sentry/i.test(src));
  const logs = component.match(/console\.\w+\([^)]*\)/g) ?? [];
  assert.deepEqual(logs, ['console.debug("[esblu:dashboard] cylinder → list fallback:", reason)']);
});

check("ilustrácie: jednotné svetlo (svetlé hrany), malé súbory, kompaktné súradnice", () => {
  for (const key of ["inbox", "invoices", "vehicles", "machines", "inventory", "partners"]) {
    const svg = read(`public/images/modules/${key}.svg`);
    assert.ok(svg.includes('stroke="#EAF4FF"'), `${key}: svetlá hrana`);
    assert.ok(!/\d\.0[ ,"]/.test(svg), `${key}: bez zbytočných „.0“`);
    assert.ok(svg.length < 10 * 1024, `${key}: ${svg.length} B`);
  }
});

check("indikátor polohy: body pre 2–8 modulov (bez „debug“ čísla), inak kompaktné číslo; ▲/▼ ostávajú", () => {
  assert.equal(cyl.progressDots(6, 2)!.filter((d) => d.active).length, 1);
  assert.equal(cyl.progressDots(1, 0), null);
  assert.equal(cyl.progressDots(9, 0), null);
  assert.ok(component.includes('className="cyl-ctrl" aria-label={labels.previous}'));
});

console.log(`${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
