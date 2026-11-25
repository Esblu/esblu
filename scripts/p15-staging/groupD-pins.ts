// =============================================================================
// P1-5 skupina D — F-4/F-5 pre runner výmazu: presné parametre Node a SHA-256 všetkých lokálnych súborov, ktoré
// proces načíta (graf trasovaný v Node 22 cez load hook).
// .ps1 overí to isté pred spustením Node. Závislosti v node_modules overuje dependency-lock.json (skupina C).
// =============================================================================
import { assertCleanProcess, EXPECTED_EXEC_ARGV, Stop } from "./runner-core.ts";

export const D_EXEC_ARGV = ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/alias-loader.mjs"];

export function assertCleanProcessD(env: Record<string, string | undefined>, execArgv: string[]): void {
  assertCleanProcess(env, EXPECTED_EXEC_ARGV); // iba premenné prostredia (F-5)
  if (execArgv.length !== D_EXEC_ARGV.length || execArgv.some((a, i) => a !== D_EXEC_ARGV[i])) {
    throw new Stop(`F-5: nečakané parametre Node (${execArgv.join(" ")})`);
  }
}

/** Generované z trasovania načítaných súborov (load hook, 2026-11-25) — pri zmene súboru pregenerovať a znovu schváliť. */
export const D_EXPECTED_LOCAL_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "lib/account-deletion-deps.ts": "dacfdf33d7d69fa17b4afc0f768ac3cecae69ad322ce28ca91ac3ee0be0661b4",
  "lib/account-deletion-orchestrator.ts": "d524a1cb817b58e3b6ab49d80d75782a0e9fc564081d2e5962377ce67a751b79",
  "lib/account-deletion-storage.ts": "920d861fcbf47c4b32d9b6e002a5461ad608b64dd4bd5ee40ca177ee862428e3",
  "lib/company-export.ts": "96adf813c4e03ba2ec15132900fa53dab6b582b584d016715edfc0a73f034eac",
  "lib/company-termination-ack.ts": "ca4532ef2e8460ac119e28d63ba1f6e33ef1c6f6191bb0ac45f74b254d6236c0",
  "lib/einvoice/visibility.ts": "7013c5f61aa819e6d299fd4eeeef9c9a65fc59cebf634d381756c54f1f14a5d2",
  "lib/i18n/dictionaries/de.ts": "d0fa694e9d20d6c1bf605ed0a116cebaa68f521206060cf0aa35bc9435b6837b",
  "lib/i18n/dictionaries/en.ts": "c650d56c4896b6669bb344180988e72d488f86d4714ae5bbcfe147e134eb05ff",
  "lib/i18n/dictionaries/index.ts": "9094a251da6a505ca644187a69f4c4f71047c4c72e425a8130a4598a06626a9d",
  "lib/i18n/dictionaries/sk.ts": "6ada04cdcbcd79ce2dcc563e85d71ba7cf809cc6610197a199c5b38d7210727d",
  "lib/i18n/locales.ts": "17b28cf83dd3efe0498eb8b331506087aa55c697a2be7f5e57040e39e6e2364f",
  "lib/i18n/translate.ts": "5bb5571f9f2c1cbb8858632e892f0498d82c51b51071734e1ce8b631deffdb4b",
  "scripts/alias-loader.mjs": "39456db8a03ce36f640ff43f98553cf3b2b902dcf1419df70d8435dcd8a3dccc",
  "scripts/p15-staging/dependency-lock.json": "51c7b7fccbad2c2f844ce2a873dafaa68bb9c2c9c31decf8b999a95b1df4d632",
  "scripts/p15-staging/groupD-core.ts": "dd4ad9c74414e85b4657a6f74a9a95b73cbae3db78a52808f4fba71177ce382b",
  "scripts/p15-staging/groupD-runner.ts": "b4e91042d4bbdfcba07b0132820aa812be82193b926683682d40111f62952e05",
  "scripts/p15-staging/manifest.json": "fd81a8f55f12c46a488f58441c7ef411a3620f50499f13b86f3804fba0b77d51",
  "scripts/p15-staging/runner-core.ts": "112729265069214a6714357d53d16a843c9ee39b32adb69aea3cb30d17dac54c",
});
