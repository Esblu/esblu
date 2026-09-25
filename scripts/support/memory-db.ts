// =============================================================================
// Pamäťová databáza pre testy asistenta — dotazy, ktoré kód skutočne volá,
// s tou istou väzbou ako RLS (iba riadky aktívnej firmy) a RPC dialógu
// faktúry / potvrdení (používateľ + firma + jednorazový claim).
//
// Zdieľajú ju scripts/voice-conversation-tests.ts a
// scripts/assistant-orchestrator-tests.ts.
// =============================================================================

import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;
export type Role = "owner" | "admin" | "accountant" | "employee";

export const COMPANY_A = "00000000-0000-4000-8000-00000000000a";
export const COMPANY_B = "00000000-0000-4000-8000-00000000000b";
export const USER_A = "00000000-0000-4000-8000-0000000000a1";
export const USER_B = "00000000-0000-4000-8000-0000000000b1";

export type Tables = Record<string, Row[]>;

export function makeDb(opts: { role: Role; financeManage: boolean; companyId?: string; userId?: string; tables?: Tables }) {
  const companyId = opts.companyId ?? COMPANY_A;
  const state = {
    role: opts.role,
    financeManage: opts.financeManage,
    tables: {
      machines: [], vehicles: [], inventory_items: [], inventory_photos: [], machine_services: [], vehicle_services: [],
      machine_photos: [], vehicle_photos: [], documents: [], business_partners: [], invoices: [], invoice_items: [], document_links: [], document_folders: [],
      document_folder_items: [], document_export_package_items: [], document_download_events: [], document_attachments: [],
      ...(opts.tables ?? {}),
    } as Tables,
    confirmations: [] as Row[],
    conversations: new Map<string, Row>(),
    storageRemoved: [] as string[],
    queries: 0,
  };
  // RLS: iba riadky aktívnej firmy (riadky bez company_id patria A).
  const visible = (row: Row) => (row.company_id ?? COMPANY_A) === companyId;

  function table(name: string) {
    state.queries++;
    let op: "select" | "delete" | "insert" | "update" = "select";
    let payload: Row | null = null;
    let head = false;
    const filters: Array<(row: Row) => boolean> = [];
    const all = () => (state.tables[name] ?? (state.tables[name] = []));
    const withJoins = (row: Row): Row => {
      if (name === "documents") {
        return { ...row, document_links: state.tables.document_links.filter((l) => l.document_id === row.id) };
      }
      if (name === "document_folders") {
        return { ...row, document_folder_items: [{ count: state.tables.document_folder_items.filter((i) => i.folder_id === row.id).length }] };
      }
      return row;
    };
    const run = () => {
      const rows = all().filter(visible).filter((row) => filters.every((f) => f(row)));
      if (op === "insert") {
        const list = Array.isArray(payload) ? (payload as Row[]) : [payload as Row];
        const rows = list.map((item) => ({ id: randomUUID(), company_id: companyId, ...item }));
        all().push(...rows);
        return { data: rows, error: null };
      }
      if (op === "delete") {
        const ids = new Set(rows.map((r) => r.id));
        state.tables[name] = all().filter((r) => !ids.has(r.id));
        if (name === "documents") {
          for (const t of ["document_links", "document_folder_items", "document_attachments"]) {
            state.tables[t] = state.tables[t].filter((r) => !ids.has(r.document_id));
          }
        }
        return { data: rows.map((r) => ({ id: r.id })), error: null };
      }
      if (op === "update") {
        for (const r of rows) Object.assign(r, payload);
        return { data: rows.map((r) => ({ id: r.id })), error: null };
      }
      if (head) return { data: null, count: rows.length, error: null };
      return { data: rows.map(withJoins), error: null };
    };
    const b: Record<string, unknown> = {
      select(_c?: string, o?: { head?: boolean }) { head = Boolean(o?.head); return b; },
      insert(row: Row | Row[]) { op = "insert"; payload = row as Row; return b; },
      single() { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null }); },
      update(row: Row) { op = "update"; payload = row; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gte() { return b; }, lte() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null }); },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) { try { res(run()); } catch (e) { rej(e); } },
    };
    // Filtre, ktoré pamäťová DB nerozlišuje (ilike, or, not …), sa ignorujú —
    // čítacie handlery tu slúžia iba na to, aby orchestrátor prešiel celý.
    const proxy: Record<string, unknown> = new Proxy(b, {
      get: (target, prop: string) => (prop in target ? target[prop] : () => proxy),
    });
    for (const key of Object.keys(b)) {
      const original = b[key];
      if (typeof original === "function" && key !== "then" && key !== "single" && key !== "maybeSingle") {
        b[key] = (...args: unknown[]) => { (original as (...a: unknown[]) => unknown)(...args); return proxy; };
      }
    }
    return proxy;
  }
  const rpc: Record<string, (a: Row) => unknown> = {
    esblu_my_finance_manage: () => state.financeManage,
    esblu_my_finance_view: () => state.financeManage,
    esblu_my_active_role: () => state.role,
    esblu_role_can_operate: () => state.role !== "accountant",
    esblu_create_action_confirmation: (a) => {
      const id = randomUUID();
      state.confirmations.push({
        id, intent: a.p_intent, canonical_args: a.p_canonical_args, expected_count: a.p_expected_count, nonce: a.p_nonce,
        server_proof: a.p_server_proof, expires_at_epoch: a.p_expires_at_epoch, user_id: opts.userId ?? USER_A, company_id: companyId, consumed_at: null,
      });
      return id;
    },
    // Dialóg faktúry (lib/intents/conversation.ts) — rovnaká väzba ako SQL:
    // používateľ + aktívna firma + conversationId, claim iba raz.
    esblu_upsert_conversation_context: (a) => {
      const k = `${opts.userId ?? USER_A}|${companyId}|${a.p_conversation_id}`;
      const prev = state.conversations.get(k);
      const turn = Math.min((prev?.turn_count as number ?? 0) + 1, 12);
      state.conversations.set(k, { pending_intent: a.p_pending_intent, slots: a.p_slots, missing_fields: a.p_missing_fields, turn_count: turn, consumed: false });
      return turn;
    },
    esblu_load_conversation_context: (a) => {
      const row = state.conversations.get(`${opts.userId ?? USER_A}|${companyId}|${a.p_conversation_id}`);
      return row && !row.consumed ? row : null;
    },
    esblu_claim_conversation_context: (a) => {
      const row = state.conversations.get(`${opts.userId ?? USER_A}|${companyId}|${a.p_conversation_id}`);
      if (!row || row.consumed) return null;
      row.consumed = true;
      return row;
    },
    esblu_clear_conversation_context: (a) => {
      state.conversations.delete(`${opts.userId ?? USER_A}|${companyId}|${a.p_conversation_id}`);
      return null;
    },
    esblu_claim_action_confirmation: (a) => {
      const row = state.confirmations.find((c) => c.id === a.p_confirmation_id && c.company_id === companyId);
      if (!row || row.consumed_at) return null;
      row.consumed_at = new Date().toISOString();
      return row;
    },
  };
  const db = {
    from: table,
    rpc(n: string, a: Row = {}) {
      const response = { data: rpc[n] ? rpc[n](a) : null, error: null };
      return Object.assign(Promise.resolve(response), { maybeSingle: () => Promise.resolve(response) });
    },
    storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => { state.storageRemoved.push(...paths.map((p) => `${bucket}/${p}`)); return { error: null }; } }) },
  };
  return { db: db as never, state, companyId, userId: opts.userId ?? USER_A };
}

