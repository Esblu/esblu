// =============================================================================
// Mobile navigácia / vrstvenie — regresia „Viac a Chat presvitajú cez nástenku"
// (build 2026-10-11T16:22:12Z).
//
// SPUSTENIE
//   npm run test:mobile-layering
//
// Príčina: Viac bol priesvitný bottom sheet (bg-black/60 + rounded-t-2xl) nad
// živou nástenkou a karty valca (inline z-index až 100, fade z-[200]) žili
// v koreňovom stacking contexte (stage bez `isolation`), takže sa kreslili
// cez prekrytie. Nástenka zostávala interaktívna (klávesnica, ťah, klik).
//
// Testy kombinujú čistú logiku (chat-fab, cylinder) so zdrojovými kontraktmi
// komponentov (MobileTabBar, Dashboard, ModuleCylinder, ChatShell, FAB).
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fab = await import("@/lib/mobile/chat-fab");
const backStack = await import("@/lib/back-stack");

let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(error);
  }
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const tabBar = read("app/components/mobile/MobileTabBar.tsx");
const dashboard = read("app/components/Dashboard.tsx");
const cylinder = read("app/components/dashboard/ModuleCylinder.tsx");
const chatShell = read("app/chat/ChatShell.tsx");
const chatFab = read("app/components/mobile/MobileChatFab.tsx");
const overlay = read("lib/mobile/screen-overlay.ts");
const backBridge = read("mobile/app/BackButtonBridge.tsx");

/** Vyreže JSX blok Viac obrazovky (od data-testid po koniec súboru). */
function moreScreenBlock(): string {
  const idx = tabBar.indexOf('data-testid="mobile-more-screen"');
  assert.ok(idx > 0, "Viac obrazovka musí mať data-testid=mobile-more-screen");
  const start = tabBar.lastIndexOf("<div", idx);
  return tabBar.slice(start, idx + 40);
}

console.log("\nDashboard → Viac");

check("Viac je nepriehľadná samostatná obrazovka (bg-page-bg), nie priesvitný sheet", () => {
  const block = moreScreenBlock();
  assert.match(block, /bg-page-bg/);
  assert.match(block, /fixed inset-x-0 top-0/);
  assert.ok(!/bg-black\/\d+|bg-transparent|backdrop-blur|opacity-/.test(block));
  assert.ok(!/bg-black\/60/.test(tabBar), "žiadny polopriesvitný backdrop");
  assert.ok(!/rounded-t-2xl/.test(tabBar), "žiadny bottom sheet");
});

check("Viac končí nad bottom nav a rešpektuje safe-area hore", () => {
  const block = moreScreenBlock();
  assert.match(block, /bottom:\s*"var\(--mobile-tabbar-space, 0px\)"/);
  assert.match(block, /paddingTop:\s*"var\(--esblu-safe-top, 0px\)"/);
});

check("Viac je modálna vrstva (role=dialog, aria-modal) → nástenka sa uspí", () => {
  const block = moreScreenBlock();
  assert.match(block, /role="dialog"/);
  assert.match(block, /aria-modal="true"/);
});

check("bottom nav je nepriehľadná (žiadne bg-surface-1/95 ani blur)", () => {
  assert.ok(!/bg-surface-1\/\d+/.test(tabBar));
  assert.ok(!/backdrop-blur/.test(tabBar));
});

console.log("\nNástenka mimo aktívnej obrazovky");

check("useModalLayerOpen sleduje [aria-modal=true] cez MutationObserver", () => {
  assert.match(overlay, /\[aria-modal="true"\]/);
  assert.match(overlay, /MutationObserver/);
  assert.match(overlay, /useSyncExternalStore/);
  assert.match(overlay, /\(\) => false/, "SSR snapshot = false");
});

check("Dashboard je aktívny len na / a bez modálnej vrstvy", () => {
  assert.match(dashboard, /onDashboardRoute = pathname === null \|\| pathname === "" \|\| isMobileDashboardPath\(pathname\)/);
  assert.match(dashboard, /dashboardActive = onDashboardRoute && !modalLayerOpen/);
});

check("dashboard content nie je viditeľný ani interaktívny mimo dashboardu (hidden + inert + aria-hidden)", () => {
  assert.match(dashboard, /hidden=\{!onDashboardRoute\}/);
  assert.match(dashboard, /inert=\{!dashboardActive\}/);
  assert.match(dashboard, /aria-hidden=\{!dashboardActive \|\| undefined\}/);
  assert.match(dashboard, /app-shell-bg relative isolate/);
});

check("valec dostáva paused={!dashboardActive}", () => {
  assert.match(dashboard, /paused=\{!dashboardActive\}/);
});

check("Dashboard → Chat: /chat nie je dashboard routa", () => {
  assert.equal(fab.isMobileDashboardPath("/chat"), false);
  assert.equal(fab.isMobileDashboardPath("/chat/index.html"), false);
  assert.equal(fab.isMobileDashboardPath("/settings"), false);
  assert.equal(fab.isMobileDashboardPath("/"), true);
  assert.equal(fab.isMobileDashboardPath("/index.html"), true);
});

console.log("\nValec — lifecycle");

check("motion = cylinder && !paused (rAF, ťah, klávesnica, koliesko gated)", () => {
  assert.match(cylinder, /const motion = isCylinder && !paused;/);
  const gated = cylinder.match(/if \(!motion\) return;/g) ?? [];
  assert.ok(gated.length >= 3, `očakávané ≥3 motion guardy, nájdené ${gated.length}`);
  assert.match(cylinder, /if \(!stage \|\| !motion\) return;/);
});

check("pauza zastaví rAF, zruší ťah a dotiahne pozíciu (žiadny skok po návrate)", () => {
  const i = cylinder.indexOf("if (!paused) return;");
  assert.ok(i > 0);
  const body = cylinder.slice(i, i + 500);
  assert.match(body, /stopLoop\(\)/);
  assert.match(body, /dragRef\.current = null/);
  assert.match(body, /Math\.round\(targetRef\.current\)/);
  assert.match(body, /velocityRef\.current = 0/);
});

check("pozastavený valec: inert + aria-hidden, žiadny aria-live, žiadny klik", () => {
  assert.match(cylinder, /inert=\{paused\}/);
  assert.match(cylinder, /aria-hidden=\{paused \|\| undefined\}/);
  assert.match(cylinder, /\{!paused && \(/);
  assert.match(cylinder, /if \(paused \|\| suppressClickRef\.current\) return;/);
});

check("pozastavený valec nepublikuje FAB avoid pásy", () => {
  assert.match(cylinder, /if \(hidden \|\| paused \|\| !motion\)/);
});

check("z-index kariet je uzavretý v izolovanom stacking contexte (isolate)", () => {
  const isolates = cylinder.match(/relative isolate/g) ?? [];
  assert.ok(isolates.length >= 2, "carousel aj stage musia mať isolate");
});

check("klávesnica nehýbe valcom počas Viac/Chat: onKeyDown závisí od motion a sekcia je inert", () => {
  assert.match(cylinder, /const onKeyDown = \(event: React\.KeyboardEvent\) => \{\s*if \(!motion\) return;/);
  assert.match(cylinder, /inert=\{paused\}/);
});

console.log("\nFAB");

check("FAB len na dashboarde", () => {
  const base = { loading: false, signedIn: true, humanChat: true, keyboardOpen: false, overlayOpen: false };
  assert.equal(fab.shouldShowChatFab({ ...base, pathname: "/" }), true);
  for (const p of ["/chat", "/settings", "/documents", "/more"]) {
    assert.equal(fab.shouldShowChatFab({ ...base, pathname: p }), false, p);
  }
});

check("FAB skrytý pri Viac/dialógu (overlayOpen) aj pri otvorenej klávesnici", () => {
  const base = { loading: false, signedIn: true, humanChat: true, keyboardOpen: false, overlayOpen: false, pathname: "/" };
  assert.equal(fab.shouldShowChatFab({ ...base, overlayOpen: true }), false);
  assert.equal(fab.shouldShowChatFab({ ...base, keyboardOpen: true }), false);
  assert.match(chatFab, /aria-modal/);
});

console.log("\nAndroid Back a návrat");

check("Android Back najprv zavrie vrchnú vrstvu (Viac) a vráti dashboard", () => {
  assert.match(backBridge, /if \(closeTopLayer\(\)\) return;/);
  assert.match(tabBar, /pushLayer/);
  let closed = false;
  const release = backStack.pushLayer(() => {
    closed = true;
  });
  assert.equal(backStack.closeTopLayer(), true);
  assert.equal(closed, true);
  release?.();
  assert.equal(backStack.closeTopLayer(), false);
});

check("Back z /chat → history.back (dashboard sa obnoví ako routa)", () => {
  assert.match(backBridge, /window\.history\.back\(\)/);
});

check("fokusovaný modul sa obnoví po návrate (sessionStorage)", () => {
  assert.match(dashboard, /DASHBOARD_FOCUS_KEY = "esblu\.dashboard\.focus\.v1"/);
  assert.match(dashboard, /sessionStorage\.getItem\(DASHBOARD_FOCUS_KEY\)/);
  assert.match(dashboard, /sessionStorage\.setItem\(DASHBOARD_FOCUS_KEY, key\)/);
});

console.log("\nChat obrazovka");

check("Chat má nepriehľadné vlastné pozadie a izolovaný stacking context", () => {
  assert.match(chatShell, /app-shell-bg relative isolate min-h-\[calc\(100dvh-var\(--mobile-tabbar-space,0px\)\)\][^"]*bg-page-bg/);
  assert.ok(!/bg-transparent/.test(chatShell));
});

check("chat výška = dvh − tab bar (klávesnica zmenší viewport, nič pod ním neodhalí)", () => {
  assert.match(chatShell, /100dvh-var\(--mobile-tabbar-space,0px\)/);
});

check("žiadna obsahová obrazovka nemá priesvitné pozadie", () => {
  for (const [name, src] of [["MobileTabBar", tabBar], ["ChatShell", chatShell]] as const) {
    assert.ok(!/bg-black\/[1-8]\d\b/.test(src), `${name}: polopriesvitné čierne pozadie`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
