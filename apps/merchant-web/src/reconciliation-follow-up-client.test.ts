import { expect, it, vi } from "vitest";
import {
  createReconciliationFollowUpClient,
  parseFollowUpView,
} from "./reconciliation-follow-up-client.js";
const id = (n: number) => "0190fa82-0000-7000-8000-" + String(n).padStart(12, "0"),
  csrf = "a".repeat(43),
  at = "2026-09-21T00:00:00.000Z";
const command = () => ({
  exceptionReference: id(1),
  operationReference: id(2),
  expectedVersion: 1,
  action: "Acknowledge" as const,
  assigneeReference: null,
});
const result = {
  status: "FollowUpRecorded",
  replayed: false,
  version: 2,
  followUpStatus: "Acknowledged",
  updatedAt: at,
};
const response = (body: unknown, status = 202) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("uses protected POST and reads bounded owner version", async () => {
  const model = {
    version: 1,
    followUpStatus: "Open",
    acknowledged: false,
    assigned: false,
    updatedAt: at,
  };
  const fetcher = vi.fn<typeof fetch>(async () => response(model, 200));
  expect(await createReconciliationFollowUpClient(fetcher).query(id(1), csrf)).toEqual(model);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/operations/order-exceptions/follow-up-query",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ exceptionReference: id(1) }),
    }),
  );
});
it("freezes same request across unknown result retries", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(response({ ...result, replayed: true }));
  const input = command(),
    prepared = createReconciliationFollowUpClient(fetcher).prepare(input);
  input.operationReference = id(99);
  input.expectedVersion = 10;
  await expect(prepared.execute(csrf)).rejects.toThrow("UNKNOWN");
  expect(await prepared.execute(csrf)).toMatchObject({ replayed: true, version: 2 });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain(id(2));
});
it.each([
  [409, "reconciliation_follow_up_conflict", "CONFLICT"],
  [403, "request_denied", "DENIED"],
  [400, "reconciliation_follow_up_invalid", "INVALID"],
] as const)("distinguishes definitive %s", async (status, error, kind) => {
  const c = createReconciliationFollowUpClient(async () => response({ error }, status));
  await expect(c.prepare(command()).execute(csrf)).rejects.toThrow(kind);
});
it("rejects malformed states, success version and unintended fields", async () => {
  expect(() =>
    parseFollowUpView({
      version: 1,
      followUpStatus: "Open",
      assigned: true,
      acknowledged: false,
      updatedAt: at,
    }),
  ).toThrow();
  const c = createReconciliationFollowUpClient(async () => response({ ...result, version: 7 }));
  await expect(c.prepare(command()).execute(csrf)).rejects.toThrow("UNKNOWN");
  expect(() =>
    c.prepare({ ...command(), actorReference: id(9) } as ReturnType<typeof command>),
  ).toThrow();
});
it("does not dispatch pre-aborted or malformed CSRF requests", async () => {
  const fetcher = vi.fn<typeof fetch>(),
    prepared = createReconciliationFollowUpClient(fetcher).prepare(command()),
    abort = new AbortController();
  abort.abort();
  await expect(prepared.execute(csrf, abort.signal)).rejects.toThrow();
  await expect(prepared.execute("bad")).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("sends self-assignment without an employee identity and requires Assigned result", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    response({ ...result, followUpStatus: "Assigned" }),
  );
  const client = createReconciliationFollowUpClient(fetcher);
  await client.prepare({ ...command(), action: "AssignSelf" }).execute(csrf);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
    action: "AssignSelf",
    assigneeReference: null,
  });
  expect(() =>
    client.prepare({ ...command(), action: "AssignSelf", assigneeReference: id(9) }),
  ).toThrow();
  fetcher.mockResolvedValue(response(result));
  await expect(
    client.prepare({ ...command(), action: "AssignSelf" }).execute(csrf),
  ).rejects.toThrow("UNKNOWN");
});

it("reads a closed capture evidence summary without private identifiers", async () => {
  const evidence = {
    amountMinor: "2260",
    currencyCode: "CAD",
    environment: "Test",
    occurredAt: "2026-09-20T03:35:37.236Z",
    observedAt: at,
    recordedReason: "ProviderCaptureWithoutInternalOperation",
  };
  const fetcher = vi.fn<typeof fetch>(async () => response({ evidence }, 200));
  const c = createReconciliationFollowUpClient(fetcher);
  expect(await c.evidence(id(1), csrf)).toEqual(evidence);
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "/merchant/operations/order-exceptions/follow-up-evidence",
  );
  fetcher.mockResolvedValueOnce(response({ evidence: null }, 200));
  expect(await c.evidence(id(1), csrf)).toBeNull();
  for (const invalid of [
    { ...evidence, amountMinor: "0" },
    { ...evidence, providerReference: "private" },
    { ...evidence, observedAt: "2026-01-01T00:00:00.000Z" },
  ]) {
    fetcher.mockResolvedValueOnce(response({ evidence: invalid }, 200));
    await expect(c.evidence(id(1), csrf)).rejects.toThrow("UNKNOWN");
  }
});

it("loads bounded employee pages and rejects unintended identity fields", async () => {
  const items = Array.from({ length: 25 }, (_, n) => ({
    actorReference: id(n + 10),
    label: "Employee " + "x".repeat(70),
  }));
  const fetcher = vi.fn<typeof fetch>(async () =>
    response({ items, nextAfterActorReference: id(34) }, 200),
  );
  const client = createReconciliationFollowUpClient(fetcher);
  expect((await client.assignees(id(1), null, csrf)).items).toHaveLength(25);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/operations/order-exceptions/follow-up-assignees",
    expect.objectContaining({
      body: JSON.stringify({ exceptionReference: id(1), afterActorReference: null }),
      credentials: "same-origin",
      cache: "no-store",
    }),
  );
  for (const invalid of [
    { items: [...items, items[0]], nextAfterActorReference: null },
    { items: [items[0], items[0]], nextAfterActorReference: null },
    {
      items: [{ actorReference: id(2), label: "Name", email: "hidden" }],
      nextAfterActorReference: null,
    },
    { items: [], nextAfterActorReference: "bad" },
  ]) {
    fetcher.mockResolvedValueOnce(response(invalid, 200));
    await expect(client.assignees(id(1), null, csrf)).rejects.toThrow("UNKNOWN");
  }
  fetcher.mockResolvedValueOnce(response({ items: [], nextAfterActorReference: id(34) }, 200));
  expect(await client.assignees(id(1), id(33), csrf)).toEqual({
    items: [],
    nextAfterActorReference: id(34),
  });
});
