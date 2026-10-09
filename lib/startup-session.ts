// =============================================================================
// Štart appky: zistenie session s bezpečným zlyhaním (fix 2026-10-09).
//
// Prvý real-device beh na Androide visel navždy na „Načítavam Esblu…", lebo
// supabase.auth.getSession() zlyhal (chyba secure storage pluginu) a stránka
// čakala iba na úspech. Teraz má štart TRI explicitné výsledky:
//   signed_in  — platná session (z úložiska),
//   signed_out — žiadna session → login,
//   error      — úložisko/klient zlyhal alebo neodpovedal v limite → chybová
//                obrazovka s „Skúsiť znova". Nikdy sa nepredstiera prihlásenie.
// Modul je bez importov (testovateľný v Node).
// =============================================================================

export type StartupSession =
  | { status: "signed_in" }
  | { status: "signed_out" }
  | { status: "error"; reason: string };

export const STARTUP_SESSION_TIMEOUT_MS = 15000;

type GetSessionResult = { data: { session: unknown | null }; error: unknown | null };

function reasonOf(error: unknown): string {
  const raw = (error as { message?: unknown })?.message ?? error;
  const text = typeof raw === "string" ? raw : "unknown";
  return /^[a-z0-9_]{1,64}$/.test(text) ? text : "startup_session_failed";
}

/** Chyba úložiska session (nie bežná „žiadna session"). */
function isStorageError(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null;
  return e?.name === "SecureStorageError" || /secure_storage_|not implemented on/i.test(String(e?.message ?? ""));
}

export async function resolveStartupSession(
  getSession: () => Promise<GetSessionResult>,
  timeoutMs: number = STARTUP_SESSION_TIMEOUT_MS
): Promise<StartupSession> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      getSession(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (result === "timeout") return { status: "error", reason: "startup_session_timeout" };
    if (result.error && isStorageError(result.error)) return { status: "error", reason: reasonOf(result.error) };
    return result.data?.session ? { status: "signed_in" } : { status: "signed_out" };
  } catch (error) {
    return { status: "error", reason: reasonOf(error) };
  } finally {
    clearTimeout(timer);
  }
}
