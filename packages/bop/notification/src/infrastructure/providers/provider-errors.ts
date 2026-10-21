/**
 * Classifies a provider SDK failure. Only an explicit refusal from the provider API (the request
 * reached it and it declined the message) is `Rejected`; a timeout, connection loss, 5xx or any
 * unrecognised error is ambiguous — the message may still go out — and is rethrown so the caller
 * records `Unknown` and never resends blindly (IDR-0027 revision 1).
 */
export function isDefinitiveProviderRefusal(error: unknown, refusals: ReadonlySet<string>) {
  if (error === null || typeof error !== "object") return false;
  const name = Object.getOwnPropertyDescriptor(error, "name")?.value;
  const metadata: unknown = Object.getOwnPropertyDescriptor(error, "$metadata")?.value;
  const status =
    metadata !== null && typeof metadata === "object"
      ? Object.getOwnPropertyDescriptor(metadata, "httpStatusCode")?.value
      : undefined;
  return (
    typeof name === "string" &&
    refusals.has(name) &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500
  );
}

/** Provider message ids are opaque; anything else is not stored (the outcome stays `Unknown`). */
export function providerMessageId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : null;
}

/** Header-safe single line: no CR/LF, control or format characters. */
export function headerSafe(value: string, max: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= max &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}
