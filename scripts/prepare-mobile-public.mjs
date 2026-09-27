#!/usr/bin/env node
// -----------------------------------------------------------------------------
// scripts/prepare-mobile-public.mjs
//
// Build-time príprava mobile/public/ pred mobile Next.js buildom.
//
// PREČO TOTO EXISTUJE: mobile/ je samostatný Next.js projekt (FÁZA 1
// Capacitor PoC), ktorý potrebuje vlastný fyzický public/ adresár (next
// vyžaduje presne tento názov na koreni projektu). Pôvodne sme použili
// symlink (mobile/public -> ../public), ale symlinky sú krehké na Windows
// (potrebujú Developer Mode / core.symlinks=true v Git for Windows, inak sa
// pri checkoute vytvorí len textový súbor s cestou namiesto reálneho
// adresára). Namiesto symlinku preto pred KAŽDÝM mobile buildom skopírujeme
// obsah koreňového public/ do mobile/public/ pomocou čistého Node.js fs API
// (žiadny shell `cp`/`rsync` — funguje identicky na Windows aj Linuxe/macOS).
//
// mobile/public/ je GENEROVANÝ artefakt — je v mobile/.gitignore, NIKDY sa
// necommituje. Jediný zdroj pravdy zostáva koreňový public/, ktorý tento
// script iba ČÍTA, nikdy nezapisuje.
//
// Spúšťa sa automaticky ako "predev"/"prebuild" npm lifecycle hook z
// mobile/package.json — netreba ho spúšťať ručne.
// -----------------------------------------------------------------------------

import { existsSync, rmSync, cpSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(__dirname, "..", "mobile");
const rootPublicDir = path.resolve(__dirname, "..", "public");
const mobilePublicDir = path.join(mobileDir, "public");

function main() {
  if (!existsSync(rootPublicDir)) {
    throw new Error(
      `[prepare-mobile-public] Koreňový public/ adresár neexistuje: ${rootPublicDir}`
    );
  }

  // Odstráň starý generovaný mobile/public (súbor, symlink alebo adresár —
  // lstatSync (nie statSync) zámerne NEsleduje symlink, aby sme vždy
  // odstránili presne to, čo je na tejto ceste, nie cieľ symlinku).
  if (existsSync(mobilePublicDir) || isBrokenSymlink(mobilePublicDir)) {
    rmSync(mobilePublicDir, { recursive: true, force: true });
  }

  // Čistá Node.js kópia (fs.cpSync, dostupné od Node 16.7+) — žiadny shell
  // `cp -r`/`rsync`, funguje identicky na Windows/macOS/Linux.
  //
  // Mobile M0 (2026-09-27): vynechané sú adresáre, ktoré do natívnej appky
  // nepatria — video/ (~41 MB demo MP4 pre marketingovú landing page webu)
  // a .well-known/ (assetlinks.json / AASA musia byť iba na webovej
  // doméne, v bundli appky nemajú žiadny význam).
  cpSync(rootPublicDir, mobilePublicDir, {
    recursive: true,
    filter: (source) => !isExcludedFromMobile(source),
  });

  console.log(
    `[prepare-mobile-public] Skopírované: ${rootPublicDir} -> ${mobilePublicDir}`
  );
}

// Top-level položky koreňového public/, ktoré sa do mobile/public NEKOPÍRUJÚ.
const MOBILE_PUBLIC_EXCLUDES = ["video", ".well-known"];

function isExcludedFromMobile(source) {
  const relative = path.relative(rootPublicDir, source);
  if (!relative || relative.startsWith("..")) return false;
  const top = relative.split(path.sep)[0];
  return MOBILE_PUBLIC_EXCLUDES.includes(top);
}

function isBrokenSymlink(p) {
  try {
    const stat = lstatSync(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

main();
