import { expect, it, vi } from "vitest";
import { TaskInboxClientError } from "./task-inbox-client.js";
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
    items: [{ ...fixture().items[0], sourceReference: id(9) }],
  },
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

it("preserves bounded permission and feature gate states from the BFF", async () => {
  const permissionDenied = createTaskInboxController(
      {
        load: async () => {
          throw new TaskInboxClientError("PermissionDenied");
        },
      },
      "store-a",
    ),
    featureDisabled = createTaskInboxController(
      {
        load: async () => {
          throw new TaskInboxClientError("FeatureDisabled");
        },
      },
      "store-a",
    );
  await permissionDenied.refresh();
  await featureDisabled.refresh();
  expect(permissionDenied.getSnapshot().kind).toBe("PermissionDenied");
  expect(featureDisabled.getSnapshot().kind).toBe("FeatureDisabled");
});

it("resets the cursor and propagates the same filters across subsequent pages", async () => {
  const lower = (n: number) => ({
    ...fixture(n),
    items: fixture(n).items.map((item) => ({ ...item, severity: "LOW" })),
  });
  const client = {
    load: vi
      .fn()
      .mockResolvedValueOnce({ ...fixture(), nextAfterTaskReference: id(1) })
      .mockResolvedValueOnce({ ...lower(2), nextAfterTaskReference: id(2) })
      .mockResolvedValueOnce(lower(3)),
  };
  const controller = createTaskInboxController(client, "store-a");
  await controller.refresh();
  controller.setFilters({ severityCode: "LOW" });
  expect(controller.getSnapshot()).toMatchObject({ kind: "Idle", view: null, readOnly: true });
  await controller.next();
  expect(client.load).toHaveBeenCalledTimes(1);
  await controller.refresh();
  expect(client.load.mock.calls[1]?.[0]).toBeNull();
  expect(client.load.mock.calls[1]?.[2]).toMatchObject({ severityCode: "LOW" });
  await controller.next();
  expect(client.load.mock.calls[2]?.[0]).toBe(id(2));
  expect(client.load.mock.calls[2]?.[2]).toBe(client.load.mock.calls[1]?.[2]);
  expect(controller.getSnapshot().view?.items[0]?.taskReference).toBe(id(3));
});
it("cancels and discards an earlier filter response without issuing an implicit read", async () => {
  let deliver: (value: unknown) => void = () => {
    throw new Error("not initialized");
  };
  const client = {
    load: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...fixture(2), items: [] }),
  };
  const controller = createTaskInboxController(client, "store-a");
  const pending = controller.refresh();
  controller.setFilters({ overdue: true });
  expect(client.load.mock.calls[0]?.[1]?.aborted).toBe(true);
  expect(client.load).toHaveBeenCalledTimes(1);
  deliver(fixture());
  await pending;
  expect(controller.getSnapshot()).toMatchObject({ kind: "Idle", view: null });
  await controller.refresh();
  expect(controller.getSnapshot().kind).toBe("Ready");
});
it("clears an incompatible offline page and all filters on context change", async () => {
  const client = { load: vi.fn().mockResolvedValue(fixture()) };
  const controller = createTaskInboxController(client, "store-a");
  await controller.refresh();
  controller.setOnline(false);
  expect(controller.getSnapshot().view).not.toBeNull();
  controller.setFilters({ severityCode: "LOW" });
  expect(controller.getSnapshot()).toMatchObject({ kind: "Offline", view: null, readOnly: true });
  await controller.refresh();
  expect(client.load).toHaveBeenCalledTimes(1);
  controller.setContext("store-b");
  expect(Object.values(controller.getFilters()).every((value) => value === null)).toBe(true);
  controller.setOnline(true);
  expect(client.load).toHaveBeenCalledTimes(1);
  await controller.refresh();
  expect(controller.getSnapshot().kind).toBe("Ready");
});
it.each([
  { status: "Claimed" },
  { taskType: "OTHER" },
  { severityCode: "LOW" },
  { ownerStatus: "ClaimedByYou" },
  { overdue: true },
])(
  "rejects a late/mismatched response instead of displaying a different selected filter %#",
  async (filters) => {
    const client = { load: vi.fn().mockResolvedValue(fixture()) };
    const controller = createTaskInboxController(client, "store-a");
    controller.setFilters(filters);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      kind: "Unavailable",
      view: null,
      readOnly: true,
    });
  },
);
it("uses the server-observed strict overdue boundary and safe exact source reference", async () => {
  const result = fixture();
  const item = result.items[0];
  if (!item) throw new Error("fixture item missing");
  item.dueAt = result.observedAt;
  const client = { load: vi.fn().mockResolvedValue(result) };
  const controller = createTaskInboxController(client, "store-a");
  controller.setFilters({ overdue: false, exactReference: id(9) });
  await controller.refresh();
  expect(controller.getSnapshot().kind).toBe("Ready");
  controller.setFilters({ overdue: true });
  await controller.refresh();
  expect(controller.getSnapshot().kind).toBe("Unavailable");
});
it("does not discard a valid page for an equivalent immutable filter selection", async () => {
  const client = { load: vi.fn().mockResolvedValue(fixture()) };
  const controller = createTaskInboxController(client, "store-a");
  controller.setFilters({ severityCode: "CRITICAL", overdue: false });
  await controller.refresh();
  const page = controller.getSnapshot();
  controller.setFilters({ overdue: false, severityCode: "CRITICAL" });
  expect(controller.getSnapshot()).toBe(page);
  expect(client.load).toHaveBeenCalledTimes(1);
});
