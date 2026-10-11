// =============================================================================
// Nekonečný vertikálny „valec" modulov nástenky — ČISTÁ matematika (bez DOM).
//
// MODEL
// -----
// `position` je spojité, NEOHRANIČENÉ reálne číslo (0, 1.4, -7.2 …). Modul s
// indexom i má voči nemu kruhový posun
//
//     offset(i) = circularOffset(i - position, n)  ∈ (-n/2, n/2]
//
// a jeho poloha na valci je uhol  θ = offset · angleStep. Žiadny modul sa
// nekopíruje ani neklonuje a pozícia sa nikdy „nepreskočí" späť na 0 —
// preto infinite loop nemá vizuálny skok: karta, ktorá prechádza zadnou
// stranou valca (|offset| ≈ n/2), je v tej chvíli neviditeľná
// (visibleRange < n/2 - 0.5).
//
// 3D: karta leží na plášti valca s polomerom R (os valca je vodorovná):
//     y = R · sin θ,   z = R · (cos θ − 1),   rotateX(−θ)
// plus jemná zmena mierky/priehľadnosti podľa vzdialenosti od fokusu.
// Všetko sú iba transform + opacity (GPU, bez layoutu).
// =============================================================================

export type CylinderVariantName = "subtle" | "spatial";

export type CylinderVariant = {
  name: CylinderVariantName;
  /** Uhol medzi susednými kartami (stupne). */
  angleStep: number;
  /** Polomer valca ako násobok výšky karty. */
  radiusFactor: number;
  /** CSS perspective (px). */
  perspective: number;
  /** Zmenšenie mierky na jeden krok od fokusu. */
  scaleFalloff: number;
  /** Pokles priehľadnosti na jeden krok od fokusu. */
  opacityFalloff: number;
  /** Stmavnutie (0–1) na jeden krok od fokusu (overlay, nie CSS filter). */
  dimFalloff: number;
  /** „Lift" fokusovanej karty: mierka v strede. */
  focusScale: number;
  /** Max. viditeľný posun (počet kariet nad/pod fokusom). */
  maxVisible: number;
};

/**
 * VARIANT A — „subtle" (ODPORÚČANÝ, predvolený): menšia perspektíva, čitateľnosť
 * susedných kariet, business/SaaS pocit. Mierka fokusu 1.0 → žiadne pretečenie.
 */
export const VARIANT_SUBTLE: CylinderVariant = {
  name: "subtle",
  angleStep: 21,
  // R·sin(21°) ≈ 0.99·H → susedné karty sa dotýkajú hranou, neprekrývajú sa
  // (overené v reálnom Chromiu na 375 px, 2026-10-11).
  radiusFactor: 2.75,
  perspective: 1400,
  // Finálny polish 2026-10-11: susedia čitateľní (opacity ≈ 0.82), ale
  // zreteľne „za" fokusom (mierka 0.92, stmavnutie 0.26) — fokus dominuje.
  scaleFalloff: 0.08,
  opacityFalloff: 0.18,
  dimFalloff: 0.26,
  focusScale: 1,
  maxVisible: 2.6,
};

/**
 * VARIANT B — „spatial": výraznejšia hĺbka a lift fokusu (prémiovejší „wow"),
 * horšia čitateľnosť kariet mimo fokusu. Zapína sa `?cylinder=spatial`.
 */
export const VARIANT_SPATIAL: CylinderVariant = {
  name: "spatial",
  angleStep: 30,
  radiusFactor: 2.0, // R·sin(30°) = 1.0·H
  perspective: 900,
  scaleFalloff: 0.12,
  opacityFalloff: 0.32,
  dimFalloff: 0.3,
  focusScale: 1.03,
  maxVisible: 2.3,
};

export const CYLINDER_VARIANTS: Record<CylinderVariantName, CylinderVariant> = {
  subtle: VARIANT_SUBTLE,
  spatial: VARIANT_SPATIAL,
};

export function parseCylinderVariant(value: string | null | undefined): CylinderVariantName {
  return value === "spatial" ? "spatial" : "subtle";
}

/** Matematické modulo do [0, n). */
export function wrapIndex(index: number, n: number): number {
  if (n <= 0) return 0;
  return ((Math.round(index) % n) + n) % n;
}

/** Kruhový posun do intervalu (-n/2, n/2]. */
export function circularOffset(delta: number, n: number): number {
  if (n <= 1) return n === 1 ? delta - Math.round(delta) : 0;
  let d = ((delta % n) + n) % n; // [0, n)
  if (d > n / 2) d -= n;
  return d;
}

/** Index modulu vo fokuse pre danú spojitú pozíciu. */
export function activeIndexFor(position: number, n: number): number {
  return wrapIndex(Math.round(position), n);
}

/**
 * Najbližšia pozícia (celé číslo) zobrazujúca modul `index`, idúc kratšou
 * cestou z aktuálnej pozície — ťuknutie na susednú kartu valec iba pootočí.
 */
export function nearestPositionFor(index: number, position: number, n: number): number {
  if (n <= 0) return 0;
  const base = Math.round(position);
  return base + circularOffset(index - wrapIndex(base, n), n);
}

/**
 * Koľko kariet nad/pod fokusom je vidieť. Musí byť < n/2, inak by karta
 * prechádzajúca „zadnou stranou" valca bola viditeľná pri preskoku zo spodku
 * na vrch (vizuálny jump).
 */
export function visibleRange(n: number, variant: CylinderVariant): number {
  if (n <= 1) return 0.5;
  return Math.max(0.6, Math.min(variant.maxVisible, n / 2 - 0.5));
}

export type CardTransform = {
  /** Posun Y (px) od stredu viewportu. */
  y: number;
  /** Posun Z (px, ≤ 0). */
  z: number;
  /** Natočenie okolo osi X (stupne). */
  rotateX: number;
  scale: number;
  opacity: number;
  /** Stmavnutie overlayom (0–1). */
  dim: number;
  zIndex: number;
  visible: boolean;
  /** Dá sa na kartu ťuknúť (iba viditeľné a dostatočne čitateľné). */
  interactive: boolean;
  /** cos θ (0–1) — zvislé „skrátenie" karty natočenej po plášti (2D projekcia). */
  foreshorten: number;
};

export function cardTransform(offset: number, cardHeight: number, n: number, variant: CylinderVariant): CardTransform {
  const range = visibleRange(n, variant);
  const distance = Math.abs(offset);
  const theta = (offset * variant.angleStep * Math.PI) / 180;
  const radius = cardHeight * variant.radiusFactor;
  const lift = Math.max(0, 1 - distance); // 1 v strede, 0 o krok ďalej
  const scale = Math.max(0.6, 1 - distance * variant.scaleFalloff) * (1 + (variant.focusScale - 1) * lift);
  const fade = Math.max(0, Math.min(1, (range + 0.4 - distance) / 0.4)); // jemné vyblednutie na okraji rozsahu
  const opacity = Math.max(0, Math.min(1, (1 - distance * variant.opacityFalloff) * fade));
  return {
    y: radius * Math.sin(theta),
    z: radius * (Math.cos(theta) - 1),
    rotateX: -offset * variant.angleStep,
    scale,
    opacity,
    dim: Math.min(0.75, distance * variant.dimFalloff),
    zIndex: 100 - Math.round(distance * 10),
    visible: distance <= range + 0.4 && opacity > 0.01,
    interactive: distance <= Math.min(range, 1.6),
    foreshorten: Math.max(0, Math.cos(theta)),
  };
}

// -----------------------------------------------------------------------------
// 2D projekcia valca (ANDROID WEBVIEW SAFE) — oprava 2026-10-11
//
// Pôvodná verzia používala skutočné 3D CSS (perspective + preserve-3d +
// translateZ + rotateX + backface-visibility). To je na Android WebView
// zbytočné riziko (flattening pri overflow:hidden, GPU rozdiely, zmiznutie
// vrstiev s backface-visibility). Valec sa teraz kreslí ako jeho 2D projekcia:
//   posun Y = R·sin θ, mierka X = scale, mierka Y = scale · (0.55 + 0.45·cos θ)
// Vizuálne rovnaký dojem, ale iba 2D transform + opacity (vždy podporované).
// -----------------------------------------------------------------------------

export function cardCss(tr: CardTransform): string {
  const scaleY = tr.scale * (0.55 + 0.45 * tr.foreshorten);
  return `translate3d(0px, ${tr.y.toFixed(2)}px, 0px) scale(${tr.scale.toFixed(4)}, ${scaleY.toFixed(4)})`;
}

export function isFiniteTransform(tr: CardTransform): boolean {
  return [tr.y, tr.z, tr.rotateX, tr.scale, tr.opacity, tr.dim, tr.foreshorten].every((value) => Number.isFinite(value));
}

// -----------------------------------------------------------------------------
// Obrana: geometria valca musí byť platná, inak sa zobrazí bezpečný zoznam.
// Používateľ NIKDY nesmie dostať prázdnu nástenku.
// -----------------------------------------------------------------------------

/** Pod touto výškou plochy valec nedáva zmysel → bezpečný zoznam. */
export const MIN_STAGE_PX = 180;

export type GeometryCheck =
  | { ok: true }
  | { ok: false; reason: "stage_height" | "card_height" | "non_finite" | "focus_hidden" | "focus_clipped" };

export function validateCylinderGeometry(input: {
  stageHeight: number;
  cardHeight: number;
  n: number;
  variant: CylinderVariant;
}): GeometryCheck {
  const { stageHeight, cardHeight, n, variant } = input;
  if (!Number.isFinite(stageHeight) || stageHeight < MIN_STAGE_PX) return { ok: false, reason: "stage_height" };
  if (!Number.isFinite(cardHeight) || cardHeight <= 0 || cardHeight > stageHeight) return { ok: false, reason: "card_height" };
  for (let offset = -n / 2; offset <= n / 2; offset += 0.25) {
    if (!isFiniteTransform(cardTransform(offset, cardHeight, Math.max(1, n), variant))) return { ok: false, reason: "non_finite" };
  }
  const focused = cardTransform(0, cardHeight, Math.max(1, n), variant);
  if (!focused.visible || focused.opacity < 0.99 || focused.scale < 0.5) return { ok: false, reason: "focus_hidden" };
  const halfExtent = Math.abs(focused.y) + (cardHeight * focused.scale) / 2;
  if (halfExtent > stageHeight / 2 + 0.5) return { ok: false, reason: "focus_clipped" };
  return { ok: true };
}

/**
 * Kontrola nad skutočným DOM (getBoundingClientRect): aspoň `minRatio`
 * fokusovanej karty musí byť vo vnútri plochy valca.
 */
export function visibleRatio(card: Rect, stage: Rect): number {
  if (card.height <= 0 || card.width <= 0) return 0;
  const top = Math.max(card.y, stage.y);
  const bottom = Math.min(card.y + card.height, stage.y + stage.height);
  const left = Math.max(card.x, stage.x);
  const right = Math.min(card.x + card.width, stage.x + stage.width);
  if (bottom <= top || right <= left) return 0;
  return ((bottom - top) * (right - left)) / (card.height * card.width);
}

// -----------------------------------------------------------------------------
// Gesto: snap s fyzikálnym dojazdom
// -----------------------------------------------------------------------------

/** Max. počet kariet, o ktoré sa valec posunie jedným švihom (stabilita rýchleho swipe). */
export const MAX_FLING_STEPS = 2; // finálny polish: jeden švih nikdy nepreskočí viac než 2 moduly

/**
 * Cieľ po pustení prsta: pozícia + dojazd podľa rýchlosti (karty/s), zaokrúhlené
 * na celú kartu a obmedzené na MAX_FLING_STEPS od pozície pri začiatku gesta.
 */
export function snapTarget(position: number, velocity: number, gestureStart: number): number {
  const projected = position + velocity * 0.18;
  const target = Math.round(projected);
  const startRound = Math.round(gestureStart);
  return Math.max(startRound - MAX_FLING_STEPS, Math.min(startRound + MAX_FLING_STEPS, target));
}

/** Pixely ťahu → zmena pozície (ťah nahor = ďalší modul). */
export function dragToPosition(startPosition: number, dragPx: number, stepPx: number): number {
  if (stepPx <= 0) return startPosition;
  return startPosition - dragPx / stepPx;
}

/** Ťuknutie vs. ťah (px). */
export const TAP_SLOP_PX = 10;

export function isTap(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP_PX;
}

// -----------------------------------------------------------------------------
// Pružina (kriticky tlmená) — jeden krok integrácie
// -----------------------------------------------------------------------------

// ζ = damping / (2·√stiffness) ≈ 0.94 → takmer kriticky tlmená: jemné
// „usadenie" bez prekmitu/cartoon bounce, ~350 ms na jeden krok.
export const SPRING = { stiffness: 190, damping: 26 } as const;

export function springStep(
  position: number,
  velocity: number,
  target: number,
  dtSeconds: number
): { position: number; velocity: number; settled: boolean } {
  const dt = Math.min(Math.max(dtSeconds, 0), 1 / 30); // stabilita pri trhanom frame
  const force = -SPRING.stiffness * (position - target) - SPRING.damping * velocity;
  const nextVelocity = velocity + force * dt;
  const nextPosition = position + nextVelocity * dt;
  const settled = Math.abs(nextPosition - target) < 0.0015 && Math.abs(nextVelocity) < 0.01;
  return settled ? { position: target, velocity: 0, settled: true } : { position: nextPosition, velocity: nextVelocity, settled: false };
}

// -----------------------------------------------------------------------------
// Koliesko myši / trackpad
// -----------------------------------------------------------------------------

/** Akumulovaný deltaY (px) na jeden krok a pauza medzi krokmi (ms). */
export const WHEEL_STEP_PX = 50;
export const WHEEL_COOLDOWN_MS = 220; // inertia trackpadu neprejde celý valec

export function wheelSteps(accumulatedPx: number): { steps: number; remainder: number } {
  const steps = Math.trunc(accumulatedPx / WHEEL_STEP_PX);
  const clamped = Math.max(-1, Math.min(1, steps)); // max 1 krok na udalosť → trackpad nepreletí celý valec
  return { steps: clamped, remainder: clamped === 0 ? accumulatedPx : 0 };
}

// -----------------------------------------------------------------------------
// Klávesnica
// -----------------------------------------------------------------------------

export function keyboardStep(key: string): number | "first" | null {
  switch (key) {
    case "ArrowDown":
    case "PageDown":
      return 1;
    case "ArrowUp":
    case "PageUp":
      return -1;
    case "Home":
      return "first";
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Rozloženie: focus zóna vs. plávajúce tlačidlo chatu
// -----------------------------------------------------------------------------

export type Rect = { x: number; y: number; width: number; height: number };

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Obdĺžnik fokusovanej karty vo viewporte valca (stred zvislo, plná šírka
 * mínus okraje) — používa sa v testoch kolízie s FAB a pretečenia.
 */
export function focusCardRect(
  stage: Rect,
  cardHeight: number,
  gutter: number,
  variant: CylinderVariant
): Rect {
  const width = (stage.width - gutter * 2) * variant.focusScale;
  const height = cardHeight * variant.focusScale;
  return { x: stage.x + (stage.width - width) / 2, y: stage.y + (stage.height - height) / 2, width, height };
}


// -----------------------------------------------------------------------------
// Finálny polish 2026-10-11 — režim zobrazenia, os ťahu, výška karty
// -----------------------------------------------------------------------------

export type CylinderMode = "empty" | "single" | "list" | "cylinder";

/**
 * Režim nástenky:
 *  - 0 modulov → prázdny stav (bezpečná správa, nie biela plocha),
 *  - 1 modul → jedna statická karta (žiadny „nekonečný" pohyb jedného prvku),
 *  - 2 moduly → statický zoznam (valec s 2 kartami by musel jednu klonovať
 *    alebo ju skrývať — oboje pôsobí rozbito),
 *  - reduced motion alebo neplatná geometria → plnohodnotný zoznam,
 *  - inak valec.
 */
export function cylinderMode(input: { n: number; reducedMotion: boolean; geometryOk: boolean }): CylinderMode {
  if (input.n <= 0) return "empty";
  if (input.n === 1) return "single";
  if (input.reducedMotion || input.n === 2 || !input.geometryOk) return "list";
  return "cylinder";
}

/** Os ťahu po prekročení prahu: vodorovný ťah valec neovláda (napr. scroll stránky, gesto späť). */
export function dragAxis(dx: number, dy: number): "vertical" | "horizontal" | null {
  if (isTap(dx, dy)) return null;
  return Math.abs(dy) >= Math.abs(dx) * 0.8 ? "vertical" : "horizontal";
}

/**
 * Výška karty podľa plochy a zväčšenia písma (Android „Veľkosť písma",
 * prehliadačový zoom). Pri 130 % písme je karta vyššia (až ×1.3), ale nikdy
 * viac než ~1/3.4 plochy — aby fokus aj susedia stále vošli.
 */
export function cardHeightFor(stageHeight: number, options: { large?: boolean; fontScale?: number } = {}): number {
  const max = options.large ? 176 : 140;
  const scale = Math.min(1.3, Math.max(1, Number.isFinite(options.fontScale ?? 1) ? options.fontScale ?? 1 : 1));
  const base = Math.max(96, Math.min(max, stageHeight / 4.6)) * scale;
  const cap = Math.max(96, stageHeight / 3.4);
  return Math.round(Math.min(base, cap));
}

/** Karta je nízka → skryť popis (ostane názov + stav), nech text nepretečie. */
export function isCompactCard(cardHeight: number, fontScale = 1): boolean {
  return cardHeight / Math.max(1, fontScale) < 108;
}

/** Bodový indikátor polohy (namiesto „1 / 6"): max. 8 bodov, inak kompaktné číslo. */
export function progressDots(n: number, active: number): Array<{ index: number; active: boolean }> | null {
  if (n < 2 || n > 8) return null;
  return Array.from({ length: n }, (_, index) => ({ index, active: index === active }));
}
