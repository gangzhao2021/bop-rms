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

/**
 * A whole JSON answer within the deadline: `boundedFetch` stops timing once the headers arrive, so a
 * body that stalls would otherwise leave the page waiting for ever. Rejects when the deadline passes;
 * an answer that isn't JSON has a null payload.
 */
export async function boundedJsonFetch(
  request: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = browserRequestTimeoutMs,
): Promise<{ readonly response: Response; readonly payload: unknown }> {
  const started = Date.now();
  const response = await boundedFetch(request, input, init, timeoutMs);
  const left = Math.max(1, timeoutMs - (Date.now() - started));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      reject(new DOMException("The answer did not finish in time.", "TimeoutError"));
    }, left);
  });
  try {
    const body = response.text().then((text): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    });
    return { response, payload: await Promise.race([body, deadline]) };
  } finally {
    clearTimeout(timer);
  }
}
