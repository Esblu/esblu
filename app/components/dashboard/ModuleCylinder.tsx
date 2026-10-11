"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  CYLINDER_VARIANTS,
  activeIndexFor,
  cardCss,
  cardTransform,
  circularOffset,
  dragToPosition,
  isTap,
  keyboardStep,
  nearestPositionFor,
  snapTarget,
  springStep,
  wheelSteps,
  isFiniteTransform,
  validateCylinderGeometry,
  visibleRatio,
  WHEEL_COOLDOWN_MS,
  type CylinderVariantName,
} from "@/lib/dashboard/cylinder";
import { cardAction, type DashboardModule, type DashboardModuleKey } from "@/lib/dashboard/modules";
import { useMediaQuery } from "@/hooks/use-media-query";

// =============================================================================
// Nekonečný „valec" modulov nástenky (dashboard v3, 2026-10-11).
//
// Výkon: počas ťahu/animácie sa NEprekresľuje React — rAF zapisuje iba
// `transform` + `opacity` priamo do DOM kariet (GPU kompozícia, žiadny layout).
// React stav sa mení iba pri zmene modulu vo fokuse (aria, texty).
// Slučka rAF beží iba počas pohybu a sama sa zastaví po usadení pružiny.
//
// Prístupnosť: region s aria-roledescription="carousel", karty ako „slide",
// vo fokuse aria-current, tlačidlá Predchádzajúci/Ďalší, šípky/PageUp/Down/
// Home, živé oznámenie aktuálneho modulu. prefers-reduced-motion → statický
// zoznam bez 3D a bez animácie.
// =============================================================================

export type CylinderCardView = DashboardModule & {
  title: string;
  description: string;
  /** „3 · uložených vozidiel" — už preložené, alebo null. */
  countLabel: string | null;
  alertsLabel: string | null;
  lockedLabel: string | null;
  illustration: string;
};

type Props = {
  modules: CylinderCardView[];
  variant?: CylinderVariantName;
  labels: {
    region: string;
    previous: string;
    next: string;
    position: (index: number, count: number) => string;
    slide: (name: string, index: number, count: number) => string;
    open: string;
    lockedBadge: string;
    requestActivation: string;
    lockedHint: string;
    hint: string;
  };
  onNavigate: (href: string) => void;
  onLockedAction: (key: DashboardModuleKey) => void;
  /** Desktop: väčšie karty a výraznejšia perspektíva. */
  large?: boolean;
};

export function ModuleCylinder({ modules, variant = "subtle", labels, onNavigate, onLockedAction, large = false }: Props) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const n = modules.length;
  const config = CYLINDER_VARIANTS[variant];

  const stageRef = useRef<HTMLElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const positionRef = useRef(0);
  const velocityRef = useRef(0);
  const targetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const cardHeightRef = useRef(120);
  const dragRef = useRef<{ startY: number; startX: number; startPos: number; lastY: number; lastT: number; v: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const wheelRef = useRef({ acc: 0, last: 0 });
  const keyboardFocusRef = useRef(false);

  const [activeIndex, setActiveIndex] = useState(0);
  const [cardHeight, setCardHeight] = useState(120);
  const activeRef = useRef(0);
  // Obrana (2026-10-11): neplatná geometria / nepoužiteľná výška / skrytá
  // fokusovaná karta → bezpečný zvislý zoznam. Nikdy prázdna nástenka.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const fallbackRef = useRef<string | null>(null);
  const enterFallback = useCallback((reason: string) => {
    if (fallbackRef.current === reason) return;
    fallbackRef.current = reason;
    setFallbackReason(reason);
  }, []);
  const exitFallback = useCallback(() => {
    if (fallbackRef.current === null) return;
    fallbackRef.current = null;
    setFallbackReason(null);
  }, []);

  // --- zápis transformácií (bez React renderu) -------------------------------
  const paint = useCallback(() => {
    const position = positionRef.current;
    const h = cardHeightRef.current;
    for (let i = 0; i < n; i++) {
      const el = cardRefs.current[i];
      if (!el) continue;
      const offset = circularOffset(i - position, n);
      const tr = cardTransform(offset, h, n, config);
      if (!isFiniteTransform(tr)) {
        enterFallback("non_finite");
        return;
      }
      // 2D projekcia valca — bez skutočného 3D CSS (perspektíva, 3D kontext, os Z)
      // (Android WebView safe, pozri lib/dashboard/cylinder.ts#cardCss).
      el.style.transform = cardCss(tr);
      el.style.opacity = tr.visible ? tr.opacity.toFixed(3) : "0";
      el.style.zIndex = String(tr.zIndex);
      el.style.visibility = tr.visible ? "visible" : "hidden";
      el.style.pointerEvents = tr.interactive ? "auto" : "none";
      const dim = el.querySelector<HTMLElement>("[data-dim]");
      if (dim) dim.style.opacity = tr.dim.toFixed(3);
    }
    const nextActive = activeIndexFor(position, n);
    if (nextActive !== activeRef.current) {
      activeRef.current = nextActive;
      setActiveIndex(nextActive);
    }
  }, [n, config, enterFallback]);

  const stopLoop = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const animateTo = useCallback(
    (target: number) => {
      targetRef.current = target;
      if (rafRef.current !== null) return;
      lastFrameRef.current = performance.now();
      const tick = (now: number) => {
        const dt = (now - lastFrameRef.current) / 1000;
        lastFrameRef.current = now;
        const next = springStep(positionRef.current, velocityRef.current, targetRef.current, dt);
        positionRef.current = next.position;
        velocityRef.current = next.velocity;
        paint();
        if (next.settled) {
          rafRef.current = null;
          if (keyboardFocusRef.current) {
            keyboardFocusRef.current = false;
            cardRefs.current[activeRef.current]?.querySelector<HTMLElement>("[data-card-action]")?.focus({ preventScroll: true });
          }
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [paint]
  );

  const step = useCallback(
    (delta: number) => {
      const base = Math.round(targetRef.current);
      animateTo(base + delta);
    },
    [animateTo]
  );

  // Počet modulov sa zmenil (načítanie nárokov) → fokus na prvý modul, bez skoku.
  // Layout efekt: transformácie sa zapíšu pred prvým vykreslením (žiadny záblesk).
  useLayoutEffect(() => {
    stopLoop();
    positionRef.current = 0;
    targetRef.current = 0;
    velocityRef.current = 0;
    activeRef.current = -1; // paint() nastaví fokus na prvý modul
    paint();
  }, [n, paint]);

  // --- veľkosť karty podľa dostupnej výšky + kontrola geometrie --------------
  // Pozoruje sa vždy ten istý kontajner (plocha valca alebo záložný zoznam),
  // takže keď sa výška neskôr opraví (rotácia, klávesnica), valec sa vráti.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      const max = large ? 176 : 140;
      const next = Math.round(Math.max(96, Math.min(max, height / 4.6))); // fokus + 2 susedia + náznak ďalších
      const check = validateCylinderGeometry({ stageHeight: height, cardHeight: next, n, variant: config });
      if (!check.ok) {
        enterFallback(check.reason);
        return;
      }
      cardHeightRef.current = next;
      setCardHeight(next);
      exitFallback();
      paint();
      // Kontrola nad skutočným DOM po vykreslení: fokusovaná karta musí byť
      // naozaj vidieť (výška, orezanie, priehľadnosť) — inak záložný zoznam.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const card = cardRefs.current[activeRef.current];
        const stageEl = stageRef.current;
        if (!card || !stageEl || fallbackRef.current) return;
        const c = card.getBoundingClientRect();
        const st = stageEl.getBoundingClientRect();
        const ratio = visibleRatio({ x: c.left, y: c.top, width: c.width, height: c.height }, { x: st.left, y: st.top, width: st.width, height: st.height });
        const opacity = Number.parseFloat(getComputedStyle(card).opacity || "1");
        if (ratio < 0.6 || !(opacity > 0.5)) enterFallback(ratio < 0.6 ? "focus_clipped" : "focus_hidden");
      });
    });
    observer.observe(stage);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [paint, large, n, config, enterFallback, exitFallback, fallbackReason]);

  useEffect(() => () => stopLoop(), []);

  // --- koliesko / trackpad (natívny listener, aby šlo preventDefault) --------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || reducedMotion || fallbackReason) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.preventDefault();
      const now = performance.now();
      const wheel = wheelRef.current;
      if (now - wheel.last < WHEEL_COOLDOWN_MS) return;
      wheel.acc += event.deltaMode === 1 ? event.deltaY * 30 : event.deltaY;
      const { steps, remainder } = wheelSteps(wheel.acc);
      wheel.acc = remainder;
      if (steps !== 0) {
        wheel.last = now;
        step(steps);
      }
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [step, reducedMotion, fallbackReason]);

  // --- dotyk / myš ------------------------------------------------------------
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    stopLoop();
    velocityRef.current = 0;
    dragRef.current = { startY: event.clientY, startX: event.clientX, startPos: positionRef.current, lastY: event.clientY, lastT: performance.now(), v: 0, moved: false };
  };

  useEffect(() => {
    if (reducedMotion || fallbackReason) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && isTap(event.clientX - drag.startX, dy)) return;
      drag.moved = true;
      const stepPx = cardHeightRef.current * 0.86;
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT) / 1000;
      const instant = -(event.clientY - drag.lastY) / stepPx / dt;
      drag.v = drag.v * 0.6 + instant * 0.4;
      drag.lastY = event.clientY;
      drag.lastT = now;
      positionRef.current = dragToPosition(drag.startPos, dy, stepPx);
      paint();
    };
    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (!drag.moved) return; // ťuknutie rieši onClick karty
      suppressClickRef.current = true;
      window.setTimeout(() => (suppressClickRef.current = false), 0);
      velocityRef.current = drag.v;
      animateTo(snapTarget(positionRef.current, drag.v, drag.startPos));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [animateTo, paint, reducedMotion, fallbackReason]);

  const handleCardClick = (index: number) => {
    if (suppressClickRef.current) return;
    const item = modules[index];
    if (!item) return;
    const action = cardAction(item, index, reducedMotion || fallbackRef.current ? index : activeRef.current);
    if (action.type === "focus") animateTo(nearestPositionFor(index, targetRef.current, n));
    else if (action.type === "navigate") onNavigate(action.href);
    else onLockedAction(action.key);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const result = keyboardStep(event.key);
    if (result === null) return;
    event.preventDefault();
    keyboardFocusRef.current = true;
    if (result === "first") animateTo(nearestPositionFor(0, targetRef.current, n));
    else step(result);
  };

  if (n === 0) return null;
  const active = modules[activeIndex] ?? modules[0];

  // --- reduced motion alebo neplatná geometria: bezpečný zvislý zoznam -------
  // min-h zaručí, že zoznam je viditeľný aj keď rodič nedá použiteľnú výšku.
  if (reducedMotion || fallbackReason) {
    return (
      <section
        ref={(el) => {
          stageRef.current = el;
        }}
        aria-label={labels.region}
        className="min-h-[240px] flex-1 overflow-y-auto pb-4"
        data-cylinder={reducedMotion ? "reduced" : "fallback"}
        data-fallback-reason={fallbackReason ?? undefined}
      >
        <ul className="space-y-2">
          {modules.map((module, index) => (
            <li key={module.key}>
              <CylinderCard module={module} focused labels={labels} onClick={() => handleCardClick(index)} height={large ? 140 : 112} large={large} />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const stageStyle: CSSProperties = { touchAction: "none" };

  return (
    <section
      aria-roledescription="carousel"
      aria-label={labels.region}
      className="flex min-h-0 flex-1 flex-col"
      data-cylinder={variant}
      onKeyDown={onKeyDown}
    >
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <p className="text-[11px] font-medium text-muted-esblu" aria-hidden="true">
          {labels.position(activeIndex + 1, n)}
        </p>
        <div className="flex items-center gap-1">
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon" aria-label={labels.previous} onClick={() => step(-1)}>
            <Chevron up />
          </button>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon" aria-label={labels.next} onClick={() => step(1)}>
            <Chevron />
          </button>
        </div>
      </div>

      <div
        ref={(el) => {
          stageRef.current = el;
        }}
        className="relative min-h-[180px] flex-1 select-none overflow-hidden"
        style={stageStyle}
        onPointerDown={onPointerDown}
        onClickCapture={(event) => {
          if (suppressClickRef.current) {
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        {/* jemné vyblednutie hornej a dolnej hrany valca (statický gradient, žiadny blur) */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-[200] h-10 bg-gradient-to-b from-page-bg to-transparent" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-[200] h-10 bg-gradient-to-t from-page-bg to-transparent" />

        <div className="absolute inset-0">
          {modules.map((module, index) => {
            const focused = index === activeIndex;
            return (
              <div
                key={module.key}
                ref={(el) => {
                  cardRefs.current[index] = el;
                }}
                role="group"
                aria-roledescription="slide"
                aria-label={labels.slide(module.title, index + 1, n)}
                aria-current={focused ? "true" : undefined}
                aria-hidden={focused ? undefined : true}
                className="absolute inset-x-1 top-1/2 will-change-transform"
                style={{ height: cardHeight, marginTop: -cardHeight / 2, transformOrigin: "50% 50%" }}
              >
                <CylinderCard
                  module={module}
                  focused={focused}
                  labels={labels}
                  height={cardHeight}
                  large={large}
                  onClick={() => handleCardClick(index)}
                />
              </div>
            );
          })}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {labels.slide(active.title, activeIndex + 1, n)}
        {active.lockedLabel ? `. ${active.lockedLabel}` : ""}
      </p>
    </section>
  );
}

function CylinderCard({
  module,
  focused,
  labels,
  onClick,
  height,
  large,
}: {
  module: CylinderCardView;
  focused: boolean;
  labels: Props["labels"];
  onClick: () => void;
  height: number;
  large: boolean;
}) {
  const locked = module.access.state === "locked";
  const compact = height < 112;
  return (
    <button
      type="button"
      data-card-action
      tabIndex={focused ? 0 : -1}
      onClick={onClick}
      aria-label={
        locked
          ? `${module.title}. ${module.lockedLabel ?? labels.lockedBadge}. ${labels.requestActivation}`
          : `${labels.open}: ${module.title}${module.countLabel ? `, ${module.countLabel}` : ""}${module.alertsLabel ? `, ${module.alertsLabel}` : ""}`
      }
      className={`cyl-card group relative flex h-full w-full items-center gap-3 overflow-hidden rounded-2xl text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
        focused ? "cyl-card-focused" : ""
      } ${locked ? "cyl-card-locked" : ""} ${large ? "px-5" : "px-3"}`}
    >
      <span data-dim aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 rounded-2xl bg-page-bg" style={{ opacity: 0 }} />

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={module.illustration}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={`relative shrink-0 ${locked ? "opacity-45 grayscale" : ""}`}
        style={{ width: height * (large ? 0.92 : 0.86), height: height * (large ? 0.92 : 0.86) }}
      />

      <span className="relative flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span className={`truncate font-semibold tracking-tight text-primary ${large ? "text-xl" : "text-[17px]"}`}>{module.title}</span>
          {locked && <LockGlyph />}
        </span>
        {!compact && (
          <span className={`line-clamp-2 leading-snug text-muted-esblu ${large ? "text-sm" : "text-[12.5px]"}`}>{module.description}</span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {locked ? (
            <>
              <span className="ui-badge">{module.lockedLabel ?? labels.lockedBadge}</span>
              {focused && <span className="text-xs font-semibold text-brand-300">{labels.requestActivation} →</span>}
            </>
          ) : (
            <>
              {module.countLabel && <span className="ui-badge ui-badge-brand tabular-nums">{module.countLabel}</span>}
              {module.alertsLabel && <span className="ui-badge border-warning/30 bg-warning-soft text-warning">{module.alertsLabel}</span>}
            </>
          )}
        </span>
      </span>

      {focused && !locked && (
        <span aria-hidden="true" className="relative mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-300">
          <Chevron right />
        </span>
      )}
    </button>
  );
}

function Chevron({ up = false, right = false }: { up?: boolean; right?: boolean }) {
  const d = right ? "M9 6l6 6-6 6" : up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6";
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-muted-esblu">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
