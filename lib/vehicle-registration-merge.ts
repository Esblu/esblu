import { normalizeSpz } from "./normalize-spz.ts";

// =============================================================================
// Sken technického preukazu → EXISTUJÚCE vozidlo: iba potvrdené hodnoty.
//
// Produkčná chyba (audit 2026-09-26): každé pole sa posielalo ako
// `hodnota || null` do UPDATE, takže všetko, čo AI nerozpoznala, prepísalo
// dobrú existujúcu hodnotu na prázdnu (a user_id na toho, kto skenoval).
//
// Pravidlá:
//   - pole chýba / null / prázdne / šum („—", „N/A", „neuvedené") = NEZMENIŤ,
//   - čísla a dátumy iba v platnom tvare, inak = NEZMENIŤ,
//   - výslovné vymazanie hodnoty nie je súčasťou skenu (AI vynechanie nikdy
//     neznamená „vymaž"),
//   - user_id / company_id sa skenom nikdy nemenia.
// Autoritatívne zlúčenie robí server (RPC esblu_apply_vehicle_registration:
// coalesce(nová, pôvodná)); tento modul iba pripraví čisté vstupy a
// zrkadlí rovnakú sémantiku pre testy.
// =============================================================================

export type RegistrationScanInput = Record<string, unknown>;

export type SanitizedRegistrationFields = Partial<{
  spz: string;
  vin: string;
  znacka: string;
  model: string;
  palivo: string;
  vykon: string;
  farba: string;
  rok_vyroby: string;
  objem: string;
  hmotnost: string;
  pocet_miest: string;
  datum_prvej_evidencie: string;
}>;

const NOISE = new Set(["", "-", "—", "–", "?", "n/a", "na", "null", "none", "undefined", "neuvedene", "neuvedené", "nezname", "neznáme", "x", "xx"]);

function cleanText(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (NOISE.has(text.toLowerCase())) return undefined;
  return text.slice(0, maxLength);
}

/** „1 998 cm3", „1500 kg", „1,6" → kladné číslo ako reťazec; inak undefined. */
function cleanPositiveNumber(value: unknown, max: number): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  const match = text.replace(/\s/g, "").replace(",", ".").match(/^(\d+(?:\.\d{1,3})?)/);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0 || number > max) return undefined;
  return String(number);
}

function cleanInteger(value: unknown, min: number, max: number): string | undefined {
  const text = cleanText(value);
  if (!text || !/^\d+$/.test(text.replace(/\s/g, ""))) return undefined;
  const number = Number(text.replace(/\s/g, ""));
  return Number.isInteger(number) && number >= min && number <= max ? String(number) : undefined;
}

/** ISO „2019-03-14" alebo „14.03.2019" / „14. 3. 2019" → ISO; neplatný dátum → undefined. */
export function cleanDate(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const sk = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(text);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (sk) [day, month, year] = [Number(sk[1]), Number(sk[2]), Number(sk[3])];
  else return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  if (year < 1900 || year > 2100) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** VIN: bez medzier, veľké písmená, 11–17 znakov (bez I, O, Q). */
function cleanVin(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  const vin = text.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin) ? vin : undefined;
}

/**
 * Z výsledku skenu (polia AI v tvare appky) vyberie IBA spoľahlivo
 * rozpoznané hodnoty v tvare RPC. Chýbajúce/šum sa do výsledku nedostanú.
 */
export function sanitizeRegistrationScan(fields: RegistrationScanInput | null | undefined, currentYear = new Date().getFullYear()): SanitizedRegistrationFields {
  const f = fields ?? {};
  const out: SanitizedRegistrationFields = {};
  const put = <K extends keyof SanitizedRegistrationFields>(key: K, value: string | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  const spz = cleanText(f.spz);
  put("spz", spz ? normalizeSpz(spz) ?? undefined : undefined);
  put("vin", cleanVin(f.vin));
  put("znacka", cleanText(f.znacka));
  put("model", cleanText(f.model));
  put("palivo", cleanText(f.palivo));
  put("vykon", cleanText(f.vykon));
  put("farba", cleanText(f.farba));
  put("rok_vyroby", cleanInteger(f.rokVyroby, 1900, currentYear + 1));
  put("objem", cleanPositiveNumber(f.objemMotora, 100000));
  put("hmotnost", cleanPositiveNumber(f.prevadzkovaHmotnost, 100000));
  put("pocet_miest", cleanInteger(f.pocetMiest, 1, 999));
  put("datum_prvej_evidencie", cleanDate(f.datumPrvejEvidencie));
  return out;
}

/**
 * Zrkadlo SQL zlúčenia (coalesce(nová, pôvodná)) — pre testy a náhľad.
 * Nikdy nemení kľúče mimo skenovaných polí (user_id, company_id, stk, ek…).
 */
export function mergeRegistrationIntoVehicle<T extends Record<string, unknown>>(existing: T, sanitized: SanitizedRegistrationFields): T {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined || value === "") continue;
    merged[key] = ["rok_vyroby", "objem", "hmotnost", "pocet_miest"].includes(key) ? Number(value) : value;
  }
  return merged as T;
}
