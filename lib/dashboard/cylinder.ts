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
  radiusFactor: 2.35,
  perspective: 1400,
  scaleFalloff: 0.07,
  opacityFalloff: 0.24,
  dimFalloff: 0.22,
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
  radiusFactor: 1.85,
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
  };
}

// -----------------------------------------------------------------------------
// Gesto: snap s fyzikálnym dojazdom
// -----------------------------------------------------------------------------

/** Max. počet kariet, o ktoré sa valec posunie jedným švihom (stabilita rýchleho swipe). */
export const MAX_FLING_STEPS = 3;

/**
 * Cieľ po pustení prsta: pozícia + dojazd podľa rýchlosti (karty/s), zaokrúhlené
 * na celú kartu a obmedzené na MAX_FLING_STEPS od pozície pri začiatku gesta.
 */
export function snapTarget(position: number, velocity: number, gestureStart: number): number {
  const projected = position + velocity * 0.22;
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
export const TAP_SLOP_PX = 8;

export function isTap(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP_PX;
}

// -----------------------------------------------------------------------------
// Pružina (kriticky tlmená) — jeden krok integrácie
// -----------------------------------------------------------------------------

export const SPRING = { stiffness: 210, damping: 27 } as const;

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
export const WHEEL_STEP_PX = 60;
export const WHEEL_COOLDOWN_MS = 160;

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
