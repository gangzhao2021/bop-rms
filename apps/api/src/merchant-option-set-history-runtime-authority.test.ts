import { expect, it, vi } from "vitest";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  parseCatalogInstant,
  materializeFullOptionSetCreation,
  createCatalogFullOptionSetPublicationMaterialization,
  parseCatalogOptionSetEditorContent,
  optionSetHistoryFields,
  optionSetHistoricalDraftFields,
  optionSetHistoricalFrozenFields,
  parseCatalogOptionSetHistoryRequest,
  parseCatalogOptionSetHistoricalDraftRequest,
  parseCatalogOptionSetHistoricalFrozenRequest,
  type OptionSetHistoryStoreOptions,
} from "@rms/catalog";
import {
  createMerchantOptionSetHistoryRuntimeAuthority,
  parseMerchantOptionSetHistoryPacket,
  merchantOptionSetCatalogHistoryReads,
} from "./merchant-option-set-history-runtime-authority.js";
import { optionSetPublicationHistoryFields } from "@bop/publishing";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import type { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
const id = (n: number) => "01902421-9700-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const listCommand = {
  optionSetReference: id(6),
  expectedAggregateVersion: null,
  before: null,
  limit: 10,
};
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
    reasonCode: "INITIAL_CONFIGURATION",
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

function view(action: "List" | "Draft", validUntil = until) {
  if (action === "List")
    return {
      profile: "CatalogOptionSetHistoryV1",
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: id(6),
      currentAggregateVersion: 1,
      entries: [
        {
          resultAggregateVersion: 1,
          operationReference: id(7),
          kind: "DraftSnapshot",
          action: "Create",
          occurredAt: at,
          availability: "Complete",
          versionReference: id(8),
          sourceAggregateVersion: 1,
          ...digests(),
          recordDigest: null,
        },
      ],
      nextBefore: null,
      observedAt: at,
      validUntil,
      publicationStatus: "NotEvaluated",
    };
  return {
    profile: "CatalogOptionSetHistoricalDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(6),
    originalTuple: {
      operationReference: id(7),
      versionReference: id(8),
      resultAggregateVersion: 1,
      action: "Create",
      intentDigest: "sha256:" + "a".repeat(64),
      occurredAt: at,
    },
    content: full(),
    ...digests(),
    observedAt: at,
    validUntil,
    referenceEligibility: "NotEvaluated",
  };
}
function digests() {
  const { sourceAggregate, ...details } = full();
  const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, details);
  return {
    sourceDigest: parsed.sourceDigest,
    contentDigest: parsed.contentDigest,
    configurationDigest: parsed.configurationDigest,
  };
}
function draftCommand() {
  const d = digests();
  return {
    optionSetReference: id(6),
    operationReference: id(7),
    versionReference: id(8),
    resultAggregateVersion: 1,
    expectedSourceDigest: d.sourceDigest,
    expectedContentDigest: d.contentDigest,
    expectedConfigurationDigest: d.configurationDigest,
  };
}
function decisions(actions: readonly string[]) {
  return Object.freeze(
    actions.map((action) =>
      Object.freeze({
        effect: "Allow" as const,
        reason: "ROLE_PERMISSION" as const,
        source: "RolePermission" as const,
        action: parseBusinessAction(action),
        scopeKind: "Brand" as const,
        policySnapshotReference: parsePolicyReference(id(20)),
        policyVersion: parsePolicyVersion(1),
        audit: Object.freeze({
          effect: "Allow" as const,
          reason: "ROLE_PERMISSION" as const,
          source: "RolePermission" as const,
        }),
      }),
    ),
  );
}

// Synthetic source ports; this exercises the real holder, not native IAM or SQL.
function harness(action: "List" | "Draft" = "List") {
  const state = { now: at, allowed: true, iamUntil: until, featureUntil: until };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const current: ReturnType<typeof createMerchantProductCurrentAuthorization> = {
    assertCurrent: () => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return parseCatalogInstant(state.now);
    },
    authorizeActions: vi.fn(async () => undefined),
    leaseDeadline: () => state.iamUntil,
    withCurrentStoreScope: vi.fn(),
  };
  const capability: ReturnType<typeof createMerchantProductStoreCapabilityGuard> = {
    holdUntilCommit: vi.fn(async () => undefined),
    leaseDeadline: () => state.featureUntil,
    holdUntilCommitWithDecisions: vi.fn(async (actions) => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return decisions(actions);
    }),
  };
  const guards: { check: () => Promise<void>; final: () => void }[] = [];
  const packet = parseMerchantOptionSetHistoryPacket({
    action,
    command: action === "List" ? listCommand : draftCommand(),
  });
  const options = {
    transaction: tx,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    packet,
    clock: { now: () => state.now },
    originalObservedAt: at,
    originalValidUntil: until,
    currentAuthorization: current,
    capability,
    registerBeforeCommit: async (
      actual: Parameters<OptionSetHistoryStoreOptions["registerBeforeCommit"]>[0],
      check: () => Promise<void>,
      final?: () => void,
    ) => {
      expect(actual).toBe(tx);
      if (!final) throw Error("Missing final guard");
      guards.push({ check, final });
    },
  };
  const holder = createMerchantOptionSetHistoryRuntimeAuthority(options);
  const input = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    actorKind: "User" as const,
    permission: "catalog.manage" as const,
    action: "catalog.option_set.history.read" as const,
    purposeCode: "CATALOG_OPTION_SET_HISTORY" as const,
    requiredFields: action === "List" ? optionSetHistoryFields : optionSetHistoricalDraftFields,
    request:
      action === "List"
        ? parseCatalogOptionSetHistoryRequest(listCommand)
        : parseCatalogOptionSetHistoricalDraftRequest(draftCommand()),
    content: null as unknown,
    observedAt: at,
  };
  const hold = (value = input) => holder.authority.holdUntilTransactionCompletes(tx, value);
  async function ready() {
    await hold();
    await hold({ ...input, content: view(action) });
  }
  async function commit() {
    for (const g of guards) await g.check();
    for (const g of guards) g.final();
  }
  return { state, tx, current, capability, guards, options, holder, input, hold, ready, commit };
}
it.each(["List", "Draft"] as const)(
  "holds exact %s history fields and fresh full decisions through actual guard completion",
  async (action) => {
    const h = harness(action);
    await h.ready();
    await h.commit();
    expect(h.capability.holdUntilCommitWithDecisions).toHaveBeenCalledTimes(3);
    expect(h.capability.holdUntilCommitWithDecisions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.option_set.history.read",
    ]);
    expect(h.capability.holdUntilCommit).not.toHaveBeenCalled();
    expect(h.current.authorizeActions).not.toHaveBeenCalled();
    expect(h.holder.leaseDeadline()).toBe(until);
  },
);
it("keeps the shortest actual Feature/IAM lease without renewal", async () => {
  const h = harness();
  h.state.featureUntil = after(1500);
  h.state.iamUntil = after(2000);
  await h.ready();
  await h.commit();
  expect(h.holder.leaseDeadline()).toBe(after(1500));
  h.state.now = after(1500);
  expect(() => h.holder.leaseDeadline()).toThrow(CatalogError);
});
it("withdrawal before asynchronous final hold poisons the original holder", async () => {
  const h = harness();
  await h.ready();
  h.state.allowed = false;
  await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  h.state.allowed = true;
  expect(() => h.holder.assertCurrent()).toThrow();
});
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "purposeCode",
  "action",
  "requiredFields",
  "request",
])("rejects substituted owning %s before fresh admission", async (key) => {
  const h = harness();
  await expect(
    h.hold({
      ...h.input,
      [key]:
        key === "requiredFields"
          ? []
          : key === "request"
            ? { ...listCommand, optionSetReference: id(99) }
            : id(99),
    }),
  ).rejects.toThrow();
  expect(h.capability.holdUntilCommitWithDecisions).not.toHaveBeenCalled();
});
it("rejects a foreign historical full root even when the envelope matches", async () => {
  const h = harness("Draft");
  await h.hold();
  await expect(
    h.hold({ ...h.input, content: { ...view("Draft"), brandReference: id(99) } }),
  ).rejects.toThrow();
});
it("rejects changed captured query and combined port", async () => {
  const h = harness();
  await h.ready();
  h.tx.query = vi.fn(async () => ({ rows: [] }));
  expect(() => h.holder.assertCurrent()).toThrow();
  const p = harness();
  await p.ready();
  p.capability.holdUntilCommitWithDecisions = vi.fn(async (a) => decisions(a));
  expect(() => p.holder.assertCurrent()).toThrow();
});
it("refuses missing combined port or source lease observers", () => {
  const h = harness();
  Reflect.deleteProperty(h.capability, "holdUntilCommitWithDecisions");
  expect(() => createMerchantOptionSetHistoryRuntimeAuthority(h.options)).toThrow();
  const p = harness();
  Reflect.deleteProperty(p.current, "leaseDeadline");
  expect(() => createMerchantOptionSetHistoryRuntimeAuthority(p.options)).toThrow();
});
it("rejects a sparse or accessor decision packet without invoking getters", async () => {
  const h = harness();
  const read = vi.fn();
  h.capability.holdUntilCommitWithDecisions = vi.fn(async () => {
    const packet = Array(2);
    Object.defineProperty(packet, "0", { enumerable: true, get: read });
    return packet;
  });
  const holder = createMerchantOptionSetHistoryRuntimeAuthority(h.options);
  await expect(holder.authority.holdUntilTransactionCompletes(h.tx, h.input)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
it("rejects denied and incoherent audit full permission packets", async () => {
  for (const mode of ["denied", "audit", "snapshot"]) {
    const h = harness();
    h.capability.holdUntilCommitWithDecisions = vi.fn(async (actions) =>
      decisions(actions).map((d, i) => {
        const row = { ...d };
        if (i === 1)
          Reflect.set(
            row,
            mode === "denied" ? "effect" : mode === "audit" ? "audit" : "policySnapshotReference",
            mode === "denied"
              ? "Deny"
              : mode === "audit"
                ? { ...d.audit, source: "ExplicitAllow" }
                : "invalid",
          );
        return row;
      }),
    );
    const holder = createMerchantOptionSetHistoryRuntimeAuthority(h.options);
    await expect(holder.authority.holdUntilTransactionCompletes(h.tx, h.input)).rejects.toThrow();
  }
});
it("cannot finalize before complete content or invoke final twice", async () => {
  const h = harness();
  await h.hold();
  await expect(h.commit()).rejects.toThrow();
  const p = harness();
  await p.ready();
  await p.commit();
  expect(() => p.guards[0]?.final()).toThrow();
});
it("rejects backward clocks and original deadline expiry", async () => {
  for (const now of [after(-1), until]) {
    const h = harness();
    h.state.now = now;
    await expect(h.hold()).rejects.toThrow();
  }
});
it("closed browser packet rejects extra body fields and a fake historical tuple", () => {
  expect(() =>
    parseMerchantOptionSetHistoryPacket({
      action: "List",
      command: listCommand,
      actorReference: id(4),
    }),
  ).toThrow();
  expect(() =>
    parseMerchantOptionSetHistoryPacket({
      action: "Draft",
      command: { ...draftCommand(), expectedSourceDigest: "fake" },
    }),
  ).toThrow();
});

it("query accessor substitution is rejected without running the accessor", async () => {
  const h = harness();
  await h.ready();
  const get = vi.fn();
  Object.defineProperty(h.tx, "query", { get });
  expect(() => h.holder.assertCurrent()).toThrow();
  expect(get).not.toHaveBeenCalled();
});

it("a non-void register result poisons admission instead of accepting a fake registration", async () => {
  const h = harness();
  Reflect.set(h.options, "registerBeforeCommit", async () => "not-registered");
  const holder = createMerchantOptionSetHistoryRuntimeAuthority(h.options);
  await expect(holder.authority.holdUntilTransactionCompletes(h.tx, h.input)).rejects.toThrow();
  expect(() => holder.assertCurrent()).toThrow();
});
it("rejects reentrant authority calls during the captured combined hold", async () => {
  const h = harness();
  h.capability.holdUntilCommitWithDecisions = vi.fn(async (actions) => {
    await holder.authority.holdUntilTransactionCompletes(h.tx, h.input);
    return decisions(actions);
  });
  const holder = createMerchantOptionSetHistoryRuntimeAuthority(h.options);
  await expect(holder.authority.holdUntilTransactionCompletes(h.tx, h.input)).rejects.toThrow();
});

function frozenContent() {
  const content = full(),
    { sourceAggregate, ...details } = content,
    d = digests();
  return createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, details, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(6),
    versionReference: id(8),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(10),
    publicationIntentDigest: "sha256:" + "a".repeat(64),
    successorDraftVersionReference: id(11),
    sealedAt: at,
    ...d,
  }).content;
}
function frozenCommand() {
  const content = frozenContent();
  return {
    ...draftCommand(),
    operationReference: id(10),
    resultAggregateVersion: 2,
    expectedRecordDigest: content.digest,
  };
}
function frozenView(validUntil = until) {
  const content = frozenContent();
  return {
    profile: "CatalogOptionSetHistoricalFrozenV1",
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(6),
    originalTuple: {
      operationReference: id(10),
      versionReference: id(8),
      resultAggregateVersion: 2,
      action: "Publish",
      intentDigest: "sha256:" + "a".repeat(64),
      occurredAt: at,
    },
    content,
    ...digests(),
    recordDigest: content.digest,
    observedAt: at,
    validUntil,
    recordingStatus: "RecordedFrozen",
    referenceEligibility: "NotEvaluated",
  };
}

function extended(action: "Frozen" | "Publishing" | "Compare") {
  const h = harness();
  const packet = parseMerchantOptionSetHistoryPacket({
    action,
    command:
      action === "Frozen"
        ? frozenCommand()
        : action === "Publishing"
          ? { optionSetReference: id(6), before: null, limit: 10 }
          : {
              left: { kind: "Draft", command: draftCommand() },
              right: { kind: "Frozen", command: frozenCommand() },
            },
  });
  h.options.packet = packet;
  const holder = createMerchantOptionSetHistoryRuntimeAuthority(h.options);
  const reads = merchantOptionSetCatalogHistoryReads(packet);
  async function admit() {
    for (const read of reads) {
      const input = {
        ...h.input,
        requiredFields:
          read.kind === "List"
            ? optionSetHistoryFields
            : read.kind === "Draft"
              ? optionSetHistoricalDraftFields
              : optionSetHistoricalFrozenFields,
        request:
          read.kind === "List"
            ? parseCatalogOptionSetHistoryRequest(read.command)
            : read.kind === "Draft"
              ? parseCatalogOptionSetHistoricalDraftRequest(read.command)
              : parseCatalogOptionSetHistoricalFrozenRequest(read.command),
      };
      await holder.authority.holdUntilTransactionCompletes(h.tx, input);
      await holder.authority.holdUntilTransactionCompletes(h.tx, {
        ...input,
        content: read.kind === "Frozen" ? frozenView() : view(read.kind),
      });
    }
    if (action === "Publishing")
      await holder.publishingAuthority.holdUntilTransactionCompletes(h.tx, publishingInput());
  }
  return { ...h, holder, admit };
}
function publishingInput() {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    selectedStoreReference: id(3),
    actorReference: id(4),
    actorKind: "User" as const,
    familyReference: id(6),
    permission: "catalog.manage" as const,
    requiredPermissions: ["catalog.manage", "catalog.option_set.history.read"] as const,
    purposeCode: "CATALOG_OPTION_SET_PUBLICATION_HISTORY" as const,
    requiredFields: optionSetPublicationHistoryFields,
    observedAt: at,
    validUntil: until,
  };
}
it.each(["Frozen", "Publishing", "Compare"] as const)(
  "holds exact %s original source authority and final current admission",
  async (action) => {
    const h = extended(action);
    await h.admit();
    await h.commit();
    expect(h.holder.leaseDeadline()).toBe(until);
    expect(h.current.authorizeActions).not.toHaveBeenCalled();
    expect(h.capability.holdUntilCommit).not.toHaveBeenCalled();
  },
);
it("Publishing cannot select a family or expose header authority before owning Catalog admission", async () => {
  const h = extended("Publishing");
  await expect(
    h.holder.publishingAuthority.holdUntilTransactionCompletes(h.tx, publishingInput()),
  ).rejects.toThrow();
  const p = extended("Publishing");
  await p.admit();
  await expect(
    p.holder.publishingAuthority.holdUntilTransactionCompletes(p.tx, {
      ...publishingInput(),
      familyReference: id(99),
    }),
  ).rejects.toThrow();
});
it("Publishing requires exact fine field purpose, permissions and selected Store", async () => {
  for (const key of [
    "requiredPermissions",
    "requiredFields",
    "purposeCode",
    "selectedStoreReference",
  ]) {
    const h = extended("Publishing");
    await h.admit();
    const value = {
      ...publishingInput(),
      [key]: key === "requiredPermissions" || key === "requiredFields" ? [] : id(99),
    };
    await expect(
      h.holder.publishingAuthority.holdUntilTransactionCompletes(h.tx, value),
    ).rejects.toThrow();
  }
});
it("two original comparison selectors cannot be swapped for current Draft or another tuple", async () => {
  const h = extended("Compare");
  await expect(
    h.holder.authority.holdUntilTransactionCompletes(h.tx, {
      ...h.input,
      request: { ...draftCommand(), operationReference: id(99) },
    }),
  ).rejects.toThrow();
});
it("late withdrawal or natural source expiry poisons multi-owner comparison and timeline", async () => {
  for (const action of ["Compare", "Publishing"] as const) {
    const h = extended(action);
    await h.admit();
    h.state.allowed = false;
    await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    const p = extended(action);
    await p.admit();
    p.state.now = until;
    await expect(p.commit()).rejects.toThrow();
  }
});
it("closed comparison only accepts two original selectors with matching actual set", () => {
  expect(() =>
    parseMerchantOptionSetHistoryPacket({
      action: "Compare",
      command: {
        left: { kind: "Draft", command: draftCommand() },
        right: { kind: "Frozen", command: { ...frozenCommand(), optionSetReference: id(99) } },
      },
    }),
  ).toThrow();
  expect(() =>
    parseMerchantOptionSetHistoryPacket({
      action: "Compare",
      command: {
        left: { kind: "Draft", command: draftCommand() },
        right: { kind: "Frozen", command: frozenCommand() },
        content: full(),
      },
    }),
  ).toThrow();
});
