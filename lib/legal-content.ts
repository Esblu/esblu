import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_LOCALES, type Locale } from "./i18n/locales";

// =============================================================================
// Nemenný obsah publikovaných verzií právnych dokumentov žije v `legal/`
// (mimo `app/`), NIE inline v .tsx komponentoch stránok. Verejné stránky
// (app/podmienky-pouzivania, app/ochrana-osobnych-udajov, app/dpa,
// app/cookies) sú iba tenké rendering shelly — obsah čítajú odtiaľto a
// vykresľujú cez lib/legal-markdown-render.tsx. content_hash v DB
// (legal_documents, supabase/migrations/20260815100000_add_legal_acceptance.sql)
// je SHA-256 presne TOHOTO súboru, nikdy hash .tsx komponentu.
//
// Priečinok POD legal/ sa nezhoduje 1:1 s legal_documents.type — mapovanie
// je zámerne explicitné (nie odvodené reťazcovou manipuláciou), aby bolo
// vždy na prvý pohľad jasné a nemenilo sa nedopatrením:
//   terms          -> legal/terms/<version>.md
//   privacy_policy -> legal/privacy/<version>.md
//   dpa            -> legal/dpa/<version>.md
//   cookie_policy  -> legal/cookies/<version>.md
// =============================================================================

export type LegalDocumentType =
  | "terms"
  | "privacy_policy"
  | "dpa"
  | "cookie_policy";

const CONTENT_FOLDER_BY_TYPE: Record<LegalDocumentType, string> = {
  terms: "terms",
  privacy_policy: "privacy",
  dpa: "dpa",
  cookie_policy: "cookies",
};

// V mobile builde (samostatný Next.js projekt, mobile/next.config.ts) je cwd
// pri `next build` = mobile/, ktorý žiadny vlastný legal/ priečinok nemá
// (obsah je zdieľaný, nekopíruje sa — presne ako pri app/globals.css
// @source fixe pre Tailwind, pozri tam). process.cwd() by preto v mobile
// builde ukazoval na neexistujúci mobile/legal.
//
// __dirname NEFUNGUJE ako riešenie: Turbopack ho pri serverovom Node.js
// bundlovaní staticky nahrádza virtuálnou hodnotou (napr. "/ROOT"), nie
// skutočnou cestou zdrojového súboru — overené priamym buildom (ENOENT na
// "/ROOT/legal/..."). Preto sa presná absolútna cesta k legal/ vypočíta v
// mobile/next.config.ts (tam __dirname funguje správne, lebo konfig sa
// načítava ako obyčajný Node.js skript, nie je súčasťou Turbopack grafu) a
// odovzdá sa cez build-time env premennú ESBLU_LEGAL_CONTENT_ROOT. Web
// build túto premennú nenastavuje vôbec, takže tam zostáva pôvodné
// process.cwd() správanie bez zmeny.
//
// Mobile Platform (2026-10-08): ESBLU_LEGAL_CONTENT_ROOT sa už NEVKLADÁ cez
// `env` blok mobile/next.config.ts — Next.js by absolútnu cestu build stroja
// vložil do bundlu. Namiesto toho sa legal/ nájde pri serverovom
// prerenderingu relatívne k cwd: web (cwd = koreň) → ./legal, mobile
// (cwd = mobile/) → ../legal. Nič z toho sa nedostane do klientskeho JS.
function resolveLegalContentRoot(): string {
  const candidates = [path.join(process.cwd(), "legal"), path.join(process.cwd(), "..", "legal")];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "terms"))) ?? candidates[0];
}

const LEGAL_CONTENT_ROOT = resolveLegalContentRoot();

/**
 * Cesta k nemennému .md súboru pre danú (document_type, version) — presne
 * ten istý súbor, ktorého SHA-256 je uložený v legal_documents.content_hash
 * PRE SLOVENSKÝ (zdrojový, právne záväzný) originál. content_hash sa VŽDY
 * počíta iba zo slovenského súboru <version>.md, nikdy z jazykovej mutácie
 * — DE/EN sú preklady rovnakého právneho obsahu, nie samostatné právne
 * verzie (acceptance model eviduje iba document_type + version, bez
 * locale — pozri komentár pri readLegalMarkdown nižšie).
 */
export function legalContentFilePath(
  documentType: LegalDocumentType,
  version: string
): string {
  const folder = CONTENT_FOLDER_BY_TYPE[documentType];

  return path.join(LEGAL_CONTENT_ROOT, folder, `${version}.md`);
}

// DE/EN preklady žijú vedľa slovenského originálu ako <version>.<locale>.md
// (napr. legal/terms/1.0.de.md) — ČISTO ADITÍVNE súbory, nikdy nemenia ani
// nenahrádzajú <version>.md. Slovenský text je zdrojový právny obsah;
// preklad musí byť významovo verný, nie marketingová parafráza.
function legalContentFilePathForLocale(
  documentType: LegalDocumentType,
  version: string,
  locale: Locale
): string {
  const folder = CONTENT_FOLDER_BY_TYPE[documentType];

  return path.join(LEGAL_CONTENT_ROOT, folder, `${version}.${locale}.md`);
}

/**
 * Prečíta nemenný obsah danej verzie. Volať iba zo Server Componentov
 * (Node.js runtime) — nie z "use client" komponentov ani z Edge runtime.
 * Raz publikovaný .md súbor sa NIKDY neupravuje — zmena textu = nová
 * verzia = nový súbor (a nový riadok v legal_documents).
 *
 * `locale` je VOLITEĽNÝ a čisto na účely ZOBRAZENIA — neovplyvňuje
 * versioned/immutable legal acceptance model (ten naďalej eviduje iba
 * document_type + version, presne ako predtým, bez locale stĺpca — user
 * akceptuje PRÁVNY DOKUMENT v danej verzii, jazyk zobrazenia je nezávislá
 * UI vec). Pri "sk" (alebo bez parametra) sa vždy číta zdrojový súbor. Pri
 * "de"/"en" appka skúsi preklad `<version>.<locale>.md` a ak ešte
 * neexistuje, bezpečne spadne na slovenský originál (nikdy chyba/prázdna
 * stránka) — fail-safe, nie fail-closed, keďže ide o zobrazenie verejného
 * informačného textu, nie o autorizáciu.
 */
export function readLegalMarkdown(
  documentType: LegalDocumentType,
  version: string,
  locale: Locale = "sk"
): string {
  if (locale !== "sk") {
    const translatedPath = legalContentFilePathForLocale(
      documentType,
      version,
      locale
    );

    if (fs.existsSync(translatedPath)) {
      return fs.readFileSync(translatedPath, "utf8");
    }
  }

  return fs.readFileSync(legalContentFilePath(documentType, version), "utf8");
}

/**
 * Prečíta VŠETKY tri jazykové mutácie naraz (sk/de/en, s fail-safe fallbackom
 * na sk pri chýbajúcom preklade — rovnaká logika ako readLegalMarkdown()).
 *
 * Dôvod existencie: appka od revízie i18n architektúry (pozri
 * lib/i18n/locales.ts) nepoužíva cookie na server-side detekciu jazyka —
 * Server Component teda pri prvom renderi nevie, ktorý jazyk klient
 * preferuje. Namiesto výberu JEDNÉHO súboru server-side preto stránka
 * prečíta všetky tri varianty a odovzdá ich "use client" komponentu, ktorý
 * si správny variant vyberie sám podľa localStorage (useLocale()) — bez
 * ďalšieho sieťového/FS požiadavku a bez cookie.
 */
export function readLegalMarkdownAllLocales(
  documentType: LegalDocumentType,
  version: string
): Record<Locale, string> {
  const result = {} as Record<Locale, string>;

  for (const locale of SUPPORTED_LOCALES) {
    result[locale] = readLegalMarkdown(documentType, version, locale);
  }

  return result;
}
