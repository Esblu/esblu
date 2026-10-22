// =============================================================================
// UI refresh (2026-10-11) — design tokeny a kompaktná komponentová vrstva.
//
// SPUSTENIE
//   npm run test:ui-tokens
//
// Chráni: brand farby z master ikony, WCAG kontrast textu a primárneho
// tlačidla, existenciu .ui-* komponentov, kompaktné výšky ovládacích
// prvkov s dotykovým minimom, a že Nastavenia nepoužívajú staré
// „obrie" triedy ani window.alert.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const css = readFileSync("app/globals.css", "utf8");

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  assert.ok(match, `token --${name}`);
  return match![1].trim();
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

check("brand tokeny = farby master ikony (#0181FD, #1236C8, #38BDF8)", () => {
  assert.equal(token("color-brand-500").toLowerCase(), "#0181fd");
  assert.equal(token("color-brand-deep").toLowerCase(), "#1236c8");
  assert.equal(token("color-brand-sky").toLowerCase(), "#38bdf8");
  assert.equal(token("color-accent-esblu"), "var(--color-brand-600)", "primárna akcia = brand");
  assert.equal(token("color-accent-blue"), "var(--color-brand-500)");
  assert.equal(token("color-focus-ring"), "var(--color-brand-400)");
});

check("WCAG AA: biely text na primárnom tlačidle ≥ 4.5:1", () => {
  assert.ok(contrast("#ffffff", token("color-brand-600")) >= 4.5);
  assert.ok(contrast("#ffffff", token("color-brand-700")) >= 4.5, "hover");
});

check("WCAG AA: text na povrchoch (primary/secondary/muted) ≥ 4.5:1", () => {
  for (const surface of ["color-page-bg", "color-surface-1", "color-surface-2"]) {
    for (const text of ["color-text-primary", "color-text-secondary", "color-text-muted"]) {
      const ratio = contrast(token(text), token(surface));
      assert.ok(ratio >= 4.5, `${text} na ${surface}: ${ratio.toFixed(2)}`);
    }
  }
  assert.ok(contrast(token("color-brand-300"), token("color-surface-1")) >= 4.5, "odkazy");
});

check("kompaktné ovládanie s dotykovým minimom (36 px desktop / 40 px dotyk, riadok 40/44 px)", () => {
  assert.equal(token("control-h"), "2.25rem");
  assert.match(css, /@media \(pointer: coarse\) \{\s*:root \{\s*--control-h: 2\.5rem;/);
  assert.match(css, /--row-min-h: 2.75rem;/, "riadok na dotyk 44 px (iOS HIG minimum)");
});

check("komponentová vrstva .ui-* existuje (button, input, group, row, segmented, switch, badge, notice)", () => {
  for (const cls of ["ui-page", "ui-page-title", "ui-group", "ui-group-label", "ui-row", "ui-input", "ui-label", "ui-btn", "ui-btn-primary", "ui-btn-secondary", "ui-btn-danger", "ui-btn-sm", "ui-segmented", "ui-switch", "ui-badge", "ui-notice", "ui-help"]) {
    assert.ok(new RegExp(`\\.${cls}[\\s{,:\\[]`).test(css), cls);
  }
  assert.match(css, /\.ui-btn:focus-visible \{\s*outline: 2px solid var\(--color-focus-ring\)/, "fokus viditeľný");
  assert.match(css, /prefers-reduced-motion: reduce/);
});

check("radius škála je menšia (karta 14 px, ovládanie 10 px)", () => {
  assert.equal(token("radius-card"), "0.875rem");
  assert.equal(token("radius-control"), "0.625rem");
});

check("Nastavenia: žiadne obrie karty/nadpisy, žiadny window.alert, zoskupený zoznam", () => {
  const page = readFileSync("app/nastavenia/page.tsx", "utf8");
  for (const big of ["rounded-3xl", "sm:p-8", "text-4xl", "sm:text-2xl", "min-h-40", "px-6 py-3"]) {
    assert.ok(!page.includes(big), big);
  }
  assert.ok(!/\balert\(/.test(page.replace(/\/\/.*$/gm, "")), "window.alert");
  assert.ok(page.includes("<SettingsSection") && page.includes("<SettingsDisclosure"));
  // Poradie skupín zo zadania.
  const order = ["settings.language.title", "settings.company.title", "settings.company.logoLabel", "settings.users.title", "settings.password.title", "<PushNotificationSettings", "settings.feedback.title", "settings.legal.title"];
  let last = -1;
  for (const marker of order) {
    const at = page.indexOf(marker, last + 1);
    assert.ok(at > last, `poradie: ${marker}`);
    last = at;
  }
  // Finance Access Hardening ostáva: billing polia iba s financeView.
  assert.ok(page.includes("{myRole && financeView && ("));
  assert.ok(page.includes("{myRole && !financeView && ("));
});

check("zdieľané tlačidlá dokumentovej vrstvy používajú výšku z tokenu", () => {
  const layout = readFileSync("app/components/document/DocumentLayout.tsx", "utf8");
  assert.equal((layout.match(/min-h-\[var\(--control-h\)\]/g) ?? []).length >= 4, true);
  assert.ok(!layout.includes("min-h-11"));
});

check("hlavička dokumentu: bohaté aside nestlačí titulok (register faktúr na desktope)", () => {
  // Regresia na Preview 4e69812: aside s akciami registra faktúr bolo shrink-0
  // bez stropu šírky, zabralo celý riadok a „Register dokladov" sa lámal po písmenách.
  const layout = readFileSync("app/components/document/DocumentLayout.tsx", "utf8");
  assert.ok(layout.includes('{aside && <div className="shrink-0 sm:max-w-[65%] sm:text-right">{aside}</div>}'));
  const faktury = readFileSync("app/faktury/page.tsx", "utf8");
  assert.ok(faktury.includes('<div className="flex flex-wrap gap-2 sm:justify-end">'), "akcie registra sa zalamujú v rámci stropu");
});

console.log(`${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
