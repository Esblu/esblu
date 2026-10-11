"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  CYLINDER_VARIANTS,
  activeIndexFor,
  cardCss,
  cardHeightFor,
  cardTransform,
  circularOffset,
  cylinderMode,
  dragAxis,
  dragToPosition,
  isCompactCard,
  isFiniteTransform,
  keyboardStep,
  nearestPositionFor,
  progressDots,
  snapTarget,
  springStep,
  validateCylinderGeometry,
  visibleRatio,
  wheelSteps,
  WHEEL_COOLDOWN_MS,
  type CylinderVariantName,
} from "@/lib/dashboard/cylinder";
import { cardAction, focusIndexForKey, type DashboardModule, type DashboardModuleKey, type ModuleStatus } from "@/lib/dashboard/modules";
import { setFabAvoidBands } from "@/lib/mobile/chat-fab";
import { haptic } from "@/lib/voice/device-feedback";
import { useMediaQuery } from "@/hooks/use-media-query";

// =============================================================================
// Nekonečný „valec" modulov nástenky — finálny produkčný komponent (2026-10-11).
//
// REŽIMY (lib/dashboard/cylinder.ts#cylinderMode)
//   empty    0 modulov → bezpečná správa (rieši Dashboard)
//   single   1 modul → jedna statická karta
//   list     2 moduly / reduced motion / neplatná geometria → plnohodnotný zoznam
//   cylinder 3+ modulov → valec (2D projekcia — Android WebView safe)
//
// VÝKON: počas ťahu/animácie sa NEprekresľuje React. rAF zapisuje iba
// transform + opacity do DOM kariet; slučka beží iba počas pohybu.
// React stav sa mení len pri zmene modulu vo fokuse.
//
// OBRANA: ak výška plochy, geometria alebo DOM kontrola fokusovanej karty
// zlyhá, valec sa prepne na zoznam (nikdy prázdna nástenka) a sám sa vráti,
// keď je výška opäť použiteľná (klávesnica, rotácia).
// =============================================================================

export type CylinderCardView = DashboardModule & {
  title: string;
  description: string;
  status: ModuleStatus;
  /** Preložený text stavu (počet, chyba, zamknuté, skúšobné obdobie) alebo null. */
  statusText: string | null;
  alertsLabel: string | null;
  illustration: string;
};

export type CylinderLabels = {
  region: string;
  previous: string;
  next: string;
  position: (index: number, count: number) => string;
  slide: (name: string, index: number, count: number) => string;
  open: string;
  requestActivation: string;
  lockedHint: string;
  loading: string;
};

type Props = {
  modules: CylinderCardView[];
  variant?: CylinderVariantName;
  labels: CylinderLabels;
  onNavigate: (href: string) => void;
  onLockedAction: (key: DashboardModuleKey) => void;
  /** Desktop: väčšie karty. */
  large?: boolean;
  /** Modul, ktorý mal používateľ naposledy vo fokuse (návrat z modulu). */
  initialFocusKey?: string | null;
  onFocusChange?: (key: DashboardModuleKey) => void;
  /** Valec je skrytý (napr. výsledky hľadania) — neohlasuje zóny pre FAB. */
  hidden?: boolean;
  /**
   * Nástenka nie je aktívna obrazovka (panel „Viac", dialóg, iná routa):
   * žiadna animácia, gestá, koliesko, klávesnica, haptika ani oznámenia;
   * obsah je `inert` a skrytý pre čítačky.
   */
  paused?: boolean;
};

/** Pomer písma používateľa voči 16 px (Android „Veľkosť písma", zoom). */
function readFontScale(): number {
  try {
    const px = Number.parseFloat(getComputedStyle(document.documentElement).fontSize || "16");
    return Number.isFinite(px) && px > 0 ? px / 16 : 1;
  } catch {
    return 1;
  }
}

export function ModuleCylinder({
  modules,
  variant = "subtle",
  labels,
  onNavigate,
  onLockedAction,
  large = false,
  initialFocusKey = null,
  onFocusChange,
  hidden = false,
  paused = false,
}: Props) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const n = modules.length;
  const config = CYLINDER_VARIANTS[variant];
  const keySignature = modules.map((module) => module.key).join("|");

  const stageRef = useRef<HTMLElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const positionRef = useRef(0);
  const velocityRef = useRef(0);
  const targetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const cardHeightRef = useRef(120);
  const dragRef = useRef<{ startY: number; startX: number; startPos: number; lastY: number; lastT: number; v: number; axis: "vertical" | "horizontal" | null } | null>(null);
  const suppressClickRef = useRef(false);
  const wheelRef = useRef({ acc: 0, last: 0 });
  const keyboardFocusRef = useRef(false);
  const touchSnapRef = useRef(false);
  const keysRef = useRef<string[]>([]);

  const [activeIndex, setActiveIndex] = useState(() => focusIndexForKey(modules, initialFocusKey));
  const [cardHeight, setCardHeight] = useState(120);
  const [compact, setCompact] = useState(false);
  const activeRef = useRef(activeIndex);

  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const fallbackRef = useRef<string | null>(null);
  const enterFallback = useCallback((reason: string) => {
    if (fallbackRef.current === reason) return;
    fallbackRef.current = reason;
    setFallbackReason(reason);
    // Nenápadný interný signál (bez dát firmy/používateľa): iba dôvod.
    console.debug("[esblu:dashboard] cylinder → list fallback:", reason);
  }, []);
  const exitFallback = useCallback(() => {
    if (fallbackRef.current === null) return;
    fallbackRef.current = null;
    setFallbackReason(null);
  }, []);

  const mode = cylinderMode({ n, reducedMotion, geometryOk: fallbackReason === null });
  const isCylinder = mode === "cylinder";
  // Interakcia valca beží IBA keď je nástenka aktívna obrazovka.
  const motion = isCylinder && !paused;

  // --- zápis transformácií (bez React renderu) -------------------------------
  const paint = useCallback(() => {
    const position = positionRef.current;
    const h = cardHeightRef.current;
    for (let i = 0; i < n; i++) {
      const el = cardRefs.current[i];
      if (!el) continue;
      const tr = cardTransform(circularOffset(i - position, n), h, n, config);
      if (!isFiniteTransform(tr)) {
        enterFallback("non_finite");
        return;
      }
      el.style.transform = cardCss(tr); // 2D projekcia, bez 3D CSS
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

  // Zóny pre plávajúci chat: fokusovaná karta + ovládanie (FAB ich obíde).
  const publishFabBands = useCallback(() => {
    if (hidden || paused || !motion) {
      setFabAvoidBands([]);
      return;
    }
    const card = cardRefs.current[activeRef.current]?.getBoundingClientRect();
    const controls = controlsRef.current?.getBoundingClientRect();
    const bands: Array<{ top: number; bottom: number }> = [];
    if (card && card.height > 0) bands.push({ top: card.top, bottom: card.bottom });
    if (controls && controls.height > 0) bands.push({ top: controls.top, bottom: controls.bottom });
    setFabAvoidBands(bands);
  }, [hidden, paused, motion]);

  const animateTo = useCallback(
    (target: number) => {
      targetRef.current = target;
      if (rafRef.current !== null) return;
      const startIndex = activeRef.current;
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
          // Jemná haptika IBA pri dotykovom snape na nový modul (nie wheel/klávesnica/každý frame).
          if (touchSnapRef.current && activeRef.current !== startIndex) haptic("start");
          touchSnapRef.current = false;
          if (keyboardFocusRef.current) {
            keyboardFocusRef.current = false;
            cardRefs.current[activeRef.current]?.querySelector<HTMLElement>("[data-card-action]")?.focus({ preventScroll: true });
          }
          publishFabBands();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [paint, publishFabBands]
  );

  const step = useCallback((delta: number) => animateTo(Math.round(targetRef.current) + delta), [animateTo]);

  // Zmena zoznamu modulov (načítanie nárokov → poradie, rola, build):
  // ZACHOVAŤ modul vo fokuse podľa kľúča (žiadny skok na náhodný modul).
  useLayoutEffect(() => {
    const previousKey = keysRef.current[activeRef.current] ?? initialFocusKey;
    const keys = keySignature.split("|");
    keysRef.current = keys;
    const index = focusIndexForKey(keys.map((key) => ({ key })), previousKey);
    stopLoop();
    positionRef.current = index;
    targetRef.current = index;
    velocityRef.current = 0;
    activeRef.current = -1; // paint() nastaví fokus
    paint();
    if (activeRef.current === -1) {
      activeRef.current = index;
      setActiveIndex(index);
    }
    // initialFocusKey sa číta iba pri prvom zostavení zoznamu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature, paint]);

  useEffect(() => {
    const key = keysRef.current[activeIndex];
    if (key) onFocusChange?.(key as DashboardModuleKey);
    // onFocusChange je callback rodiča; reagujeme iba na zmenu fokusu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, keySignature]);

  // --- výška karty + kontrola geometrie (ResizeObserver) ---------------------
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined" || !isCylinder) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      const fontScale = readFontScale();
      const next = cardHeightFor(height, { large, fontScale });
      const check = validateCylinderGeometry({ stageHeight: height, cardHeight: next, n, variant: config });
      if (!check.ok) {
        enterFallback(check.reason);
        return;
      }
      cardHeightRef.current = next;
      setCardHeight(next);
      setCompact(isCompactCard(next, fontScale));
      paint();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const card = cardRefs.current[activeRef.current];
        const stageEl = stageRef.current;
        if (!card || !stageEl || fallbackRef.current) return;
        const c = card.getBoundingClientRect();
        const st = stageEl.getBoundingClientRect();
        const ratio = visibleRatio({ x: c.left, y: c.top, width: c.width, height: c.height }, { x: st.left, y: st.top, width: st.width, height: st.height });
        const opacity = Number.parseFloat(getComputedStyle(card).opacity || "1");
        if (ratio < 0.6 || !(opacity > 0.5)) {
          enterFallback(ratio < 0.6 ? "focus_clipped" : "focus_hidden");
          return;
        }
        publishFabBands();
      });
    });
    observer.observe(stage);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [paint, large, n, config, enterFallback, exitFallback, isCylinder, publishFabBands]);

  // Záložný zoznam sa skúsi vrátiť na valec iba po zmene viewportu (zatvorenie
  // klávesnice, rotácia, resize okna) — nikdy v slučke bez zmeny rozmerov.
  useEffect(() => {
    if (!fallbackReason || reducedMotion || n < 3) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      clearTimeout(timer);
      timer = setTimeout(exitFallback, 180);
    };
    window.addEventListener("resize", retry);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", retry);
    };
  }, [fallbackReason, reducedMotion, n, exitFallback]);

  useEffect(() => {
    publishFabBands();
    return () => setFabAvoidBands([]);
  }, [publishFabBands]);

  useEffect(() => () => stopLoop(), []);

  // Pozastavenie (iná vrstva/obrazovka nad nástenkou): zastaviť rAF, zrušiť
  // prebiehajúci ťah, dotiahnuť pozíciu na celú kartu (žiadny „skok" po
  // návrate) a nespúšťať haptiku.
  useEffect(() => {
    if (!paused) return;
    stopLoop();
    dragRef.current = null;
    touchSnapRef.current = false;
    keyboardFocusRef.current = false;
    const settled = Math.round(targetRef.current);
    positionRef.current = settled;
    targetRef.current = settled;
    velocityRef.current = 0;
    paint();
  }, [paused, paint]);

  // --- koliesko / trackpad ---------------------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !motion) return;
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
  }, [step, motion]);

  // --- dotyk / myš (iba v ploche valca, os uzamknutá na zvislý smer) --------
  const onPointerDown = (event: React.PointerEvent) => {
    if (!motion) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    stopLoop();
    velocityRef.current = 0;
    dragRef.current = { startY: event.clientY, startX: event.clientX, startPos: positionRef.current, lastY: event.clientY, lastT: performance.now(), v: 0, axis: null };
  };

  useEffect(() => {
    if (!motion) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.axis === null) {
        drag.axis = dragAxis(dx, dy);
        if (drag.axis === null) return;
      }
      if (drag.axis === "horizontal") return; // vodorovné gesto valec nechá tak
      const stepPx = cardHeightRef.current * 0.9;
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
      if (!drag || drag.axis === null) return; // ťuknutie rieši onClick karty
      suppressClickRef.current = true; // ťah nikdy neotvorí modul
      window.setTimeout(() => (suppressClickRef.current = false), 0);
      if (drag.axis !== "vertical") {
        animateTo(Math.round(positionRef.current));
        return;
      }
      velocityRef.current = drag.v;
      touchSnapRef.current = true;
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
  }, [animateTo, paint, motion]);

  const handleCardClick = (index: number) => {
    if (paused || suppressClickRef.current) return;
    const item = modules[index];
    if (!item) return;
    const action = cardAction(item, index, motion ? activeRef.current : index);
    if (action.type === "focus") {
      touchSnapRef.current = true;
      animateTo(nearestPositionFor(index, targetRef.current, n));
    } else if (action.type === "navigate") onNavigate(action.href);
    else onLockedAction(action.key);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!motion) return;
    const result = keyboardStep(event.key);
    if (result === null) return;
    event.preventDefault();
    keyboardFocusRef.current = true;
    if (result === "first") animateTo(nearestPositionFor(0, targetRef.current, n));
    else step(result);
  };

  if (mode === "empty") return null;

  // --- 1 modul / 2 moduly / reduced motion / fallback: plnohodnotný zoznam ---
  if (!isCylinder) {
    const listHeight = large ? 148 : 120;
    return (
      <section
        ref={(el) => {
          stageRef.current = el;
        }}
        aria-label={labels.region}
        aria-hidden={paused || undefined}
        inert={paused}
        className="relative isolate min-h-[240px] flex-1 overflow-y-auto pb-4 lg:max-w-3xl"
        data-cylinder={reducedMotion ? "reduced" : mode === "single" ? "single" : n === 2 ? "pair" : "fallback"}
        data-fallback-reason={fallbackReason ?? undefined}
      >
        <ul className="space-y-2.5">
          {modules.map((module, index) => (
            <li key={module.key}>
              <CylinderCard module={module} focused labels={labels} onClick={() => handleCardClick(index)} height={listHeight} large={large} compact={false} />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const active = modules[activeIndex] ?? modules[0];
  const dots = progressDots(n, activeIndex);
  const stageStyle: CSSProperties = { touchAction: "none" };

  return (
    <section
      aria-roledescription="carousel"
      aria-label={labels.region}
      aria-hidden={paused || undefined}
      inert={paused}
      data-paused={paused || undefined}
      className="relative isolate flex min-h-0 flex-1 flex-col lg:max-w-3xl"
      data-cylinder={variant}
      onKeyDown={onKeyDown}
    >
      {/* Ovládanie: tichý indikátor polohy + ▲/▼ (prístupnosť bez swipe). */}
      <div ref={controlsRef} className="mb-0.5 flex items-center justify-between gap-2 pl-1">
        {dots ? (
          <span aria-hidden="true" className="flex items-center gap-1">
            {dots.map((dot) => (
              <span
                key={dot.index}
                className={`h-1.5 rounded-full transition-all duration-300 ${dot.active ? "w-4 bg-brand-400" : "w-1.5 bg-border-strong"}`}
              />
            ))}
          </span>
        ) : (
          <span aria-hidden="true" className="text-[11px] font-medium tabular-nums text-muted-esblu">
            {labels.position(activeIndex + 1, n)}
          </span>
        )}
        <span className="flex items-center">
          <button type="button" className="cyl-ctrl" aria-label={labels.previous} onClick={() => step(-1)}>
            <Chevron up />
          </button>
          <button type="button" className="cyl-ctrl" aria-label={labels.next} onClick={() => step(1)}>
            <Chevron />
          </button>
        </span>
      </div>

      <div
        ref={(el) => {
          stageRef.current = el;
        }}
        // `isolate`: z-index kariet (až 100) a prechodov (200) ostáva VNÚTRI
        // valca — nikdy neprerazí nad panel „Viac", dialógy ani spodnú lištu.
        className="relative isolate min-h-[180px] flex-1 select-none overflow-hidden"
        style={stageStyle}
        onPointerDown={onPointerDown}
        onClickCapture={(event) => {
          if (suppressClickRef.current) {
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-[200] h-8 bg-gradient-to-b from-page-bg to-transparent" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-[200] h-8 bg-gradient-to-t from-page-bg to-transparent" />

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
                <CylinderCard module={module} focused={focused} labels={labels} height={cardHeight} large={large} compact={compact} onClick={() => handleCardClick(index)} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Jediné živé oznámenie: modul vo fokuse (vrátane zamknutého stavu).
          Pri pozastavení sa nevykresľuje — žiadne oznámenia spod inej vrstvy. */}
      {!paused && (
        <p className="sr-only" aria-live="polite">
          {labels.slide(active.title, activeIndex + 1, n)}
          {active.statusText ? `. ${active.statusText}` : ""}
        </p>
      )}
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
  compact,
}: {
  module: CylinderCardView;
  focused: boolean;
  labels: CylinderLabels;
  onClick: () => void;
  height: number;
  large: boolean;
  compact: boolean;
}) {
  const status = module.status;
  const locked = status.kind === "locked" || status.kind === "trial";
  const ill = Math.round(Math.min(height * (large ? 0.92 : 0.84), large ? 156 : 116));

  const ariaLabel = locked
    ? `${module.title}. ${module.statusText ?? ""}. ${labels.requestActivation}`
    : `${labels.open}: ${module.title}${module.statusText ? `, ${module.statusText}` : ""}${module.alertsLabel ? `, ${module.alertsLabel}` : ""}`;

  return (
    <button
      type="button"
      data-card-action
      data-status={status.kind}
      tabIndex={focused ? 0 : -1}
      onClick={onClick}
      aria-label={ariaLabel}
      className={`cyl-card group relative flex h-full w-full items-center overflow-hidden rounded-2xl text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
        focused ? "cyl-card-focused" : ""
      } ${status.kind === "locked" ? "cyl-card-locked" : ""} ${status.kind === "trial" ? "cyl-card-trial" : ""} ${large ? "gap-4 px-5" : "gap-3 px-3"}`}
    >
      <span data-dim aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 rounded-2xl bg-page-bg" style={{ opacity: 0 }} />

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={module.illustration}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        width={ill}
        height={ill}
        className={`relative shrink-0 ${locked ? "opacity-40 grayscale" : ""}`}
        style={{ width: ill, height: ill }}
      />

      <span className="relative flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`line-clamp-2 min-w-0 break-words font-semibold leading-tight tracking-tight text-primary ${large ? "text-xl" : "text-[1.0625rem]"}`}>
            {module.title}
          </span>
          {locked && <LockGlyph />}
        </span>
        {!compact && (
          <span className={`line-clamp-2 leading-snug text-muted-esblu ${large ? "text-sm" : "text-[0.78rem]"}`}>{module.description}</span>
        )}
        <span className="mt-0.5 flex min-h-5 flex-wrap items-center gap-1.5">
          <StatusChip status={status} text={module.statusText} loadingLabel={labels.loading} />
          {!locked && module.alertsLabel && (
            <span className="ui-badge border-warning/30 bg-warning-soft text-warning">
              <span aria-hidden="true">!</span>
              {module.alertsLabel}
            </span>
          )}
          {locked && focused && <span className="text-xs font-semibold text-brand-300">{labels.requestActivation} →</span>}
        </span>
      </span>

      {focused && !locked && (
        <span aria-hidden="true" className="relative mr-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-300 transition group-hover:bg-brand-500/25">
          <Chevron right />
        </span>
      )}
    </button>
  );
}

function StatusChip({ status, text, loadingLabel }: { status: ModuleStatus; text: string | null; loadingLabel: string }) {
  switch (status.kind) {
    case "loading":
    case "pending":
      // Skeleton s pevnou šírkou — žiadny layout shift pri dobehnutí dát.
      return <span className="inline-flex h-5 w-24 animate-pulse rounded-full bg-surface-hover motion-reduce:animate-none" role="status" aria-label={loadingLabel} />;
    case "error":
      return <span className="ui-badge border-border-strong text-secondary">{text}</span>;
    case "count":
      return <span className="ui-badge ui-badge-brand tabular-nums">{text}</span>;
    case "locked":
      return <span className="ui-badge">{text}</span>;
    case "trial":
      return (
        <span className="ui-badge border-warning/30 bg-warning-soft text-warning">
          <ClockGlyph />
          {text}
        </span>
      );
    default:
      return null;
  }
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

function ClockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
