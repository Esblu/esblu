// =============================================================================
// B2B VOP 1.2 — unit/statické testy (bez DB, bez siete).
//   - SK originál + EN/DE preklady: 44 článkov, zhodná štruktúra a čísla
//   - config ↔ súbory ↔ DB seed hash; verejná stránka + predchádzajúce verzie
//   - mobile route, firemný gate (B2B + oprávnenie), i18n kľúče v 3 jazykoch
//   - žiadne spotrebiteľské / nepravdivé tvrdenia (SLA, testovacia verzia,
//     zákonný archív Esblu), konzistencia s Cenníkom / DPA / PP
//
//   npm run test:b2b-terms
// =============================================================================
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { legalConfig, PREVIOUS_TERMS_VERSIONS, REQUIRED_ACCEPTANCE_DOCUMENTS } from "@/lib/legal-config";
import { legalTranslationAvailability } from "@/lib/legal-content";
import { registrationAckVersions } from "@/lib/legal-ack-versions";
import sk from "@/lib/i18n/dictionaries/sk";
import en from "@/lib/i18n/dictionaries/en";
import de from "@/lib/i18n/dictionaries/de";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n       ") : String(error)}`);
  }
}

const SK = read("legal/terms/1.2.md");
const EN = read("legal/terms/1.2.en.md");
const DE = read("legal/terms/1.2.de.md");
const shape = (t: string) =>
  t.split("\n").map((l) => (l === "" ? "_" : l.startsWith("## ") ? `H${l.match(/^## (\d+)\./)?.[1]}` : l.match(/^\*\*(\d+\.\d+)\*\*/)?.[1] ?? (l.startsWith("- ") ? "-" : "t")));
const numbers = (t: string) => (t.match(/\d+/g) ?? []).join(",");
const links = (t: string) => (t.match(/\]\(([^)]+)\)/g) ?? []).join(",");

check("termsVersion = 1.2, required dokument, registrácia potvrdzuje 1.2", () => {
  assert.equal(legalConfig.termsVersion, "1.2");
  assert.equal(REQUIRED_ACCEPTANCE_DOCUMENTS.find((d) => d.type === "terms")?.version, "1.2");
  assert.equal(REQUIRED_ACCEPTANCE_DOCUMENTS.find((d) => d.type === "terms")?.label, "Všeobecné obchodné podmienky");
  assert.equal(registrationAckVersions(null).find((d) => d.type === "terms")?.version, "1.2");
});

check("SK originál: 44 článkov v poradí 1–44, verzia 1.2, B2B rozsah", () => {
  const heads = SK.split("\n").filter((l) => l.startsWith("## ")).map((l) => Number(l.match(/^## (\d+)\./)?.[1]));
  assert.deepEqual(heads, Array.from({ length: 44 }, (_, i) => i + 1));
  assert.match(SK.trimEnd(), /Verzia 1\.2$/);
  assert.match(SK, /výlučne na podnikateľské alebo profesijné účely/);
  assert.match(SK, /zákon č\. 513\/1991 Zb\. Obchodný zákonník/);
});

check("EN/DE = úplné preklady: rovnaká štruktúra riadkov, čísla a odkazy", () => {
  for (const [name, tr] of [["en", EN], ["de", DE]] as const) {
    assert.deepEqual(shape(tr), shape(SK), `${name} štruktúra`);
    assert.equal(numbers(tr), numbers(SK), `${name} čísla`);
    assert.equal(links(tr), links(SK), `${name} odkazy`);
    assert.ok(tr.endsWith("\n") && !tr.endsWith("\n\n"), `${name} koniec súboru`);
  }
  assert.deepEqual(legalTranslationAvailability("terms", "1.2"), { sk: true, en: true, de: true });
});

check("DB seed hash = sha256(legal/terms/1.2.md), canonical /podmienky-pouzivania, firemné prijatie + 30-dňová lehota", () => {
  const h = createHash("sha256").update(readFileSync(path.join(ROOT, "legal/terms/1.2.md"))).digest("hex");
  const m = read("supabase/migrations/20261112100000_b2b_terms_1_2_company_acceptance.sql");
  assert.ok(m.includes(`('terms', '1.2', now(), false, '${h}', '/podmienky-pouzivania', 30)`));
  assert.ok(existsSync(path.join(ROOT, "supabase/rollback/20261112100000_b2b_terms_1_2_company_acceptance_rollback.sql")));
});

check("predchádzajúce verzie sú nemenné a verejne zobrazené (VOP 8.3)", () => {
  assert.deepEqual([...PREVIOUS_TERMS_VERSIONS], ["1.1", "1.0"]);
  for (const v of PREVIOUS_TERMS_VERSIONS) assert.ok(existsSync(path.join(ROOT, `legal/terms/${v}.md`)), v);
  const page = read("app/podmienky-pouzivania/page.tsx");
  assert.match(page, /PreviousLegalVersions/);
  assert.match(page, /legalTranslationAvailability\("terms", legalConfig\.termsVersion\)/);
  assert.match(read("mobile/app/podmienky-pouzivania/page.tsx"), /export \{ default \} from "@\/app\/podmienky-pouzivania\/page"/);
});

check("firemný gate: owner potvrdzuje B2B + oprávnenie, VOP pred DPA, legal-hold iba pri DPA", () => {
  const g = read("app/components/CompanyDpaGate.tsx");
  assert.match(g, /acceptCompanyTerms\(/);
  assert.match(g, /disabled=\{!confirmedB2b \|\| !confirmedTermsAuthority \|\| submitting\}/);
  assert.match(g, /isOwner && !showTermsModal && !termsConfirmation && !termsBlocking && dpaPending/);
  assert.match(g, /termsBlocking = termsPending && !!termsStatus\?\.required_now/);
  assert.match(g, /company-terms-grace-notice/);
  assert.match(g, /company-terms-confirmation/);
  assert.match(g, /company-terms-review/);
  assert.match(g, /legalHold: dpaPending/);
  const lib = read("lib/company-dpa.ts");
  assert.match(lib, /esblu_accept_company_terms/);
  assert.match(lib, /p_b2b_confirmed: b2bConfirmed/);
  assert.match(lib, /p_locale: currentDisplayLocale\(\)/);
});

check("i18n: companyTermsGate + legal.previousVersions v SK/EN/DE so zhodnými kľúčmi", () => {
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
  const g = (d: typeof sk) => (d as unknown as { companyTermsGate: object }).companyTermsGate;
  assert.deepEqual(keys(g(en)), keys(g(sk)));
  assert.deepEqual(keys(g(de)), keys(g(sk)));
  for (const d of [sk, en, de]) {
    const legal = (d as unknown as { legal: Record<string, unknown> }).legal;
    assert.ok(legal.previousVersions && legal.versionLabel);
    const errs = (d as unknown as { companyDpaGate: { errors: Record<string, string> } }).companyDpaGate.errors;
    assert.ok(errs.ESBLU_COMPANY_TERMS_NOT_ACCEPTED);
  }
});

check("bez rozporu: žiadne 'Podmienky používania' / 'bezplatná testovacia verzia' / Esblu ako zákonný archív v UI", () => {
  const s = read("lib/i18n/dictionaries/sk.ts");
  assert.ok(!s.includes("Podmienky používania"));
  assert.ok(!s.includes("bezplatná testovacia verzia"));
  assert.ok(!s.includes("Esblu povinné archivovať"));
  assert.ok(!read("lib/i18n/dictionaries/en.ts").includes("Terms of Use"));
  assert.ok(!read("lib/i18n/dictionaries/de.ts").includes("Nutzungsbedingungen"));
});

check("VOP neobsahuje vymyslené SLA ani spotrebiteľské inštitúty (nie sú ponúkané)", () => {
  assert.doesNotMatch(SK, /99[.,]\d+\s*%/);
  assert.doesNotMatch(SK, /odstúpiť od zmluvy do 14 dní|alternatívne riešenie spotrebiteľských sporov|reklamačný poriadok/i);
  assert.match(SK, /negarantuje nepretržitú prevádzku, konkrétnu percentuálnu dostupnosť/);
  // kogentné práva sa nevylučujú (nie obchádzanie spotrebiteľského práva)
  assert.match(SK, /tým nie sú dotknuté práva, ktoré takejto osobe priznávajú kogentné právne predpisy/);
});

check("konzistencia s produktom: trial 14 dní, bez karty, downgrade bez mazania, eFaktúra neaktívna, AI návrhy", () => {
  assert.match(read("supabase/migrations/20261012160000_legal_entity_trial_final.sql"), /now\(\) \+ interval '14 days'/);
  assert.match(SK, /v trvaní 14 dní/);
  assert.match(SK, /nie je potrebné zadať platobnú kartu/);
  assert.match(SK, /údaje Firmy automaticky nemažú, nepresúvajú ani neskrývajú/);
  assert.match(SK, /sprístupní až po jej spustení/);
  assert.match(SK, /Esblu nie je prístupovým bodom siete Peppol/);
  assert.match(SK, /Odoslanie alebo doručenie elektronickej faktúry neznamená jej úhradu/);
  assert.match(SK, /Výstupy týchto funkcií sú návrhmi/);
  assert.match(SK, /nevykonávajú rozhodnutia s právnymi účinkami/);
});

check("konzistencia s DPA 1.3 / PP 1.4 / Cookies 1.1 (odkazy a prednosť DPA)", () => {
  assert.equal(legalConfig.dpaVersion, "1.3");
  assert.equal(legalConfig.privacyPolicyVersion, "1.4");
  for (const href of ["/dpa", "/ochrana-osobnych-udajov", "/cookies", "/subprocessors", "/cennik"]) assert.ok(SK.includes(`(${href})`), href);
  assert.match(SK, /V otázkach spracúvania osobných údajov má DPA prednosť pred týmito VOP/);
  assert.match(read("legal/dpa/1.3.md"), /trénovanie modelov umelej inteligencie/);
});

check("ChatGPT audit: čl. 1 (SOI adresa, DPH, telefón cez /kontakt), Firma ≠ Zákazník", () => {
  assert.match(SK, /Slovenská obchodná inšpekcia, Ústredný inšpektorát, Bajkalská 21\/A, P\. O\. BOX 29, 827 99 Bratislava/);
  assert.match(SK, /Ku dňu účinnosti týchto VOP Esblu nie je platiteľom DPH\./);
  assert.match(SK, /\*\*Telefón:\*\* aktuálne kontaktné telefónne číslo je uvedené na stránke \[Kontakt\]\(\/kontakt\)/);
  assert.doesNotMatch(SK, /každá Firma je samostatným Zákazníkom/);
  assert.match(SK, /Firma je jednotkou Predplatného/);
  assert.match(read("app/kontakt/ContactPageClient.tsx"), /legalConfig\.publicPhone/);
  assert.equal(legalConfig.publicPhone, "0903 464 006");
});

check("ChatGPT audit: čl. 8 (kroky, oprava, uchovanie, jazyk, potvrdenie; bez prijatia nevlastníkom)", () => {
  assert.doesNotMatch(SK, /Používateľom, ktorý nie je Vlastníkom, znamená/);
  assert.match(SK, /vykonať ho môže iba Vlastník/);
  assert.match(SK, /bez odoslania sa Zmluva neuzatvára/);
  assert.match(SK, /Vlastník ho môže kedykoľvek zobraziť v nastaveniach Aplikácie/);
  assert.match(SK, /Zmluva sa uzatvára v slovenskom jazyku/);
  assert.match(SK, /\*\*8\.5\*\* Esblu potvrdí uzatvorenie Zmluvy bez zbytočného odkladu elektronicky/);
  assert.match(read("app/nastavenia/page.tsx"), /CompanyLegalAcceptancesSection/);
});

check("ChatGPT audit: čl. 17.2, 20.2/20.6, 36, 39, 43, 44.5", () => {
  assert.match(SK, /výpoveď nadobudne účinnosť uplynutím aktuálneho zaplateného zúčtovacieho obdobia, ak sa zmluvné strany nedohodnú na skoršom skončení/);
  assert.match(SK, /neobmedzuje právo Zákazníka po skončení poskytovania služieb rozhodnúť podľa DPA o vrátení alebo výmaze osobných údajov/);
  assert.match(SK, /Esblu nemá vlastnú zákonnú povinnosť archivovať účtovné doklady Zákazníka/);
  assert.doesNotMatch(SK, /500 EUR|12 mesiacov pred vznikom škody/);
  assert.match(SK, /pravidla o predvídateľnosti škody podľa § 379 Obchodného zákonníka/);
  assert.match(SK, /§ 386 ods\. 1 Obchodného zákonníka/);
  assert.doesNotMatch(SK, /sa považuje za súhlas so zmenou/);
  assert.match(SK, /Pokračovanie v používaní Aplikácie samo osebe nepredstavuje súhlas/);
  assert.match(SK, /Prípadné spory budú rozhodované príslušnými súdmi podľa uplatniteľných právnych predpisov/);
  assert.doesNotMatch(SK, /podľa sídla Esblu/);
  assert.match(SK, /Do prijatia, najdlhšie do uplynutia tejto lehoty, sa vzťah spravuje Podmienkami používania vo verzii 1\.1/);
});

check("produkčná brána existuje a nie je súčasťou test:* regresie", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["check:b2b-terms-release"]);
  assert.ok(!Object.keys(pkg.scripts).some((k) => k.startsWith("test:") && pkg.scripts[k].includes("b2b-terms-release-gate")));
});

check("re-audit: výpadky nezakladajú automatický nárok, súčinnosť, tvrdenie ≠ uznanie, zákonná zodpovednosť nedotknutá", () => {
  assert.match(SK, /Esblu negarantuje nepretržitú prevádzku, konkrétnu percentuálnu dostupnosť ani to, že Aplikácia bude bez chýb/);
  assert.match(SK, /samo osebe nezakladá nárok na zľavu z odplaty ani na náhradu škody/);
  assert.match(SK, /bez zbytočného odkladu po tom, ako poruchu zistil/);
  assert.match(SK, /primeranú súčinnosť pri diagnostike/);
  assert.match(SK, /samotné tvrdenie o výpadku, nedostupnosti údajov alebo škode nepredstavuje uznanie nároku/);
  assert.match(SK, /zodpovednosť Esblu za porušenie jej zákonných povinností, za úmyselné konanie/);
  assert.doesNotMatch(SK, /500 EUR|12 mesiacov pred vznikom škody/);
});

check("re-audit: export všetkých údajov (19.2), obnova zo záloh bez sľubu 100 % (19.4), termination workflow (20.6)", () => {
  assert.match(SK, /export všetkých údajov Firmy, a to záznamy vo formáte JSON a CSV a originálne súbory vo formáte ZIP/);
  assert.match(SK, /obnova zo zálohy nemusí zahŕňať zmeny vykonané po jej vytvorení/);
  assert.match(SK, /Výmaz databázových záznamov prebieha naraz v jednom kroku/);
  assert.match(SK, /Esblu nemá vlastnú zákonnú povinnosť archivovať účtovné doklady Zákazníka/);
  assert.doesNotMatch(SK, /zákonný archív zákazníckych/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
