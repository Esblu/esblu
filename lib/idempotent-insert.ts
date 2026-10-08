// =============================================================================
// Idempotentné vytváranie záznamov (Mobile Platform 2026-10-08).
//
// Jeden logický pokus o vytvorenie = jeden `client_mutation_id` (UUID).
//   - Retry toho istého obsahu (stratená odpoveď, opakované ťuknutie po
//     výpadku siete) pošle ROVNAKÝ kľúč → DB unique index
//     (company_id, client_mutation_id) druhý záznam nedovolí → klient si
//     existujúci prečíta cez RLS a vráti ho ako úspech (replayed=true).
//   - Iný obsah = nový kľúč (fingerprint payloadu) → nikdy falošne
//     nezablokovaný odlišný záznam.
//   - Po úspechu sa kľúč zahodí (ďalšie vytvorenie = nový kľúč).
// Server/RLS ostáva autorita: kľúč nič neautorizuje, iba deduplikuje v rámci firmy.
// Rollout: ak DB stĺpec ešte nemá (PGRST204), insert sa zopakuje bez kľúča —
// správanie ako pred zmenou, nikdy chyba kvôli nasadeniu v zlom poradí.
// =============================================================================

export type MutationKeyRef = { current: { fingerprint: string; key: string } | null };

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function payloadFingerprint(payload: unknown): string {
  return stableStringify(payload);
}

function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Kľúč pre aktuálny obsah: rovnaký obsah → rovnaký kľúč (retry), iný → nový. */
export function mutationKeyFor(ref: MutationKeyRef, payload: unknown): string {
  const fingerprint = payloadFingerprint(payload);
  if (ref.current && ref.current.fingerprint === fingerprint) return ref.current.key;
  ref.current = { fingerprint, key: randomUuid() };
  return ref.current.key;
}

/** Po potvrdenom úspechu — ďalšie vytvorenie dostane nový kľúč. */
export function resetMutationKey(ref: MutationKeyRef): void {
  ref.current = null;
}

type PgError = { code?: string; message?: string } | null;
type QueryResult<T> = PromiseLike<{ data: T | null; error: PgError }>;

/** Minimálne rozhranie Supabase klienta (testovateľné bez siete). */
export type InsertDb = {
  from(table: string): {
    insert(row: Record<string, unknown>): { select(columns: string): { single(): QueryResult<unknown> } };
    select(columns: string): { eq(column: string, value: string): { maybeSingle(): QueryResult<unknown> } };
  };
};

export function isMutationReplayConflict(error: PgError, table: string): boolean {
  return error?.code === "23505" && (error.message ?? "").includes(`${table}_client_mutation_uidx`);
}

function isMissingMutationColumn(error: PgError): boolean {
  return (error?.code === "PGRST204" || error?.code === "42703") && (error.message ?? "").includes("client_mutation_id");
}

export type IdempotentInsertResult<T> = { data: T; replayed: boolean };

export async function insertIdempotent<T>(
  db: InsertDb,
  table: string,
  row: Record<string, unknown>,
  mutationId: string | null | undefined,
  columns = "*",
): Promise<IdempotentInsertResult<T>> {
  if (!mutationId) {
    const { data, error } = await db.from(table).insert(row).select(columns).single();
    if (error || !data) throw error ?? new Error("INSERT_FAILED");
    return { data: data as T, replayed: false };
  }
  const first = await db.from(table).insert({ ...row, client_mutation_id: mutationId }).select(columns).single();
  if (!first.error && first.data) return { data: first.data as T, replayed: false };
  if (first.error?.code === "23505") {
    // Ten istý logický pokus už prešiel (stratená odpoveď / súbeh) → vráť ho.
    // Pozor: Postgres môže nahlásiť INÝ unikátny index skôr (napr. názov
    // priečinka) — preto sa pri KAŽDOM 23505 overí, či záznam s týmto kľúčom
    // existuje. Ak nie, je to skutočná duplicita → pôvodná chyba.
    const existing = await db.from(table).select(columns).eq("client_mutation_id", mutationId).maybeSingle();
    if (!existing.error && existing.data) return { data: existing.data as T, replayed: true };
    if (isMutationReplayConflict(first.error, table)) throw existing.error ?? first.error;
    throw first.error;
  }
  if (isMissingMutationColumn(first.error)) {
    const { data, error } = await db.from(table).insert(row).select(columns).single();
    if (error || !data) throw error ?? new Error("INSERT_FAILED");
    return { data: data as T, replayed: false };
  }
  throw first.error ?? new Error("INSERT_FAILED");
}
