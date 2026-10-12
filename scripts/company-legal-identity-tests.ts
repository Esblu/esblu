// =============================================================================
// POST /api/company/legal-identity — handler (bez siete, bez DB).
// DB rozhodnutie o triale: scripts/multi-company-pglite-tests.ts.
//   npm run test:company-legal-identity
// =============================================================================
import assert from "node:assert/strict";
import { handleLegalIdentityRequest, type LegalIdentityDeps } from "@/lib/company-legal-identity/handler";
import type { CompanyDetailResponseBody } from "@/lib/company-lookup/types";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${(error as Error)?.stack?.split("\n").slice(0, 3).join("\n       ") ?? error}`);
  }
}

const COMPANY = "c0000000-0000-4000-8000-0000000000aa";
function detail(ico: string, status: "active" | "terminated" = "active", rpo: "VERIFIED" | "STALE" | "UNAVAILABLE" = "VERIFIED"): CompanyDetailResponseBody {
  return {
    ok: true,
    checkedAt: "2026-10-12T00:00:00Z",
    company: {
      ico, name: "Test s.r.o.", dic: null, addressLine1: null, city: null, postalCode: null, countryCode: "SK", legalForm: null,
      status, terminatedOn: null, establishedOn: null, sourceRegister: null, registryRef: "rpo:1", icoChecksumValid: true,
    } as CompanyDetailResponseBody["company"],
    sources: [{ id: "rpo", status: rpo }],
    warnings: [],
  };
}

type Calls = { lookup: string[]; verified: unknown[][]; attempts: unknown[][] };
function deps(over: Partial<LegalIdentityDeps> = {}, role = "owner"): { deps: LegalIdentityDeps; calls: Calls } {
  const calls: Calls = { lookup: [], verified: [], attempts: [] };
  const base: LegalIdentityDeps = {
    verifyUser: async () => ({ id: "u1" }),
    activeMembership: async () => ({ companyId: COMPANY, role }),
    consumeRateLimit: () => true,
    lookup: async (ico) => {
      calls.lookup.push(ico);
      return { ok: true, body: detail(ico) };
    },
    recordVerified: async (...args) => {
      calls.verified.push(args);
      return { data: { verification_status: "verified", trial: "granted" }, error: null };
    },
    recordAttempt: async (...args) => {
      calls.attempts.push(args);
      return { error: null };
    },
  };
  return { deps: { ...base, ...over }, calls };
}
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

await check("trial-verified-legal-entity: owner + RPO VERIFIED + aktívny subjekt → zápis overenej identity pre firmu z membership", async () => {
  const { deps: d, calls } = deps();
  const r = await handleLegalIdentityRequest({ ico: "IČO: 12 345 678", company_id: "c0000000-0000-4000-8000-0000000000ff", trial: true, verified: true }, d);
  assert.equal(r.status, 200);
  assert.deepEqual(await body(r), { success: true, verificationStatus: "verified", trial: "granted" });
  assert.deepEqual(calls.lookup, ["12345678"], "normalizované IČO");
  assert.deepEqual(calls.verified, [[COMPANY, "SK", "12345678"]], "company_id z tela sa ignoruje");
  assert.equal(calls.attempts.length, 0);
});

await check("company-settings-rbac: admin / accountant / employee → 403 bez lookupu a bez zápisu; bez firmy 409; neprihlásený 401", async () => {
  for (const role of ["admin", "accountant", "employee"]) {
    const { deps: d, calls } = deps({}, role);
    const r = await handleLegalIdentityRequest({ ico: "12345678" }, d);
    assert.equal(r.status, 403, role);
    assert.equal((await body(r)).code, "ESBLU_NOT_ACTIVE_OWNER");
    assert.deepEqual([calls.lookup.length, calls.verified.length, calls.attempts.length], [0, 0, 0]);
  }
  assert.equal((await handleLegalIdentityRequest({ ico: "12345678" }, deps({ activeMembership: async () => null }).deps)).status, 409);
  assert.equal((await handleLegalIdentityRequest({ ico: "12345678" }, deps({ activeMembership: async () => "error" }).deps)).status, 500);
  assert.equal((await handleLegalIdentityRequest({ ico: "12345678" }, deps({ verifyUser: async () => null }).deps)).status, 401);
});

await check("trial-normalization: neplatné IČO / nepodporovaná krajina → bez lookupu a bez zápisu", async () => {
  for (const ico of ["abc", "", "123", "123456789", "00000000", null, 12345678]) {
    const { deps: d, calls } = deps();
    const r = await handleLegalIdentityRequest({ ico }, d);
    assert.equal(r.status, 400, String(ico));
    assert.equal(calls.lookup.length + calls.attempts.length + calls.verified.length, 0);
  }
  const { deps: d, calls } = deps();
  assert.equal((await handleLegalIdentityRequest({ ico: "12345678", country: "CZ" }, d)).status, 422);
  assert.equal(calls.lookup.length, 0);
});

await check("trial-register-unavailable: 503 / STALE / iný subjekt → 'unavailable' pokus, žiadna overená identita, retryable", async () => {
  const cases: Array<Partial<LegalIdentityDeps>> = [
    { lookup: async () => ({ ok: false, status: 503, code: "UPSTREAM_UNAVAILABLE" }) },
    { lookup: async () => ({ ok: false, status: 429, code: "RATE_LIMITED" }) },
    { lookup: async (ico) => ({ ok: true, body: detail(ico, "active", "STALE") }) },
    { lookup: async () => ({ ok: true, body: detail("87654321") }) },
  ];
  for (const over of cases) {
    const { deps: d, calls } = deps(over);
    const r = await handleLegalIdentityRequest({ ico: "12345678" }, d);
    assert.equal(r.status, 503);
    const b = await body(r);
    assert.deepEqual([b.code, b.verificationStatus, b.retryable], ["ESBLU_REGISTRY_UNAVAILABLE", "unverified", true]);
    assert.deepEqual(calls.attempts, [[COMPANY, "SK", "12345678", "unavailable"]]);
    assert.equal(calls.verified.length, 0);
  }
  // pád zápisu pokusu nesmie zhodiť odpoveď
  const { deps: d } = deps({ lookup: async () => ({ ok: false, status: 503, code: "X" }), recordAttempt: async () => ({ error: { message: "boom" } }) });
  assert.equal((await handleLegalIdentityRequest({ ico: "12345678" }, d)).status, 503);
});

await check("register: neexistuje → 404 'failed'; zaniknutý → 409 'failed'; nič sa neoverí", async () => {
  let x = deps({ lookup: async () => ({ ok: false, status: 404, code: "NOT_FOUND" }) });
  let r = await handleLegalIdentityRequest({ ico: "12345678" }, x.deps);
  assert.equal(r.status, 404);
  assert.equal((await body(r)).verificationStatus, "failed");
  assert.deepEqual(x.calls.attempts, [[COMPANY, "SK", "12345678", "not_found"]]);
  assert.equal(x.calls.verified.length, 0);
  x = deps({ lookup: async (ico) => ({ ok: true, body: detail(ico, "terminated") }) });
  r = await handleLegalIdentityRequest({ ico: "12345678" }, x.deps);
  assert.equal(r.status, 409);
  assert.deepEqual(x.calls.attempts, [[COMPANY, "SK", "12345678", "terminated"]]);
  assert.equal(x.calls.verified.length, 0);
});

await check("zamknutá identita / limit: LOCKED → 409; rate limit → 429 bez registra; DB chyba → 500", async () => {
  const locked = deps({ recordVerified: async () => ({ data: null, error: { message: "ESBLU_LEGAL_IDENTITY_LOCKED" } }) });
  const r = await handleLegalIdentityRequest({ ico: "12345678" }, locked.deps);
  assert.equal(r.status, 409);
  assert.equal((await body(r)).code, "ESBLU_LEGAL_IDENTITY_LOCKED");
  const limited = deps({ consumeRateLimit: () => false });
  assert.equal((await handleLegalIdentityRequest({ ico: "12345678" }, limited.deps)).status, 429);
  assert.equal(limited.calls.lookup.length, 0);
  const broken = deps({ recordVerified: async () => ({ data: null, error: { message: "connection reset" } }) });
  assert.equal((await handleLegalIdentityRequest({ ico: "12345678" }, broken.deps)).status, 500);
});

await check("výsledok trialu prechádza z DB bez úprav (not_eligible_previous_trial / already_has_trial)", async () => {
  for (const trial of ["not_eligible_previous_trial", "already_has_trial", "legacy_no_trial"]) {
    const { deps: d } = deps({ recordVerified: async () => ({ data: { verification_status: "verified", trial }, error: null }) });
    assert.equal((await body(await handleLegalIdentityRequest({ ico: "12345678" }, d))).trial, trial);
  }
});

console.log(`\ncompany-legal-identity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
