export function createTaskInboxClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    async load(afterTaskReference: string | null = null, signal?: AbortSignal) {
      if (
        afterTaskReference !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          afterTaskReference,
        )
      )
        throw new Error("TASK_INBOX_UNAVAILABLE");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetcher("/merchant/tasks", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(afterTaskReference === null ? {} : { "X-Bop-Task-After": afterTaskReference }),
          },
        });
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          throw new Error("TASK_INBOX_UNAVAILABLE");
        const text = await response.text();
        if (controller.signal.aborted || text.length > 262144)
          throw new Error("TASK_INBOX_UNAVAILABLE");
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("TASK_INBOX_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}
