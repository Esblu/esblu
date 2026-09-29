// =============================================================================
// Zásobník otvorených vrstiev (panel „Viac", potvrdzovacie dialógy) pre
// systémové „späť" (Mobile M1, 2026-09-28).
//
// Android hardvérové/gestové „späť" má najprv zavrieť otvorenú vrstvu a až
// potom odísť zo stránky. mobile/app/BackButtonBridge.tsx (iba mobilný build)
// počúva @capacitor/app „backButton" a zavolá closeTopLayer(); ak nie je
// otvorená žiadna vrstva, správa sa ako doteraz (história späť, na koreni
// ukončenie appky). Na webe sa zásobník používa iba pre Escape.
// Bez závislostí (testovateľné v Node).
// =============================================================================

type Layer = { id: number; close: () => void };

const layers: Layer[] = [];
let nextId = 1;

/** Zaregistruje otvorenú vrstvu; vráti funkciu na odregistrovanie. */
export function pushLayer(close: () => void): () => void {
  const layer = { id: nextId++, close };
  layers.push(layer);
  return () => {
    const index = layers.findIndex((item) => item.id === layer.id);
    if (index >= 0) layers.splice(index, 1);
  };
}

/** Zavrie najvrchnejšiu vrstvu. true = niečo sa zavrelo („späť" spotrebované). */
export function closeTopLayer(): boolean {
  const top = layers.pop();
  if (!top) return false;
  top.close();
  return true;
}

export function openLayerCount(): number {
  return layers.length;
}
