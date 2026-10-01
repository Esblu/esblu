import { canonicalIco } from "./normalize.ts";
import type { CompanyDetail } from "./types.ts";

// =============================================================================
// Registrový detail → polia formulára obchodného partnera (klient aj test).
// =============================================================================
//   - prepíšu sa IBA polia, ktoré register naozaj vedie (názov, IČO, DIČ,
//     sídlo); ostatné (e-mail, IBAN, Peppol, splatnosť…) ostávajú,
//   - chýbajúca registrová hodnota pole vyprázdni — nesmie v ňom ostať
//     adresa/DIČ inej firmy z predchádzajúceho výberu,
//   - ak sa výberom zmenil subjekt (iné IČO), vyprázdnia sa aj IČ DPH a VAT
//     identifikátor: patrili inému subjektu a register PHASE 1 ich nevedie,
//   - legal_registration_id sa ZÁMERNE nenastavuje z IČO (EN16931 mapovanie
//     rozhoduje používateľ, pozri app/obchodni-partneri/page.tsx §14),
//   - nič sa neukladá: formulár ukáže hodnoty a uloží ich až človek.
// =============================================================================

export type RegistryPrefillableForm = {
  legal_name: string;
  ico: string;
  dic: string;
  ic_dph: string;
  vat_identifier: string;
  address_line1: string;
  address_line2: string;
  city: string;
  postal_code: string;
  country_code: string;
};

export function applyCompanyDetailToForm<F extends RegistryPrefillableForm>(form: F, detail: CompanyDetail): F {
  const previousIco = canonicalIco(form.ico);
  const subjectChanged = previousIco !== null && previousIco !== detail.ico;
  return {
    ...form,
    legal_name: detail.name,
    ico: detail.ico,
    dic: detail.dic ?? "",
    address_line1: detail.addressLine1 ?? "",
    address_line2: "",
    city: detail.city ?? "",
    postal_code: detail.postalCode ?? "",
    country_code: detail.countryCode ?? "",
    ic_dph: subjectChanged ? "" : form.ic_dph,
    vat_identifier: subjectChanged ? "" : form.vat_identifier,
  };
}

/** Existujúci partner s rovnakým IČO (porovnanie v kanonickom tvare). */
export function findPartnerWithIco<P extends { ico: string | null }>(partners: P[], ico: string, exceptId?: string | null): P | null {
  const target = canonicalIco(ico);
  if (!target) return null;
  return (
    partners.find(
      (partner) => (exceptId == null || (partner as { id?: string }).id !== exceptId) && canonicalIco(partner.ico ?? "") === target
    ) ?? null
  );
}
