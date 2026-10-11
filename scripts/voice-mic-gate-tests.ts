// =============================================================================
// Mikrofón Esblu v poli hľadania — kedy je viditeľný a ako (2026-10-11).
//
// SPUSTENIE
//   npm run test:voice-mic-gate
//
// Regresia z reálneho telefónu (build 2026-10-11T17:36:58Z): owner firmy
// v triali nevidel mikrofón vôbec — VoiceSessionControl vracal `null`, keď
// firma nemala nárok `voice` (hlas nie je súčasťou trialu), a rovnako počas
// načítania a pri chybe nárokov. Natívne QA sa preto nedalo ani začať.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { micGate } = await import("@/lib/voice/mic-gate");
const { voiceTranscriptionAllowed } = await import("@/lib/intents/permissions");
const { INITIAL_VOICE_SESSION, voiceSessionReducer } = await import("@/lib/voice/voice-session");
const { fetchJsonWithTimeout } = await import("@/lib/voice/assistant-http");
const { isOpenAiConfigured } = await import("@/lib/ai/openai-runtime");
const { translate } = await import("@/lib/i18n/translate");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const control = read("app/components/voice/VoiceSessionControl.tsx");
const dashboard = read("app/components/Dashboard.tsx");

const base = {
  sessionActive: false,
  membershipLoading: false,
  roleAllowsVoice: true,
  entitlementsLoading: false,
  entitlementsError: false,
  hasVoiceEntitlement: true,
};

console.log("\nPravidlá zobrazenia");

await check("eligible owner + voice entitlement → mikrofón aktívny (ready)", () => {
  assert.equal(voiceTranscriptionAllowed("owner"), true);
  assert.equal(micGate({ ...base, roleAllowsVoice: voiceTranscriptionAllowed("owner") }), "ready");
  assert.equal(micGate({ ...base, roleAllowsVoice: voiceTranscriptionAllowed("admin") }), "ready");
});

await check("nároky sa načítavajú → stabilné miesto (pending), nie zmiznutie", () => {
  assert.equal(micGate({ ...base, entitlementsLoading: true, hasVoiceEntitlement: false }), "pending");
  assert.equal(micGate({ ...base, membershipLoading: true }), "pending");
});

await check("chyba nárokov → „unavailable“ (ťuknutie = skúsiť znova), relácia sa nespustí", () => {
  assert.equal(micGate({ ...base, entitlementsError: true, hasVoiceEntitlement: false }), "unavailable");
  assert.match(control, /if \(gate === "unavailable"\) entitlements\.retry\(\);/);
});

await check("bez nároku voice (trial) → zámok + vysvetlenie + „Požiadať o aktiváciu“, nie null", () => {
  assert.equal(micGate({ ...base, hasVoiceEntitlement: false }), "locked");
  assert.ok(!/if \(!active && !entitlements\.has\("voice"\)\) return null;/.test(control), "pôvodné tiché skrytie odstránené");
  assert.match(control, /\{gate === "locked" && <LockBadge \/>\}/);
  assert.match(dashboard, /onGateNotice=\{setVoiceGateNotice\}/);
  assert.match(dashboard, /voiceGateNotice === "locked" && \(\s*<button type="button" onClick=\{\(\) => router\.push\("\/kontakt"\)\}/);
});

await check("zamknutý / čakajúci mikrofón NIKDY nespustí reláciu (žiadne onTap)", () => {
  const gateBlock = control.slice(control.indexOf('if (gate !== "ready") {'), control.indexOf("  return (\n    <span"));
  assert.ok(gateBlock.length > 0);
  assert.ok(!gateBlock.includes("onTap"), "gate tlačidlo nevolá onTap");
  assert.match(gateBlock, /if \(gate === "pending"\) return;/);
});

await check("rola bez hlasu (employee) → mikrofón sa nezobrazí (politika rolí bez zmeny)", () => {
  assert.equal(voiceTranscriptionAllowed("employee"), false);
  assert.equal(micGate({ ...base, roleAllowsVoice: false }), "hidden");
  assert.equal(micGate({ ...base, roleAllowsVoice: false, hasVoiceEntitlement: false }), "hidden");
});

await check("bežiaca relácia sa dá vždy ukončiť (aj keby nárok medzičasom zmizol)", () => {
  assert.equal(micGate({ ...base, sessionActive: true, hasVoiceEntitlement: false, entitlementsError: true }), "ready");
});

await check("platforma: žiadna detekcia natívnej appky / webu v rozhodnutí (Android native aj web rovnako)", () => {
  const gateSource = read("lib/voice/mic-gate.ts");
  for (const src of [control, gateSource]) {
    assert.ok(!/Capacitor|isNativePlatform|getPlatform|navigator\.userAgent|isMobileBuild/.test(src));
  }
  // Dashboard renderuje ovládanie bez podmienky; rozhoduje iba mic-gate.
  assert.match(dashboard, /<\/button>\s*\)\}\s*<VoiceSessionControl\s+variant="icon"/);
});

console.log("\nRozloženie v poli hľadania");

await check("pole: input sa zmršťuje (min-w-0), mikrofón aj „x“ majú pevnú veľkosť (shrink-0, 32 px), neprekrývajú sa", () => {
  const row = dashboard.slice(dashboard.indexOf('<div className="mt-3 flex min-h-10 shrink-0 items-center gap-2'), dashboard.indexOf("onGateNotice={setVoiceGateNotice}"));
  assert.match(row, /className="dash-search-input w-full min-w-0/);
  assert.match(row, /className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full/, "clear button 32 px shrink-0");
  assert.ok(row.indexOf("clearSearch") < row.indexOf("<VoiceSessionControl"), "poradie: input → x → mikrofón");
  assert.ok(!/absolute/.test(row.slice(row.indexOf("<input"), row.indexOf("<VoiceSessionControl"))), "žiadne absolútne prekrytie");
  assert.match(control, /relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full/);
});

await check("focus + klávesnica mikrofón neskryjú (žiadna podmienka na focus/klávesnicu)", () => {
  const row = dashboard.slice(dashboard.indexOf('<div className="mt-3 flex min-h-10 shrink-0 items-center gap-2'), dashboard.indexOf("onGateNotice={setVoiceGateNotice}"));
  assert.ok(!/keyboardOpen|isFocused|onFocus|onBlur/.test(row));
  assert.ok(!/(hidden|invisible|sr-only)/.test(control.slice(control.indexOf("data-voice-gate"), control.indexOf("<MicGlyph />"))));
});

await check("stavy ikony: idle / listening (pulz) / processing (spinner) / error (tlmená červená) / locked (zámok)", () => {
  assert.match(control, /animate-ping rounded-full border border-danger\/40/);
  assert.match(control, /\{processing \? <SpinnerGlyph \/> : <MicGlyph \/>\}/);
  assert.match(control, /border-danger\/35 text-danger\/80/);
  assert.match(control, /function LockBadge\(\)/);
});

console.log("\nStaging s vypnutou AI");

await check("AI vypnutá: mikrofón sa dá spustiť (natívny tok nezávisí od servera), prepis skončí 503 → jasné ukončenie", async () => {
  // gate nepozerá na AI konfiguráciu
  assert.ok(!/OPENAI|aiUnavailable/.test(read("lib/voice/mic-gate.ts")));
  let s = voiceSessionReducer(INITIAL_VOICE_SESSION, { type: "START" }).state;
  assert.equal(s.status, "starting", "štart → mikrofón (povolenie)");
  s = voiceSessionReducer(s, { type: "MIC_READY", gen: s.gen }).state;
  assert.equal(s.status, "listening");
  s = voiceSessionReducer(s, { type: "UTTERANCE_CAPTURED", gen: s.gen }).state;
  const res = await fetchJsonWithTimeout("/api/assistant/transcribe", {}, {
    timeoutMs: 1000,
    isOnline: () => true,
    fetchImpl: async () => new Response(JSON.stringify({ success: false, code: "AI_UNAVAILABLE" }), { status: 503 }),
  });
  assert.equal(!res.ok && res.kind, "unavailable");
  const end = voiceSessionReducer(s, { type: "TRANSCRIBE_FAILED", kind: "unavailable", gen: s.gen });
  assert.equal(end.state.status, "stopped");
  assert.equal(end.state.noticeKey, "aiUnavailable");
  assert.equal(isOpenAiConfigured({ OPENAI_API_KEY: "preview-disabled" }), false);
  const route = read("app/api/assistant/transcribe/route.ts");
  assert.ok(route.indexOf("guardTranscription") < route.indexOf("const client = getClient();"), "nárok/rola sa overia pred 503");
});

await check("i18n: texty stavov mikrofónu existujú v sk/en/de", () => {
  for (const locale of ["sk", "en", "de"] as const) {
    for (const key of ["pending", "locked", "unavailable", "lockedNotice", "unavailableNotice"]) {
      const full = `search.voice.gate.${key}`;
      const value = translate(locale, full);
      assert.ok(value && value !== full, `${locale}: ${full}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
