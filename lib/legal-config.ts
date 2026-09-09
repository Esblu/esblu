// =============================================================================
// Esblu — centrálna legal konfigurácia
// =============================================================================
// JEDINÝ zdroj pravdy pre právnu identitu prevádzkovateľa a verzie právnych
// dokumentov. Žiadny komponent/stránka nesmie identitu prevádzkovateľa
// (meno, adresu, IČO a pod.) vpisovať natvrdo — vždy importuj z tohto
// súboru, aby zmena (napr. budúca zmena sídla) znamenala úpravu na jednom
// mieste.
//
// Prevádzkovateľom Esblu je od tejto revízie (2026-09-09) spoločnosť
// Esblu s. r. o. (predtým fyzická osoba Jaroslav Juriš) — pozri
// docs/gdpr-compliance-review-2026-08-15.md a nové verzie legal/terms/1.1.md,
// legal/privacy/1.3.md, legal/dpa/1.2.md. Deň zápisu spoločnosti do
// obchodného registra sa VEDOME NEUVÁDZA (nie je súčasťou zadania a nie je
// potrebný pre žiadny z právnych textov). DIČ a IČ DPH ostávajú `null` —
// nie sú pre aktuálny rozsah reálne potrebné.
// =============================================================================

export type LegalPersonType = "fyzická osoba" | "právnická osoba";

export const legalConfig = {
  // --- Identita prevádzkovateľa (controller) ---------------------------------
  controllerName: "Esblu s. r. o.",
  legalForm: "právnická osoba" as LegalPersonType,

  address: "Karpatské námestie 10A, 831 06 Bratislava – mestská časť Rača",
  country: "Slovenská republika",

  contactEmail: "info@esblu.com",
  privacyEmail: "privacy@esblu.com",

  businessId: "57 815 941", // IČO
  taxId: null as string | null, // DIČ — neuvádza sa, nie je aktuálne potrebné
  vatId: null as string | null, // IČ DPH — neuvádza sa, nie je aktuálne potrebné

  // --- Verzovanie právnych dokumentov -----------------------------------------
  // effectiveDate = dátum, odkedy platí AKTUÁLNA verzia nižšie uvedených
  // dokumentov. Zhoduje sa s "Posledná aktualizácia" na dnešných verejných
  // stránkach. Pri KAŽDEJ obsahovej zmene dokumentu treba zvýšiť príslušné
  // *Version pole a effectiveDate — verzia sa následne premieta do
  // legal_documents (DB) a do user_legal_acceptances (kto akú verziu
  // akceptoval, pozri supabase/migrations/…_add_legal_acceptance.sql).
  effectiveDate: "2026-09-09",
  // Ochrana osobných údajov ide vo verzii 1.3 — história: 1.0 (21. júla
  // 2026) → 1.1 (15. augusta 2026, oprava nepresného zoznamu dodávateľov
  // v sekcii E) → 1.2 (16. augusta 2026, doplnenie Namecheap do sekcie E)
  // → 1.3 (9. septembra 2026, prechod identifikácie prevádzkovateľa z
  // fyzickej osoby Jaroslav Juriš na Esblu s. r. o. v sekcii A — jediná
  // obsahová zmena, zvyšok dokumentu bezo zmeny). Pozri legal/privacy/1.3.md
  // a supabase/migrations/20260909100000_add_esblu_sro_identity_legal_versions.sql.
  privacyPolicyVersion: "1.3",
  // Podmienky používania idú vo verzii 1.1 — história: 1.0 (21. júla 2026)
  // → 1.1 (9. septembra 2026, prechod identifikácie prevádzkovateľa z
  // fyzickej osoby Jaroslav Juriš na Esblu s. r. o. v úvodnej vete — jediná
  // obsahová zmena). Pozri legal/terms/1.1.md.
  termsVersion: "1.1",
  // Cookie Policy ostáva na v1.0 (revidované 2026-08-19). Prvý pokus pri
  // implementácii viacjazyčnej podpory (SK/DE/EN) ukladal zvolený jazyk do
  // nového cookie `esblu_locale`, čo by bolo v rozpore s tvrdením v1.0
  // "Esblu aktuálne nepoužíva žiadne cookies" a vyžiadalo by si novú verziu
  // (pozri zrušenú migráciu — bod nižšie). Namiesto pridávania novej
  // cookie appka jazykovú preferenciu ukladá do localStorage (rovnaký
  // mechanizmus, aký už appka používa na Supabase Auth session token) —
  // pozri lib/i18n/locales.ts a lib/i18n/LocaleProvider.tsx. Právny obsah
  // Cookie Policy sa teda skutočne NEMENÍ a nová verzia nie je potrebná.
  // ZRUŠENÉ (nikdy neaplikované v produkcii): pôvodná migrácia
  // supabase/migrations/20260819100000_add_cookie_policy_v1_1_locale.sql
  // a súbory legal/cookies/1.1*.md boli odstránené v rámci tejto revízie.
  cookiePolicyVersion: "1.0",
  // DPA ide vo verzii 1.2 — história: 1.0 (nikdy verejne nasadená) → 1.1
  // (plné pokrytie čl. 28, pozri docs/gdpr-compliance-review-2026-08-15.md)
  // → 1.2 (9. septembra 2026, prechod identifikácie prevádzkovateľa z
  // fyzickej osoby Jaroslav Juriš na Esblu s. r. o. v úvodnom odseku —
  // jediná obsahová zmena, zvyšok dokumentu bezo zmeny). Pozri
  // legal/dpa/1.2.md.
  dpaVersion: "1.2",
} as const;

// Dokumenty, ktoré musí AKTÍVNY používateľ (owner/admin/employee) akceptovať
// pred ďalším používaním appky. Iba tieto dva sú "required" v zmysle
// legal_documents.required = true — DPA a Subprocessors sú informačné/B2B
// dokumenty bez osobnej acceptance povinnosti pre bežného používateľa.
export const REQUIRED_ACCEPTANCE_DOCUMENTS = [
  {
    type: "terms" as const,
    version: legalConfig.termsVersion,
    label: "Podmienky používania",
    href: "/podmienky-pouzivania",
  },
  {
    type: "privacy_policy" as const,
    version: legalConfig.privacyPolicyVersion,
    label: "Zásady ochrany osobných údajov",
    href: "/ochrana-osobnych-udajov",
  },
] as const;

export type LegalDocumentType =
  (typeof REQUIRED_ACCEPTANCE_DOCUMENTS)[number]["type"];
