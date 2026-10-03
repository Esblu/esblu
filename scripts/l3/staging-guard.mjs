// =============================================================================
// L3 staging — HARD GUARD. Každý L3 krok (restore, seed, rollout, E2E) ho volá
// ako prvý. Nikdy nevypisuje URL, heslá ani kľúče — iba verdikt.
//
//   - cieľ MUSÍ byť staging ref cjbdijbbcujvmrzezusd (esblu-test),
//   - ak sa produkčný ref fkpgvgvsmbpieduoatrt objaví v ktorejkoľvek cieľovej
//     premennej (ref, URL, DB URL) → okamžitý STOP (exit 3).
//
// Použitie: node scripts/l3/staging-guard.mjs   (číta STAGING_* z env)
// =============================================================================

export const STAGING_REF = "cjbdijbbcujvmrzezusd";
export const PRODUCTION_REF = "fkpgvgvsmbpieduoatrt";

/** Hodí chybu, ak cieľ nie je výhradne staging. Vstup: ref + ľubovoľné URL cieľa. */
export function assertStagingTarget({ ref, urls = [] }) {
  const values = [ref, ...urls].filter((v) => typeof v === "string" && v.length > 0);
  if (values.some((v) => v.includes(PRODUCTION_REF))) {
    throw new Error("L3_GUARD_STOP: produkčný project ref v cieli — nič sa nevykoná");
  }
  if (ref !== STAGING_REF) throw new Error("L3_GUARD_STOP: target ref nie je staging (esblu-test)");
  for (const url of urls.filter(Boolean)) {
    if (!url.includes(STAGING_REF)) throw new Error("L3_GUARD_STOP: cieľová URL nepatrí staging projektu");
  }
  return true;
}

const isCli = import.meta.url === new URL(process.argv[1] ?? "", "file://").href || process.argv[1]?.endsWith("staging-guard.mjs");
if (isCli) {
  try {
    assertStagingTarget({
      ref: process.env.STAGING_SUPABASE_REF?.trim(),
      urls: [process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.STAGING_DB_URL].map((v) => v?.trim()),
    });
    console.log("L3_GUARD_OK: cieľ je staging esblu-test");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "L3_GUARD_STOP");
    process.exit(3);
  }
}
