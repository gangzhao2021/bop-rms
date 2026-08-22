export const browserRequestTimeoutMs = 15_000;

export async function boundedFetch(
  request: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = browserRequestTimeoutMs,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > browserRequestTimeoutMs)
    throw new TypeError("invalid browser request timeout");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}
