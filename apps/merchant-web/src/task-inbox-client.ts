import { parseTaskInboxFilters, type TaskInboxFilters } from "./task-inbox-filters.js";
export type TaskInboxClientErrorCode =
  "PermissionDenied" | "NotFound" | "FeatureDisabled" | "Unavailable";

export class TaskInboxClientError extends Error {
  constructor(readonly code: TaskInboxClientErrorCode) {
    super("TASK_INBOX_UNAVAILABLE");
    this.name = "TaskInboxClientError";
  }
}

const fail = (code: TaskInboxClientErrorCode = "Unavailable"): never => {
  throw new TaskInboxClientError(code);
};

export function createTaskInboxClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    async load(
      afterTaskReference: string | null = null,
      signal?: AbortSignal,
      filters?: TaskInboxFilters,
    ) {
      const filterHeader =
        filters === undefined ? null : JSON.stringify(parseTaskInboxFilters(filters));
      if (
        afterTaskReference !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          afterTaskReference,
        )
      )
        fail();
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
            ...(filterHeader === null ? {} : { "X-Bop-Task-Filters": filterHeader }),
            ...(afterTaskReference === null ? {} : { "X-Bop-Task-After": afterTaskReference }),
          },
        });
        if (response.status === 401 || response.status === 403) fail("PermissionDenied");
        if (response.status === 404) fail("NotFound");
        if (response.status === 503) fail();
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          fail();
        const text = await response.text();
        if (controller.signal.aborted || text.length > 262144) fail();
        return JSON.parse(text) as unknown;
      } catch (error) {
        if (error instanceof TaskInboxClientError) throw error;
        fail();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}
