#!/usr/bin/env node
// Vyrenderuje AASA + assetlinks zo šablón (mobile/deep-link-templates). Fail closed:
// bez platného Team ID / SHA-256 nič nezapíše. Nič nenasadzuje.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "mobile", "deep-link-templates");
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export function renderDeepLinkFiles({ teamId, playSha256 }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("Neplatný Apple Team ID (10 znakov A-Z0-9)");
  if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(playSha256 ?? "")) throw new Error("Neplatný SHA-256 fingerprint (AA:BB:… 32 bajtov)");
  const aasa = readFileSync(path.join(DIR, "apple-app-site-association.template.json"), "utf8").replaceAll("__APPLE_TEAM_ID__", teamId);
  const links = readFileSync(path.join(DIR, "assetlinks.template.json"), "utf8").replaceAll("__GOOGLE_PLAY_APP_SIGNING_SHA256__", playSha256);
  JSON.parse(aasa);
  JSON.parse(links);
  if (/__[A-Z_]+__/.test(aasa + links)) throw new Error("Nevyplnený placeholder");
  return { aasa, links };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const { aasa, links } = renderDeepLinkFiles({ teamId: arg("--team-id"), playSha256: arg("--play-sha256") });
    const out = path.join(DIR, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "apple-app-site-association"), aasa);
    writeFileSync(path.join(out, "assetlinks.json"), links);
    console.log(`OK → ${out} (NENASADENÉ)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
