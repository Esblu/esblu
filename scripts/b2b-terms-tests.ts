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

check("DB seed hash = sha256(legal/terms/1.2.md), canonical /podmienky-pouzivania, required", () => {
  const h = createHash("sha256").update(readFileSync(path.join(ROOT, "legal/terms/1.2.md"))).digest("hex");
  const m = read("supabase/migrations/20261112100000_b2b_terms_1_2_company_acceptance.sql");
  assert.ok(m.includes(`('terms', '1.2', now(), true, '${h}', '/podmienky-pouzivania')`));
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
  assert.match(g, /isOwner && !termsPending && dpaPending/);
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
  assert.match(SK, /negarantuje konkrétnu percentuálnu dostupnosť/);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
