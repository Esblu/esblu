"use client";

import { useEffect } from "react";
import { ESBLU_BUILD_ID, IS_MOBILE_BUILD } from "@/lib/build-target";

// -----------------------------------------------------------------------------
// Overiteľná značka natívneho runtime (Mobile M1, 2026-09-28) — iba mobilný build.
//
// Na <html> nastaví data-esblu-runtime="native-app" a data-esblu-build="<id>".
// Na zariadení (chrome://inspect → Console):
//   document.documentElement.dataset
// ukáže, či beží natívny bundle a ktorý. Webová stránka (Chrome/PWA na
// www.esblu.com) tieto atribúty nemá — tak sa dá spoľahlivo rozlíšiť, či
// snímka obrazovky pochádza z appky alebo z webu.
// -----------------------------------------------------------------------------
export default function NativeRuntimeMarker() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.esbluRuntime = IS_MOBILE_BUILD ? "native-app" : "web";
    if (ESBLU_BUILD_ID) root.dataset.esbluBuild = ESBLU_BUILD_ID;
  }, []);
  return null;
}
