// =============================================================================
// E-Faktúra — spoločný limit partnerského kľúča (migrácia 20261126100000) — offline testy.
//   PGlite (všetky e-faktúra migrácie + 20261125100000 + 20261126100000) + skutočný EfakturaSkProvider s falošným HTTP.
//   npm run test:einvoice-rate-limit
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPartnerHarness } from "./einvoice-partner-harness.ts";
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import { EinvoiceProviderError } from "../lib/einvoice/provider/types.ts";
import {
  cooldownSeconds,
  isLocalRateLimit,
  PROVIDER_LOCAL_METHODS,
  PROVIDER_METHOD_CLASS,
  withProviderRateLimit,
  type ProviderRateClass,
  type ProviderRateDecision,
  type ProviderRateLimiter,
} from "../lib/einvoice/provider/rate-limit.ts";
import { getEinvoiceProvider } from "../lib/einvoice/provider/index.ts";
import { classifySendError } from "../lib/einvoice/outbound/policy.ts";
import { providerErrorStatus } from "../lib/einvoice/outbound/request.ts";
import { withInboundRateLimit } from "../lib/einvoice/inbound/processor.ts";
import type { InboundStore } from "../lib/einvoice/inbound/store.ts";
import { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts, sanitizeHealth } from "../lib/einvoice/ops/alerts.ts";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n").slice(0, 3).join(" ") : String(error)}`);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const M125 = "supabase/migrations/20261125100000_einvoice_inbound_quarantine.sql";
const M126 = "supabase/migrations/20261126100000_einvoice_provider_rate_classes.sql";
const R126 = "supabase/rollback/20261126100000_einvoice_provider_rate_classes_rollback.sql";

const h = await createPartnerHarness();
await h.exec(read(M125));
await h.exec(read(M126));
const svc = async <T>(q: string, p: unknown[] = []) => (await h.asService(() => h.db.query<T>(q, p))).rows;
const acquire = async (cls: string, env = "sandbox", provider = "efaktura_sk") =>
  (await svc<{ r: string }>("select public.esblu_einvoice_rate_acquire_class($1, $2, $3, 1) r", [provider, env, cls]))[0].r;
const reset = () => h.exec("delete from public.einvoice_provider_rate_usage; delete from public.einvoice_provider_rate_state;");
/** Mimo posledných 3 s minúty (kvóty v jednej minúte bez prechodu okna počas cyklu). */
async function safeWindow() {
  const s = new Date().getUTCSeconds();
  if (s >= 57) await new Promise((r) => setTimeout(r, (61 - s) * 1000));
}

// -----------------------------------------------------------------------------
// Mapovanie metód
// -----------------------------------------------------------------------------
await check("RL-map: každá sieťová metóda EfakturaSkProvider má triedu limitu (nová metóda bez triedy = chyba)", () => {
  const proto = EfakturaSkProvider.prototype as unknown as Record<string, unknown>;
  const missing: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name)!;
    if (typeof d.value !== "function") continue; // gettery (inboundPagination) nerobia požiadavky
    if (PROVIDER_LOCAL_METHODS.has(name)) continue;
    if (!PROVIDER_METHOD_CLASS[name]) missing.push(name);
  }
  assert.deepEqual(missing, []);
  assert.equal(PROVIDER_METHOD_CLASS.sendUbl, "outbound");
  assert.equal(PROVIDER_METHOD_CLASS.preflight, "interactive");
  assert.equal(PROVIDER_METHOD_CLASS.listPartnerEvents, "background");
  assert.equal(PROVIDER_METHOD_CLASS.acknowledgeInbound, "inbound");
});

// -----------------------------------------------------------------------------
// DB funkcia: kvóty, rezerva, celkový strop, kĺzavé okno, cooldown, súbeh
// -----------------------------------------------------------------------------
await check("RL-quota: trieda má vlastnú kvótu; 11. požiadavka interactive = class_limit, zamietnutie sa počíta", async () => {
  await reset();
  await safeWindow();
  const r: string[] = [];
  for (let i = 0; i < 11; i++) r.push(await acquire("interactive"));
  assert.deepEqual(r.slice(0, 10), Array(10).fill("ok"));
  assert.equal(r[10], "class_limit");
  const [u] = await svc<{ used: number; denied: number }>("select sum(used)::int used, sum(denied)::int denied from public.einvoice_provider_rate_usage where class = 'interactive'");
  assert.deepEqual([u.used, u.denied], [10, 1]);
});

await check("RL-reserve: vyčerpanie VŠETKÝCH ostatných tried nezníži rezervu odosielania (25/min)", async () => {
  await reset();
  await safeWindow();
  for (const [cls, n] of [["interactive", 12], ["reconcile", 12], ["inbound_event", 20], ["inbound_poll", 30], ["background", 8]] as const) {
    for (let i = 0; i < n; i++) await acquire(cls);
  }
  const out: string[] = [];
  for (let i = 0; i < 26; i++) out.push(await acquire("outbound"));
  assert.equal(out.filter((x) => x === "ok").length, 25, "odosielanie má celú rezervu");
  assert.equal(out[25], "class_limit");
  const [t] = await svc<{ used: number }>("select sum(used)::int used from public.einvoice_provider_rate_usage");
  assert.equal(t.used, 90, "celkovo presne strop 90/min");
});

await check("RL-total: celkový strop platí aj pri zvýšených kvótach tried (total_limit)", async () => {
  await reset();
  await safeWindow();
  await h.exec("update public.einvoice_provider_rate_limits set per_minute = 12 where provider = 'efaktura_sk' and environment = 'sandbox' and class = 'total'");
  try {
    const r: string[] = [];
    for (let i = 0; i < 8; i++) r.push(await acquire("interactive"));
    for (let i = 0; i < 6; i++) r.push(await acquire("outbound"));
    assert.equal(r.filter((x) => x === "ok").length, 12);
    assert.ok(r.includes("total_limit"));
  } finally {
    await h.exec("update public.einvoice_provider_rate_limits set per_minute = 90 where provider = 'efaktura_sk' and environment = 'sandbox' and class = 'total'");
  }
});

await check("RL-sliding: predchádzajúca minúta sa započíta váhou (žiadny dvojnásobný nápor na hranici); staršie okno nie", async () => {
  await reset();
  await h.exec("insert into public.einvoice_provider_rate_usage (provider, environment, window_start, class, used) values ('efaktura_sk', 'sandbox', date_trunc('minute', clock_timestamp()) - interval '1 minute', 'background', 100000)");
  assert.equal(await acquire("background"), "class_limit", "predchádzajúca minúta plná → zamietnuté");
  await reset();
  await h.exec("insert into public.einvoice_provider_rate_usage (provider, environment, window_start, class, used) values ('efaktura_sk', 'sandbox', date_trunc('minute', clock_timestamp()) - interval '2 minutes', 'background', 100000)");
  assert.equal(await acquire("background"), "ok", "okno spred 2 minút sa nepočíta");
});

await check("RL-cooldown: po 429 čakajú všetky triedy vrátane odosielania; po uplynutí znova ok; čakanie sa neskracuje", async () => {
  await reset();
  const [c1] = await svc<{ u: string }>("select public.esblu_einvoice_rate_cooldown('efaktura_sk', 'sandbox', 120)::text u");
  const [c2] = await svc<{ u: string }>("select public.esblu_einvoice_rate_cooldown('efaktura_sk', 'sandbox', 5)::text u");
  assert.equal(c2.u, c1.u, "kratší Retry-After neskráti čakanie");
  for (const cls of ["interactive", "outbound", "reconcile", "inbound_event", "inbound_poll", "background"]) assert.equal(await acquire(cls), "cooldown", cls);
  assert.equal(await acquire("outbound", "live"), "ok", "iné prostredie nie je ovplyvnené");
  await h.exec("update public.einvoice_provider_rate_state set blocked_until = clock_timestamp() - interval '1 second'");
  assert.equal(await acquire("outbound"), "ok");
  const [s] = await svc<{ n: number }>("select count_429 n from public.einvoice_provider_rate_state where environment = 'sandbox'");
  assert.equal(Number(s.n), 2);
});

await check("RL-concurrency: 30 súbežných žiadostí background (kvóta 5) → presne 5 povolených", async () => {
  await reset();
  await safeWindow();
  const r = await Promise.all(Array.from({ length: 30 }, () => acquire("background")));
  assert.equal(r.filter((x) => x === "ok").length, 5);
});

await check("RL-unconfigured + validácia: neznámy provider = povolené (fail-open, zaznamenané); neplatná trieda/cena = chyba; bez prístupu pre authenticated", async () => {
  await reset();
  assert.equal(await acquire("outbound", "sandbox", "other_provider"), "unconfigured");
  await assert.rejects(() => acquire("total"));
  await assert.rejects(() => svc("select public.esblu_einvoice_rate_acquire_class('efaktura_sk', 'sandbox', 'outbound', 0)"));
  const [g] = await svc<{ a: boolean; b: boolean; t: boolean }>(
    "select has_function_privilege('authenticated', 'public.esblu_einvoice_rate_acquire_class(text,text,text,integer)', 'execute') a, has_function_privilege('anon', 'public.esblu_einvoice_rate_cooldown(text,text,integer)', 'execute') b, has_table_privilege('authenticated', 'public.einvoice_provider_rate_usage', 'select') t"
  );
  assert.deepEqual([g.a, g.b, g.t], [false, false, false]);
});

// -----------------------------------------------------------------------------
// Proxy nad skutočným poskytovateľom
// -----------------------------------------------------------------------------
type Call = { method: string; path: string };
function fakeHttp(status = 200, headers: Record<string, string> = {}, body: unknown = { data: { status: "queued", invoice_id: "i1", document_id: "9915:1#N", send_ready: true } }) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: u.pathname });
    return new Response(JSON.stringify(status === 429 ? { error: { code: "RATE_LIMITED", message: "slow down" } } : body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { calls, impl: impl as typeof fetch };
}
function memLimiter(decide: (cls: ProviderRateClass) => ProviderRateDecision | Error = () => "ok") {
  const seen: ProviderRateClass[] = [];
  const cooldowns: number[] = [];
  const limiter: ProviderRateLimiter = {
    async acquire(_p, _e, cls) {
      seen.push(cls);
      const d = decide(cls);
      if (d instanceof Error) throw d;
      return d;
    },
    async cooldown(_p, _e, s) {
      cooldowns.push(s);
    },
  };
  return { limiter, seen, cooldowns };
}
const KEY = "efk_pk_test_" + "0".repeat(24);
const ctx = { environment: "sandbox" as const, providerOrgId: "11111111-1111-4111-8111-111111111111" };
const ubl = new TextEncoder().encode("<Invoice/>");
const { createHash } = await import("node:crypto");
const sendInput = { ubl, ublSha256: createHash("sha256").update(ubl).digest("hex"), idempotencyKey: "idem-rl-0000000001", receiverParticipantId: "9915:2020147507" };

await check("RL-proxy: instanceof, getter inboundPagination a toJSON fungujú cez Proxy (privátne polia)", () => {
  const p = withProviderRateLimit(new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: fakeHttp().impl }), "sandbox", memLimiter().limiter);
  assert.ok(p instanceof EfakturaSkProvider);
  assert.equal(p.inboundPagination, "offset");
  assert.ok(!JSON.stringify(p).includes(KEY), "kľúč sa neserializuje");
});

await check("RL-outbound-deny: zamietnuté odoslanie → žiadna HTTP požiadavka, retryable RATE_LIMITED, politika = istý retry (bez neznámeho výsledku)", async () => {
  const http = fakeHttp();
  const m = memLimiter((cls) => (cls === "outbound" ? "class_limit" : "ok"));
  const p = withProviderRateLimit(new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: http.impl }), "sandbox", m.limiter);
  const err = await p.sendUbl(ctx, sendInput).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof EinvoiceProviderError && err.code === "EINVOICE_PROVIDER_RATE_LIMITED" && err.retryable);
  assert.ok(isLocalRateLimit(err));
  assert.equal(http.calls.length, 0, "požiadavka sa neodoslala → Idempotency-Key nespotrebovaný");
  const d = classifySendError(err) as { kind: string; outcomeUnknown?: boolean };
  assert.equal(d.kind, "retry");
  assert.equal(d.outcomeUnknown, false, "nevznikne neistý výsledok odoslania → žiadna duplicita");
  assert.deepEqual(m.cooldowns, [], "lokálne zamietnutie nenastaví cooldown");
});

await check("RL-outbound-ok: povolené odoslanie ide presne raz s rovnakým Idempotency-Key; trieda outbound", async () => {
  const http = fakeHttp();
  const m = memLimiter();
  const p = withProviderRateLimit(new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: http.impl }), "sandbox", m.limiter);
  await p.sendUbl(ctx, sendInput);
  assert.deepEqual(m.seen, ["outbound"]);
  assert.equal(http.calls.filter((c) => c.path.endsWith("/connector/send")).length, 1);
});

await check("RL-429: 429 poskytovateľa → cooldown podľa Retry-After (12 s), chyba ostáva retryable; bez Retry-After 30 s", async () => {
  const m = memLimiter();
  const p = withProviderRateLimit(new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: fakeHttp(429, { "retry-after": "12" }).impl }), "sandbox", m.limiter);
  const err = await p.getOutboundStatus(ctx, { providerSubmissionId: "s1" }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof EinvoiceProviderError && err.code === "EINVOICE_PROVIDER_RATE_LIMITED" && !isLocalRateLimit(err));
  assert.deepEqual(m.cooldowns, [12]);
  assert.equal(cooldownSeconds(new Error("x")), 30);
  assert.equal(cooldownSeconds(new Error("(Retry-After 99999 s)")), 3600);
});

await check("RL-inbound: metódy príjmu globálny limiter nepočíta (rieši ich withInboundRateLimit), 429 pri príjme nastaví cooldown", async () => {
  const m = memLimiter();
  const p = withProviderRateLimit(new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: fakeHttp(429).impl }), "sandbox", m.limiter);
  await p.listUnacknowledgedInboundPage!(ctx, { limit: 10 }).catch(() => null);
  assert.deepEqual(m.seen, []);
  assert.deepEqual(m.cooldowns, [30]);
});

await check("RL-failopen: chyba limitera (DB/migrácia) nezastaví prevádzku — požiadavka pokračuje", async () => {
  const http = fakeHttp(200, {}, { data: { found: true } });
  const p = withProviderRateLimit(new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: http.impl }), "sandbox", memLimiter(() => new Error("db down")).limiter);
  await p.verifyRecipient(ctx, "9915:2020147507").catch(() => null);
  assert.equal(http.calls.length, 1);
});

await check("RL-interactive: zamietnutá kontrola pred odoslaním → HTTP 429 pre používateľa (nie 502)", () => {
  assert.equal(providerErrorStatus(new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", "Lokálny limit požiadaviek (interactive: class_limit)", true)), 429);
  assert.equal(providerErrorStatus(new EinvoiceProviderError("EINVOICE_PROVIDER_UNAVAILABLE", "x", true)), 502);
});

await check("RL-runtime: getEinvoiceProvider predvolene obalí poskytovateľa limiterom; null = bez obalu; LIVE brány nezmenené", () => {
  const env = { ESBLU_EINVOICE_PROVIDER: "efaktura_sk", ESBLU_EINVOICE_ENVIRONMENT: "sandbox", ESBLU_EFAKTURA_API_KEY: KEY };
  const m = memLimiter();
  const wrapped = getEinvoiceProvider(env, { rateLimiter: m.limiter })!;
  assert.ok(wrapped.provider instanceof EfakturaSkProvider);
  assert.notEqual(Object.getPrototypeOf(wrapped.provider), null);
  const raw = getEinvoiceProvider(env, { rateLimiter: null })!;
  assert.ok(raw.provider instanceof EfakturaSkProvider);
  assert.equal(getEinvoiceProvider({ ...env, ESBLU_EINVOICE_ENVIRONMENT: "live" }, { rateLimiter: m.limiter }), null, "LIVE bez brán = null");
});

await check("RL-inbound-class: príjem používa triedu spoločného limitu (inbound_poll/inbound_event); pri chybe starší limiter; inak fail-open", async () => {
  const seen: string[] = [];
  const base = { name: "efaktura_sk", async acknowledgeInbound() {} } as unknown as import("../lib/einvoice/provider/types.ts").EinvoiceProvider;
  const store = {
    async acquireProviderClass(_p: string, _e: string, cls: string) { seen.push(cls); return false; },
    async acquireProviderBudget() { seen.push("legacy"); return true; },
  } as unknown as InboundStore;
  const d = withInboundRateLimit({ store, provider: base, environment: "sandbox" }, "poll");
  await assert.rejects(() => d.provider.acknowledgeInbound(ctx, "r1"), /Lokálny limit/);
  assert.deepEqual(seen, ["inbound_poll"]);
  const store2 = {
    async acquireProviderClass() { throw new Error("no migration"); },
    async acquireProviderBudget() { seen.push("legacy"); return true; },
  } as unknown as InboundStore;
  await withInboundRateLimit({ store: store2, provider: base, environment: "sandbox" }, "event").provider.acknowledgeInbound(ctx, "r1");
  assert.deepEqual(seen, ["inbound_poll", "legacy"]);
});

// -----------------------------------------------------------------------------
// Monitoring a migrácia
// -----------------------------------------------------------------------------
await check("RL-health: provider.* v health a alerty (cooldown warning, opakované 429 critical, odosielanie warning)", async () => {
  await reset();
  await svc("select public.esblu_einvoice_rate_cooldown('efaktura_sk', 'sandbox', 60)");
  for (let i = 0; i < 26; i++) await acquire("outbound");
  const [r] = await svc<{ j: Record<string, unknown> }>("select public.esblu_einvoice_health(60, 60) j");
  const hh = sanitizeHealth(r.j);
  assert.equal(hh.provider.cooldown_active, 1);
  assert.ok(hh.provider.rate_denied_outbound_1h >= 26, "počas cooldownu zamietnuté aj odosielanie");
  const codes = evaluateAlerts(hh, DEFAULT_ALERT_THRESHOLDS).map((a) => `${a.code}:${a.severity}`);
  assert.ok(codes.includes("PROVIDER_RATE_COOLDOWN:warning"));
  assert.ok(codes.includes("OUTBOUND_RATE_LIMITED:warning"));
  await h.exec("update public.einvoice_provider_rate_state set count_429 = 5, last_429_at = clock_timestamp()");
  const [r2] = await svc<{ j: Record<string, unknown> }>("select public.esblu_einvoice_health(60, 60) j");
  assert.ok(evaluateAlerts(sanitizeHealth(r2.j)).some((a) => a.code === "PROVIDER_429_REPEATED" && a.severity === "critical"));
  assert.equal(sanitizeHealth({}).provider.cooldown_active, 0, "bez migrácie 0");
});

await check("RL-migration: rollback vráti health z 20261125100000 a odstráni tabuľky/funkcie; opätovná aplikácia je idempotentná", async () => {
  await h.exec(read(R126));
  const [r] = await svc<{ j: Record<string, unknown> }>("select public.esblu_einvoice_health(60, 60) j");
  assert.equal((r.j as { provider?: unknown }).provider, undefined);
  assert.equal(typeof (r.j.inbound as Record<string, unknown>).scan_overdue, "number", "health z 20261125100000");
  const [n] = await svc<{ n: number }>("select count(*)::int n from pg_class where relname in ('einvoice_provider_rate_limits', 'einvoice_provider_rate_usage', 'einvoice_provider_rate_state')");
  assert.equal(n.n, 0);
  await h.exec(read(M126));
  await h.exec(read(M126));
  const [k] = await svc<{ n: number }>("select count(*)::int n from public.einvoice_provider_rate_limits");
  assert.equal(k.n, 14, "7 tried × sandbox/live, bez duplicít");
});

console.log(`\neinvoice-rate-limit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
