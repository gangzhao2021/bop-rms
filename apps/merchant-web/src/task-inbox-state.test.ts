import { expect, it, vi } from "vitest";
import { createTaskInboxController, parseTaskInboxView } from "./task-inbox-state.js";
const id = (n: number) => "0190fad6-0000-7000-8000-" + String(n).padStart(12, "0");
const fixture = (n = 1) => ({
  screenId: "TASK-INBOX",
  storeLabel: "Synthetic Store",
  observedAt: "2026-09-20T00:00:00.000Z",
  items: [
    {
      taskReference: id(n),
      version: 2,
      taskType: "DINING_UNPAID_BATCH_EXCEPTION",
      severity: "CRITICAL",
      priority: "CRITICAL",
      status: "Assigned",
      ownerStatus: "Unclaimed",
      dueAt: "2026-09-20T01:00:00.000Z",
      sourceType: "DINING_SESSION",
      sourceReference: id(9),
      canClaim: true,
    },
  ],
  nextAfterTaskReference: null as string | null,
});
it("accepts exact immutable fields and a source-trimmed empty page with continuation", () => {
  const view = parseTaskInboxView(fixture());
  expect(Object.isFrozen(view.items[0])).toBe(true);
  expect(
    parseTaskInboxView({ ...fixture(), items: [], nextAfterTaskReference: id(1) }).items,
  ).toEqual([]);
});
it.each([
  { ...fixture(), privateData: "not allowed" },
  { ...fixture(), items: [...fixture().items, ...fixture().items] },
  {
    ...fixture(),
    items: [
      { ...fixture().items[0], status: "Claimed", ownerStatus: "ClaimedByYou", canClaim: true },
    ],
  },
  { ...fixture(), items: [{ ...fixture().items[0], ownerStatus: "ClaimedByStaff" }] },
  { ...fixture(2), nextAfterTaskReference: id(1) },
])("rejects unexpected fields and inconsistent state %#", (value) => {
  expect(() => parseTaskInboxView(value)).toThrow("TASK_INBOX_INVALID");
});
it("uses continuation for next page and starts refresh from the beginning", async () => {
  const client = {
    load: vi
      .fn()
      .mockResolvedValueOnce({ ...fixture(), nextAfterTaskReference: id(1) })
      .mockResolvedValueOnce(fixture(2))
      .mockResolvedValueOnce(fixture()),
  };
  const controller = createTaskInboxController(client, "store-a");
  await controller.refresh();
  await controller.next();
  expect(client.load.mock.calls[1]?.[0]).toBe(id(1));
  expect(controller.getSnapshot().view?.items[0]?.taskReference).toBe(id(2));
  await controller.refresh();
  expect(client.load.mock.calls[2]?.[0]).toBeNull();
});
it("aborts and discards a prior Store response after context changes", async () => {
  let deliver: (value: unknown) => void = () => {
    throw new Error("Pending request not initialized");
  };
  const client = {
      load: vi.fn((after?: string | null, signal?: AbortSignal) => {
        expect(after).toBeNull();
        expect(signal?.aborted).toBe(false);
        return new Promise((resolve) => {
          deliver = resolve;
        });
      }),
    },
    controller = createTaskInboxController(client, "store-a");
  const pending = controller.refresh();
  controller.setContext("store-b");
  expect(client.load.mock.calls[0]?.[1]?.aborted).toBe(true);
  deliver(fixture());
  await pending;
  expect(controller.getSnapshot()).toMatchObject({ kind: "Idle", view: null, readOnly: true });
});
it("keeps same-context offline snapshot read-only and clears it on Store switch", async () => {
  const client = { load: vi.fn().mockResolvedValue(fixture()) },
    controller = createTaskInboxController(client, "store-a");
  await controller.refresh();
  controller.setOnline(false);
  expect(controller.getSnapshot()).toMatchObject({ kind: "Offline", readOnly: true });
  await controller.refresh();
  expect(client.load).toHaveBeenCalledTimes(1);
  controller.setContext("store-b");
  expect(controller.getSnapshot().view).toBeNull();
});
it("hides stale data on failed refresh and stops new reads after disposal", async () => {
  const client = {
      load: vi.fn().mockResolvedValueOnce(fixture()).mockRejectedValueOnce(new Error("private")),
    },
    controller = createTaskInboxController(client, "store-a");
  await controller.refresh();
  await controller.refresh();
  expect(controller.getSnapshot()).toEqual({ kind: "Unavailable", view: null, readOnly: true });
  controller.dispose();
  await controller.refresh();
  expect(client.load).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().kind).toBe("Disposed");
});
it("rejects nonadvancing pagination", async () => {
  const client = {
      load: vi.fn().mockResolvedValue({ ...fixture(), nextAfterTaskReference: id(1) }),
    },
    controller = createTaskInboxController(client, "store-a");
  await controller.refresh();
  await controller.next();
  expect(controller.getSnapshot().kind).toBe("Unavailable");
});
