import { expect, it, vi } from "vitest";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  materializeFullOptionSetEdit,
  parseFullOptionSetEditCommand,
  parseCatalogInstant,
} from "@rms/catalog";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantOptionSetAuthoringRuntimeAuthority,
  type MerchantOptionSetAuthoringPacket,
} from "./merchant-option-set-authoring-runtime-authority.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
const id = (n: number) => "01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type Options = Parameters<typeof createMerchantOptionSetAuthoringRuntimeAuthority>[0];
type Holder = ReturnType<typeof createMerchantOptionSetAuthoringRuntimeAuthority>;
type CreateInput = Parameters<Holder["creation"]["holdUntilTransactionCompletes"]>[1];
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
function command() {
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
    reasonCode: "INITIAL_CONFIGURATION",
  };
}
function full() {
  return materializeFullOptionSetCreation(command(), {
    brandReference: id(2),
    actorReference: id(4),
    allocations: {
      optionSetReference: id(6),
      versionReference: id(8),
      options: [{ stableCode: "CHOICE", optionReference: id(9) }],
    },
  }).content;
}
function editing() {
  const create = command();
  return parseFullOptionSetEditCommand({
    optionSetReference: id(6),
    expectedAggregateVersion: 1,
    draft: {
      ...create.draft,
      options: create.draft.options.map((o) => ({
        ...o,
        identity: { kind: "Existing", optionReference: id(9) },
      })),
    },
    additionalContent: create.additionalContent,
    archiveOptionReferences: [],
    operationReference: id(10),
    occurredAt: after(1),
    reasonCode: "EDIT_CONFIGURATION",
  });
}
function harness(
  packet: MerchantOptionSetAuthoringPacket = { action: "Create", command: command() },
) {
  const state = {
    now: at,
    authorizationUntil: until,
    capabilityUntil: until,
    allowed: true,
    disabled: false,
    committed: false,
  };
  const actions = vi.fn(async (_actions: readonly string[]) => {
    void _actions;
    if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  const capability = vi.fn(async () => {
    if (state.disabled) throw new MerchantProductWriteFeatureDisabled();
  });
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [];
  const host = createMerchantCategoryTransactions({
    async run(work) {
      const value = await work({
        async query<Row>() {
          return { rows: [] as readonly Row[] };
        },
      });
      state.committed = true;
      return value;
    },
  });
  return {
    state,
    actions,
    capability,
    hooks,
    run<T>(work: (holder: Holder, tx: Options["transaction"], options: Options) => Promise<T>) {
      return host.transactions.run(async (tx) => {
        const options: Options = {
          transaction: tx,
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          actorReference: id(4),
          sessionReference: id(5),
          packet,
          clock: { now: () => state.now },
          originalValidUntil: until,
          currentAuthorization: {
            authorizeActions: actions,
            assertCurrent() {
              if (state.now >= state.authorizationUntil)
                throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
              return parseCatalogInstant(state.now);
            },
            leaseDeadline: () => state.authorizationUntil,
            async withCurrentStoreScope() {
              throw new Error("unused synthetic capability scope");
            },
          },
          capability: { holdUntilCommit: capability, leaseDeadline: () => state.capabilityUntil },
          async registerBeforeCommit(actual, guard, final) {
            if (!final) throw new Error("missing final guard");
            hooks.push({ guard, final });
            await host.registerBeforeCommit(actual, guard, final);
          },
        };
        const holder = createMerchantOptionSetAuthoringRuntimeAuthority(options);
        return work(holder, tx, options);
      });
    },
  };
}
function createInput(target: string | null = null): CreateInput {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    actorKind: "User",
    permission: "catalog.manage",
    action: "catalog.option_set.create",
    purposeCode: "CATALOG_OPTION_SET_DRAFT",
    requiredFields: ["internalCode", ...fields],
    optionSetReference: target,
    proposedCommand: command(),
    observedAt: at,
  };
}
const completeCreate = async (h: Holder, tx: Options["transaction"]) => {
  await h.creation.holdUntilTransactionCompletes(tx, createInput());
  return h.creation.holdUntilTransactionCompletes(tx, createInput(id(6)));
};
it("holds real supplied sources for null Create intent then an actual owning allocation and returns only the shortest lease", async () => {
  const f = harness();
  f.state.authorizationUntil = after(3000);
  f.state.capabilityUntil = after(2000);
  const lease = await f.run(async (h, tx) => completeCreate(h, tx));
  expect(lease).toEqual({ observedAt: at, validUntil: after(2000) });
  expect(f.state.committed).toBe(true);
  expect(f.actions).toHaveBeenCalledTimes(3);
  expect(f.capability).toHaveBeenCalledTimes(3);
  for (const [actions] of f.actions.mock.calls)
    expect(actions).toEqual(["catalog.manage", "catalog.option_set.create"]);
});
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "permission",
  "action",
  "purposeCode",
  "requiredFields",
  "extra",
  "command",
])("poisons changed Create %s and preserves refusal after catch", async (field) => {
  const f = harness();
  await expect(
    f.run(async (h, tx) => {
      const input = { ...createInput() } as unknown as Record<string, unknown>;
      if (field === "extra") input.extra = true;
      else if (field === "command")
        input.proposedCommand = { ...command(), internalCode: "CHANGED" };
      else input[field] = field === "requiredFields" ? [] : "Wrong";
      await h.creation
        .holdUntilTransactionCompletes(tx, input as unknown as CreateInput)
        .catch(() => undefined);
      await completeCreate(h, tx);
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.state.committed).toBe(false);
});
it("requires null intent before allocation, refuses changing or releasing an already-bound Create target", async () => {
  for (const first of [true, false]) {
    const f = harness();
    await expect(
      f.run(async (h, tx) => {
        if (first) return h.creation.holdUntilTransactionCompletes(tx, createInput(id(6)));
        await completeCreate(h, tx);
        return h.creation.holdUntilTransactionCompletes(tx, createInput(null));
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(f.state.committed).toBe(false);
  }
});
it("captures original methods/packet so later option replacement cannot change authorization or intent", async () => {
  const source = command(),
    f = harness({ action: "Create", command: source });
  await f.run(async (h, tx, options) => {
    source.internalCode = "REPLACED";
    Object.assign(options.currentAuthorization, {
      authorizeActions: vi.fn(() => {
        throw Error("replacement");
      }),
      leaseDeadline: () => after(9000),
    });
    Object.assign(options.capability, {
      holdUntilCommit: vi.fn(() => {
        throw Error("replacement");
      }),
    });
    Object.assign(options, { clock: { now: () => after(9000) } });
    await completeCreate(h, tx);
  });
  expect(f.state.committed).toBe(true);
  expect(f.actions).toHaveBeenCalledTimes(3);
});
it.each(["authorization", "capability"])(
  "fails closed without the real %s lease accessor",
  async (port) => {
    const f = harness();
    await expect(
      f.run(async (_h, _tx, options) => {
        const supplied = {
          ...options,
          currentAuthorization: { ...options.currentAuthorization },
          capability: { ...options.capability },
        };
        if (port === "authorization") delete supplied.currentAuthorization.leaseDeadline;
        else delete supplied.capability.leaseDeadline;
        createMerchantOptionSetAuthoringRuntimeAuthority(supplied);
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(f.actions).not.toHaveBeenCalled();
    expect(f.state.committed).toBe(false);
  },
);
it.each(["denied", "disabled", "expired", "rollbackClock"])(
  "refuses %s between work and the actual precommit guard",
  async (condition) => {
    const f = harness();
    await expect(
      f.run(async (h, tx) => {
        await completeCreate(h, tx);
        if (condition === "denied") f.state.allowed = false;
        if (condition === "disabled") f.state.disabled = true;
        if (condition === "expired") f.state.now = until;
        if (condition === "rollbackClock") f.state.now = "2026-10-05T11:59:59.999Z";
      }),
    ).rejects.toSatisfy((error: unknown) =>
      condition === "disabled"
        ? error instanceof MerchantProductWriteFeatureDisabled
        : error instanceof CatalogError,
    );
    expect(f.state.committed).toBe(false);
  },
);
it("does not renew an earlier shortened deadline on later holds or later final assertions", async () => {
  const f = harness();
  f.state.authorizationUntil = after(1500);
  await expect(
    f.run(async (h, tx, options) => {
      await h.creation.holdUntilTransactionCompletes(tx, createInput());
      f.state.authorizationUntil = until;
      const lease = await h.creation.holdUntilTransactionCompletes(tx, createInput(id(6)));
      expect(lease.validUntil).toBe(after(1500));
      await options.registerBeforeCommit(
        tx,
        async () => {
          f.state.now = after(1500);
        },
        () => undefined,
      );
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.state.committed).toBe(false);
});
it("poisons a duplicate precommit guard after its asynchronous check completed", async () => {
  const f = harness();
  await expect(
    f.run(async (h, tx) => {
      await completeCreate(h, tx);
      await f.hooks[0]?.guard();
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.state.committed).toBe(false);
});
it("reads only the actual full content and exact current target/version under the read action", async () => {
  const content = full(),
    f = harness({
      action: "Read",
      command: { optionSetReference: id(6), expectedAggregateVersion: 1 },
    });
  await f.run(async (h, tx) => {
    const input = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User" as const,
      permission: "catalog.manage" as const,
      action: "catalog.option_set.read" as const,
      purposeCode: "CATALOG_OPTION_SET_DRAFT" as const,
      requiredFields: [
        "internalCode",
        "brandReference",
        "lifecycle",
        "aggregateVersion",
        "createdAt",
        "createdByActorReference",
        "updatedAt",
        ...fields,
      ],
      optionSetReference: id(6),
      content: null as unknown,
      observedAt: at,
    };
    await h.reading.holdUntilTransactionCompletes(tx, input);
    await h.reading.holdUntilTransactionCompletes(tx, { ...input, content });
  });
  expect(f.state.committed).toBe(true);
  expect(f.actions).toHaveBeenLastCalledWith(["catalog.manage", "catalog.option_set.read"]);
});
it.each(["Apply", "Replay"] as const)(
  "binds Edit %s to the original parsed command and immutable complete baseline/candidate",
  async (phase) => {
    const command = editing(),
      original = full(),
      proposed = materializeFullOptionSetEdit(command, original, {
        actorReference: id(4),
        newOptions: [],
      }).content;
    const f = harness({ action: "Edit", command });
    f.state.now = after(1);
    await f.run(async (h, tx) => {
      const input = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User" as const,
        permission: "catalog.manage" as const,
        action: "catalog.option_set.update" as const,
        purposeCode: "CATALOG_OPTION_SET_DRAFT" as const,
        requiredFields: ["internalCode", "aggregateVersion", "archiveOptionReferences", ...fields],
        phase: "Intent" as const,
        proposedCommand: command,
        originalContent: null,
        proposedContent: null,
        observedAt: after(1),
      };
      await h.editing.holdUntilTransactionCompletes(tx, input);
      await h.editing.holdUntilTransactionCompletes(tx, {
        ...input,
        phase,
        originalContent: original,
        proposedContent: proposed,
      });
    });
    expect(f.state.committed).toBe(true);
    expect(f.actions).toHaveBeenLastCalledWith(["catalog.manage", "catalog.option_set.update"]);
  },
);
it("cannot finish a read, create or edit transaction with only initial observation", async () => {
  for (const packet of [
    { action: "Create", command: command() },
    { action: "Read", command: { optionSetReference: id(6), expectedAggregateVersion: null } },
  ] as const) {
    const f = harness(packet);
    await expect(
      f.run(async (h, tx) => {
        if (packet.action === "Create")
          await h.creation.holdUntilTransactionCompletes(tx, createInput());
        else
          await h.reading.holdUntilTransactionCompletes(tx, {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: id(4),
            actorKind: "User",
            permission: "catalog.manage",
            action: "catalog.option_set.read",
            purposeCode: "CATALOG_OPTION_SET_DRAFT",
            requiredFields: [
              "internalCode",
              "brandReference",
              "lifecycle",
              "aggregateVersion",
              "createdAt",
              "createdByActorReference",
              "updatedAt",
              ...fields,
            ],
            optionSetReference: id(6),
            content: null,
            observedAt: at,
          });
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(f.state.committed).toBe(false);
  }
});
it("refuses synchronous final assertion while the required asynchronous source recheck remains pending", async () => {
  const f = harness();
  let release: (() => void) | undefined;
  await expect(
    f.run(async (h, tx) => {
      await completeCreate(h, tx);
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.capability.mockImplementation(async () => {
        await waiting;
      });
      const pending = f.hooks[0]?.guard();
      await Promise.resolve();
      expect(() => f.hooks[0]?.final()).toThrow(CatalogError);
      release?.();
      await pending?.catch(() => undefined);
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.state.committed).toBe(false);
});
it("rejects a different transaction and poisons subsequent ordinary holds", async () => {
  const f = harness();
  await expect(
    f.run(async (h, tx) => {
      await h.creation
        .holdUntilTransactionCompletes({ ...tx }, createInput())
        .catch(() => undefined);
      await completeCreate(h, tx);
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.actions).not.toHaveBeenCalled();
  expect(f.state.committed).toBe(false);
});
it("refuses an Edit baseline or candidate from another Brand even after an earlier valid Intent", async () => {
  const command = editing(),
    original = full(),
    proposed = materializeFullOptionSetEdit(command, original, {
      actorReference: id(4),
      newOptions: [],
    }).content;
  const f = harness({ action: "Edit", command });
  f.state.now = after(1);
  await expect(
    f.run(async (h, tx) => {
      const input = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User" as const,
        permission: "catalog.manage" as const,
        action: "catalog.option_set.update" as const,
        purposeCode: "CATALOG_OPTION_SET_DRAFT" as const,
        requiredFields: ["internalCode", "aggregateVersion", "archiveOptionReferences", ...fields],
        phase: "Intent" as const,
        proposedCommand: command,
        originalContent: null,
        proposedContent: null,
        observedAt: after(1),
      };
      await h.editing.holdUntilTransactionCompletes(tx, input);
      await h.editing.holdUntilTransactionCompletes(tx, {
        ...input,
        phase: "Apply",
        originalContent: {
          ...original,
          sourceAggregate: { ...original.sourceAggregate, brandReference: id(88) as never },
        },
        proposedContent: proposed,
      });
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.state.committed).toBe(false);
});
