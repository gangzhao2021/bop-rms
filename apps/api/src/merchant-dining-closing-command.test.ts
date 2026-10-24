vi.mock("./dining-table-release-composition.js", () => ({
  createDiningTableReleaseComposition: () => mock.release,
}));
vi.mock("./dining-exception-task-composition.js", () => ({
  createDiningExceptionTaskComposition: (options: unknown) => {
    mock.taskComposition(options);
    return { ensure: async () => ({ status: "Ensured" }) };
  },
}));
vi.mock("./dining-settled-session-evidence.js", () => ({
  createDiningSettledSessionEvidence: () => ({ load: mock.evidence }),
  createDiningSessionClosingEvidence: () => ({ load: mock.evidence }),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  scope: vi.fn(),
  fence: vi.fn(),
  receipt: vi.fn(),
  begin: vi.fn(),
  finalize: vi.fn(),
  ports: vi.fn(),
  release: vi.fn(),
  sessionOrders: vi.fn(),
  cancellations: vi.fn(),
  taskComposition: vi.fn(),
  evidence: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  listStoreDiningSessionOrders: mock.sessionOrders,
  createPostgresStaffOrderCancellationReader: () => ({ listByOrders: mock.cancellations }),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.scope }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningClosingFence: () => mock.fence,
  createPostgresDiningClosingStore: () => ({ readReceipt: mock.receipt }),
  createDiningClosingService: (ports: unknown) => {
    mock.ports(ports);
    return { begin: mock.begin, finalize: mock.finalize };
  },
}));
import { createMerchantDiningClosingCommand } from "./merchant-dining-closing-command.js";
const id = (n: number) => "0190fad7-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function setup() {
  const allowed = vi.fn(async () => true),
    // The run's single current-fact read at the start (close and Task permissions together).
    authorizeActions = vi.fn(
      async (actions: readonly string[]): Promise<ReadonlyMap<string, unknown>> =>
        new Map(actions.map((action) => [action, { effect: "Allow", action }])),
    ),
    authenticate = vi.fn(async () => ({ sessionReference: id(8) })),
    tx = { query: vi.fn() },
    inside = { thrown: false },
    run = vi.fn(async (work: (tx: object) => Promise<unknown>) => {
      try {
        return await work(tx);
      } catch (error) {
        inside.thrown = true;
        throw error;
      }
    });
  mock.scope.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed,
    authorizeActions,
  });
  mock.fence.mockResolvedValue({
    diningSessionReference: id(5),
    version: 2,
    tableAssignmentVersion: 1,
  });
  mock.receipt.mockResolvedValue(null);
  mock.begin.mockResolvedValue({ status: "Applied", session: { phase: "Closing", version: 3 } });
  mock.finalize.mockResolvedValue({ status: "Applied", session: { phase: "Closed", version: 3 } });
  const handler = createMerchantDiningClosingCommand({
    persistence: { transactions: { run } } as unknown as Parameters<
      typeof createMerchantDiningClosingCommand
    >[0]["persistence"],
    authentication: { authorize: authenticate } as unknown as Parameters<
      typeof createMerchantDiningClosingCommand
    >[0]["authentication"],
    providerAccountReference: id(9),
    environment: "Test",
    newReference: () => id(10),
    retentionPolicyCode: "ORDER_AUDIT",
    retentionPolicyVersion: 1,
  });
  const input = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    command: {
      action: "Begin",
      diningSessionReference: id(5),
      operationReference: id(6),
      expectedSessionVersion: 2,
    },
  };
  return { allowed, authorizeActions, authenticate, run, inside, input, handler };
}
it.each(["Begin", "Finalize"])("routes %s through domain with server time", async (action) => {
  const f = setup();
  f.input.command.action = action;
  const result = await f.handler(f.input);
  expect(result.status).toBe("Applied");
  expect(action === "Begin" ? mock.begin : mock.finalize).toHaveBeenCalledWith({
    diningSessionReference: id(5),
    operationReference: id(6),
    expectedSessionVersion: 2,
    requestedAt: at,
  });
});
it("returns matching historical retry without reapplying transition", async () => {
  const f = setup();
  mock.receipt.mockResolvedValue({
    record: {
      action: "Begin",
      session: { diningSessionReference: id(5), version: 2, phase: "Closing" },
    },
    expectedVersion: 2,
    occurredAt: at,
  });
  expect(await f.handler(f.input)).toEqual({
    status: "AlreadyApplied",
    phase: "Closing",
    sessionVersion: 2,
  });
  expect(mock.begin).not.toHaveBeenCalled();
});
it("rejects conflicting retry action", async () => {
  const f = setup();
  mock.receipt.mockResolvedValue({
    record: { action: "Finalize", session: { diningSessionReference: id(5), version: 2 } },
    expectedVersion: 2,
    occurredAt: at,
  });
  await expect(f.handler(f.input)).rejects.toThrow();
});
it("rejects absent current permission before fence", async () => {
  const f = setup();
  f.authorizeActions.mockResolvedValue(new Map([["dining.session.close", null]]));
  await expect(f.handler(f.input)).rejects.toMatchObject({
    code: "DINING_CLOSING_PERMISSION_DENIED",
  });
  expect(mock.fence).not.toHaveBeenCalled();
});
it("WP-2423: resolves the caller in full once at the start and once before the reply", async () => {
  const f = setup();
  await f.handler(f.input);
  expect(mock.scope).toHaveBeenCalledOnce();
  expect(f.authorizeActions).toHaveBeenCalledExactlyOnceWith([
    "dining.session.close",
    "task.create",
    "task.assign",
  ]);
  // Owner reads are fenced by the run itself; only the final re-check resolves the caller again.
  expect(f.allowed).toHaveBeenCalledOnce();
});
it("WP-2423: a permission withdrawn during the close refuses it before commit", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.handler(f.input)).rejects.toMatchObject({
    code: "DINING_CLOSING_PERMISSION_DENIED",
  });
  expect(mock.begin).toHaveBeenCalledOnce();
  // The refusal is thrown inside the transaction callback, so nothing it wrote commits.
  expect(f.inside.thrown).toBe(true);
});
it("WP-2423: owner callbacks take the run's guard during the close and are refused after it", async () => {
  const f = setup();
  mock.sessionOrders.mockResolvedValue(new Map());
  const during: unknown[] = [];
  mock.begin.mockImplementation(async () => {
    const ports = mock.ports.mock.calls[0]?.[0];
    during.push(
      (await ports.authorization.authorize({
        session: { diningSessionReference: id(5) },
        operation: "Begin",
        observedAt: at,
      })) !== null,
    );
    during.push(
      await ports.authorization.authorize({
        session: { diningSessionReference: id(99) },
        operation: "Begin",
        observedAt: at,
      }),
    );
    return { status: "Applied", session: { phase: "Closing", version: 3 } };
  });
  await f.handler(f.input);
  expect(during).toEqual([true, null]);
  expect(f.allowed).toHaveBeenCalledOnce();
  const ports = mock.ports.mock.calls[0]?.[0];
  expect(
    await ports.authorization.authorize({
      session: { diningSessionReference: id(5) },
      operation: "Begin",
      observedAt: at,
    }),
  ).toBeNull();
});
describe("WP-2423: exception Task permissions", () => {
  const policy = { synthetic: true };
  function withTasks() {
    const f = setup();
    const handler = createMerchantDiningClosingCommand({
      persistence: { transactions: { run: f.run } } as unknown as Parameters<
        typeof createMerchantDiningClosingCommand
      >[0]["persistence"],
      authentication: { authorize: f.authenticate } as unknown as Parameters<
        typeof createMerchantDiningClosingCommand
      >[0]["authentication"],
      providerAccountReference: id(9),
      environment: "Test",
      exceptionTaskPolicy: policy,
      newReference: () => id(10),
      retentionPolicyCode: "ORDER_AUDIT",
      retentionPolicyVersion: 1,
    } as Parameters<typeof createMerchantDiningClosingCommand>[0]);
    mock.evidence.mockResolvedValue({ synthetic: "evidence" });
    const decisions: unknown[] = [];
    mock.begin.mockImplementation(async () => {
      const ports = mock.ports.mock.calls[0]?.[0];
      await ports.closureEvidence.resolve({ diningSessionReference: id(5), observedAt: at });
      await ports.tasks.ensure({});
      const composition = mock.taskComposition.mock.calls[0]?.[0];
      // Several Task decisions during the run cost no further resolution.
      decisions.push(await composition.authorizeTask({ action: "task.create" }));
      decisions.push(await composition.authorizeTask({ action: "task.assign" }));
      decisions.push(await composition.authorizeTask({ action: "task.create" }));
      return { status: "Applied", session: { phase: "Closing", version: 3 } };
    });
    return { ...f, handler, decisions };
  }
  it("are decided once at the start and re-checked once with the close permission", async () => {
    const f = withTasks();
    await expect(f.handler(f.input)).resolves.toMatchObject({ status: "Applied" });
    expect(f.decisions).toEqual([
      { effect: "Allow", action: "task.create" },
      { effect: "Allow", action: "task.assign" },
      { effect: "Allow", action: "task.create" },
    ]);
    // Exactly two full resolutions: the start and the re-check before the commit.
    expect(f.authorizeActions).toHaveBeenCalledTimes(2);
    expect(f.authorizeActions).toHaveBeenLastCalledWith([
      "dining.session.close",
      "task.create",
      "task.assign",
    ]);
    expect(f.allowed).not.toHaveBeenCalled();
    // After the run the Task callback is refused.
    const composition = mock.taskComposition.mock.calls[0]?.[0];
    await expect(composition.authorizeTask({ action: "task.create" })).rejects.toThrow();
  });
  it("a Task permission withdrawn during the close refuses it before commit", async () => {
    const f = withTasks();
    f.authorizeActions
      .mockImplementationOnce(
        async (actions: readonly string[]) =>
          new Map(actions.map((action) => [action, { effect: "Allow", action }])),
      )
      .mockImplementationOnce(
        async (actions: readonly string[]) =>
          new Map(
            actions.map((action) => [
              action,
              { effect: action === "task.assign" ? "Deny" : "Allow", action },
            ]),
          ),
      );
    await expect(f.handler(f.input)).rejects.toMatchObject({
      code: "DINING_CLOSING_PERMISSION_DENIED",
    });
    expect(f.authorizeActions).toHaveBeenCalledTimes(2);
    expect(f.inside.thrown).toBe(true);
  });
});
it("rejects CSRF failure before transaction", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue(new Error("denied"));
  await expect(f.handler(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects caller time and unsupported Cancel", async () => {
  const f = setup();
  await expect(
    f.handler({ ...f.input, command: { ...f.input.command, requestedAt: at } }),
  ).rejects.toThrow();
  f.input.command.action = "Cancel";
  await expect(f.handler(f.input)).rejects.toThrow();
});

it("releases table only after Finalize with the resulting session version", async () => {
  const f = setup();
  f.input.command.action = "Finalize";
  await f.handler(f.input);
  expect(mock.release).toHaveBeenCalledWith(expect.anything(), {
    diningSessionReference: id(5),
    operationReference: id(6),
    expectedSessionVersion: 3,
    observedAt: at,
  });
  expect(mock.finalize.mock.invocationCallOrder[0]).toBeLessThan(
    mock.release.mock.invocationCallOrder[0] ?? 0,
  );
});
it("fails the outer command if table release fails", async () => {
  const f = setup();
  f.input.command.action = "Finalize";
  mock.release.mockRejectedValue(new Error("release"));
  await expect(f.handler(f.input)).rejects.toThrow("release");
});
it("repairs matching old Finalize via release without repeating session transition", async () => {
  const f = setup();
  f.input.command.action = "Finalize";
  mock.fence.mockResolvedValue({ version: 3 });
  mock.receipt.mockResolvedValue({
    record: {
      action: "Finalize",
      session: { diningSessionReference: id(5), version: 3, phase: "Closed" },
    },
    expectedVersion: 2,
    occurredAt: at,
  });
  expect((await f.handler(f.input)).status).toBe("AlreadyApplied");
  expect(mock.finalize).not.toHaveBeenCalled();
  expect(mock.release).toHaveBeenCalledTimes(1);
});

it.each([
  [[{ reasonCode: "SOLD_OUT" }, { reasonCode: "GUEST_LEFT" }], "GUEST_LEFT"],
  [[{ reasonCode: "SOLD_OUT" }], "CUSTOMER_FINISHED"],
  [null, "CUSTOMER_FINISHED"],
])(
  "DEC-TABLE-CLOSE-GUESTS-LEFT: records why the table was closed (%j)",
  async (cancellations, reason) => {
    const f = setup();
    mock.sessionOrders.mockResolvedValue(new Map(cancellations === null ? [] : [[id(5), id(11)]]));
    mock.cancellations.mockResolvedValue(cancellations ?? []);
    let decision: { audit: { reasonCode: string } } | null = null;
    // The domain asks for the staff authorization while the command's run is in progress.
    mock.begin.mockImplementation(async () => {
      const ports = mock.ports.mock.calls[0]?.[0] as {
        authorization: {
          authorize(request: unknown): Promise<{ audit: { reasonCode: string } }>;
        };
      };
      decision = await ports.authorization.authorize({
        session: { diningSessionReference: id(5) },
        operation: "Begin",
        observedAt: at,
      });
      return { status: "Applied", session: { phase: "Closing", version: 3 } };
    });
    await f.handler(f.input);
    expect(decision).toMatchObject({ audit: { reasonCode: reason } });
    if (cancellations !== null)
      expect(mock.cancellations).toHaveBeenCalledWith(expect.anything(), [id(11)]);
  },
);
