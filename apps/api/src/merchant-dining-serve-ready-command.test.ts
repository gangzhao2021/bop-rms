import { describe, expect, it, vi } from "vitest";
import {
  createMerchantDiningServeReadyCommand,
  deriveDiningServeLineReference,
  DINING_SERVE_READY_MAX_LINES,
  DiningServeReadyError,
} from "./merchant-dining-serve-ready-command.js";

const id = (n: number) => "0190a7c6-1111-7000-8000-" + n.toString(16).padStart(12, "0");
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const batch = id(1),
  order = id(2);
const session = { sessionCookie: "cookie", csrf: "c".repeat(43) };

interface ProgressItem {
  orderItemReference: string;
  phase: string;
  remainingQuantity: number;
  itemServiceVersion: number;
}
const view = (items: ProgressItem[], extra: Record<string, unknown> = {}) => ({
  orderReference: order,
  orderVersion: 3,
  sessionVersion: 2,
  tableAssignmentVersion: 4,
  sessionPhase: "Active",
  closureStatus: "Open",
  items,
  ...extra,
});
const ready = (n: number, remaining = 2, version = 0): ProgressItem => ({
  orderItemReference: id(n),
  phase: "Ready",
  remainingQuantity: remaining,
  itemServiceVersion: version,
});
const command = (lines: number[], extra: Record<string, unknown> = {}) => ({
  operationReference: batch,
  orderReference: order,
  expectedOrderVersion: 3,
  expectedSessionVersion: 2,
  expectedTableAssignmentVersion: 4,
  lines: lines.map((n) => ({
    orderItemReference: id(n),
    quantity: 2,
    expectedItemServiceVersion: 0,
  })),
  ...extra,
});
function harness(progressViews: unknown[]) {
  const serve = vi.fn<(input: { command: Record<string, unknown> }) => Promise<unknown>>();
  const progress = vi.fn(async () => {
    const next = progressViews.length > 1 ? progressViews.shift() : progressViews[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const execute = createMerchantDiningServeReadyCommand({
    serve: serve as never,
    progress: progress as never,
    retry: (work) => work(),
  });
  return { serve, progress, execute };
}

describe("deriveDiningServeLineReference", () => {
  it("is deterministic per batch and item, UUIDv7-shaped, and keeps the batch timestamp", () => {
    const a = deriveDiningServeLineReference(batch, id(10));
    expect(a).toMatch(uuidV7);
    expect(deriveDiningServeLineReference(batch, id(10))).toBe(a);
    expect(a.slice(0, 13)).toBe(batch.slice(0, 13));
    expect(deriveDiningServeLineReference(batch, id(11))).not.toBe(a);
    expect(deriveDiningServeLineReference(id(3), id(10))).not.toBe(a);
    expect(a).not.toBe(batch);
    for (let n = 0; n < 200; n++)
      expect(deriveDiningServeLineReference(batch, id(1000 + n))).toMatch(uuidV7);
  });
  it("refuses references that are not UUIDv7", () => {
    expect(() => deriveDiningServeLineReference("not-a-reference", id(10))).toThrow(
      DiningServeReadyError,
    );
  });
});

describe("createMerchantDiningServeReadyCommand", () => {
  it("serves every line once with the client's versions and a derived operation reference", async () => {
    const { serve, execute } = harness([view([ready(10), ready(11), ready(12)])]);
    serve.mockResolvedValue({ status: "Created", itemServiceVersion: 1 });
    const result = await execute({ ...session, command: command([10, 11, 12]) });
    expect(result).toEqual({
      operationReference: batch,
      served: 3,
      alreadyServed: 0,
      changed: 0,
      failed: 0,
      lines: [10, 11, 12].map((n) => ({ orderItemReference: id(n), outcome: "Served" })),
    });
    expect(serve).toHaveBeenCalledTimes(3);
    expect(serve.mock.calls[0]?.[0]).toEqual({
      ...session,
      command: {
        operationReference: deriveDiningServeLineReference(batch, id(10)),
        orderReference: order,
        orderItemReference: id(10),
        quantity: 2,
        expectedOrderVersion: 3,
        expectedItemServiceVersion: 0,
        expectedSessionVersion: 2,
        expectedTableAssignmentVersion: 4,
      },
    });
  });

  it("replays the same operations on a retried batch, so nothing is served twice", async () => {
    const { serve, execute } = harness([view([ready(10), ready(11)])]);
    serve.mockResolvedValue({ status: "Created", itemServiceVersion: 1 });
    await execute({ ...session, command: command([10, 11]) });
    serve.mockResolvedValue({ status: "AlreadyCommitted", itemServiceVersion: 1 });
    const retried = await execute({ ...session, command: command([10, 11]) });
    expect(retried.served).toBe(2);
    const operations = serve.mock.calls.map((call) => call[0].command.operationReference);
    expect(operations.slice(2)).toEqual(operations.slice(0, 2));
    expect(new Set(operations).size).toBe(2);
  });

  it("keeps serving after a line fails and says why each line was not served", async () => {
    const before = view([ready(10), ready(11), ready(12), ready(13), ready(14)]);
    const after = view([
      { ...ready(10), phase: "Fulfilled", remainingQuantity: 0, itemServiceVersion: 1 },
      { ...ready(11), phase: "Fulfilled", remainingQuantity: 0, itemServiceVersion: 1 },
      { ...ready(12), phase: "Cancelled" },
      ready(13, 1, 1),
      ready(14),
    ]);
    const { serve, progress, execute } = harness([before, after]);
    serve
      .mockResolvedValueOnce({ status: "Created", itemServiceVersion: 1 })
      .mockRejectedValueOnce(new Error("DINING_SERVE_COMMAND_DENIED"))
      .mockRejectedValueOnce(new Error("DINING_SERVE_COMMAND_DENIED"))
      .mockRejectedValueOnce(new Error("DINING_SERVE_COMMAND_DENIED"))
      .mockRejectedValueOnce(new Error("DINING_ITEM_SERVICE_UNAVAILABLE"));
    const result = await execute({ ...session, command: command([10, 11, 12, 13, 14]) });
    expect(serve).toHaveBeenCalledTimes(5);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(result.lines.map((line) => line.outcome)).toEqual([
      "Served", // this request
      "AlreadyServed", // another device served it meanwhile
      "Changed", // cancelled meanwhile
      "Changed", // partly served elsewhere
      "Failed", // unchanged but not served
    ]);
    expect([result.served, result.alreadyServed, result.changed, result.failed]).toEqual([
      1, 1, 2, 1,
    ]);
  });

  it("reports lines as changed when the table moved or the order was revised", async () => {
    const before = view([ready(10), ready(11)]);
    const { serve, execute } = harness([before, { ...before, orderVersion: 4 }]);
    serve.mockRejectedValue(new Error("DINING_SERVE_COMMAND_DENIED"));
    const result = await execute({ ...session, command: command([10, 11]) });
    expect(result.changed).toBe(2);
  });

  it("reports failed lines when the follow-up read is unavailable", async () => {
    const { serve, execute } = harness([view([ready(10), ready(11)]), new Error("offline")]);
    serve
      .mockResolvedValueOnce({ status: "Created", itemServiceVersion: 1 })
      .mockRejectedValueOnce(new Error("DINING_ITEM_SERVICE_UNAVAILABLE"));
    const result = await execute({ ...session, command: command([10, 11]) });
    expect(result.lines.map((line) => line.outcome)).toEqual(["Served", "Failed"]);
  });

  it("retries a line whose transaction conflicted, with the same operation", async () => {
    const serve = vi.fn<(input: { command: Record<string, unknown> }) => Promise<unknown>>();
    const conflict = Object.assign(new Error("conflict"), {
      code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
    });
    serve
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue({ status: "Created", itemServiceVersion: 1 });
    const execute = createMerchantDiningServeReadyCommand({
      serve: serve as never,
      progress: (async () => view([ready(10)])) as never,
    });
    vi.useFakeTimers();
    try {
      const pending = execute({ ...session, command: command([10]) });
      await vi.runAllTimersAsync();
      expect((await pending).served).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    expect(serve).toHaveBeenCalledTimes(2);
    expect(serve.mock.calls[1]?.[0].command.operationReference).toBe(
      serve.mock.calls[0]?.[0].command.operationReference,
    );
  });

  it("refuses the whole request when the caller may not serve, before any line", async () => {
    const { serve, execute } = harness([new Error("DINING_ORDER_PROGRESS_PERMISSION_DENIED")]);
    await expect(execute({ ...session, command: command([10, 11]) })).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    expect(serve).not.toHaveBeenCalled();
  });

  it("a serving view busy with a database conflict is 'try again', not a refusal", async () => {
    const conflict = Object.assign(new Error("conflict"), {
      code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
    });
    const { serve, execute } = harness([conflict]);
    await expect(execute({ ...session, command: command([10]) })).rejects.toBe(conflict);
    expect(serve).not.toHaveBeenCalled();
  });

  it("answers not found for an order that is not a dine-in order here", async () => {
    const { serve, execute } = harness([null]);
    await expect(execute({ ...session, command: command([10]) })).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(serve).not.toHaveBeenCalled();
  });

  it.each([
    ["no lines", command([])],
    [
      "too many lines",
      command(Array.from({ length: DINING_SERVE_READY_MAX_LINES + 1 }, (_, n) => n + 10)),
    ],
    ["a repeated line", command([10, 10])],
    ["an unknown field", { ...command([10]), actorReference: id(9) }],
    [
      "a zero quantity",
      {
        ...command([10]),
        lines: [{ orderItemReference: id(10), quantity: 0, expectedItemServiceVersion: 0 }],
      },
    ],
    [
      "a quantity over 999",
      {
        ...command([10]),
        lines: [{ orderItemReference: id(10), quantity: 1000, expectedItemServiceVersion: 0 }],
      },
    ],
    ["a malformed batch reference", command([10], { operationReference: "abc" })],
    ["a missing session version", command([10], { expectedSessionVersion: 0 })],
  ])("rejects %s before reading or serving", async (_label, body) => {
    const { serve, progress, execute } = harness([view([ready(10)])]);
    await expect(execute({ ...session, command: body })).rejects.toMatchObject({
      code: "Invalid",
    });
    expect(progress).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("accepts the maximum number of lines", async () => {
    const lines = Array.from({ length: DINING_SERVE_READY_MAX_LINES }, (_, n) => n + 10);
    const { serve, execute } = harness([view(lines.map((n) => ready(n)))]);
    serve.mockResolvedValue({ status: "Created", itemServiceVersion: 1 });
    expect((await execute({ ...session, command: command(lines) })).served).toBe(
      DINING_SERVE_READY_MAX_LINES,
    );
  });
});
