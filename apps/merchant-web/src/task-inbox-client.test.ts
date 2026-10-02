import { expect, it, vi } from "vitest";
import { parseTaskInboxFilters } from "./task-inbox-filters.js";
import { createTaskInboxClient, TaskInboxClientError } from "./task-inbox-client.js";
it("uses only the same-origin BFF and never sends scope or credentials in a URL", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('{"items":[]}', {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  expect(await createTaskInboxClient(fetcher).load()).toEqual({ items: [] });
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/tasks",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      method: "GET",
    }),
  );
});
it.each([
  new Response("private-denial", { status: 403 }),
  new Response("{}", { headers: { "content-type": "application/json" } }),
  new Response("private-html", {
    headers: { "content-type": "text/html", "cache-control": "no-store" },
  }),
])("rejects denied or cacheable/unexpected responses with a safe error", async (response) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  await expect(createTaskInboxClient(fetcher).load()).rejects.toThrow("TASK_INBOX_UNAVAILABLE");
});
it.each([
  [403, "PermissionDenied"],
  [404, "NotFound"],
  [503, "Unavailable"],
] as const)("maps HTTP %s to the bounded Task Inbox state", async (status, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private", { status }));
  await expect(createTaskInboxClient(fetcher).load()).rejects.toMatchObject({
    name: "TaskInboxClientError",
    code,
  } satisfies Partial<TaskInboxClientError>);
});
it("propagates context cancellation and discards a late response", async () => {
  const context = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    context.abort();
    expect(options?.signal?.aborted).toBe(true);
    return new Response("{}", {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  });
  await expect(createTaskInboxClient(fetcher).load(null, context.signal)).rejects.toThrow(
    "TASK_INBOX_UNAVAILABLE",
  );
});

it("retains the response-size bound", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(" ".repeat(262145), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  await expect(createTaskInboxClient(fetcher).load()).rejects.toThrow("TASK_INBOX_UNAVAILABLE");
});

it("sends only a validated continuation header, never a task reference in the URL", async () => {
  const after = "0190fad5-0000-7000-8000-000000000001";
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response("{}", {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  await createTaskInboxClient(fetcher).load(after);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/tasks",
    expect.objectContaining({ headers: { Accept: "application/json", "X-Bop-Task-After": after } }),
  );
  await expect(createTaskInboxClient(fetcher).load("invalid")).rejects.toThrow(
    "TASK_INBOX_UNAVAILABLE",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("transports a closed masked filter header on the same URL with no actor identity", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response("{}", {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  const filters = parseTaskInboxFilters({
    status: "Claimed",
    taskType: "DINING_UNPAID_BATCH_EXCEPTION",
    severityCode: "CRITICAL",
    exactReference: "0190fad5-0000-7000-8000-000000000001",
    ownerStatus: "ClaimedByYou",
    overdue: true,
  });
  await createTaskInboxClient(fetcher).load(null, undefined, filters);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/tasks",
    expect.objectContaining({
      headers: {
        Accept: "application/json",
        "X-Bop-Task-Filters": JSON.stringify(filters),
      },
    }),
  );
});
it.each([
  null,
  [],
  Object.create(null),
  { actorReference: "foreign" },
  { storeReference: "foreign" },
  { ownerStatus: "employee@example.invalid" },
  { status: "Completed" },
  { overdue: "true" },
  { exactReference: "not-a-reference" },
  { taskType: "name text" },
  { severityCode: "x' OR TRUE --" },
  { taskType: "A".repeat(97) },
  { [Symbol("secret")]: true },
])("rejects unsafe browser filter values before any network read %#", async (value) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(() => parseTaskInboxFilters(value)).toThrow("TASK_INBOX_UNAVAILABLE");
  await expect(
    createTaskInboxClient(fetcher).load(
      null,
      undefined,
      value as ReturnType<typeof parseTaskInboxFilters>,
    ),
  ).rejects.toThrow("TASK_INBOX_UNAVAILABLE");
  expect(fetcher).not.toHaveBeenCalled();
});
it("copies caller selections immutably without executing accessors", () => {
  const value = { severityCode: "CRITICAL", overdue: false };
  const parsed = parseTaskInboxFilters(value);
  value.severityCode = "LOW";
  expect(parsed.severityCode).toBe("CRITICAL");
  expect(Object.isFrozen(parsed)).toBe(true);
  const getter = vi.fn(() => "Assigned");
  expect(() =>
    parseTaskInboxFilters(Object.defineProperty({}, "status", { enumerable: true, get: getter })),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
