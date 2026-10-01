import "server-only";

// =============================================================================
// Esblu — Company lookup: in-memory cache, rate limit a circuit breaker.
// =============================================================================
// PHASE 1 rozhodnutie (audit 2026-10-01): bez novej DB tabuľky.
//
//   - Cache drží IBA verejné registrové polia (CompanyDetail / návrhy) a
//     žije v pamäti serverovej inštancie. Kľúč detailu je IČO; kľúč
//     vyhľadávania je SHA-256 normalizovaného dopytu — samotný text dopytu
//     sa nikde neukladá. TTL detailu 7 dní, vyhľadávania 10 minút.
//   - Rate limit je server-side, per používateľ aj per firma (firma z DB,
//     nikdy z požiadavky). Je per-inštancia: pri viacerých inštanciách je
//     reálny strop násobkom. Je to abuse guard, nie billing — trvalý
//     DB-backed limit je PHASE 2 (existujúci esblu_consume_ai_scan_quota sa
//     NEDÁ znovu použiť: počíta jeden spoločný bucket pre všetky AI scany).
//   - Circuit breaker chráni register aj používateľa pred čakaním na
//     opakované timeouty.
// =============================================================================

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(ttlMs: number, maxEntries: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU: posledné použitie na koniec.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = 10_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** true = povolené (a započítané), false = prekročený limit. */
  consume(key: string): boolean {
    const now = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.delete(key);
    this.hits.set(key, fresh);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.hits.clear();
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(threshold: number, cooldownMs: number, now: () => number = Date.now) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  isOpen(): boolean {
    return this.openUntil > this.now();
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.failures = 0;
    }
  }

  reset(): void {
    this.failures = 0;
    this.openUntil = 0;
  }
}

export async function sha256Key(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
