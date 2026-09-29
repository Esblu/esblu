"use client";

import { useEffect, useRef, useState } from "react";

// =============================================================================
// Horizontálne posúvateľné záložky (Mobile M1, 2026-09-28).
//
// Jedna implementácia pre detail vozidla aj stroja (predtým dve rôzne):
//   - 44 px vysoké položky (dotyk), skrytý posuvník, fade vpravo naznačuje
//     ďalšie záložky (zmizne na konci — .scroll-tabs v globals.css),
//   - aktívna záložka sa po zmene posunie do viditeľnej oblasti,
//   - ARIA tablist/tab + šípky vľavo/vpravo na klávesnici.
// =============================================================================

export type ScrollTab<K extends string> = { key: K; label: string; count?: number };

export function ScrollTabs<K extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className = "",
}: {
  tabs: ScrollTab<K>[];
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = useState(false);

  function updateEdge() {
    const el = listRef.current;
    if (!el) return;
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  }

  useEffect(() => {
    updateEdge();
    const el = listRef.current;
    if (!el) return;
    // Iba posun VNÚTRI pásu záložiek. scrollIntoView() by posúval aj všetky
    // predky vrátane dokumentu (vodorovne aj zvislo) — nikdy ho tu nepoužiť.
    const active = el.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active) {
      const box = el.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      const left = tab.left - box.left + el.scrollLeft;
      const right = left + tab.width;
      if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 4);
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 4;
    }
    const onResize = () => updateEdge();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [value, tabs.length]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = tabs.findIndex((item) => item.key === value);
    const next = event.key === "ArrowRight" ? Math.min(tabs.length - 1, index + 1) : Math.max(0, index - 1);
    if (next !== index) {
      event.preventDefault();
      onChange(tabs[next].key);
      listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onScroll={updateEdge}
      onKeyDown={onKeyDown}
      data-at-end={atEnd ? "true" : "false"}
      className={`scroll-tabs -mx-1 flex min-w-0 snap-x gap-1 overflow-x-auto px-1 pb-1 ${className}`}
    >
      {tabs.map((item) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.key)}
            className={`min-h-11 shrink-0 snap-start whitespace-nowrap rounded-doc-sm border px-3.5 py-2 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
              selected
                ? "border-border-strong bg-surface-hover text-primary"
                : "border-doc-border text-secondary hover:text-primary"
            }`}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="ml-1.5 tabular-nums opacity-70">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
