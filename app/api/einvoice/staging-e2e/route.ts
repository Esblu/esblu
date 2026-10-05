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

      default:
        return json(400, { code: "UNKNOWN_ACTION" });
    }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "DRIVER_ERROR";
    return json(500, { code });
  }
}
