/**
 * WP-2423 (v15 rush 2026-11-02): a guest told "we couldn't load your cart" with nothing in the logs
 * can't be diagnosed. One line per such answer: a fixed event and error codes, with SQLSTATE or
 * pool codes when the cause has them. Never the request, credentials or cart content.
 */
const codeOf = (error: unknown): string => {
  const raw = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const message = typeof raw?.message === "string" ? raw.message : "";
  const code = raw?.code ?? (/^[A-Z][A-Z0-9_]{2,79}$/u.test(message) ? message : raw?.name);
  return typeof code === "string" && /^[A-Za-z0-9_]{1,80}$/u.test(code) ? code : "UNAVAILABLE";
};
export function logGuestFailure(
  event: string,
  error: unknown,
  write: (line: string) => void = (line) => process.stderr.write(line),
  /** 50: the guest was told it failed; 40: a failure the guest never saw (read again and worked). */
  level: 40 | 50 = 50,
): void {
  try {
    const causes: string[] = [];
    for (
      let at = (error as { cause?: unknown } | null)?.cause;
      at !== undefined && at !== null && causes.length < 4;
      at = (at as { cause?: unknown }).cause
    )
      causes.push(codeOf(at));
    write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        event,
        code: codeOf(error),
        ...(causes.length > 0 ? { causes } : {}),
      }) + "\n",
    );
  } catch {
    /* A log line never changes the guest's answer. */
  }
}
