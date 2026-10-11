"use client";

import { useSyncExternalStore } from "react";

/**
 * Media query ako externý store (bez setState v efekte, bez hydration
 * nesúladu: na serveri vždy `serverValue`).
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue
  );
}

/** Hodnota query parametra URL (statická počas života stránky). */
export function useSearchParamValue(name: string): string | null {
  return useSyncExternalStore(
    () => () => undefined,
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name)),
    () => null
  );
}
