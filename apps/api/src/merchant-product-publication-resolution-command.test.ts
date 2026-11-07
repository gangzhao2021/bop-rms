import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  buildCatalogProductPublicationResolution,
  parseCatalogProductPublicationResolutionCommand,
  productPublicationResolutionFields,
  type ProductPublicationResolutionStoreOptions as StoreOptions,
} from "@rms/catalog";
import { createMerchantProductPublicationResolutionCommand } from "./merchant-product-publication-resolution-command.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  execute: vi.fn(),
  currentAuthorization: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.resolve }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (options: unknown) =>
    mocks.currentAuthorization(options),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (options: unknown) => mocks.capability(options),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductPublicationResolutionStore: (options: unknown) => ({
    execute: (command: unknown) => mocks.execute(options, command),
  }),
}));
// Owning store/identity doubles isolate API protocol and the real outer UoW.
// SQL lock/fence and committed receipt evidence belongs to native acceptance.
const id = (n: number) => "01902701-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  end = "2026-10-03T12:00:05.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
type Kind = "PublicationV1" | "PublicationV2" | "WarningAcknowledgementV1";
type Tx = Parameters<StoreOptions["authority"]["holdUntilTransactionCompletes"]>[0];
type Command = Parameters<StoreOptions["authority"]["holdUntilTransactionCompletes"]>[1]["command"];
const permissions = [
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.read",
  "catalog.product.history.read",
] as const;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at) + 1000);
});
afterEach(() => vi.restoreAllMocks());
function browserCommand(kind: Kind) {
  if (kind === "WarningAcknowledgementV1")
    return {
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      action: "AcknowledgeProductPublicationWarnings",
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      reportOperationReference: id(7),
      reportDigest: hash("report"),
      warningBindingDigest: hash("warnings"),
      warningCodes: ["ChangeImpact"],
      reasonCode: "CONFIRMED_REFERENCE_WARNING",
      occurredAt: at,
    };
  const original = {
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: hash("content"),
    configurationDigest: hash("configuration"),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "USER_REQUEST",
  };
  if (kind === "PublicationV1") return original;
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return {
    ...original,
    profile: "CatalogProductPublicationCommandV2",
    replacementIntent: { ...intent, digest: hash(intent) },
    replacementIntentDigest: hash(intent),
  };
}
function setup(kind: Kind = "PublicationV2", outcome: "Committed" | "Abandoned" = "Abandoned") {
  let clock = at,
    late: () => void = () => undefined,
    failCommit = false,
    actualTx: Tx | undefined;
  const body = {
      profile: "CatalogProductPublicationResolutionCommandV1",
      originalKind: kind,
      originalCommand: browserCommand(kind),
    },
    authorizeAction = vi.fn(async (action: string) => ({
      effect: "Allow",
      action,
      scopeKind: "Brand",
    })),
    scope = {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      actorReference: id(3),
      selectedStoreReference: id(20),
      authorizeAction,
    },
    authentication = { authorize: vi.fn(async () => ({ sessionReference: id(21) })) },
    events: string[] = [],
    query = vi.fn(async () => ({ rows: [] })),
    tx = { query },
    run = vi.fn(async (work: (value: Tx) => Promise<unknown>) => {
      events.push("BEGIN");
      try {
        const result = await work(tx);
        if (failCommit) throw Error("SYNTHETIC_COMMIT_FAILURE");
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    }),
    holder = {
      holdUntilTransactionCompletes: vi.fn(async function (this: unknown) {
        expect(this).toBe(holder);
      }),
    },
    screen = vi.fn(async () => undefined),
    auditReference = vi.fn(() => id(22)),
    options = {
      merchant: { transactions: { run }, now: () => clock } as never,
      authentication: authentication as never,
      authority: holder,
      holdScreenUntilCommit: screen,
      auditReference,
    };
  mocks.resolve.mockImplementation(async (value: Tx) => {
    actualTx = value;
    return scope;
  });
  const authorityPacket = (command: Command) => ({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User" as const,
    command,
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_OPERATION_RESOLUTION" as const,
    permission: "catalog.manage" as const,
    requiredPermissions: permissions,
    requiredScope: "FullBrandScope" as const,
    requiredFields: productPublicationResolutionFields,
    observedAt: at,
  });
  const execute = async (store: StoreOptions, command: Command) =>
    store.transactions.run(async (actual) => {
      expect(actual).toBe(actualTx);
      await store.authority.holdUntilTransactionCompletes(actual, authorityPacket(command));
      const resolution = buildCatalogProductPublicationResolution(command, outcome, at);
      if (outcome === "Abandoned") {
        const audit = store.audit.create({ command, resolution });
        validateAuditRecord(audit);
        expect(audit).toMatchObject({
          actionCode: "CATALOG_PRODUCT_PUBLICATION_OPERATION_ABANDONED",
          targetType: "ProductPublicationOperation",
          targetId: id(4),
          reasonCode: "ORIGINAL_OPERATION_ABANDONED",
          actor: { type: "User", reference: id(3) },
        });
      }
      late();
      return { resolution, currentAggregateVersion: 9 };
    });
  mocks.execute.mockImplementation(execute);
  return {
    body,
    scope,
    authentication,
    events,
    query,
    run,
    holder,
    screen,
    options,
    execute,
    authorityPacket,
    authorizeAction,
    auditReference,
    get tx() {
      if (!actualTx) throw Error("Missing actual transaction");
      return actualTx;
    },
    request: {
      command: body,
      sessionCookie: "SYNTHETIC_SESSION",
      csrf: "SYNTHETIC_CSRF",
      expectedScope: { brandReference: id(2), storeReference: id(20) },
    },
    setClock(value: string) {
      clock = value;
    },
    setLate(value: () => void) {
      late = value;
    },
    setCommitFailure() {
      failCommit = true;
    },
  };
}

it.each(["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"] as const)(
  "resolves %s with current management authority and the exact original transport digest",
  async (kind) => {
    const f = setup(kind),
      result = await createMerchantProductPublicationResolutionCommand(f.options)(f.request),
      parsed = mocks.execute.mock.calls[0]?.[1] as Command;
    expect(result).toEqual({
      profile: "CatalogProductPublicationResolutionResultV1",
      outcome: "Abandoned",
      originalKind: kind,
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(20),
      productReference: id(5),
      versionReference: id(6),
      operationReference: id(4),
      originalCommandDigest: hash(browserCommand(kind)),
      originalIntentDigest: hash(parsed.originalCommand),
      recordedAt: at,
      resolutionDigest: buildCatalogProductPublicationResolution(parsed, "Abandoned", at).digest,
      currentAggregateVersion: 9,
    });
    expect(parsed.originalCommand).toMatchObject({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      expectedProductAggregateVersion: 1,
    });
    expect([...new Set(f.authorizeAction.mock.calls.map(([action]) => action))]).toEqual(
      permissions,
    );
    expect(f.screen).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_OPERATION_RESOLUTION",
        screenId: "CAT-PRODUCT-EDIT",
        owningAction: "catalog.product.manage",
        requiredFields: productPublicationResolutionFields,
      }),
    );
    expect(Object.keys(result)).not.toContain("actorReference");
    expect(Object.keys(result)).not.toContain("originalCommand");
    expect(f.events).toEqual(["BEGIN", "COMMIT"]);
  },
);
it.each(["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"] as const)(
  "returns committed %s without acquiring old action permission, audit or qualification",
  async (kind) => {
    const f = setup(kind, "Committed");
    f.authorizeAction.mockImplementation(async (action) => ({
      effect: permissions.includes(action as (typeof permissions)[number]) ? "Allow" : "Deny",
      action,
      scopeKind: "Brand",
    }));
    expect(
      await createMerchantProductPublicationResolutionCommand(f.options)(f.request),
    ).toMatchObject({ outcome: "Committed", currentAggregateVersion: 9 });
    expect(f.auditReference).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();
  },
);
it("hashes parsed transport canonically rather than depending on insertion order", async () => {
  const f = setup();
  f.request.command = {
    ...f.body,
    originalCommand: Object.fromEntries(Object.entries(f.body.originalCommand).reverse()),
  } as typeof f.body;
  expect(
    (await createMerchantProductPublicationResolutionCommand(f.options)(f.request))
      .originalCommandDigest,
  ).toBe(hash(browserCommand("PublicationV2")));
});
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "purposeCode",
  "sources",
  "validation",
])("rejects injected original %s before authentication", async (key) => {
  const f = setup();
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)({
      ...f.request,
      command: { ...f.body, originalCommand: { ...f.body.originalCommand, [key]: id(100) } },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.authentication.authorize).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
it.each(["ActivateScheduled", "Supersede"])("refuses original System action %s", async (action) => {
  const f = setup("PublicationV1");
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)({
      ...f.request,
      command: { ...f.body, originalCommand: { ...f.body.originalCommand, action } },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("rejects foreign scope before store dispatch", async () => {
  const f = setup();
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)({
      ...f.request,
      expectedScope: { brandReference: id(2), storeReference: id(99) },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("captures request bytes and receiver-bound ports before asynchronous authentication", async () => {
  const f = setup(),
    command = createMerchantProductPublicationResolutionCommand(f.options);
  f.authentication.authorize.mockImplementationOnce(async () => {
    f.body.originalCommand.productReference = id(90);
    return { sessionReference: id(21) };
  });
  f.options.authority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("replacement");
  });
  f.options.holdScreenUntilCommit = vi.fn(async () => {
    throw Error("replacement");
  });
  expect(await command(f.request)).toMatchObject({ productReference: id(5) });
  expect(f.screen).toHaveBeenCalled();
});
it.each(["permission", "fields", "screen"])(
  "rolls back late %s refusal after a tentative resolution",
  async (mode) => {
    const f = setup();
    f.setLate(() => {
      if (mode === "permission")
        f.authorizeAction.mockImplementation(async (action) => ({
          action,
          effect: "Deny",
          scopeKind: "Brand",
        }));
      if (mode === "fields")
        f.holder.holdUntilTransactionCompletes.mockRejectedValue(
          new CatalogError("CATALOG_PERMISSION_DENIED"),
        );
      if (mode === "screen")
        f.screen.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
    });
    await expect(
      createMerchantProductPublicationResolutionCommand(f.options)(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("rejects at the original final deadline after later asynchronous guards run", async () => {
  const f = setup();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
    const result = await f.execute(store, command);
    await store.registerBeforeCommit(
      f.tx,
      async () => {
        f.setClock(end);
      },
      () => undefined,
    );
    return result;
  });
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each(["invalid", "2026-10-03T11:59:59.999Z", end])(
  "refuses malformed/backwards/expired clock %s",
  async (clock) => {
    const f = setup();
    f.setLate(() => f.setClock(clock));
    await expect(
      createMerchantProductPublicationResolutionCommand(f.options)(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("maps an initially malformed clock to unavailable without starting a transaction", async () => {
  const f = setup();
  f.setClock("invalid");
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual([]);
});
it("poisons a caught authority packet failure", async () => {
  const f = setup();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
    const result = await f.execute(store, command);
    await expect(
      store.authority.holdUntilTransactionCompletes(f.tx, {
        ...f.authorityPacket(command),
        actorReference: id(99),
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    return result;
  });
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each(["actorReference", "operationReference", "productReference"])(
  "rejects a valid but transplanted %s resolution",
  async (key) => {
    const f = setup();
    mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
      const result = await f.execute(store, command),
        transplanted = parseCatalogProductPublicationResolutionCommand({
          ...command,
          originalCommand: { ...command.originalCommand, [key]: id(99) },
        });
      return {
        ...result,
        resolution: buildCatalogProductPublicationResolution(transplanted, "Abandoned", at),
      };
    });
    await expect(
      createMerchantProductPublicationResolutionCommand(f.options)(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it.each([0, -1, 1.5, "9", null])(
  "rejects invalid current revision %s",
  async (currentAggregateVersion) => {
    const f = setup();
    mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => ({
      ...(await f.execute(store, command)),
      currentAggregateVersion,
    }));
    await expect(
      createMerchantProductPublicationResolutionCommand(f.options)(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("does not return an authoritative DTO before the outer commit succeeds", async () => {
  const f = setup();
  f.setCommitFailure();
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toBeDefined();
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("refuses a corrupted owning resolution as a dependency failure", async () => {
  const f = setup();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
    const result = await f.execute(store, command);
    return { ...result, resolution: { ...result.resolution, digest: hash("corrupt") } };
  });
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("rejects extra envelope fields without invoking getters", async () => {
  const f = setup();
  let reads = 0;
  const hostile = {
    ...f.body,
    get resolution() {
      reads++;
      return "Abandoned";
    },
  };
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)({
      ...f.request,
      command: hostile,
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(reads).toBe(0);
  expect(f.authentication.authorize).not.toHaveBeenCalled();
});
it("rejects repeated owning transaction callbacks even if the second error is caught", async () => {
  const f = setup();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
    const result = await f.execute(store, command);
    await expect(store.transactions.run(async () => undefined)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    return result;
  });
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("rejects misbound original kind rather than interpreting V2 as V1", async () => {
  const f = setup();
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)({
      ...f.request,
      command: { ...f.body, originalKind: "PublicationV1" },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(mocks.execute).not.toHaveBeenCalled();
});

function runtimeSetup(
  kind: Kind = "PublicationV2",
  outcome: "Committed" | "Abandoned" = "Abandoned",
) {
  const f = setup(kind, outcome),
    order: string[] = [],
    bridge = {
      assertCurrent: vi.fn(),
      authorizeActions: vi.fn(async function (this: unknown, actions: readonly string[]) {
        expect(this).toBe(bridge);
        expect(actions).toEqual(permissions);
        order.push("BrandPermissions");
      }),
    },
    capability = {
      holdUntilCommit: vi.fn(async function (this: unknown) {
        expect(this).toBe(capability);
        order.push("EditCapability");
      }),
    },
    options = {
      merchant: f.options.merchant,
      authentication: f.options.authentication,
      auditReference: f.auditReference,
      currentRuntime: true as const,
    };
  mocks.currentAuthorization.mockReturnValue(bridge);
  mocks.capability.mockReturnValue(capability);
  // Assign only the new fields: spreading f would eagerly evaluate its actual
  // transaction getter before the real transaction host has entered.
  return Object.assign(f, { options, bridge, capability, order });
}

it.each(["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"] as const)(
  "uses fixed current management/feature authority for committed %s recovery without qualification",
  async (kind) => {
    const f = runtimeSetup(kind, "Committed"),
      result = await createMerchantProductPublicationResolutionCommand(f.options)(f.request);
    expect(result).toMatchObject({
      outcome: "Committed",
      originalKind: kind,
      currentAggregateVersion: 9,
    });
    expect(result.originalCommandDigest).toBe(hash(browserCommand(kind)));
    expect(mocks.currentAuthorization).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        transaction: f.tx,
        scope: f.scope,
        sessionCookie: "SYNTHETIC_SESSION",
        sessionReference: id(21),
        originalValidUntil: end,
      }),
    );
    expect(mocks.capability).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        transaction: f.tx,
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(20),
        actorReference: id(3),
        currentAuthorization: f.bridge,
        originalValidUntil: end,
      }),
    );
    expect(f.order).toEqual([
      "EditCapability",
      "BrandPermissions",
      "EditCapability",
      "BrandPermissions",
    ]);
    expect(f.authorizeAction).not.toHaveBeenCalled();
    expect(f.holder.holdUntilTransactionCompletes).not.toHaveBeenCalled();
    expect(f.screen).not.toHaveBeenCalled();
    expect(f.auditReference).not.toHaveBeenCalled();
    expect(f.events).toEqual(["BEGIN", "COMMIT"]);
  },
);
it("uses the same fixed current authority and owning audit for a new abandonment", async () => {
  const f = runtimeSetup();
  expect(
    await createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).toMatchObject({
    outcome: "Abandoned",
    currentAggregateVersion: 9,
  });
  expect(f.auditReference).toHaveBeenCalledExactlyOnceWith(id(4));
  expect(f.order.at(-1)).toBe("BrandPermissions");
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});
it.each(["authority", "holdScreenUntilCommit"] as const)(
  "rejects mixed current-runtime and supplied %s configuration before reads",
  (key) => {
    const f = runtimeSetup();
    expect(() =>
      createMerchantProductPublicationResolutionCommand({
        ...f.options,
        [key]: key === "authority" ? f.holder : f.screen,
      }),
    ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(f.authentication.authorize).not.toHaveBeenCalled();
  },
);
it("rejects disabled current-runtime configuration and missing legacy holders", () => {
  const f = runtimeSetup();
  expect(() =>
    createMerchantProductPublicationResolutionCommand({
      ...f.options,
      currentRuntime: false,
    } as unknown as Parameters<typeof createMerchantProductPublicationResolutionCommand>[0]),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
  const { currentRuntime, ...legacy } = f.options;
  expect(currentRuntime).toBe(true);
  expect(() => createMerchantProductPublicationResolutionCommand(legacy)).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
it("captures current-runtime session credentials before awaiting authentication", async () => {
  const f = runtimeSetup();
  f.authentication.authorize.mockImplementationOnce(async () => {
    f.request.sessionCookie = "REPLACED_SESSION";
    f.request.csrf = "REPLACED_CSRF";
    return { sessionReference: id(21) };
  });
  await createMerchantProductPublicationResolutionCommand(f.options)(f.request);
  expect(f.authentication.authorize).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: "SYNTHETIC_SESSION",
    csrf: "SYNTHETIC_CSRF",
  });
  expect(mocks.resolve).toHaveBeenCalledWith(f.tx, "SYNTHETIC_SESSION", id(21));
  expect(mocks.currentAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({ sessionCookie: "SYNTHETIC_SESSION" }),
  );
});
it.each(["permission", "feature"] as const)(
  "rolls back current-runtime recovery after a late %s refusal",
  async (mode) => {
    const f = runtimeSetup(),
      error =
        mode === "permission"
          ? new CatalogError("CATALOG_PERMISSION_DENIED")
          : new MerchantProductWriteFeatureDisabled();
    f.setLate(() => {
      if (mode === "permission") f.bridge.authorizeActions.mockRejectedValue(error);
      else f.capability.holdUntilCommit.mockRejectedValue(error);
    });
    await expect(
      createMerchantProductPublicationResolutionCommand(f.options)(f.request),
    ).rejects.toBe(error);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("keeps the original current-runtime lease through later asynchronous commit work", async () => {
  const f = runtimeSetup();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
    const result = await f.execute(store, command);
    await store.registerBeforeCommit(
      f.tx,
      async () => {
        f.setClock(end);
      },
      () => undefined,
    );
    return result;
  });
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each(["requiredFields", "purposeCode", "actorReference"] as const)(
  "retains exact %s binding and poison when current-runtime recovery catches a forged packet",
  async (key) => {
    const f = runtimeSetup();
    mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
      const result = await f.execute(store, command),
        packet = {
          ...f.authorityPacket(command),
          [key]: key === "requiredFields" ? [] : "changed",
        };
      await expect(
        store.authority.holdUntilTransactionCompletes(
          f.tx,
          packet as unknown as ReturnType<typeof f.authorityPacket>,
        ),
      ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      return result;
    });
    await expect(
      createMerchantProductPublicationResolutionCommand(f.options)(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);

it("checks a shortened owning authorization deadline after later asynchronous recovery work", async () => {
  const f = runtimeSetup();
  mocks.execute.mockImplementation(async (store: StoreOptions, command: Command) => {
    const result = await f.execute(store, command);
    await store.registerBeforeCommit(
      f.tx,
      async () => {
        f.bridge.assertCurrent.mockImplementation(() => {
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        });
      },
      () => undefined,
    );
    return result;
  });
  await expect(
    createMerchantProductPublicationResolutionCommand(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
