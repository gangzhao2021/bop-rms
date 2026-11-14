import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  createCatalogOptionSetAuthoringIdentity,
  parseCatalogOptionSetEditorContent,
  materializeFullOptionSetCreation,
  materializeFullOptionSetEdit,
  parseFullOptionSetCreateCommand,
  parseFullOptionSetEditCommand,
  parseCatalogInstant,
  parseCatalogReference,
  optionSetAuthoringResolutionFields,
  type OptionSetAuthoringResolutionStoreOptions,
  type OptionSetOriginalOperation,
  type createPostgresFullOptionSetDraftStore,
} from "@rms/catalog";
import { createMerchantOptionSetAuthoringCommand } from "./merchant-option-set-authoring-command.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  original: vi.fn(),
  owner: vi.fn(),
  admission: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (o: unknown) => mocks.current(o),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (o: unknown) => mocks.capability(o),
}));
type Resolver = OptionSetAuthoringResolutionStoreOptions;
type Tx = Parameters<Resolver["registerBeforeCommit"]>[0];
type Command = Parameters<Resolver["authority"]["holdUntilTransactionCompletes"]>[1]["command"];
type Writer = Parameters<typeof createPostgresFullOptionSetDraftStore>[0];
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresOptionSetAuthoringResolutionStore: (o: Resolver) => ({
    async withOriginalOperation<T>(
      tx: Tx,
      c: Command,
      work: (original: OptionSetOriginalOperation) => Promise<T>,
    ): Promise<T> {
      const input = {
        command: c,
        mode: "Write" as const,
        permission: "catalog.manage" as const,
        requiredPermissions: [
          "catalog.manage",
          c.action === "Create" ? "catalog.option_set.create" : "catalog.option_set.update",
        ],
        requiredFields: optionSetAuthoringResolutionFields,
        purposeCode: "CATALOG_OPTION_SET_AUTHORING_OPERATION_RESOLUTION" as const,
        actorKind: "User" as const,
        requiredScope: "FullBrandScope" as const,
        observedAt: parseCatalogInstant(mocks.admission()),
      };
      await o.authority.holdUntilTransactionCompletes(tx, input);
      await o.registerBeforeCommit(
        tx,
        async () => {
          await o.authority.holdUntilTransactionCompletes(tx, {
            ...input,
            observedAt: parseCatalogInstant(mocks.admission()),
          });
        },
        () => undefined,
      );
      const result: OptionSetOriginalOperation = mocks.original(o, tx, c);
      return work(result);
    },
  }),
  createPostgresFullOptionSetDraftStore: (o: Writer) => ({
    create: (command: unknown) => mocks.owner(o, "Create", command),
    edit: (command: unknown) => mocks.owner(o, "Edit", command),
  }),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
function creation() {
  return {
    internalCode: "SYNTH_CHOICES",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "CHOICE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "CHOICE",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
    operationReference: id(7),
    occurredAt: at,
    reasonCode: "AUTHORIZED_OPERATION",
  };
}
function full() {
  return materializeFullOptionSetCreation(creation(), {
    brandReference: id(2),
    actorReference: id(4),
    allocations: {
      optionSetReference: id(6),
      versionReference: id(8),
      options: [{ stableCode: "CHOICE", optionReference: id(9) }],
    },
  }).content;
}

const fields = [
  "optionSetReference",
  "versionReference",
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
  "options",
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
];
function harness(
  action: "Create" | "Edit" = "Create",
  outcome: "Absent" | "Committed" | "Abandoned" = "Absent",
) {
  const state = {
    now: at,
    permissionUntil: until,
    featureUntil: until,
    allowed: true,
    feature: true,
    committed: false,
    failCommit: false,
    underLock: false,
    ownerFinished: false,
    withdrawAfterOwner: false,
    expireAfterOwner: false,
    actorReference: id(4),
  };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  let actualTx: Tx | undefined;
  const current = {
    assertCurrent: vi.fn(() => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return parseCatalogInstant(state.now);
    }),
    authorizeActions: vi.fn(async () => {
      if (state.ownerFinished && state.withdrawAfterOwner) state.allowed = false;
      if (state.ownerFinished && state.expireAfterOwner) state.now = state.featureUntil;
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    leaseDeadline: () => state.permissionUntil,
    withCurrentStoreScope: vi.fn(),
  };
  const capability = {
    holdUntilCommit: vi.fn(async () => {
      if (!state.feature) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    leaseDeadline: () => state.featureUntil,
  };
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  mocks.admission.mockImplementation(() => state.now);
  mocks.scope.mockImplementation(async (t: Tx) => {
    actualTx = t;
    return {
      tenantReference: parseCatalogReference(id(1)),
      actorReference: parseCatalogReference(state.actorReference),
      context: { brand: { brandReference: parseCatalogReference(id(2)) } },
      selectedStoreReference: parseCatalogReference(id(3)),
    };
  });
  const base = creation();
  const { occurredAt, reasonCode, ...createBody } = base;
  void occurredAt;
  void reasonCode;
  const editBody = {
    optionSetReference: id(6),
    expectedAggregateVersion: 1,
    draft: {
      ...base.draft,
      options: [{ ...base.draft.options[0], identity: { kind: "New" }, stableCode: "NEW" }],
    },
    additionalContent: {
      ...base.additionalContent,
      optionDetails: [{ ...base.additionalContent.optionDetails[0], stableCode: "NEW" }],
    },
    archiveOptionReferences: [id(9)],
    operationReference: id(7),
  };
  const body = action === "Create" ? createBody : editBody;
  const allocation = vi.fn(
    (kind: "OptionSet" | "OptionSetVersion" | "Option" | "Audit" | "Event") =>
      ({ OptionSet: id(6), OptionSetVersion: id(8), Option: id(11), Audit: id(10), Event: id(12) })[
        kind
      ],
  );
  let originalContent = full();
  if (action === "Edit")
    originalContent = materializeFullOptionSetEdit(
      { ...editBody, occurredAt: at, reasonCode: "AUTHORIZED_OPERATION" },
      full(),
      { actorReference: id(4), newOptions: [{ stableCode: "NEW", optionReference: id(11) }] },
    ).content;
  mocks.original.mockImplementation((_o: Resolver, t: Tx, c: Command) => {
    expect(t).toBe(actualTx);
    state.underLock = true;
    if (outcome === "Absent") return { outcome };
    if (outcome === "Abandoned") return { outcome, resolution: {} };
    const { sourceAggregate, ...details } = originalContent,
      parsed = parseCatalogOptionSetEditorContent(sourceAggregate, details);
    return {
      outcome,
      identity: createCatalogOptionSetAuthoringIdentity({
        command: c,
        sourceOperationReference: c.operationReference,
        optionSetReference: sourceAggregate.optionSetReference,
        versionReference: sourceAggregate.draft.versionReference,
        aggregateVersion: sourceAggregate.aggregateVersion,
        originalOccurredAt: parseCatalogInstant(at),
        auditReference: parseCatalogReference(id(10)),
        originalIntentDigest: "sha256:" + "1".repeat(64),
        sourceDigest: parsed.sourceDigest,
        contentDigest: parsed.contentDigest,
        configurationDigest: parsed.configurationDigest,
      }),
      content: originalContent,
    };
  });
  mocks.owner.mockImplementation(
    async (o: Writer, actualAction: "Create" | "Edit", value: unknown) =>
      o.transactions.run(async (t) => {
        expect(t).toBe(actualTx);
        expect(state.underLock).toBe(true);
        expect(actualAction).toBe(action);
        const parsed =
          actualAction === "Create"
            ? parseFullOptionSetCreateCommand(value)
            : parseFullOptionSetEditCommand(value);
        const shared = {
          tenantReference: parseCatalogReference(id(1)),
          brandReference: parseCatalogReference(id(2)),
          actorReference: parseCatalogReference(id(4)),
          actorKind: "User" as const,
          permission: "catalog.manage" as const,
          purposeCode: "CATALOG_OPTION_SET_DRAFT" as const,
          observedAt: parseCatalogInstant(state.now),
        };
        let prepared;
        if (actualAction === "Create") {
          if (!o.creation) throw Error("Required Creation config missing");
          await o.creation.authority.holdUntilTransactionCompletes(t, {
            ...shared,
            action: "catalog.option_set.create",
            requiredFields: ["internalCode", ...fields],
            optionSetReference: null,
            proposedCommand: parsed,
          });
          const set = outcome === "Committed" ? id(6) : o.creation.references.generate("OptionSet"),
            version =
              outcome === "Committed" ? id(8) : o.creation.references.generate("OptionSetVersion"),
            option = outcome === "Committed" ? id(9) : o.creation.references.generate("Option");
          prepared = materializeFullOptionSetCreation(parsed, {
            brandReference: id(2),
            actorReference: id(4),
            allocations: {
              optionSetReference: set,
              versionReference: version,
              options: [{ stableCode: "CHOICE", optionReference: option }],
            },
          });
          await o.creation.authority.holdUntilTransactionCompletes(t, {
            ...shared,
            action: "catalog.option_set.create",
            requiredFields: ["internalCode", ...fields],
            optionSetReference: parseCatalogReference(set),
            proposedCommand: parsed,
          });
        } else {
          if (!o.editing) throw Error("Required Edit config missing");
          const proposedCommand = parseFullOptionSetEditCommand(parsed);
          const input = {
            ...shared,
            action: "catalog.option_set.update" as const,
            requiredFields: [
              "internalCode",
              "aggregateVersion",
              "archiveOptionReferences",
              ...fields,
            ],
            proposedCommand,
          };
          await o.editing.authority.holdUntilTransactionCompletes(t, {
            ...input,
            phase: "Intent",
            originalContent: null,
            proposedContent: null,
          });
          prepared = materializeFullOptionSetEdit(parsed, full(), {
            actorReference: id(4),
            newOptions: [
              {
                stableCode: "NEW",
                optionReference:
                  outcome === "Committed" ? id(11) : o.editing.references.generateOption(),
              },
            ],
          });
          await o.editing.authority.holdUntilTransactionCompletes(t, {
            ...input,
            phase: outcome === "Committed" ? "Replay" : "Apply",
            originalContent: full(),
            proposedContent: prepared.content,
          });
        }
        state.ownerFinished = true;
        return {
          status: outcome === "Committed" ? "Replayed" : "Applied",
          content: prepared.content,
          operationReference: parsed.operationReference,
          contentDigest: prepared.contentDigest,
          configurationDigest: prepared.configurationDigest,
          referenceEligibility: "NotEvaluated",
        };
      }),
  );
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) };
  const merchant = {
    now: () => state.now,
    transactions: {
      async run<T>(work: (t: typeof tx) => Promise<T>) {
        const result = await work(tx);
        if (state.failCommit) throw Error("Synthetic COMMIT failure");
        state.committed = true;
        return result;
      },
    },
  };
  const references: Parameters<typeof createMerchantOptionSetAuthoringCommand>[0]["references"] = {
    generate: allocation,
  };
  const options = {
    merchant: merchant as unknown as Parameters<
      typeof createMerchantOptionSetAuthoringCommand
    >[0]["merchant"],
    authentication: authentication as unknown as Parameters<
      typeof createMerchantOptionSetAuthoringCommand
    >[0]["authentication"],
    references,
  };
  const request = {
    sessionCookie: "synthetic-session",
    csrf: "synthetic-csrf",
    command: body,
    expectedScope: { brandReference: id(2), storeReference: id(3) },
  };
  const command = createMerchantOptionSetAuthoringCommand(options);
  return {
    state,
    body,
    request,
    command,
    options,
    allocation,
    current,
    capability,
    authentication,
    tx,
    merchant,
  };
}
it.each(["Create", "Edit"] as const)(
  "%s uses original host/fresh permission/feature and confirms only after outer COMMIT",
  async (action) => {
    const f = harness(action);
    const result = await f.command[action === "Create" ? "create" : "edit"](f.request);
    expect(f.state.committed).toBe(true);
    expect(result).toMatchObject({
      action,
      status: "Applied",
      referenceEligibility: "NotEvaluated",
      storeReference: id(3),
    });
    expect(f.current.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      action === "Create" ? "catalog.option_set.create" : "catalog.option_set.update",
    ]);
    expect(f.capability.holdUntilCommit).toHaveBeenCalled();
  },
);
it("original replay uses owning original clock after request time advances and never allocates again", async () => {
  const f = harness("Create", "Committed");
  f.state.now = after(1000);
  const result = await f.command.create(f.request);
  expect(result.status).toBe("Replayed");
  expect(result.content.sourceAggregate.updatedAt).toBe(at);
  expect(f.allocation).not.toHaveBeenCalled();
});
it("permanent Abandoned rejects before writing or allocation", async () => {
  const f = harness("Create", "Abandoned");
  await expect(f.command.create(f.request)).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(f.allocation).not.toHaveBeenCalled();
  expect(f.state.committed).toBe(false);
});
it.each([
  "actorReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "occurredAt",
  "reasonCode",
])("closed normal body refuses client %s", async (key) => {
  const f = harness();
  await expect(
    f.command.create({ ...f.request, command: { ...f.body, [key]: id(99) } }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.authentication.authorize).not.toHaveBeenCalled();
});
it("New Option identity cannot contain a supplied UUID", async () => {
  const f = harness("Edit");
  const edit = f.request.command as unknown as Record<string, unknown>;
  const draft = edit.draft as Record<string, unknown>;
  await expect(
    f.command.edit({
      ...f.request,
      command: {
        ...edit,
        draft: {
          ...draft,
          options: [
            { ...creation().draft.options[0], identity: { kind: "New", optionReference: id(99) } },
          ],
        },
      },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
});
it("expected scope mismatch denies source access", async () => {
  const f = harness();
  await expect(
    f.command.create({
      ...f.request,
      expectedScope: { brandReference: id(2), storeReference: id(99) },
    }),
  ).rejects.toThrow();
  expect(mocks.original).not.toHaveBeenCalled();
});
it.each(["permission", "feature"])("actual %s withdrawal denies writing", async (which) => {
  const f = harness();
  if (which === "permission") f.state.allowed = false;
  else f.state.feature = false;
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(f.state.committed).toBe(false);
  expect(f.allocation).not.toHaveBeenCalled();
});
it("outer COMMIT failure is never reported as confirmed", async () => {
  const f = harness();
  f.state.failCommit = true;
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(f.state.committed).toBe(false);
});
it("server generator is captured at factory creation", async () => {
  const f = harness();
  f.options.references.generate = () => id(99);
  const result = await f.command.create(f.request);
  expect(result.content.sourceAggregate.optionSetReference).toBe(id(6));
  expect(f.allocation).toHaveBeenCalled();
});

it("late permission withdrawal after tentative owner write vetoes outer COMMIT", async () => {
  const f = harness();
  f.state.withdrawAfterOwner = true;
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(f.state.ownerFinished).toBe(true);
  expect(f.state.committed).toBe(false);
});
it("actual shortest Feature lease remains binding during later guard", async () => {
  const f = harness();
  f.state.featureUntil = after(1000);
  f.state.expireAfterOwner = true;
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(f.state.ownerFinished).toBe(true);
  expect(f.state.committed).toBe(false);
});
it("server fresh occurrence is chosen after original global operation admission", async () => {
  const f = harness();
  mocks.original.mockImplementation(() => {
    f.state.underLock = true;
    f.state.now = after(1000);
    return { outcome: "Absent" };
  });
  const result = await f.command.create(f.request);
  expect(result.content.sourceAggregate.createdAt).toBe(after(1000));
});
it("source query substitution is refused by the immutable original host", async () => {
  const f = harness();
  mocks.original.mockImplementation((_o: Resolver, t: Tx) => {
    Object.defineProperty(t, "query", { value: async () => ({ rows: [] }) });
    return { outcome: "Absent" };
  });
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(f.state.committed).toBe(false);
  expect(f.allocation).not.toHaveBeenCalled();
});
it("Actor change is bound into exact original server identity", async () => {
  const f = harness();
  f.state.actorReference = id(99);
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(f.state.committed).toBe(false);
});

it("Edit cannot omit an existing identity instead of explicitly Archiving it", async () => {
  const f = harness("Edit");
  const edit = f.request.command as unknown as Record<string, unknown>;
  await expect(
    f.command.edit({ ...f.request, command: { ...edit, archiveOptionReferences: [] } }),
  ).rejects.toThrow();
  expect(f.state.committed).toBe(false);
});
it("short current permission lease also vetoes later source guard", async () => {
  const f = harness();
  f.state.permissionUntil = after(500);
  f.state.expireAfterOwner = true;
  f.state.featureUntil = after(500);
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(f.state.committed).toBe(false);
});
it("session denial cannot enter the current source transaction", async () => {
  const f = harness();
  f.authentication.authorize.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.command.create(f.request)).rejects.toThrow();
  expect(mocks.scope).not.toHaveBeenCalled();
  expect(f.allocation).not.toHaveBeenCalled();
});
