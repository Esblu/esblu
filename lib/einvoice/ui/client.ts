// =============================================================================
// E-Faktúra UI — volania API z klienta (web aj natívna appka).
//
// apiUrl() → web: relatívna cesta; appka: produkčný backend (CORS v proxy.ts).
// Identita = Bearer JWT aktuálnej session; firma, rola ani prostredie sa z
// klienta NIKDY neposielajú. Telá POST sú presne tie, ktoré server prijíma.
// =============================================================================

import { supabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { downloadBlob } from "@/lib/file-actions";
import type { Locale } from "@/lib/i18n/locales";

export type ApiResult<T> = { status: number; body: T | null; code: string | null };

async function authHeaders(locale: Locale): Promise<Record<string, string> | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  return { Authorization: `Bearer ${session.access_token}`, [REQUEST_LOCALE_HEADER]: locale };
}

async function call<T>(path: string, locale: Locale, init: { method: "GET" | "POST"; body?: unknown }): Promise<ApiResult<T>> {
  const headers = await authHeaders(locale);
  if (!headers) return { status: 401, body: null, code: "UNAUTHENTICATED" };
  try {
    const res = await fetch(apiUrl(path), {
      method: init.method,
      headers: init.body !== undefined ? { ...headers, "Content-Type": "application/json" } : headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : null;
    return { status: res.status, body: body as T, code };
  } catch {
    return { status: 0, body: null, code: "NETWORK" };
  }
}

export function getEinvoiceJson<T>(path: string, locale: Locale): Promise<ApiResult<T>> {
  return call<T>(path, locale, { method: "GET" });
}

/** POST /api/einvoice/outbound — telo presne { invoice_id, confirm_send: true }. */
export function requestEinvoiceSend(invoiceId: string, locale: Locale) {
  return call<{ code: string }>("/api/einvoice/outbound", locale, { method: "POST", body: { invoice_id: invoiceId, confirm_send: true } });
}

export type OperatorRoute = "outbound/reconcile" | "outbound/retry" | "inbound/reprocess" | "inbound/ack-retry";

/** Operátorská akcia — telo presne { confirm_action: true }. */
export function runEinvoiceAction(route: OperatorRoute, id: string, locale: Locale) {
  const [kind, action] = route.split("/");
  return call<{ code: string }>(`/api/einvoice/${kind}/${encodeURIComponent(id)}/${action}`, locale, { method: "POST", body: { confirm_action: true } });
}

/** Stiahnutie presne uložených bajtov (UBL / XML). Vráti true pri úspechu. */
export async function downloadEinvoiceDocument(path: string, fileName: string, locale: Locale): Promise<boolean> {
  const headers = await authHeaders(locale);
  if (!headers) return false;
  try {
    const res = await fetch(apiUrl(path), { method: "GET", headers, cache: "no-store" });
    if (!res.ok) return false;
    await downloadBlob(await res.blob(), fileName);
    return true;
  } catch {
    return false;
  }
}
