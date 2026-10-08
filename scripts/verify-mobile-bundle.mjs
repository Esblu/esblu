#!/usr/bin/env node
// =============================================================================
// scripts/verify-mobile-bundle.mjs — overenie SKUTOČNÉHO mobilného bundlu
// (Mobile M1, 2026-09-28).
//
// Kontroluje hotový statický export (predvolene mobile/out), alebo assets,
// ktoré `npx cap sync android` skopíroval do natívneho projektu:
//
//   node scripts/verify-mobile-bundle.mjs
//   node scripts/verify-mobile-bundle.mjs mobile/android/app/src/main/assets/public
//
// Nekontroluje zdrojový kód, ale to, čo WebView na telefóne naozaj načíta:
//   - natívny prepínač IS_MOBILE_BUILD je v bundli zapečený ako `true`,
//   - plávajúci chat (FloatingChatWidget) je v natívnom builde vypnutý,
//   - spodná navigácia (MobileTabBar) je v layoute, ktorý načítava KAŽDÁ
//     stránka modulu (vrátane detailu vozidla),
//   - všetky M1 stránky existujú, bez demo videa / .well-known / apex hostu,
//   - vypíše build ID — to isté musí byť v appke (Viac → spodný riadok).
// Výstup: zoznam kontrol a exit 1 pri akomkoľvek zlyhaní.
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "mobile/out");
const chunksDir = path.join(dir, "_next", "static", "chunks");
const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok: Boolean(ok), detail });

if (!existsSync(dir)) {
  console.error(`Bundle neexistuje: ${dir}`);
  process.exit(2);
}

const chunkFiles = existsSync(chunksDir) ? readdirSync(chunksDir).filter((f) => f.endsWith(".js")) : [];
const chunk = new Map(chunkFiles.map((f) => [f, readFileSync(path.join(chunksDir, f), "utf8")]));
const chunksWith = (needle) => [...chunk.entries()].filter(([, src]) => src.includes(needle)).map(([f]) => f);
const htmlScripts = (file) =>
  [...readFileSync(path.join(dir, file), "utf8").matchAll(/\/_next\/static\/chunks\/([^"']+\.js)/g)].map((m) => m[1]);

// 0. Bundler (Mobile Platform 2026-10-08). Kontroly nižšie čítajú TURBOPACK
//    výstup (`next build` v Next 16 = Turbopack; mobile/package.json "build").
//    Bundle z `next build --webpack` má iný tvar exportov a chunkov — kontroly
//    by hlásili falošné zlyhania. Preto sa bundler overí ako prvý a pri
//    inom bundleri sa skončí jasnou správou, nie 23 falošnými FAIL.
const turbopackChunks = chunksWith("globalThis.TURBOPACK");
if (chunkFiles.length > 0 && turbopackChunks.length === 0) {
  console.error("FAIL  bundle NIE JE z Turbopacku (pravdepodobne `next build --webpack`).");
  console.error("      Produkčný mobilný build je `npm run build -w mobile` (Turbopack) — postav ho tak a spusti overenie znova.");
  process.exit(3);
}
check("bundle je z Turbopacku (produkčný `next build`)", turbopackChunks.length > 0, `${turbopackChunks.length} chunkov`);

// 0b. Žiadne absolútne cesty build stroja (napr. ESBLU_LEGAL_CONTENT_ROOT cez `env`).
const LOCAL_PATH = /(?:\/home\/[a-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/|[A-Z]:\\\\Users\\\\|\/sessions\/[a-z0-9-]+\/|\/private\/var\/folders\/)/;
const leaking = [...chunk.entries()].filter(([, src]) => LOCAL_PATH.test(src)).map(([f]) => f);
const htmlLeaks = [];
(function scan(p) {
  for (const name of readdirSync(p)) {
    const full = path.join(p, name);
    if (statSync(full).isDirectory()) scan(full);
    else if (/\.(html|txt|json)$/.test(name) && LOCAL_PATH.test(readFileSync(full, "utf8"))) htmlLeaks.push(path.relative(dir, full));
  }
})(dir);
check("bez lokálnych ciest build stroja v JS/HTML", leaking.length === 0 && htmlLeaks.length === 0, [...leaking, ...htmlLeaks].join(", "));
check("bez ESBLU_LEGAL_CONTENT_ROOT v bundli", chunksWith("ESBLU_LEGAL_CONTENT_ROOT").length === 0);

// 1. Natívny prepínač zapečený ako true (a nikde ako false).
const flagTrue = chunksWith('"IS_MOBILE_BUILD",0,!0');
const flagFalse = chunksWith('"IS_MOBILE_BUILD",0,!1');
check("IS_MOBILE_BUILD je v bundli true", flagTrue.length > 0 && flagFalse.length === 0, `true v ${flagTrue.length}, false v ${flagFalse.length}`);

// 2. Plávajúci chat je v natívnom builde vypnutý.
const widget = chunksWith("esblu.chat.bubble.position.v1");
const widgetGated = widget.some((f) => /IS_MOBILE_BUILD\?null:/.test(chunk.get(f)));
check("FloatingChatWidget je v appke vypnutý (IS_MOBILE_BUILD ? null)", widget.length > 0 && widgetGated, widget.join(", "));

// 3. Spodná navigácia je v chunkoch, ktoré načítavajú stránky modulov.
const tabbarChunks = new Set(chunksWith("--mobile-tabbar-space").filter((f) => chunk.get(f).includes("nav.mainNavigation")));
check("MobileTabBar je v bundli", tabbarChunks.size > 0, [...tabbarChunks].join(", "));
const modulePages = [
  "index.html",
  "vozidla.html",
  "vozidla/detail.html",
  "stroje.html",
  "stroje/detail.html",
  "sklad.html",
  "sklad/detail.html",
  "ai-evidencia.html",
  "faktury.html",
  "faktury/detail.html",
  "faktury/new.html",
  "obchodni-partneri.html",
  "obchodni-partneri/detail.html",
  "priecinky.html",
  "priecinky/detail.html",
  "chat.html",
  "nastavenia.html",
];
for (const page of modulePages) {
  const exists = existsSync(path.join(dir, page));
  const loadsTabbar = exists && htmlScripts(page).some((f) => tabbarChunks.has(f));
  check(`${page}: existuje a načítava spodnú navigáciu`, exists && loadsTabbar, exists ? "" : "chýba");
}

// 4. Detail vozidla je M1 verzia (kompaktné upozornenia + posúvateľné záložky).
const vehicleChunks = htmlScripts("vozidla/detail.html");
const vehicleSrc = vehicleChunks.map((f) => chunk.get(f) ?? "").join("\n");
check("detail vozidla: kompaktné upozornenia (vehicles.detail.deadlineOverdue)", vehicleSrc.includes("vehicles.detail.deadlineOverdue"));
check("detail vozidla: posúvateľné záložky (scroll-tabs)", vehicleSrc.includes("scroll-tabs"));

// 4b. Oprava vodorovného pretečenia (real-device bug 2026-09-28).
check("detail vozidla: PageShell má w-full min-w-0", vehicleSrc.includes("relative mx-auto w-full min-w-0"));
// scrollIntoView je aj v rámci Next/React chunkov — kontroluje sa iba chunk ScrollTabs.
const tabsChunks = [...new Set(vehicleChunks)].filter((f) => (chunk.get(f) ?? "").includes("scroll-tabs -mx-1 flex min-w-0"));
check(
  "detail vozidla: ScrollTabs (min-w-0) bez scrollIntoView — posúva iba vlastný pás",
  tabsChunks.length > 0 && tabsChunks.every((f) => !/scrollIntoView/.test(chunk.get(f))),
  tabsChunks.join(", ")
);
const cssDir = path.join(dir, "_next", "static", "css");
const cssFiles = existsSync(cssDir) ? readdirSync(cssDir).filter((f) => f.endsWith(".css")) : [];
const chunkCss = existsSync(chunksDir) ? readdirSync(chunksDir).filter((f) => f.endsWith(".css")) : [];
const cssSrc = [
  ...cssFiles.map((f) => readFileSync(path.join(cssDir, f), "utf8")),
  ...chunkCss.map((f) => readFileSync(path.join(chunksDir, f), "utf8")),
].join("\n");
check("CSS: .scroll-tabs má contain:inline-size", /\.scroll-tabs\{[^}]*contain:inline-size/.test(cssSrc), [...cssFiles, ...chunkCss].join(", "));
check("CSS: natívna appka má overflow-x:clip na html/body", /html\[data-esblu-runtime="?native-app"?\][^{]*\{[^}]*overflow-x:clip/.test(cssSrc));

// 5. Bez nepotrebných/nebezpečných súčastí.
check("bez demo videa (video/)", !existsSync(path.join(dir, "video")));
check("bez .well-known/", !existsSync(path.join(dir, ".well-known")));
const apex = chunksWith("https://esblu.com");
check("bez apex hostu https://esblu.com v JS", apex.length === 0, apex.join(", "));
const viewport = readFileSync(path.join(dir, "vozidla/detail.html"), "utf8").match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? "";
check("viewport = width=device-width, initial-scale=1", /width=device-width/.test(viewport) && /initial-scale=1/.test(viewport), viewport);

// 6. Build ID.
const buildIds = new Set();
for (const src of chunk.values()) {
  for (const m of src.matchAll(/NEXT_PUBLIC_ESBLU_BUILD_ID|"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/g)) if (m[1]) buildIds.add(m[1]);
}
const sizeOf = (p) => {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((sum, name) => sum + sizeOf(path.join(p, name)), 0);
};

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "OK  " : "FAIL"}  ${r.label}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\nBundle: ${dir}`);
console.log(`Veľkosť: ${(sizeOf(dir) / 1024 / 1024).toFixed(1)} MB, HTML stránok: ${countHtml(dir)}`);
console.log(`Build ID v bundli: ${[...buildIds].join(", ") || "(žiadny — build pred M1 opravou)"}`);
console.log(failed ? `\n${failed} kontrol ZLYHALO` : "\nVšetky kontroly prešli.");
process.exit(failed ? 1 : 0);

function countHtml(p) {
  let n = 0;
  for (const name of readdirSync(p)) {
    const full = path.join(p, name);
    if (statSync(full).isDirectory()) n += countHtml(full);
    else if (name.endsWith(".html")) n++;
  }
  return n;
}
