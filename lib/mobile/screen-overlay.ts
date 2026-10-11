"use client";

import { useSyncExternalStore } from "react";

// =============================================================================
// Je nad aktuálnou obrazovkou modálna vrstva (panel „Viac", dialóg, modál)?
//
// Navigačná/vrstvová oprava 2026-10-11: nástenka (valec modulov) sa pod
// takou vrstvou POZASTAVÍ — žiadna animácia, gestá, koliesko, klávesnica,
// haptika ani živé oznámenia a obsah je `inert` (neklikateľný, mimo
// čítačky). Zdroj pravdy je samotný DOM: akýkoľvek prvok s
// aria-modal="true" (rovnaké pravidlo ako skrytie plávajúceho chatu).
// =============================================================================

const SELECTOR = '[aria-modal="true"]';

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });
  return () => observer.disconnect();
}

function snapshot(): boolean {
  return typeof document !== "undefined" && document.querySelector(SELECTOR) !== null;
}

export function useModalLayerOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
