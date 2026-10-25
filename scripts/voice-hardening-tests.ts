// =============================================================================
// Voice hardening (2026-10-11) — stavový model, chyby mikrofónu, sieť,
// bezpečnostný model príkazov a potvrdenie zápisu.
//
// SPUSTENIE
//   npm run test:voice-hardening
//
// Chráni:
//   - žiadny stav nevisí (strážny časovač), opakované zlyhania reláciu ukončia,
//   - dvojitý štart / dvojité ťuknutie / dvojité potvrdenie nič nezdvojí,
//   - odmietnuté vs. trvalo zablokované povolenie mikrofónu (→ nastavenia),
//   - offline / timeout / 4xx / 5xx → zrozumiteľný kľúč správy, nikdy
//     automatické opakovanie,
//   - pozadie / zamknutie / odchod zo stránky mikrofón uvoľní,
//   - zápis (návrh faktúry) iba po výslovnom „áno", mazanie nikdy iba hlasom,
//   - nejasná / číselná odpoveď pri potvrdení nič nevykoná.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ESBLU_ACTION_CONFIRMATION_SECRET ??= "cd".repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const {
  INITIAL_VOICE_SESSION,
  MAX_CONSECUTIVE_FAILURES,
  voiceSessionReducer,
  watchdogMsFor,
} = await import("@/lib/voice/voice-session");
const { classifyMicError, INSTANT_DENIAL_MS } = await import("@/lib/voice/mic-errors");
const { fetchJsonWithTimeout, classifyHttpStatus, failureMessageKey } = await import("@/lib/voice/assistant-http");
const { decideVoiceReplyForPreview, isCriticalPreview, riskOfResult } = await import("@/lib/voice/command-safety");
const { translate } = await import("@/lib/i18n/translate");
const { runAssistantTurnDetailed } = await import("@/lib/intents/orchestrator");

type IntentResult = import("@/lib/intents/types").IntentResult;
type Preview = Extract<IntentResult, { kind: "action_preview" }>;

import { makeDb, COMPANY_A, type Tables } from "./support/memory-db.ts";

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Pomocníci stavového automatu
// -----------------------------------------------------------------------------

/** Relácia v stave „počúvam" (štart → mikrofón pripravený). */
function listening() {
  const started = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" }).state;
  return voiceSessionReducer(started, { type: "MIC_READY", gen: started.gen }).state;
}

function transcribing() {
  const s = listening();
  return voiceSessionReducer(s, { type: "UTTERANCE_CAPTURED", gen: s.gen }).state;
}

function waitingServer() {
  const s = transcribing();
  return voiceSessionReducer(s, { type: "TRANSCRIPT", text: "ukáž sklad", gen: s.gen }).state;
}

// =============================================================================
// 1. Stavový model
// =============================================================================

await check("duplicate start: druhý START počas relácie nič nespustí (žiadne druhé acquireMic)", () => {
  const first = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" });
  assert.deepEqual(first.effects.map((e) => e.type), ["cancelSpeech", "acquireMic"]);
  const second = voiceSessionReducer(first.state, { type: "START" });
  assert.equal(second.state, first.state);
  assert.equal(second.effects.length, 0);
  const whileListening = voiceSessionReducer(listening(), { type: "START" });
  assert.equal(whileListening.effects.length, 0);
});

await check("dvojité ťuknutie: hook ignoruje ťuknutie rýchlejšie než TAP_DEBOUNCE_MS", () => {
  const hook = readFileSync("hooks/use-voice-session.ts", "utf8");
  assert.match(hook, /export const TAP_DEBOUNCE_MS = \d+;/);
  assert.ok(hook.includes("if (now - lastTapRef.current < TAP_DEBOUNCE_MS) return;"));
});

await check("stop/cancel: ťuknutie počas počúvania zastaví reláciu a uvoľní mikrofón", () => {
  const step = voiceSessionReducer(listening(), { type: "USER_TAP" });
  assert.equal(step.state.status, "stopped");
  assert.equal(step.state.stopReason, "user");
  const types = step.effects.map((e) => e.type);
  assert.ok(types.includes("cancelListen") && types.includes("releaseMic") && types.includes("cancelSpeech"));
  assert.ok(!types.includes("speakNotice"), "zámerné zastavenie je tiché");
});

await check("stop počas spracovania: neskorý prepis po zastavení nič nespustí", () => {
  const s = transcribing();
  const stopped = voiceSessionReducer(s, { type: "STOP", reason: "user" }).state;
  const late = voiceSessionReducer(stopped, { type: "TRANSCRIPT", text: "zmaž stroj Aman", gen: s.gen });
  assert.equal(late.state, stopped);
  assert.equal(late.effects.length, 0);
});

await check("permission denied: MIC_FAILED denied → error + micDenied (bez nastavení)", () => {
  const started = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" }).state;
  const step = voiceSessionReducer(started, { type: "MIC_FAILED", reason: "denied", gen: started.gen });
  assert.equal(step.state.status, "error");
  assert.equal(step.state.noticeKey, "micDenied");
  assert.equal(step.state.micFailure, "denied");
  assert.deepEqual(step.effects.map((e) => e.type), ["releaseMic"]);
});

await check("permanent denial: MIC_FAILED blocked → micBlocked; UI ponúkne „Otvoriť nastavenia“", () => {
  const started = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" }).state;
  const step = voiceSessionReducer(started, { type: "MIC_FAILED", reason: "blocked", gen: started.gen });
  assert.equal(step.state.noticeKey, "micBlocked");
  assert.equal(step.state.micFailure, "blocked");
  const hook = readFileSync("hooks/use-voice-session.ts", "utf8");
  assert.ok(hook.includes('session.micFailure === "blocked"') && hook.includes("canOpenSettings"));
  const control = readFileSync("app/components/voice/VoiceSessionControl.tsx", "utf8");
  assert.ok(control.includes('t("search.voice.session.openSettings")'));
  // Nový štart po chybe vyčistí dôvod (povolenie mohol používateľ medzitým zapnúť).
  const restarted = voiceSessionReducer(step.state, { type: "START" }).state;
  assert.equal(restarted.micFailure, undefined);
  assert.equal(restarted.status, "starting");
});

await check("klasifikácia getUserMedia: zakázané / zablokované / obsadené / žiadny mikrofón / nepodporované", () => {
  const err = (name: string) => ({ name });
  assert.equal(classifyMicError(err("NotAllowedError"), { permission: "prompt", elapsedMs: 3000 }), "denied");
  assert.equal(classifyMicError(err("NotAllowedError"), { permission: "denied", elapsedMs: 3000 }), "blocked");
  assert.equal(classifyMicError(err("NotAllowedError"), { permission: "unknown", elapsedMs: INSTANT_DENIAL_MS - 100 }), "blocked", "odmietnutie bez výzvy");
  assert.equal(classifyMicError(err("SecurityError"), { permission: "unknown", elapsedMs: 2000 }), "denied");
  assert.equal(classifyMicError(err("NotFoundError"), { permission: "granted", elapsedMs: 10 }), "not_found");
  assert.equal(classifyMicError(err("OverconstrainedError"), { permission: "granted", elapsedMs: 10 }), "not_found");
  assert.equal(classifyMicError(err("NotReadableError"), { permission: "granted", elapsedMs: 10 }), "busy");
  assert.equal(classifyMicError(err("AbortError"), { permission: "granted", elapsedMs: 10 }), "busy");
  assert.equal(classifyMicError(err("TypeError"), { permission: "unknown", elapsedMs: 10 }), "unsupported");
  assert.equal(classifyMicError(err("NotAllowedError"), { permission: "prompt", elapsedMs: 3000, secureContext: false }), "unsupported");
  assert.equal(classifyMicError(new Error("x"), { permission: "granted", elapsedMs: 10 }), "busy", "neznáma chyba ≠ zákaz");
});

await check("timeout: strážny časovač pre STARTING / TRANSCRIBING / WAITING_SERVER, nie pre počúvanie", () => {
  assert.ok((watchdogMsFor("starting") ?? 0) >= 15_000, "výzva na povolenie potrebuje čas");
  assert.ok((watchdogMsFor("transcribing") ?? 0) > 0);
  assert.ok((watchdogMsFor("waiting_server") ?? 0) > 0);
  assert.equal(watchdogMsFor("listening"), null, "počúvanie má vlastné VAD okná");
  assert.equal(watchdogMsFor("idle"), null);
});

await check("timeout: visiaci mikrofón → error micTimeout; visiaci prepis/server → povie a počúva znova", () => {
  const started = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" }).state;
  const mic = voiceSessionReducer(started, { type: "WATCHDOG", gen: started.gen });
  assert.equal(mic.state.status, "error");
  assert.equal(mic.state.noticeKey, "micTimeout");
  assert.ok(mic.effects.some((e) => e.type === "releaseMic"));

  const t = transcribing();
  const afterT = voiceSessionReducer(t, { type: "WATCHDOG", gen: t.gen });
  assert.equal(afterT.state.status, "speaking");
  assert.equal(afterT.state.noticeKey, "timeoutRetry");
  assert.equal(afterT.state.failures, 1);

  const w = waitingServer();
  const afterW = voiceSessionReducer(w, { type: "WATCHDOG", gen: w.gen });
  assert.equal(afterW.state.status, "speaking");
  // Neskorá odpoveď servera po timeoute sa zahodí — nič sa nevykoná dvakrát.
  const late = voiceSessionReducer(afterW.state, { type: "TURN_RESULT", spoken: "Hotovo", gen: w.gen });
  assert.equal(late.state, afterW.state);
});

await check("timeout: neskorý strážny časovač staršieho kola je ignorovaný", () => {
  const t = transcribing();
  const next = voiceSessionReducer(t, { type: "TRANSCRIPT", text: "ukáž sklad", gen: t.gen }).state;
  const stale = voiceSessionReducer(next, { type: "WATCHDOG", gen: t.gen });
  assert.equal(stale.state, next);
});

await check(`opakované zlyhania: ${MAX_CONSECUTIVE_FAILURES}× za sebou → relácia skončí (žiadna nekonečná slučka)`, () => {
  // Server stále padá, prepis zakaždým prejde → po limite koniec (nie slučka).
  let state = waitingServer();
  for (let i = 1; i <= MAX_CONSECUTIVE_FAILURES; i++) {
    state = voiceSessionReducer(state, { type: "TURN_FAILED", gen: state.gen }).state;
    if (i === MAX_CONSECUTIVE_FAILURES) break;
    assert.equal(state.status, "speaking");
    state = voiceSessionReducer(state, { type: "SPEECH_DONE", gen: state.gen }).state;
    state = voiceSessionReducer(state, { type: "MIC_READY", gen: state.gen }).state;
    state = voiceSessionReducer(state, { type: "UTTERANCE_CAPTURED", gen: state.gen }).state;
    state = voiceSessionReducer(state, { type: "TRANSCRIPT", text: "ukáž sklad", gen: state.gen }).state;
    assert.equal(state.failures, i, "prepis počítadlo nenuluje");
  }
  assert.equal(state.status, "stopped");
  assert.equal(state.stopReason, "failures");
  // Úspešná odpoveď servera počítadlo nuluje.
  const ws = { ...waitingServer(), failures: 2 };
  const reset = voiceSessionReducer(ws, { type: "TURN_RESULT", spoken: "Hotovo", gen: ws.gen });
  assert.equal(reset.state.failures, 0);
  // Zlyhania prepisu za sebou:
  let s2 = transcribing();
  for (let i = 1; i <= MAX_CONSECUTIVE_FAILURES; i++) {
    const step = voiceSessionReducer(s2, { type: "TRANSCRIBE_FAILED", kind: "network", gen: s2.gen });
    s2 = step.state;
    if (i < MAX_CONSECUTIVE_FAILURES) {
      assert.equal(s2.status, "speaking");
      s2 = voiceSessionReducer(s2, { type: "SPEECH_DONE", gen: s2.gen }).state;
      s2 = voiceSessionReducer(s2, { type: "MIC_READY", gen: s2.gen }).state;
      s2 = voiceSessionReducer(s2, { type: "UTTERANCE_CAPTURED", gen: s2.gen }).state;
    }
  }
  assert.equal(s2.status, "stopped");
  assert.equal(s2.stopReason, "failures");
  assert.equal(s2.noticeKey, "tooManyFailures");
});

await check("offline: výpadok siete zastaví reláciu a POVIE prečo; prepis offline → koniec, nie slučka", () => {
  const step = voiceSessionReducer(listening(), { type: "STOP", reason: "offline" });
  assert.equal(step.state.status, "stopped");
  assert.equal(step.state.noticeKey, "offline");
  assert.ok(step.effects.some((e) => e.type === "speakNotice"));
  const t = transcribing();
  const offline = voiceSessionReducer(t, { type: "TRANSCRIBE_FAILED", kind: "offline", gen: t.gen });
  assert.equal(offline.state.status, "stopped");
  assert.equal(offline.state.stopReason, "offline");
});

await check("prepis 401/403: vypršané prihlásenie / bez nároku → koniec relácie s vysvetlením", () => {
  const t = transcribing();
  const unauth = voiceSessionReducer(t, { type: "TRANSCRIBE_FAILED", kind: "unauthenticated", gen: t.gen });
  assert.equal(unauth.state.stopReason, "session_end");
  assert.equal(unauth.state.noticeKey, "sessionExpired");
  const forbidden = voiceSessionReducer(t, { type: "TRANSCRIBE_FAILED", kind: "forbidden", gen: t.gen });
  assert.equal(forbidden.state.stopReason, "forbidden");
  assert.equal(forbidden.state.noticeKey, "voiceNotAllowed");
});

await check("background: pozadie / zamknutie / navigácia zastaví reláciu potichu a uvoľní mikrofón", () => {
  for (const reason of ["hidden", "navigation"] as const) {
    const step = voiceSessionReducer(listening(), { type: "STOP", reason });
    assert.equal(step.state.status, "stopped");
    assert.ok(step.effects.some((e) => e.type === "releaseMic"));
    assert.ok(!step.effects.some((e) => e.type === "speakNotice"), reason);
  }
  const hook = readFileSync("hooks/use-voice-session.ts", "utf8");
  for (const listener of ['"visibilitychange"', '"pagehide"', '"freeze"', "APP_STATE_EVENT", '"offline"']) {
    assert.ok(hook.includes(listener), listener);
  }
  const bridge = readFileSync("mobile/app/AppLifecycleBridge.tsx", "utf8");
  assert.ok(bridge.includes('new CustomEvent("esblu:app-state", { detail: { isActive } })'), "natívny most hlási pozadie");
  assert.ok(hook.includes('export const APP_STATE_EVENT = "esblu:app-state";'));
});

await check("route change: odmontovanie zruší strážny časovač, upload prepisu aj mikrofón", () => {
  const hook = readFileSync("hooks/use-voice-session.ts", "utf8");
  const cleanup = hook.slice(hook.indexOf("return () => {", hook.indexOf("Súkromie: pozadie")));
  for (const piece of ["clearTimeout(watchdogRef.current)", "transcribeAbortRef.current?.abort()", 'reason: "navigation"', "micRef.current?.close()"]) {
    assert.ok(cleanup.includes(piece), piece);
  }
});

// =============================================================================
// 2. Sieť / API
// =============================================================================

function response(status: number, body: unknown, raw = false): Response {
  return new Response(raw ? String(body) : JSON.stringify(body), { status, headers: { "Content-Type": raw ? "text/html" : "application/json" } });
}

await check("offline: požiadavka sa vôbec neodošle", async () => {
  let calls = 0;
  const result = await fetchJsonWithTimeout("/x", {}, { timeoutMs: 1000, isOnline: () => false, fetchImpl: async () => (calls++, response(200, {})) });
  assert.deepEqual(result, { ok: false, kind: "offline" });
  assert.equal(calls, 0);
});

await check("timeout / slow network: požiadavka sa zruší po limite, bez opakovania", async () => {
  let calls = 0;
  const hanging = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const started = Date.now();
  const result = await fetchJsonWithTimeout("/x", {}, { timeoutMs: 50, isOnline: () => true, fetchImpl: hanging });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "timeout");
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 1, "žiadne automatické opakovanie");
});

await check("cancelled request: externé zrušenie (stop relácie) → cancelled, nie chyba", async () => {
  const controller = new AbortController();
  const hanging = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const pending = fetchJsonWithTimeout("/x", {}, { timeoutMs: 5000, signal: controller.signal, isOnline: () => true, fetchImpl: hanging });
  controller.abort();
  const result = await pending;
  assert.equal(!result.ok && result.kind, "cancelled");
});

await check("4xx / 5xx: stav → typ chyby; HTML chybová stránka nespadne", async () => {
  const cases: Array<[number, string]> = [[401, "unauthenticated"], [403, "forbidden"], [413, "too_large"], [429, "rate_limited"], [400, "bad_request"], [422, "bad_request"], [500, "server"], [502, "server"], [503, "server"]];
  for (const [status, kind] of cases) {
    assert.equal(classifyHttpStatus(status), kind, String(status));
    const result = await fetchJsonWithTimeout("/x", {}, { timeoutMs: 1000, isOnline: () => true, fetchImpl: async () => response(status, { success: false }) });
    assert.equal(!result.ok && result.kind, kind, String(status));
  }
  const html = await fetchJsonWithTimeout("/x", {}, { timeoutMs: 1000, isOnline: () => true, fetchImpl: async () => response(502, "<html>Bad gateway</html>", true) });
  assert.equal(!html.ok && html.kind, "server");
  const broken = await fetchJsonWithTimeout("/x", {}, { timeoutMs: 1000, isOnline: () => true, fetchImpl: async () => response(200, "<html>", true) });
  assert.equal(!broken.ok && broken.kind, "invalid_response");
  const ok = await fetchJsonWithTimeout<{ a: number }>("/x", {}, { timeoutMs: 1000, isOnline: () => true, fetchImpl: async () => response(200, { a: 1 }) });
  assert.ok(ok.ok && ok.data.a === 1);
});

await check("používateľ nedostane technický bordel: každý typ chyby má preložený kľúč (sk/de/en)", () => {
  const kinds = ["offline", "timeout", "network", "cancelled", "unauthenticated", "forbidden", "bad_request", "too_large", "rate_limited", "server", "invalid_response"] as const;
  for (const kind of kinds) {
    for (const phase of ["intent", "execute", "transcribe"] as const) {
      const key = failureMessageKey(kind, phase);
      for (const locale of ["sk", "de", "en"] as const) {
        const text = translate(locale, key);
        assert.ok(text && text !== key && !/\d{3}/.test(text), `${kind}/${phase}/${locale}: ${text}`);
      }
    }
  }
  // Potvrdenie zápisu po výpadku: „neviem, či sa uložilo" — nikdy „zlyhalo" (duplicitné ručné zadanie).
  assert.equal(failureMessageKey("timeout", "execute"), "search.voice.errors.executeUnknown");
  assert.equal(failureMessageKey("network", "execute"), "search.voice.errors.executeUnknown");
  assert.equal(failureMessageKey("bad_request", "execute"), "search.voice.errors.confirmationExpired");
});

await check("nové hlasové oznámenia existujú v sk/de/en (žiadny surový kľúč v UI)", () => {
  const keys = ["unsupported", "micBlocked", "micNotFound", "micBusy", "micTimeout", "micLost", "offline", "timeoutRetry", "tooManyFailures", "sessionExpired", "voiceNotAllowed", "tooLong", "tapToConfirm", "openSettings", "micDenied", "asrRetry", "networkRetry"];
  for (const key of keys) {
    for (const locale of ["sk", "de", "en"] as const) {
      const full = `search.voice.session.${key}`;
      assert.notEqual(translate(locale, full), full, `${locale}: ${full}`);
    }
  }
});

await check("duplicate submit prevention: potvrdenie má in-flight poistku a kontroluje stav odpovede", () => {
  for (const file of ["app/components/voice/VoiceLauncher.tsx", "app/components/Dashboard.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("if (confirmInFlightRef.current) return null;"), file);
    assert.ok(source.includes("confirmInFlightRef.current = false;"), `${file}: poistka sa uvoľní`);
    assert.ok(source.includes('failureMessageKey(http.kind, "execute")'), `${file}: chyba potvrdenia ≠ „Hotovo"`);
  }
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  assert.ok(launcher.includes("if (!http.ok || !http.data?.success || !http.data.result)"), "launcher: úspech iba 2xx + success + result");
});

// =============================================================================
// 3. Bezpečnostný model príkazov
// =============================================================================

const preview = (action: Preview["action"], destructive?: boolean): Preview => ({
  kind: "action_preview",
  action,
  summary: "…",
  confirmLabel: "Potvrdiť",
  cancelLabel: "Zrušiť",
  confirmationId: "x",
  ...(destructive !== undefined ? { destructive } : {}),
});

await check("kategórie: navigation / read / write / critical", () => {
  assert.equal(riskOfResult({ kind: "navigate", entity: { type: "vehicle", id: "v", label: "V" } } as IntentResult), "navigation");
  assert.equal(riskOfResult({ kind: "answer", text: "Máte 3 neuhradené faktúry." } as IntentResult), "read");
  assert.equal(riskOfResult(preview("INVENTORY_ITEM_CREATE")), "write");
  assert.equal(riskOfResult(preview("FOLDER_RENAME")), "write");
  for (const action of ["MACHINE_DELETE", "VEHICLE_DELETE", "INVENTORY_ITEM_DELETE", "FOLDER_DELETE", "FOLDER_REMOVE_ITEMS", "DELETE_DOCUMENT_CATEGORY", "INBOX_DELETE_UNASSIGNED"] as const) {
    assert.equal(riskOfResult(preview(action)), "critical", action);
  }
  assert.ok(isCriticalPreview(preview("INVENTORY_QUANTITY_ADJUST", true)), "server označil destructive");
});

await check("write action requires confirmation: hlasové „áno“ pri bežnom zápise = confirm, nejasné = ask_again", () => {
  const create = preview("MACHINE_CREATE");
  assert.equal(decideVoiceReplyForPreview("Áno", create), "confirm");
  assert.equal(decideVoiceReplyForPreview("Nie", create), "cancel");
  assert.equal(decideVoiceReplyForPreview("hm", create), "ask_again");
  assert.equal(decideVoiceReplyForPreview("áno?", create), "ask_again", "otázka nie je súhlas");
});

await check("critical action requires confirmation: mazanie sa hlasom NIKDY nepotvrdí (tap_required)", () => {
  for (const action of ["MACHINE_DELETE", "VEHICLE_DELETE", "INVENTORY_ITEM_DELETE", "FOLDER_DELETE"] as const) {
    for (const yes of ["Áno", "áno, zmaž", "Ja", "Yes"]) {
      const decision = decideVoiceReplyForPreview(yes, preview(action));
      assert.notEqual(decision, "confirm", `${action}: ${yes}`);
    }
    assert.equal(decideVoiceReplyForPreview("Áno", preview(action)), "tap_required");
    assert.equal(decideVoiceReplyForPreview("Nie", preview(action)), "cancel", "zrušiť sa dá aj hlasom");
  }
  for (const file of ["app/components/voice/VoiceLauncher.tsx", "app/components/Dashboard.tsx"]) {
    const source = readFileSync(file, "utf8");
    const at = source.indexOf('decision === "tap_required"');
    assert.ok(at > 0 && at < source.indexOf('decision === "confirm"', at), `${file}: tap_required pred confirm`);
  }
});

await check("ambiguous numeric input does not auto-execute: číslo / suma / IBAN namiesto „áno“ nič nevykoná", () => {
  const create = preview("INVENTORY_QUANTITY_ADJUST");
  for (const reply of ["300", "tristo eur", "15. 10.", "SK31 1200", "12345678", "300?"]) {
    const decision = decideVoiceReplyForPreview(reply, create);
    assert.ok(decision === "ask_again" || decision === "new_command", `${reply} → ${decision}`);
    assert.notEqual(decision, "confirm");
  }
});

// =============================================================================
// 4. Návrh faktúry hlasom — zápis až po výslovnom „áno"
// =============================================================================

const CONV = "0123456789abcdef0123456789abcdef";
const P_T1 = "00000000-0000-4000-8000-0000000000e1";
const PARTNERS = (): Tables => ({ business_partners: [{ id: P_T1, legal_name: "Tester1", ico: "12345678", company_id: COMPANY_A }] });

async function say(env: ReturnType<typeof makeDb>, text: string): Promise<IntentResult> {
  const { output } = await runAssistantTurnDetailed(
    { db: env.db, classifyWithAi: async () => null },
    {
      rawText: text,
      locale: "sk",
      userId: env.userId,
      companyId: env.companyId,
      role: "owner",
      financeView: true,
      financeManage: true,
      canOperate: true,
      conversationId: CONV,
      pendingClarification: null,
      structuredPartnerId: null,
      issueDate: "2026-10-11",
      uiContext: null,
      moduleContext: null as never,
      selection: null,
      folderContextId: null,
    }
  );
  return output.result;
}

const missingField = (env: ReturnType<typeof makeDb>) =>
  ((env.state.conversations.get([...env.state.conversations.keys()][0])?.missing_fields ?? []) as string[])[0];
const invoiceCount = (env: ReturnType<typeof makeDb>) => (env.state.tables.invoices ?? []).length;

async function readyForConfirmation() {
  const env = makeDb({ role: "owner", financeManage: true, tables: PARTNERS() });
  await say(env, "Vytvor faktúru pre Tester1.");
  await say(env, "Kopanie 300 eur.");
  const last = await say(env, "23 percent.");
  return { env, last };
}

await check("write: úplné údaje → súhrn + otázka (sumy, partner), ŽIADNY doklad", async () => {
  const { env, last } = await readyForConfirmation();
  assert.equal(last.kind, "clarify", JSON.stringify(last));
  const question = (last as { question: string }).question;
  assert.ok(question.includes("Tester1") && /kopanie/i.test(question) && question.includes("300"), question);
  assert.ok((last as { quickReplies?: unknown[] }).quickReplies?.length === 2, "tlačidlá Áno / Nie");
  assert.equal(missingField(env), "confirm");
  assert.equal(invoiceCount(env), 0);
});

await check("write: nejasná odpoveď / číslo pri potvrdení → otázka znova, žiadny doklad", async () => {
  const { env } = await readyForConfirmation();
  for (const reply of ["hm", "300", "možno"]) {
    const r = await say(env, reply);
    assert.equal(r.kind, "clarify", `${reply}: ${JSON.stringify(r)}`);
    assert.equal(invoiceCount(env), 0, reply);
    assert.equal(missingField(env), "confirm");
  }
});

await check("write: „nie“ → nič sa nevytvorí, dialóg zrušený", async () => {
  const { env } = await readyForConfirmation();
  const r = await say(env, "Nie.");
  assert.notEqual(r.kind, "draft_created");
  assert.equal(invoiceCount(env), 0);
});

await check("write: oprava pri potvrdení → nový súhrn s opravenou sumou, stále bez dokladu", async () => {
  const { env } = await readyForConfirmation();
  const r = await say(env, "Zmeň kopanie na 350 eur.");
  assert.equal(r.kind, "clarify", JSON.stringify(r));
  assert.ok((r as { question: string }).question.includes("350"), (r as { question: string }).question);
  assert.equal(invoiceCount(env), 0);
  assert.equal(missingField(env), "confirm");
});

await check("write: „áno“ → presne jeden draft; zopakované „áno“ (retry) nevytvorí druhý", async () => {
  const { env } = await readyForConfirmation();
  const created = await say(env, "Áno.");
  assert.equal(created.kind, "draft_created", JSON.stringify(created));
  assert.equal(invoiceCount(env), 1);
  const again = await say(env, "Áno.");
  assert.notEqual(again.kind, "draft_created");
  assert.equal(invoiceCount(env), 1, "retry nevytvorí duplicitu");
});

await check("write: nový príkaz počas potvrdenia návrh zahodí (nič nevytvorí)", async () => {
  const { env } = await readyForConfirmation();
  await say(env, "Ukáž sklad.");
  assert.equal(invoiceCount(env), 0);
  const after = await say(env, "Áno.");
  assert.notEqual(after.kind, "draft_created");
  assert.equal(invoiceCount(env), 0);
});

// =============================================================================
// 5. Súkromie / audio
// =============================================================================

await check("privacy: zvuk ani prepis sa nelogujú, žiadne object URL ani súbory v hlasovej ceste", () => {
  for (const file of ["hooks/use-voice-session.ts", "lib/voice/utterance-capture.ts", "lib/voice/assistant-http.ts", "app/api/assistant/transcribe/route.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!/createObjectURL|localStorage|indexedDB|writeFile/.test(source), `${file}: perzistencia zvuku`);
    assert.ok(!/console\.(log|error|warn|info)\([^)]*\b(text|transcript|blob|audio)\b\s*[,)]/.test(source), `${file}: log obsahu`);
  }
  const launcher = readFileSync("app/components/voice/VoiceLauncher.tsx", "utf8");
  assert.ok(!/console\.error\("VoiceLauncher:[^"]*", error\)/.test(launcher), "launcher loguje iba správu chyby");
});

await check("server: OpenAI prepis má časový limit a obmedzené opakovanie; SK prompt pozná IČO/DIČ/IČ DPH/IBAN", () => {
  const route = readFileSync("app/api/assistant/transcribe/route.ts", "utf8");
  // Cost control (2026-10-25): SDK retry 0, timeout z politiky; jedno opakovanie
  // iba pri 429/5xx cez callOpenAiWithCostGuard (nie po timeoute).
  assert.match(route, /timeout: AI_CALL_POLICY\.voiceTranscription\.timeoutMs,[\s\S]*?maxRetries: 0,/);
  assert.match(route, /callOpenAiWithCostGuard\([\s\S]*?maxRetries: AI_CALL_POLICY\.voiceTranscription\.maxRetries/);
  const policy = readFileSync("lib/ai/openai-guard.ts", "utf8");
  assert.match(policy, /voiceTranscription: \{ timeoutMs: 18_000, maxRetries: 1 \}/);
  assert.match(route, /export const maxDuration = \d+;/);
  for (const term of ["IČO", "DIČ", "IČ DPH", "IBAN", "číslo faktúry", "splatnosť"]) assert.ok(route.includes(term), term);
});

await check("lifecycle: MediaRecorder bez udalosti `stop` (Android WebView) → poistka, session nevisí v listening", () => {
  const src = readFileSync("lib/voice/utterance-capture.ts", "utf8");
  assert.match(src, /export const RECORDER_STOP_FALLBACK_MS = \d+;/);
  assert.match(src, /const stopFallback = setTimeout\(deliver, RECORDER_STOP_FALLBACK_MS\);\s*recorder\.onstop = deliver;/);
  assert.match(src, /if \(delivered\) return;\s*delivered = true;\s*clearTimeout\(stopFallback\);/);
});

console.log(`${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
