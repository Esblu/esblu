import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getEfakturaWebhookSecrets, getEinvoiceProvider } from "@/lib/einvoice/provider";
import { EfakturaSkProvider } from "@/lib/einvoice/provider/efaktura-sk";
import { enrollCompany, provisionCompany, receptionView } from "@/lib/einvoice/onboarding";
import { createSupabaseOnboardingStore } from "@/lib/einvoice/onboarding-supabase-store";
import { processPartnerEventPage, type WebhookDeps } from "@/lib/einvoice/inbound/webhook";
import { createSupabaseInboundStore } from "@/lib/einvoice/inbound/supabase-store";
import { createSupabaseOutboundStore } from "@/lib/einvoice/outbound/supabase-store";
import {
  STAGING_E2E_COMPANIES,
  STAGING_E2E_TOKENS,
  STAGING_E2E_USERS,
  parseTarget,
  stagingE2eGuard,
  targetForCompany,
  type StagingE2eTarget,
} from "@/lib/einvoice/staging-e2e/guard";

// =============================================================================
// POST /api/einvoice/staging-e2e — STAGING-ONLY driver reálneho sandbox E2E.
//
// Mimo Vercel Preview vetvy einvoice-port so staging DB a sandbox kľúčom = 404
// (lib/einvoice/staging-e2e/guard.ts). Autorizácia: Bearer ESBLU_STAGING_E2E_SECRET.
// Pracuje IBA s uzavretým zoznamom syntetických firiem A–D a sandbox kódmi FS
// z dokumentácie. Volá TIE ISTÉ moduly ako produkcia (onboarding, webhook/feed
// spracovanie, skutočná route /api/einvoice/outbound cez HTTP s user JWT).
// Odpovede: iba stavy, kódy, počty a prefixy hashov — žiadne tajomstvá, tokeny,
// XML ani osobné údaje.
// =============================================================================

export const runtime = "nodejs";

/** RPC fakturácie, ktoré smie driver volať ako syntetický owner (nič iné). */
const USER_RPC_ALLOWLIST = new Set([
  "esblu_save_invoice_draft", "esblu_set_invoice_compliance_fields", "esblu_finalize_invoice",
  "esblu_add_invoice_payment", "esblu_add_invoice_refund", "esblu_invoice_settlement",
  "esblu_set_invoice_advance_deductions", "esblu_available_advances",
  "esblu_received_correction_link", "esblu_received_correction_reject",
  "esblu_received_advance_confirm", "esblu_received_advance_link", "esblu_received_advance_unlink",
  "esblu_received_advance_reject", "esblu_received_advance_candidates",
]);
export const maxDuration = 60;

type Json = Record<string, unknown>;

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
}
function json(status: number, body: Json): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function authorized(req: Request): boolean {
  const secret = (process.env.ESBLU_STAGING_E2E_SECRET ?? "").trim();
  const given = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(secret);
  return secret.length >= 32 && given.length === expected.length && timingSafeEqual(given, expected);
}
const short = (v: string | null | undefined, n = 8) => (v ? v.slice(0, n) : null);

function runtimeOrThrow() {
  const rt = getEinvoiceProvider();
  if (!rt || !(rt.provider instanceof EfakturaSkProvider) || rt.environment !== "sandbox") throw new Error("NOT_CONFIGURED");
  return { provider: rt.provider, environment: rt.environment };
}

/** org ID poskytovateľa → cieľ A–D (iba syntetické firmy); iné org = null. */
async function orgTargets(admin: SupabaseClient): Promise<Map<string, StagingE2eTarget>> {
  const { data, error } = await admin
    .from("einvoice_organizations")
    .select("company_id, provider_org_id")
    .in("company_id", Object.values(STAGING_E2E_COMPANIES))
    .eq("environment", "sandbox");
  if (error) throw new Error("DB_ERROR");
  const map = new Map<string, StagingE2eTarget>();
  for (const r of (data ?? []) as { company_id: string; provider_org_id: string | null }[]) {
    const t = targetForCompany(r.company_id);
    if (t && r.provider_org_id) map.set(r.provider_org_id, t);
  }
  return map;
}

/** Krátkodobá session syntetického ownera (magic link → verifyOtp). Nikdy sa nevracia. */
async function userSession(admin: SupabaseClient, target: "A" | "B"): Promise<{ token: string; client: SupabaseClient; userId: string }> {
  const email = STAGING_E2E_USERS[target];
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) throw new Error("SESSION_LINK_FAILED");
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: verified, error: vErr } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: hashed });
  const token = verified?.session?.access_token;
  if (vErr || !token || !verified.user) throw new Error("SESSION_VERIFY_FAILED");
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { token, client, userId: verified.user.id };
}

async function endSession(admin: SupabaseClient, token: string): Promise<void> {
  try {
    await admin.auth.admin.signOut(token, "local");
  } catch {
    // best effort — token aj tak vyprší
  }
}

function sanitizeEvent(e: { id: string; event: string; eventId: string | null; orgId: string | null; createdAt: string | null; payload: Json }, targets: Map<string, StagingE2eTarget>) {
  const data = (e.payload.data && typeof e.payload.data === "object" ? (e.payload.data as Json) : {}) as Json;
  const pick = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : null);
  return {
    id: e.id,
    event: e.event,
    event_id_sha: e.eventId ? createHash("sha256").update(e.eventId).digest("hex").slice(0, 12) : null,
    target: e.orgId ? targets.get(e.orgId) ?? "other" : null,
    created_at: e.createdAt,
    data: {
      invoiceId: short(pick("invoiceId")),
      state: pick("state"),
      mode: pick("mode"),
      code: pick("code"),
      source: pick("source"),
      documentType: pick("documentType"),
      participantScheme: pick("participantId")?.slice(0, 4) ?? null,
    },
  };
}

export async function POST(req: Request) {
  const guard = stagingE2eGuard(process.env);
  if (!guard.ok) return notFound();
  if (!authorized(req)) return notFound();

  let body: Json;
  try {
    body = (await req.json()) as Json;
  } catch {
    return json(400, { code: "INVALID_BODY" });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const admin = getSupabaseAdmin();

  try {
    switch (action) {
      case "status": {
        return json(200, {
          code: "OK",
          guard: "ok",
          webhook_secrets: getEfakturaWebhookSecrets().length,
          bypass_configured: !!process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        });
      }

      case "ensure-users": {
        const out: Json = {};
        for (const t of ["A", "B"] as const) {
          const email = STAGING_E2E_USERS[t];
          const { data: list, error: lErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
          if (lErr) return json(500, { code: "LIST_USERS_FAILED" });
          const existing = list.users.find((u) => u.email === email);
          if (existing) {
            out[t] = { id: existing.id, created: false };
            continue;
          }
          const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { esblu_e2e: true } });
          if (error || !data.user) return json(500, { code: "CREATE_USER_FAILED", target: t, status: error?.status ?? null });
          out[t] = { id: data.user.id, created: true };
        }
        return json(200, { code: "OK", users: out });
      }

      case "provision": {
        const t = parseTarget(body.target);
        if (!t) return json(400, { code: "INVALID_TARGET" });
        const rt = runtimeOrThrow();
        const res = await provisionCompany({ store: createSupabaseOnboardingStore(admin), ...rt }, STAGING_E2E_COMPANIES[t]);
        return json(200, res.ok ? { code: "OK", target: t, reused: res.reused, created: res.created, reception: res.receptionStatus, org: short(res.providerOrgId) } : { code: res.code, target: t });
      }

      case "enroll": {
        const t = parseTarget(body.target);
        const tokenKey = typeof body.token === "string" ? body.token : "";
        if (!t) return json(400, { code: "INVALID_TARGET" });
        if (!(tokenKey in STAGING_E2E_TOKENS)) return json(400, { code: "INVALID_TOKEN_KEY" });
        const rt = runtimeOrThrow();
        const res = await enrollCompany({ store: createSupabaseOnboardingStore(admin), ...rt }, STAGING_E2E_COMPANIES[t], STAGING_E2E_TOKENS[tokenKey as keyof typeof STAGING_E2E_TOKENS]);
        return json(200, res.ok ? { code: "OK", target: t, status: res.status, reception: res.reception, warnings: res.warnings } : { code: res.code, target: t, retryable: res.retryable, reception: res.reception });
      }

      case "reception": {
        const out: Json = {};
        const store = createSupabaseOnboardingStore(admin);
        for (const t of ["A", "B", "C", "D"] as const) out[t] = receptionView(await store.organization(STAGING_E2E_COMPANIES[t], "sandbox"));
        return json(200, { code: "OK", reception: out });
      }

      case "feed": {
        const rt = runtimeOrThrow();
        const after = typeof body.after === "string" && /^[0-9]{1,15}$/.test(body.after) ? body.after : undefined;
        const page = await rt.provider.listPartnerEvents({ after, limit: 200 });
        const targets = await orgTargets(admin);
        return json(200, {
          code: "OK",
          next_after: page.nextAfter,
          has_more: page.hasMore,
          events: page.events.map((e) => sanitizeEvent(e, targets)),
        });
      }

      case "feed-process": {
        const rt = runtimeOrThrow();
        const after = typeof body.after === "string" && /^[0-9]{1,15}$/.test(body.after) ? body.after : undefined;
        const ids = Array.isArray(body.ids) ? new Set(body.ids.filter((x): x is string => typeof x === "string")) : null;
        if (!ids || ids.size === 0 || ids.size > 50) return json(400, { code: "INVALID_IDS" });
        const page = await rt.provider.listPartnerEvents({ after, limit: 200 });
        const targets = await orgTargets(admin);
        // Iba udalosti syntetických firiem A–D (iné organizácie partnera sa nespracujú).
        const selected = page.events.filter((e) => ids.has(e.id) && e.orgId && targets.has(e.orgId));
        const deps: WebhookDeps = {
          inbound: createSupabaseInboundStore(admin),
          outbound: createSupabaseOutboundStore(admin),
          provider: rt.provider,
          environment: rt.environment,
          secrets: getEfakturaWebhookSecrets(),
          nowSeconds: () => Math.floor(Date.now() / 1000),
        };
        const res = await processPartnerEventPage(deps, { events: selected });
        return json(200, { code: "OK", processed: res.processed, results: res.results, skipped: ids.size - selected.length });
      }

      case "outbound": {
        // Skutočná route /api/einvoice/outbound cez HTTP s JWT syntetického ownera A.
        const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id : "";
        if (!/^[0-9a-f-]{36}$/.test(invoiceId)) return json(400, { code: "INVALID_INVOICE" });
        const { data: inv, error } = await admin.from("invoices").select("company_id").eq("id", invoiceId).maybeSingle<{ company_id: string }>();
        if (error || !inv || targetForCompany(inv.company_id) !== "A") return json(400, { code: "INVOICE_NOT_IN_E2E_COMPANY_A" });
        const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
        const session = await userSession(admin, "A");
        try {
          const origin = new URL(req.url).origin;
          const res = await fetch(`${origin}/api/einvoice/outbound`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${session.token}`,
              "content-type": "application/json",
              ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
            },
            body: JSON.stringify({ invoice_id: invoiceId, confirm_send: true }),
          });
          const text = await res.text();
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { non_json: true, length: text.length };
          }
          return json(200, { code: "OK", route_status: res.status, route_body: parsed });
        } finally {
          await endSession(admin, session.token);
        }
      }

      case "reception-route": {
        // Skutočné routy /api/einvoice/reception(/enroll) cez HTTP s JWT syntetického ownera A/B.
        const t = body.target === "A" || body.target === "B" ? body.target : null;
        if (!t) return json(400, { code: "INVALID_TARGET" });
        const op = body.op === "enroll" ? "enroll" : "get";
        const tokenKey = typeof body.token === "string" ? body.token : "";
        if (op === "enroll" && !(tokenKey in STAGING_E2E_TOKENS)) return json(400, { code: "INVALID_TOKEN_KEY" });
        const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
        const session = await userSession(admin, t);
        try {
          const origin = new URL(req.url).origin;
          const res = await fetch(`${origin}/api/einvoice/reception${op === "enroll" ? "/enroll" : ""}`, {
            method: op === "enroll" ? "POST" : "GET",
            headers: {
              authorization: `Bearer ${session.token}`,
              ...(op === "enroll" ? { "content-type": "application/json" } : {}),
              ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
            },
            body: op === "enroll" ? JSON.stringify({ verification_code: STAGING_E2E_TOKENS[tokenKey as keyof typeof STAGING_E2E_TOKENS], confirm_enroll: true }) : undefined,
          });
          let parsed: unknown = null;
          try {
            parsed = await res.json();
          } catch {
            parsed = { non_json: true };
          }
          return json(200, { code: "OK", target: t, op, route_status: res.status, route_body: parsed });
        } finally {
          await endSession(admin, session.token);
        }
      }

      case "isolation": {
        // RLS matica cez skutočné user JWT: A a B vidia iba svoje E-Faktúra dáta;
        // privilegované RPC onboardingu sú pre authenticated zakázané.
        const out: Json = {};
        for (const t of ["A", "B"] as const) {
          const s = await userSession(admin, t);
          try {
            const own = STAGING_E2E_COMPANIES[t];
            const other = STAGING_E2E_COMPANIES[t === "A" ? "B" : "A"];
            const count = async (table: string, company: string) => {
              const { count: n, error } = await s.client.from(table).select("id", { count: "exact", head: true }).eq("company_id", company);
              return error ? `ERR:${error.code ?? "?"}` : n ?? 0;
            };
            const rpc = await s.client.rpc("esblu_einvoice_org_apply_enroll", {
              p_provider: "efaktura_sk", p_environment: "sandbox", p_provider_org_id: "x", p_outcome: "enrolled", p_participant_id: null, p_held_by: null, p_error_code: null,
            });
            out[t] = {
              own: { organizations: await count("einvoice_organizations", own), outbound: await count("einvoice_outbound", own), inbound: await count("einvoice_inbound", own), invoices: await count("invoices", own) },
              other: { organizations: await count("einvoice_organizations", other), outbound: await count("einvoice_outbound", other), inbound: await count("einvoice_inbound", other), invoices: await count("invoices", other) },
              privileged_rpc: rpc.error ? `DENIED:${rpc.error.code ?? "?"}` : "ALLOWED",
            };
          } finally {
            await endSession(admin, s.token);
          }
        }
        return json(200, { code: "OK", isolation: out });
      }

      case "user-rpc": {
        // 20261008100005: RPC fakturácie cez skutočné user JWT syntetického ownera A/B (PostgREST + RLS).
        const t = body.target === "A" || body.target === "B" ? body.target : null;
        const fn = typeof body.fn === "string" ? body.fn : "";
        if (!t) return json(400, { code: "INVALID_TARGET" });
        if (!USER_RPC_ALLOWLIST.has(fn)) return json(400, { code: "RPC_NOT_ALLOWED" });
        const args = body.args && typeof body.args === "object" ? (body.args as Json) : {};
        const s = await userSession(admin, t);
        try {
          const { data, error } = await s.client.rpc(fn, args);
          return json(200, { code: "OK", target: t, fn, data: data ?? null, error: error ? (error.message.match(/ESBLU_[A-Z0-9_]+/)?.[0] ?? `PG:${error.code ?? "?"}`) : null });
        } finally {
          await endSession(admin, s.token);
        }
      }

      case "user-insert-invoice": {
        // Koncept vydaného dokladu ako owner A/B (insert pod RLS, potom esblu_save_invoice_draft cez user-rpc).
        const t = body.target === "A" || body.target === "B" ? body.target : null;
        const kind = typeof body.kind === "string" ? body.kind : "";
        if (!t || !["regular_invoice", "payment_received_invoice", "credit_note", "debit_note", "proforma"].includes(kind)) return json(400, { code: "INVALID_INPUT" });
        const corrects = typeof body.corrects_invoice_id === "string" && /^[0-9a-f-]{36}$/.test(body.corrects_invoice_id) ? body.corrects_invoice_id : null;
        const partner = typeof body.customer_business_partner_id === "string" && /^[0-9a-f-]{36}$/.test(body.customer_business_partner_id) ? body.customer_business_partner_id : null;
        const issueDate = typeof body.issue_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.issue_date) ? body.issue_date : null;
        if (!partner || !issueDate) return json(400, { code: "INVALID_INPUT" });
        const s = await userSession(admin, t);
        try {
          const { data, error } = await s.client.from("invoices").insert({
            company_id: STAGING_E2E_COMPANIES[t], direction: "issued", kind, issue_date: issueDate, currency: "EUR",
            customer_business_partner_id: partner, source: "manual", corrects_invoice_id: corrects,
          }).select("id").single<{ id: string }>();
          return json(200, { code: "OK", target: t, invoice_id: data?.id ?? null, error: error ? (error.message.match(/ESBLU_[A-Z0-9_]+/)?.[0] ?? `PG:${error.code ?? "?"}`) : null });
        } finally {
          await endSession(admin, s.token);
        }
      }

      case "user-select": {
        // Čítanie vlastných dokladov cez user JWT (iba povolené stĺpce; RLS rozhoduje o firme).
        const t = body.target === "A" || body.target === "B" ? body.target : null;
        const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x)).slice(0, 50) : [];
        const company = body.company === "A" || body.company === "B" ? STAGING_E2E_COMPANIES[body.company] : null;
        if (!t) return json(400, { code: "INVALID_TARGET" });
        const s = await userSession(admin, t);
        try {
          let q = s.client.from("invoices").select("id, company_id, direction, kind, document_status, payment_status, invoice_number, supplier_invoice_number, total_amount, corrects_invoice_id, correction_review_status, correction_review_reasons, corrected_document_reference, source, subtotal_amount, vat_total_amount, tax_point_date, prepaid_amount, advance_review_status, advance_review_reasons");
          if (ids.length > 0) q = q.in("id", ids);
          if (company) q = q.eq("company_id", company);
          const { data, error } = await q.order("created_at", { ascending: true }).limit(100);
          // 20261008100008: väzby prijatých záloh pod RLS volajúceho (finance.view).
          const rowIds = (data ?? []).map((r) => (r as { id: string }).id);
          const links = rowIds.length > 0
            ? await s.client.from("received_advance_links").select("invoice_id, advance_invoice_id, amount, taxable_amount, vat_amount, source").or(`invoice_id.in.(${rowIds.join(",")}),advance_invoice_id.in.(${rowIds.join(",")})`)
            : { data: [], error: null };
          return json(200, { code: "OK", target: t, rows: data ?? [], links: links.data ?? [], error: error ? `PG:${error.code ?? "?"}` : null });
        } finally {
          await endSession(admin, s.token);
        }
      }

      case "provider-probe": {
        // 8. 10. 2026: overenie kontraktu poskytovateľa v sandboxe (IBA firma A, IBA test kľúč):
        //   op=submission — GET /submissions/{document_id} pre už odoslané podanie (read-only);
        //   op=race       — dve SÚBEŽNÉ connector/send s TÝM ISTÝM Idempotency-Key a bajtmi pre ešte neodoslaný
        //                   (queued) riadok → očakáva sa 1× výsledok + replay alebo 409 „práve sa spracúva“; poskytovateľ
        //                   garantuje jedno odoslanie (rovnaký kľúč + telo). Stav riadku sa NEMENÍ — dokončí ho worker
        //                   tým istým kľúčom (replay uloženej odpovede).
        // Vracia iba HTTP stavy, kódy chýb, kľúče JSON odpovede (bez hodnôt) a porovnanie ID — nikdy XML ani telá.
        const outboundId = typeof body.outbound_id === "string" && /^[0-9a-f-]{36}$/.test(body.outbound_id) ? body.outbound_id : "";
        const op = body.op === "race" ? "race" : body.op === "submission" ? "submission" : null;
        if (!outboundId || !op) return json(400, { code: "INVALID_INPUT" });
        runtimeOrThrow();
        const { data: row, error } = await admin.from("einvoice_outbound")
          .select("id, company_id, environment, state, idempotency_key, ubl_sha256, ubl_storage_path, receiver_participant_id, provider_submission_id, document_id")
          .eq("id", outboundId).maybeSingle<{ id: string; company_id: string; environment: string; state: string; idempotency_key: string; ubl_sha256: string | null;
            ubl_storage_path: string | null; receiver_participant_id: string | null; provider_submission_id: string | null; document_id: string | null }>();
        if (error || !row || targetForCompany(row.company_id) !== "A" || row.environment !== "sandbox") return json(400, { code: "OUTBOUND_NOT_IN_E2E_COMPANY_A" });
        const { data: org } = await admin.from("einvoice_organizations").select("provider_org_id").eq("company_id", row.company_id).eq("environment", "sandbox").maybeSingle<{ provider_org_id: string | null }>();
        if (!org?.provider_org_id) return json(400, { code: "ORG_NOT_READY" });
        const apiKey = process.env.ESBLU_EFAKTURA_API_KEY ?? "";
        if (!apiKey.startsWith("efk_pk_test_")) return json(400, { code: "NOT_SANDBOX_KEY" });
        const seen: { path: string; status: number; keys: string[]; dataKeys: string[]; errorCode: string | null; messageHint: string | null }[] = [];
        const recording = new EfakturaSkProvider({
          apiKey, environment: "sandbox", baseUrl: process.env.ESBLU_EFAKTURA_BASE_URL,
          fetchImpl: async (input, init) => {
            const res = await fetch(input, init);
            const text = await res.clone().text();
            let parsed: Json | null = null;
            try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
            const data = parsed && typeof parsed.data === "object" && parsed.data ? (parsed.data as Json) : null;
            const err = parsed && typeof parsed.error === "object" && parsed.error ? (parsed.error as Json) : null;
            const msg = typeof err?.message === "string" ? (err.message as string) : typeof parsed?.message === "string" ? (parsed.message as string) : "";
            seen.push({
              path: new URL(input).pathname.replace(/[^/]+$/, (last) => (/^[0-9a-f-]{36}$|[@#:]/.test(decodeURIComponent(last)) ? "{id}" : last)),
              status: res.status,
              keys: parsed ? Object.keys(parsed).sort() : [],
              dataKeys: data ? Object.keys(data).sort() : [],
              errorCode: typeof err?.code === "string" ? (err.code as string).slice(0, 60) : typeof parsed?.error === "string" ? (parsed.error as string).slice(0, 60) : null,
              // iba rozpoznanie textu „práve sa spracúva“ / „different body“ — nie celý text
              messageHint: /pr[aá]ve\s+sprac|in\s+progress|being\s+processed/i.test(msg) ? "IN_PROGRESS_TEXT" : /different/i.test(msg) ? "DIFFERENT_BODY_TEXT" : msg ? "OTHER_TEXT" : null,
            });
            return res;
          },
        });
        const ctx = { environment: "sandbox" as const, providerOrgId: org.provider_org_id };
        if (op === "submission") {
          if (!row.document_id) return json(200, { code: "NO_DOCUMENT_ID", state: row.state });
          let mapped: { invoiceId: string | null; state: string | null } | null = null;
          let errCode: string | null = null;
          try { mapped = await recording.getSubmissionByDocumentId(ctx, row.document_id); } catch (e) { errCode = e instanceof Error && "code" in e ? String((e as { code: string }).code) : "ERROR"; }
          return json(200, { code: "OK", op, http: seen, mapped_state: mapped?.state ?? null, invoice_id_matches: mapped?.invoiceId ? mapped.invoiceId === row.provider_submission_id : null, error: errCode });
        }
        // race
        if (row.state !== "queued" || row.provider_submission_id) return json(400, { code: "RACE_REQUIRES_FRESH_QUEUED_ROW", state: row.state });
        if (!row.ubl_storage_path || !row.ubl_sha256 || !row.receiver_participant_id) return json(400, { code: "ROW_INCOMPLETE" });
        const bytes = await createSupabaseOutboundStore(admin).getUbl(row.ubl_storage_path);
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== row.ubl_sha256) return json(400, { code: "UBL_HASH_MISMATCH" });
        const input = { ubl: bytes, ublSha256: row.ubl_sha256, idempotencyKey: row.idempotency_key, receiverParticipantId: row.receiver_participant_id };
        const settled = await Promise.allSettled([recording.sendUbl(ctx, input), recording.sendUbl(ctx, input)]);
        const outcome = settled.map((r) => (r.status === "fulfilled"
          ? { result: r.value.state, has_invoice_id: !!r.value.providerSubmissionId, has_document_id: !!r.value.providerDocumentId, invoice_id_sha: r.value.providerSubmissionId ? createHash("sha256").update(r.value.providerSubmissionId).digest("hex").slice(0, 12) : null }
          : { error: r.reason instanceof Error && "code" in r.reason ? String((r.reason as { code: string }).code) : "ERROR", retryable: r.reason instanceof Error && "retryable" in r.reason ? Boolean((r.reason as { retryable: boolean }).retryable) : null }));
        return json(200, { code: "OK", op, http: seen, outcome });
      }

      case "handoff-export": {
        // Skutočná route /api/accounting-handoff/package (hromadný export za obdobie) s JWT ownera A/B.
        // Vracia iba hlavičky, počty a zoznam ciest v ZIP-e — nie obsah dokladov.
        const t = body.target === "A" || body.target === "B" ? body.target : null;
        const period = body.period && typeof body.period === "object" ? body.period : null;
        if (!t || !period) return json(400, { code: "INVALID_INPUT" });
        const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
        const session = await userSession(admin, t);
        try {
          const origin = new URL(req.url).origin;
          const res = await fetch(`${origin}/api/accounting-handoff/package`, {
            method: "POST",
            headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) },
            body: JSON.stringify({ period }),
          });
          if (!res.ok) {
            let parsed: unknown = null;
            try { parsed = await res.json(); } catch { parsed = { non_json: true }; }
            return json(200, { code: "OK", target: t, route_status: res.status, route_body: parsed });
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(bytes);
          const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir).map((p) => p.split("/").slice(1).join("/"));
          const manifestPath = Object.keys(zip.files).find((p) => p.endsWith("/manifest.json"));
          const manifest = manifestPath ? JSON.parse(await zip.files[manifestPath].async("string")) as { invoices?: { kind: string; direction: string; folder: string }[]; file_count?: number } : null;
          return json(200, {
            code: "OK", target: t, route_status: res.status,
            package_sha256: res.headers.get("x-esblu-package-sha256"), invoice_count: res.headers.get("x-esblu-invoice-count"),
            sha_matches: createHash("sha256").update(bytes).digest("hex") === res.headers.get("x-esblu-package-sha256"),
            file_count: manifest?.file_count ?? null,
            kinds: (manifest?.invoices ?? []).map((i) => `${i.direction}:${i.kind}:${i.folder.split("/")[0]}`),
            paths: paths.filter((p) => p.startsWith("summary/") || p.endsWith(".xml") || p.endsWith(".pdf") || p.endsWith("metadata.json")).slice(0, 200),
          });
        } finally {
          await endSession(admin, session.token);
        }
      }

      default:
        return json(400, { code: "UNKNOWN_ACTION" });
    }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "DRIVER_ERROR";
    return json(500, { code });
  }
}
