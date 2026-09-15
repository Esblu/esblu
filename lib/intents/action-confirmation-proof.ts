import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// =============================================================================
// Esblu — Action Engine confirmation: server-only HMAC proof.
// =============================================================================
// KONTEXT (3. bezpečnostné review): predchádzajúca oprava presunula
// INSERT/UPDATE na `assistant_action_confirmations` do dvoch SECURITY
// DEFINER RPC funkcií (esblu_create_action_confirmation/
// esblu_claim_action_confirmation), aby priamy klientský
// `.from(...).insert()/.update()` nefungoval. Problém: `create` RPC musí
// zostať `GRANT EXECUTE TO authenticated` (Next.js server ju volá pod
// identitou prihláseného používateľa, cez user-scoped klienta — appka
// nikdy nepoužíva service_role), takže AJ authenticated používateľ z
// browser konzoly ju vie zavolať priamo — s vlastným intentom/args/count.
// DB samotná (bez ďalšej vrstvy) nevie odlíšiť "toto vzniklo zo skutočného
// serverového buildActionPreview() flow" od "toto si used priamo vytvoril
// cez devtools".
//
// RIEŠENIE: kryptografický proof, ktorý vie vypočítať/overiť VÝHRADNE
// Next.js server (má prístup k `ESBLU_ACTION_CONFIRMATION_SECRET`, ktorý
// nie je nikdy v client bundle, nikdy NEXT_PUBLIC_, nikdy v DB ako secret,
// nikdy loggovaný). DB stále ukladá `nonce`/`server_proof`, ale bez
// znalosti secretu z nich nevie overiť platnosť — to robí VÝHRADNE
// `executeAction()` (lib/intents/actions.ts) tesne pred samotným DB
// zápisom, cez `verifyActionConfirmation()` nižšie. Riadok vytvorený
// priamym RPC volaním bez platného proof teda v DB PRETRVÁVA (RPC ho
// nezamieta — nevie, čo je "platné"), ale execute krok ho odmietne
// vykonať (proof nesedí) — presne to vyžaduje bezpečnostné review, bod 12:
// "DB confirmation vytvorený mimo skutočného serverového preview flow
// NESMIE byť kryptograficky platný pre execution."
//
// KANONICKÁ SERIALIZÁCIA (dôležité pre správnosť, nielen bezpečnosť):
// `canonical_args` sa v DB ukladá ako `jsonb`, ktorý pri round-tripe NEMUSÍ
// zachovať pôvodné poradie kľúčov objektu (Postgres jsonb interne
// normalizuje/triedi kľúče inak než JS object insertion order) — keby sme
// na HMAC použili obyčajný `JSON.stringify()`, podpis vypočítaný pri
// vytvorení (pred INSERTom) by sa nemusel zhodovať s tým, čo appka prepočíta
// pri claim-e (po SELECTe späť z DB), a KAŽDÉ legitímne potvrdenie by
// zlyhalo. `canonicalStringify()` preto rekurzívne triedi kľúče objektov
// (polia zostávajú v pôvodnom poradí — tie jsonb netriedi) — výsledný
// reťazec je tak nezávislý od toho, v akom poradí DB kľúče vráti.
//
// Z rovnakého dôvodu sa `expiresAt` podpisuje ako CELOČÍSELNÝ unix epoch
// (sekundy), nie ako ISO reťazec — `timestamptz` stĺpec v DB by pri
// round-tripe mohol appke vrátiť inak formátovaný reťazec (iná presnosť/
// formát), zatiaľ čo `extract(epoch from ...)::bigint` po
// `to_timestamp(bigint)` dáva vždy presne to isté celé číslo naspäť.
// =============================================================================

const CONFIRMATION_PAYLOAD_VERSION = 1;

// 24 bajtov (192 bitov) — výrazne nad tým, čo je potrebné na zabránenie
// uhádnutiu/kolízii, konzistentné s "unique" DB constraintom (bod 7
// zadania — nonce musí byť dostatočne náhodný).
const NONCE_BYTES = 24;

// SHA-256 vždy 32 bajtov = 64 hex znakov — appka toto očakáva striktne aj
// v DB CHECK constraint (obe strany nezávisle, nie iba appka).
const PROOF_HEX_LENGTH = 64;

// Minimálna entropia secretu podľa zadania (bod 1) — hex-encoded teda
// aspoň 64 znakov (32 bajtov). Odporúčané generovanie (dokumentované aj v
// migrácii/reporte): `openssl rand -hex 32`.
const SECRET_HEX_PATTERN = /^[0-9a-fA-F]{64,}$/;
const PROOF_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export type ActionConfirmationPayload = {
  userId: string;
  companyId: string;
  intent: string;
  canonicalArgs: Record<string, unknown>;
  expectedCount: number | null;
  nonce: string;
  expiresAtEpochSeconds: number;
};

/**
 * Deterministická serializácia nezávislá od poradia kľúčov objektu (polia
 * si poradie zachovávajú — tie sa netriedia, iba objekty). Používa sa
 * VÝHRADNE na výpočet/overenie HMAC — nikde inde (nie je to všeobecný
 * "pekný JSON" formát, iba kanonický vstup pre podpis).
 */
function canonicalStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`).join(",")}}`;
}

function canonicalPayloadString(payload: ActionConfirmationPayload): string {
  return canonicalStringify({
    version: CONFIRMATION_PAYLOAD_VERSION,
    userId: payload.userId,
    companyId: payload.companyId,
    intent: payload.intent,
    canonicalArgs: payload.canonicalArgs,
    expectedCount: payload.expectedCount,
    nonce: payload.nonce,
    expiresAtEpochSeconds: payload.expiresAtEpochSeconds,
  });
}

/**
 * Číta VÝHRADNE server-only env premennú `ESBLU_ACTION_CONFIRMATION_SECRET`
 * — NIKDY `NEXT_PUBLIC_*`, NIKDY reuse anon/service_role/OPENAI_API_KEY
 * (bod 1 zadania). Vracia `null` (nikdy nehádže/nepoužíva fallback
 * hodnotu), ak chýba alebo nemá dostatočnú entropiu — volajúci MUSÍ tento
 * prípad ošetriť ako "write akcie momentálne nedostupné" (fail closed,
 * bod 11 zadania), nikdy nie ako "secret nepotrebný".
 */
function getConfirmationSecret(): Buffer | null {
  const raw = process.env.ESBLU_ACTION_CONFIRMATION_SECRET;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!SECRET_HEX_PATTERN.test(trimmed)) return null;
  return Buffer.from(trimmed, "hex");
}

/** Appka toto volá pri štarte write-flow, aby vedela včas a jasne zlyhať. */
export function isActionConfirmationSecretConfigured(): boolean {
  return getConfirmationSecret() !== null;
}

/** Kryptograficky náhodný nonce (hex) — UNIQUE v DB, súčasť podpisu. */
export function generateActionConfirmationNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/**
 * Vypočíta server_proof pre daný payload — volá sa VÝHRADNE pri vytváraní
 * preview (lib/intents/actions.ts#insertActionConfirmation), PRED
 * zavolaním esblu_create_action_confirmation RPC. Vracia `null`, ak secret
 * chýba/je neplatný (fail closed — volajúci nesmie v tom prípade
 * confirmation vôbec vytvoriť).
 */
export function signActionConfirmation(payload: ActionConfirmationPayload): string | null {
  const secret = getConfirmationSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(canonicalPayloadString(payload)).digest("hex");
}

/**
 * Overí server_proof proti nanovo prepočítanému očakávanému HMAC — volá sa
 * VÝHRADNE v lib/intents/actions.ts#executeAction, PO úspešnom atomickom
 * claim-e (teda potvrdenie je v tomto bode už spotrebované bez ohľadu na
 * výsledok tejto verifikácie — replay teda nehrozí ani keď proof nesedí).
 * Timing-safe porovnanie (`crypto.timingSafeEqual`) — appka nikdy
 * neporovnáva hex reťazce cez `===`.
 */
export function verifyActionConfirmation(
  payload: ActionConfirmationPayload,
  serverProof: string
): boolean {
  const secret = getConfirmationSecret();
  if (!secret) return false;
  if (typeof serverProof !== "string" || !PROOF_HEX_PATTERN.test(serverProof)) return false;

  const expected = createHmac("sha256", secret).update(canonicalPayloadString(payload)).digest();
  const actual = Buffer.from(serverProof, "hex");
  if (actual.length !== expected.length || expected.length !== PROOF_HEX_LENGTH / 2) return false;

  return timingSafeEqual(expected, actual);
}
