// =============================================================================
// AI usage metering — čisté (bez DB/OpenAI) časti, testované v Node.
//
// GDPR: ACCESS / COST TELEMETRY ONLY — NO CONTENT LOGGING.
// Z odpovede OpenAI sa číta VÝHRADNE objekt `usage` (počty tokenov / sekúnd).
// Nikdy sa nečíta ani neposiela ďalej output_text, transcript, prompt,
// obrázok, audio ani nič z požiadavky používateľa. Záznam nemá žiadne pole
// pre voľný text — iba enum flowu, model z allowlistu a čísla.
// =============================================================================

export const AI_FLOW_TYPES = [
  "document_scan",
  "document_scan_plate_fallback",
  "vehicle_document_scan",
  "vehicle_document_plate_fallback",
  "vehicle_registration_scan",
  "voice_transcription",
  "intent_classification_fallback",
] as const;
export type AiFlowType = (typeof AI_FLOW_TYPES)[number];

/** Modely, ktoré appka reálne volá (kód RC). Iný reťazec sa nezapíše. */
export const METERED_MODELS = ["gpt-5.6-terra", "gpt-4.1", "gpt-4.1-mini", "gpt-4o-transcribe"] as const;
export type MeteredModel = (typeof METERED_MODELS)[number];

export type AiUsageNumbers = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  audioInputTokens: number;
  audioSeconds: number;
};

/** Čo sa meria — bez firmy/používateľa (tie určuje MeterScope). */
export type AiUsageRecord = {
  flow: AiFlowType;
  model: MeteredModel;
  outcome: "success" | "failure";
  usage: AiUsageNumbers;
  imageCount: number;
  /** Počet dodatočných pokusov (attempts − 1). */
  retryCount: number;
};

/**
 * Komu sa usage pripíše (company scoping, fail closed):
 *   - reservation: AI sken — firmu aj používateľa odvodí DB z AI rezervácie
 *     (ai_processing_usage), server company_id vôbec neposiela,
 *   - member: hlas / intent fallback — aktívna firma zo serverom overeného
 *     členstva; DB ešte raz overí aktívne členstvo. user_id sa neukladá.
 */
export type MeterScope =
  | { kind: "reservation"; usageId: string }
  | { kind: "member"; companyId: string; userId: string };

export const RESERVATION_FLOWS: readonly AiFlowType[] = [
  "document_scan",
  "document_scan_plate_fallback",
  "vehicle_document_scan",
  "vehicle_document_plate_fallback",
  "vehicle_registration_scan",
];

export function reservationMeterScope(usageId: string): MeterScope {
  return { kind: "reservation", usageId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ZERO_USAGE: AiUsageNumbers = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioInputTokens: 0, audioSeconds: 0 };

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Responses API: `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, `usage.output_tokens`. */
export function usageFromResponse(response: unknown): AiUsageNumbers {
  const usage = response && typeof response === "object" ? (response as { usage?: unknown }).usage : null;
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  const u = usage as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } | null };
  return {
    inputTokens: count(u.input_tokens),
    cachedInputTokens: count(u.input_tokens_details?.cached_tokens),
    outputTokens: count(u.output_tokens),
    audioInputTokens: 0,
    audioSeconds: 0,
  };
}

/** Transcriptions API: `usage` typu `tokens` (vrátane audio tokenov) alebo `duration` (sekundy). */
export function usageFromTranscription(transcription: unknown): AiUsageNumbers {
  const usage = transcription && typeof transcription === "object" ? (transcription as { usage?: unknown }).usage : null;
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  const u = usage as {
    type?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_token_details?: { audio_tokens?: unknown } | null;
    seconds?: unknown;
  };
  if (u.type === "duration") {
    const seconds = typeof u.seconds === "number" && Number.isFinite(u.seconds) && u.seconds > 0 ? Math.min(u.seconds, 86_400) : 0;
    return { ...ZERO_USAGE, audioSeconds: Math.round(seconds * 1000) / 1000 };
  }
  return {
    inputTokens: count(u.input_tokens),
    cachedInputTokens: 0,
    outputTokens: count(u.output_tokens),
    audioInputTokens: count(u.input_token_details?.audio_tokens),
    audioSeconds: 0,
  };
}

export type UsageRpcName = "esblu_record_ai_usage" | "esblu_record_ai_usage_for_reservation";
export type UsageRpcCall = { fn: UsageRpcName; args: Record<string, string | number> };

/**
 * Jediné miesto, kde vzniká tvar zápisu usage. null = neplatný záznam alebo
 * scope → nič sa neodošle (fail closed). Žiadne pole pre voľný text.
 */
export function buildUsageRpcCall(scope: MeterScope | null, record: AiUsageRecord): UsageRpcCall | null {
  if (!scope) return null;
  if (!(AI_FLOW_TYPES as readonly string[]).includes(record.flow)) return null;
  if (!(METERED_MODELS as readonly string[]).includes(record.model)) return null;
  if (record.outcome !== "success" && record.outcome !== "failure") return null;
  const numbers = {
    p_input_tokens: count(record.usage.inputTokens),
    p_cached_input_tokens: count(record.usage.cachedInputTokens),
    p_output_tokens: count(record.usage.outputTokens),
    p_image_count: Math.min(count(record.imageCount), 100),
    p_retry_count: Math.min(count(record.retryCount), 10),
  };
  const base = { p_flow_type: record.flow, p_model: record.model, p_outcome: record.outcome };
  if (scope.kind === "reservation") {
    if (!UUID.test(scope.usageId) || !RESERVATION_FLOWS.includes(record.flow)) return null;
    return { fn: "esblu_record_ai_usage_for_reservation", args: { p_ai_usage_id: scope.usageId, ...base, ...numbers } };
  }
  if (!UUID.test(scope.companyId) || !UUID.test(scope.userId)) return null;
  return {
    fn: "esblu_record_ai_usage",
    args: {
      p_company_id: scope.companyId,
      p_user_id: scope.userId,
      ...base,
      ...numbers,
      p_audio_input_tokens: count(record.usage.audioInputTokens),
      p_audio_seconds: Math.max(0, Math.min(record.usage.audioSeconds || 0, 86_400)),
    },
  };
}

export type UsageRpc = (fn: UsageRpcName, args: Record<string, string | number>) => Promise<{ data: unknown; error: unknown }>;

/** Zapíše usage; nikdy nehádže a nikdy neblokuje používateľský flow. */
export async function recordAiUsageWith(rpc: UsageRpc, scope: MeterScope | null, record: AiUsageRecord): Promise<boolean> {
  const call = buildUsageRpcCall(scope, record);
  if (!call) return false;
  try {
    const { data, error } = await rpc(call.fn, call.args);
    return !error && data === true;
  } catch {
    return false;
  }
}
