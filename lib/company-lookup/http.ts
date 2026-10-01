import "server-only";

import type { ProviderError } from "./types.ts";

// =============================================================================
// Esblu — Company lookup: bezpečné HTTP volanie registrov.
// =============================================================================
//   - SSRF: iba pevne dané hosty (allowlist nižšie), iba https, bez
//     presmerovaní (redirect: "error"). URL skladá výhradne provider z
//     konštanty + URLSearchParams; používateľský vstup je iba hodnota
//     parametra alebo overené číslo v ceste.
//   - Timeout (AbortSignal) a strop veľkosti odpovede (počíta sa pri čítaní
//     streamu, nie podľa Content-Length, ktorému sa nedá veriť).
//   - Odpoveď musí byť JSON objekt; čokoľvek iné = BAD_RESPONSE (fail closed).
//   - Nič sa neloguje (volajúci loguje iba technický výsledok, nie URL).
// =============================================================================

export const ALLOWED_REGISTRY_HOSTS = new Set(["api.statistics.sk", "www.registeruz.sk"]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RegistryFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: FetchLike;
};

export type RegistryFetchResult =
  | { ok: true; status: number; json: Record<string, unknown> }
  | { ok: false; status: number | null; error: ProviderError };

export async function fetchRegistryJson(url: URL, options: RegistryFetchOptions): Promise<RegistryFetchResult> {
  if (url.protocol !== "https:" || !ALLOWED_REGISTRY_HOSTS.has(url.hostname) || url.port !== "" || url.username || url.password) {
    // Programátorská chyba, nie stav providera — nikdy nevolať.
    return { ok: false, status: null, error: { code: "BAD_RESPONSE", retryable: false } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const fetchImpl = options.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));

  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });

    if (response.status === 404) {
      return { ok: false, status: 404, error: { code: "UPSTREAM_HTTP", retryable: false } };
    }
    if (response.status === 429) {
      return { ok: false, status: 429, error: { code: "RATE_LIMITED", retryable: true } };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: { code: "UPSTREAM_HTTP", retryable: response.status >= 500 } };
    }

    const text = await readBodyCapped(response, options.maxBytes);
    if (text === null) return { ok: false, status: response.status, error: { code: "TOO_LARGE", retryable: false } };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: response.status, error: { code: "BAD_RESPONSE", retryable: false } };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: response.status, error: { code: "BAD_RESPONSE", retryable: false } };
    }
    return { ok: true, status: response.status, json: parsed as Record<string, unknown> };
  } catch {
    if (controller.signal.aborted) return { ok: false, status: null, error: { code: "TIMEOUT", retryable: true } };
    return { ok: false, status: null, error: { code: "NETWORK", retryable: true } };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}
