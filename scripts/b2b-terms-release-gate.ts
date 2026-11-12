// =============================================================================
// B2B VOP 1.2 — PRODUKČNÁ BRÁNA (nie je súčasťou test:* regresie).
// Musí prejsť PRED produkčným nasadením VOP 1.2:
//   - legalConfig.publicPhone je vyplnené (22/2004 § 4; VOP čl. 1 → /kontakt)
//   - VOP SK/EN/DE neobsahujú zástupné texty
//   - hash v migrácii = sha256(legal/terms/1.2.md)
//
//   npm run check:b2b-terms-release
// =============================================================================
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { legalConfig } from "@/lib/legal-config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const problems: string[] = [];

if (!/^\+?[0-9][0-9 ]{7,}$/.test(legalConfig.publicPhone.trim())) {
  problems.push("legalConfig.publicPhone nie je vyplnené (HARD STOP — firemné/kontaktné číslo doplní vlastník)");
}
for (const f of ["legal/terms/1.2.md", "legal/terms/1.2.en.md", "legal/terms/1.2.de.md"]) {
  if (/\[[^\]]*(doplní|to be added|ergänzt)[^\]]*\]/i.test(read(f))) problems.push(`${f}: zástupný text`);
}
const h = createHash("sha256").update(readFileSync(path.join(ROOT, "legal/terms/1.2.md"))).digest("hex");
if (!read("supabase/migrations/20261112100000_b2b_terms_1_2_company_acceptance.sql").includes(h)) {
  problems.push("migrácia 20261112100000 nemá aktuálny hash legal/terms/1.2.md");
}

// Re-audit 2026-11-12: termination/DPA delete flow a export musia byť súčasťou releasu.
for (const f of [
  "supabase/migrations/20261112110000_company_termination_workflow.sql",
  "app/api/company/export/route.ts",
]) {
  try {
    read(f);
  } catch {
    problems.push(`${f}: chýba (termination / export údajov firmy)`);
  }
}

if (problems.length) {
  console.log(`HARD STOP — VOP 1.2 nie je pripravené na produkciu:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("VOP 1.2 release gate: OK");
