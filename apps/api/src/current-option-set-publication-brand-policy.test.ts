import { beforeEach, expect, it, vi } from "vitest";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  optionSetPolicyScopeLevels,
  parsePublishingOptionSetPublicationPolicy,
} from "@bop/publishing";
import {
  parseTenantOptionSetBrandConfigurationContentRequest,
  parseTenantStoreReferenceRequest,
  parseTenantStoreReferenceSnapshot,
  tenantBrandConfigurationRequiredFields,
  type createPostgresTenantOptionSetBrandConfigurationContentSource,
  type createPostgresTenantStoreReferenceSource,
} from "@bop/tenant";
import {
  CatalogError,
  evaluateCatalogOptionSetRuleSatisfiability,
  materializeFullOptionSetCreation,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import {
  createCurrentOptionSetPublicationBrandPolicySource,
  type CurrentOptionSetPublicationBrandPolicyOptions,
} from "./current-option-set-publication-brand-policy.js";
import {
  currentOptionSetPolicyFields,
  type createCurrentOptionSetPublicationPolicySource,
} from "./current-option-set-publication-policy.js";
import type { CurrentBrandConfigurationContent } from "./current-brand-configuration-content.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
const owner = vi.hoisted(() => ({
  tenant: vi.fn(),
  wrapper: vi.fn(),
  policy: vi.fn(),
  roster: vi.fn(),
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<object>()),
  createPostgresTenantOptionSetBrandConfigurationContentSource: owner.tenant,
  createPostgresTenantStoreReferenceSource: owner.roster,
}));
vi.mock("./current-brand-configuration-content.js", () => ({
  createCurrentOptionSetBrandConfigurationContentSource: owner.wrapper,
}));
vi.mock("./current-option-set-publication-policy.js", async (original) => ({
  ...(await original<object>()),
  createCurrentOptionSetPublicationPolicySource: owner.policy,
}));
const id = (n: number) => "01902421-7981-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
type BrandOptions = Parameters<
  typeof createPostgresTenantOptionSetBrandConfigurationContentSource
>[0];
type RosterOptions = Parameters<typeof createPostgresTenantStoreReferenceSource>[0];
type PolicyOptions = Parameters<typeof createCurrentOptionSetPublicationPolicySource>[0];
let policyHead = id(62),
  generation = "1",
  requiredLocales = ["en-CA"],
  requiredMedia = "Optional",
  badFields = false,
  badTx = false,
  brandLease = until,
  advance: () => void = () => undefined;
let brandCaptured: BrandOptions | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  policyHead = id(62);
  generation = "1";
  requiredLocales = ["en-CA"];
  requiredMedia = "Optional";
  badFields = false;
  badTx = false;
  brandLease = until;
  advance = () => undefined;
  brandCaptured = undefined;
  // Controlled public owner observations and authority ports, not native IAM/SQL proof.
  owner.tenant.mockImplementation((options: BrandOptions) => {
    brandCaptured = options;
    return { withRecordedConfiguration: vi.fn() };
  });
  owner.wrapper.mockImplementation(() => ({
    async withCurrentContent(
      value: unknown,
      work: (source: unknown, tx: unknown) => Promise<unknown>,
    ) {
      const request = parseTenantOptionSetBrandConfigurationContentRequest(value),
        options = brandCaptured;
      if (!options) throw new Error("missing controlled Brand source");
      return options.authority.withCurrentContentRead(
        request,
        badFields ? [] : tenantBrandConfigurationRequiredFields,
        () =>
          options.transactions.run(async (tx) => {
            await options.authority.isCurrent(
              badTx ? { query: tx.query } : tx,
              request,
              tenantBrandConfigurationRequiredFields,
            );
            advance();
            const brandConfiguration: CurrentBrandConfigurationContent = {
              profile: "CurrentBrandConfigurationContentV1",
              tenantReference: id(1),
              brandReference: id(2),
              brandVersion: 1,
              configurationVersionReference: id(50),
              configurationVersion: 1,
              contentDigest: "sha256:" + "d".repeat(64),
              originalPublicationReference: id(51),
              currentPublicationReference: id(51),
              defaultLocale: "en-CA",
              supportedLocales: ["en-CA"],
              overrideAllowedFieldCodes: [],
              hardRequirementFieldCodes: ["SYNTHETIC_REQUIRED_FIELD"],
              catalogSourceReference: id(52),
              platformTemplateReference: id(53),
              effectiveFrom: at,
              effectiveUntil: null,
              originalIntentDigest: request.originalIntentDigest,
              observedAt: request.observedAt,
              validUntil: brandLease < request.validUntil ? brandLease : request.validUntil,
              eligibility: "NotEvaluated",
            };
            return work(
              {
                profile: "CurrentOptionSetBrandConfigurationContentV1",
                publicationIntent: request,
                brandConfiguration,
                eligibility: "NotEvaluated",
              },
              tx,
            );
          }),
      );
    },
  }));
  owner.policy.mockImplementation((options: PolicyOptions) => ({
    async withCurrentPolicy(
      tx: CurrentOptionSetPublicationBrandPolicyOptions["transaction"],
      request: {
        optionSetReference: string;
        policyReference: string;
        policyVersion: number;
        observedAt: string;
      },
      work: (source: unknown) => Promise<unknown>,
    ) {
      const observation = options.clock.now(),
        evidence = await options.authority.holdUntilTransactionCompletes(tx, {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User",
          permission: "catalog.manage",
          action:
            options.qualificationAction === "Read"
              ? "catalog.option_set.read"
              : options.qualificationAction === "SubmitReview"
                ? "catalog.option_set.submit"
                : "catalog.option_set.publish",
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          ...request,
          requiredFields: currentOptionSetPolicyFields,
          observedAt: observation,
        });
      const content = parsePublishingOptionSetPublicationPolicy({
        profile: "PublishingOptionSetPublicationPolicyV1",
        tenantReference: id(1),
        brandReference: id(2),
        familyReference: id(60),
        policyReference: id(61),
        policyVersion: 1,
        scopeOrder: optionSetPolicyScopeLevels,
        approvalPolicy: "NotRequired",
        warningOverrideAllowed: false,
        requiredLocales,
        mediaRequirement: requiredMedia,
        effectiveFrom: at,
        effectiveUntil: null,
      });
      return work({
        profile: "CurrentOptionSetPublicationPolicyV1",
        content,
        currentPublicationReference: policyHead,
        optionSetReference: request.optionSetReference,
        originalObservedAt: request.observedAt,
        observedAt: observation,
        validUntil: evidence.validUntil,
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
      });
    },
  }));
  owner.roster.mockImplementation((options: RosterOptions) => ({
    async withCurrentSnapshot(value: unknown, work: (source: unknown) => Promise<unknown>) {
      const request = parseTenantStoreReferenceRequest(value);
      return options.authority.withCurrentBrandReferenceRead(request, () =>
        options.transactions.run(async (tx) => {
          await options.authority.isCurrent(tx, request);
          const roster = parseTenantStoreReferenceSnapshot({
            profile: "TenantStoreReferenceV1",
            brandReference: id(2),
            brandLifecycle: "Active",
            brandVersion: "1",
            generation,
            referenceCount: "1",
            originalIntentDigest: request.originalIntentDigest,
            observedAt: request.observedAt,
            references: [
              {
                storeReference: id(3),
                lifecycle: "Active",
                version: "1",
                createdAt: at,
                updatedAt: at,
              },
            ],
          });
          return work(roster);
        }),
      );
    },
  }));
});
function fixture(hasMedia = false) {
  const command = {
    internalCode: "SYNTH_OPTION_MEDIA",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic extras" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "EXTRA",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic unselected extra" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: false,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "EXTRA",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: hasMedia
            ? {
                mediaReference: id(30),
                assetReference: id(31),
                assetVersionReference: id(32),
                altText: { "en-CA": "Synthetic media" },
              }
            : null,
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
    operationReference: id(90),
    occurredAt: at,
    reasonCode: "AUTHORIZED_OPERATION",
  };
  const content = materializeFullOptionSetCreation(command, {
    brandReference: id(2),
    actorReference: id(4),
    allocations: {
      optionSetReference: id(10),
      versionReference: id(11),
      options: [{ stableCode: "EXTRA", optionReference: id(12) }],
    },
  }).content;
  const { sourceAggregate, ...details } = content,
    root = parseCatalogOptionSetEditorContent(sourceAggregate, details),
    graph = {
      brandReference: id(2),
      rootOptionSetReference: id(10),
      rootVersionReference: id(11),
      contents: [content],
    },
    rules = evaluateCatalogOptionSetRuleSatisfiability(graph),
    tuple = {
      tenantReference: parseCatalogReference(id(1)),
      brandReference: parseCatalogReference(id(2)),
      optionSetReference: parseCatalogReference(id(10)),
      versionReference: parseCatalogReference(id(11)),
      aggregateVersion: 1,
      sourceDigest: root.sourceDigest,
      contentDigest: root.contentDigest,
      configurationDigest: root.configurationDigest,
    };
  const packet = {
    profile: "CurrentOptionSetPublicationDraftGraphV1" as const,
    graph,
    sourceRecords: [],
    sourceOperationReference: parseCatalogReference(id(90)),
    sourceSnapshotTuple: tuple,
    aggregateVersion: 1,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
    graphDigest: rules.graphDigest,
    rules: {
      status: rules.status,
      reason: "reason" in rules ? rules.reason : null,
      searchNodes: rules.searchNodes,
    },
    originalObservedAt: at,
    observedAt: at,
    validUntil: until,
    sourceAuthority: "CurrentDraftRootAndCurrentPublishedChildren" as const,
    referenceEligibility: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
  };
  const binding = {
    ...tuple,
    expectedAggregateVersion: 1,
    graphDigest: rules.graphDigest,
    originalIntentDigest: "sha256:" + "a".repeat(64),
    observedAt: at,
    validUntil: until,
    activationAt: at,
  };
  const { aggregateVersion, ...closedBinding } = binding;
  void aggregateVersion;
  return { graph: packet, binding: closedBinding };
}
function runtime(
  qualificationAction?: CurrentOptionSetPublicationBrandPolicyOptions["qualificationAction"],
  useCombined = false,
) {
  let clock = at,
    lease = until,
    withdrawn = false,
    committed = false,
    badDecision = "";
  let combinedInvalid = "";
  const legacyCapability = vi.fn(async () => undefined);
  const combined = vi.fn(async (actions: readonly string[]) => {
    if (withdrawn) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return combinedDecisions(actions, combinedInvalid);
  });
  let captured: CurrentOptionSetPublicationBrandPolicyOptions | undefined;
  const authorize = vi.fn(async (actions: readonly string[]) => {
    if (withdrawn) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return (badDecision === "count" ? actions.slice(1) : actions).map((action) => ({
      effect: "Allow" as const,
      reason: "ROLE_PERMISSION" as const,
      source: "RolePermission" as const,
      action: parseBusinessAction(badDecision === "action" ? "catalog.manage" : action),
      scopeKind: badDecision === "scope" ? ("Store" as const) : ("Brand" as const),
      policySnapshotReference: parsePolicyReference(id(80)),
      policyVersion: parsePolicyVersion(1),
      audit: {
        effect: "Allow" as const,
        reason:
          badDecision === "audit" ? ("EXPLICIT_ALLOW" as const) : ("ROLE_PERMISSION" as const),
        source: "RolePermission" as const,
      },
    }));
  });
  const host = createMerchantCategoryTransactions({
    async run(work) {
      const tx = {
        async query<Row>() {
          return { rows: [] as Row[] };
        },
      };
      const result = await work(tx);
      committed = true;
      return result;
    },
  });
  return {
    combined,
    legacyCapability,
    invalidCombined: (value: string) => {
      combinedInvalid = value;
    },
    authorize,
    committed: () => committed,
    time: (value: string) => {
      clock = value;
    },
    shorten: (value: string) => {
      lease = value;
    },
    withdraw: () => {
      withdrawn = true;
    },
    badDecision: (value: string) => {
      badDecision = value;
    },
    options: () => captured,
    run: <T>(
      work: (
        source: ReturnType<typeof createCurrentOptionSetPublicationBrandPolicySource>,
      ) => Promise<T>,
    ) =>
      host.transactions.run(async (tx) => {
        const options: CurrentOptionSetPublicationBrandPolicyOptions = {
          transaction: tx,
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          actorReference: id(4),
          sessionReference: id(6),
          operationReference: id(7),
          policyReference: id(61),
          policyVersion: 1,
          brandConfigurationVersionReference: id(50),
          ...(qualificationAction === undefined ? {} : { qualificationAction }),
          expectedBrandVersion: 1,
          clock: { now: () => clock },
          originalValidUntil: until,
          currentAuthorization: {
            authorizeActions: async () => undefined,
            authorizeActionsWithDecisions: authorize,
            assertCurrent: () => parseCatalogInstant(clock),
            leaseDeadline: () => lease,
            async withCurrentStoreScope() {
              throw new Error("unused controlled scope");
            },
          },
          capability: {
            holdUntilCommit: legacyCapability,
            ...(useCombined ? { holdUntilCommitWithDecisions: combined } : {}),
            leaseDeadline: () => lease,
          },
          registerBeforeCommit: host.registerBeforeCommit,
          events: { generateReference: () => id(8) },
        };
        captured = options;
        return work(createCurrentOptionSetPublicationBrandPolicySource(options));
      }),
  };
}
it("composes actual public source packets and pure business assessments without promoting them to complete publish eligibility", async () => {
  const f = runtime(),
    input = fixture();
  const result = await f.run((s) => s.withCurrentAssessment(input, async (value) => value));
  expect(result.graph).toEqual(input.graph);
  expect(result.binding.observedAt).toBe(at);
  expect(result.contentPolicy.decision).toBe("PassForAssessedRules");
  expect(result.brandScope.decision).toBe("PassForAssessedBrandStoreRules");
  expect(result.brandFieldRequirements).toEqual(["SYNTHETIC_REQUIRED_FIELD"]);
  expect(
    result.permissionProvenance.every(
      (d) => d.scopeKind === "Brand" && d.audit.reason === "ROLE_PERMISSION",
    ),
  ).toBe(true);
  expect(result.eligibility).toBe("NotEvaluated");
  expect(f.committed()).toBe(true);
});
it("source read latency retains original immediate activation and reports actual later policy/roster observation", async () => {
  const f = runtime();
  advance = () => f.time("2026-10-05T12:00:00.010Z");
  const result = await f.run((s) => s.withCurrentAssessment(fixture(), async (value) => value));
  expect(result.binding.activationAt).toBe(at);
  expect(result.binding.observedAt).toBe(at);
  expect(result.policy.observedAt).toBe("2026-10-05T12:00:00.010Z");
  expect(result.storeRoster.observedAt).toBe("2026-10-05T12:00:00.010Z");
  expect(result.contentPolicy.decision).toBe("PassForAssessedRules");
});
it.each(["locale", "media"])(
  "preserves concrete %s hard errors rather than blanket owner Pass",
  async (kind) => {
    if (kind === "locale") requiredLocales = ["fr-CA"];
    if (kind === "media") requiredMedia = "Required";
    const f = runtime();
    const result = await f.run((s) => s.withCurrentAssessment(fixture(), async (value) => value));
    expect(result.contentPolicy.decision).toBe("HardError");
    expect(result.contentPolicy.checks.some((c) => c.outcome === "HardError")).toBe(true);
  },
);
it("unsupported Region membership remains explicit Indeterminate software coverage", async () => {
  const base = fixture(),
    content = base.graph.graph.contents[0];
  if (!content) throw new Error("missing full fixture");
  const { sourceAggregate, ...details } = content,
    parsed = parseCatalogOptionSetEditorContent(sourceAggregate, {
      ...details,
      scopeSet: [{ level: "Region", reference: id(90), channelCodes: [], orderTypeCodes: [] }],
    }),
    graph = { ...base.graph.graph, contents: [parsed.content] },
    rules = evaluateCatalogOptionSetRuleSatisfiability(graph);
  const input = {
    graph: {
      ...base.graph,
      graph,
      graphDigest: rules.graphDigest,
      sourceDigest: parsed.sourceDigest,
      contentDigest: parsed.contentDigest,
      configurationDigest: parsed.configurationDigest,
      sourceSnapshotTuple: {
        ...base.graph.sourceSnapshotTuple,
        sourceDigest: parsed.sourceDigest,
        contentDigest: parsed.contentDigest,
        configurationDigest: parsed.configurationDigest,
      },
    },
    binding: {
      ...base.binding,
      graphDigest: rules.graphDigest,
      sourceDigest: parsed.sourceDigest,
      contentDigest: parsed.contentDigest,
      configurationDigest: parsed.configurationDigest,
    },
  };
  const f = runtime();
  const result = await f.run((s) => s.withCurrentAssessment(input, async (value) => value));
  expect(result.brandScope.decision).toBe("Indeterminate");
  expect(result.brandScope.missingSources).toContain("RegionMembership");
});
it.each(["root", "tuple", "graphDigest", "scope"])(
  "refuses altered %s before acquiring owner facts",
  async (field) => {
    const input = fixture(),
      f = runtime();
    if (field === "root") input.graph.contentDigest = "sha256:" + "b".repeat(64);
    if (field === "tuple")
      input.graph.sourceSnapshotTuple.optionSetReference = parseCatalogReference(id(99));
    if (field === "graphDigest") input.graph.graphDigest = "sha256:" + "b".repeat(64);
    if (field === "scope") input.binding.brandReference = parseCatalogReference(id(99));
    await expect(
      f.run((s) => s.withCurrentAssessment(input, async (value) => value)),
    ).rejects.toThrow();
    expect(owner.tenant).not.toHaveBeenCalled();
    expect(f.committed()).toBe(false);
  },
);
it.each(["fields", "transaction"])("refuses owning Brand %s substitutions", async (field) => {
  badFields = field === "fields";
  badTx = field === "transaction";
  const f = runtime();
  await expect(
    f.run((s) => s.withCurrentAssessment(fixture(), async (value) => value)),
  ).rejects.toThrow();
  expect(f.committed()).toBe(false);
});
it.each(["scope", "action", "count", "audit"])(
  "requires complete exact Brand permission %s observations",
  async (value) => {
    const f = runtime();
    f.badDecision(value);
    await expect(
      f.run((s) => s.withCurrentAssessment(fixture(), async (source) => source)),
    ).rejects.toThrow();
    expect(owner.tenant).not.toHaveBeenCalled();
  },
);
it.each(["permission", "expiry", "query", "port", "pins", "roster", "policyHead"])(
  "poisons actual beforeCOMMIT after late %s changes",
  async (change) => {
    const f = runtime();
    await expect(
      f.run((s) =>
        s.withCurrentAssessment(fixture(), async () => {
          const options = f.options();
          if (!options) throw new Error("missing captured options");
          if (change === "permission") f.withdraw();
          if (change === "expiry") f.time(until);
          if (change === "query") options.transaction.query = async () => ({ rows: [] });
          if (change === "port")
            options.currentAuthorization.authorizeActionsWithDecisions = async () => [];
          if (change === "pins") Object.assign(options, { policyReference: id(99) });
          if (change === "roster") generation = "2";
          if (change === "policyHead") policyHead = id(63);
        }),
      ),
    ).rejects.toThrow();
    expect(f.committed()).toBe(false);
  },
);
it("retains actual narrower Brand effective lease", async () => {
  brandLease = "2026-10-05T12:00:02.000Z";
  const f = runtime();
  const result = await f.run((s) => s.withCurrentAssessment(fixture(), async (value) => value));
  expect(result.validUntil).toBe(brandLease);
});
it("retains narrower actual IAM and Feature deadline", async () => {
  const f = runtime();
  f.shorten("2026-10-05T12:00:02.000Z");
  const result = await f.run((s) => s.withCurrentAssessment(fixture(), async (value) => value));
  expect(result.validUntil).toBe("2026-10-05T12:00:02.000Z");
});
it("reentry poisons original operation even when caught", async () => {
  const f = runtime();
  await expect(
    f.run((s) =>
      s.withCurrentAssessment(fixture(), async () => {
        await s.withCurrentAssessment(fixture(), async () => undefined).catch(() => undefined);
      }),
    ),
  ).rejects.toThrow();
  expect(f.committed()).toBe(false);
});

it.each(["Read", "SubmitReview", "Publish"] as const)(
  "server %s qualification holds only its actual Catalog action plus read/manage",
  async (mode) => {
    const f = runtime(mode),
      r = await f.run((s) => s.withCurrentAssessment(fixture(), async (value) => value)),
      action =
        mode === "Read"
          ? "catalog.option_set.read"
          : mode === "SubmitReview"
            ? "catalog.option_set.submit"
            : "catalog.option_set.publish",
      actions = [...new Set(["catalog.manage", "catalog.option_set.read", action])].sort();
    expect(f.authorize).toHaveBeenCalledWith(actions);
    expect(r.permissionProvenance.map((d) => d.action)).toEqual(actions);
    expect(f.committed()).toBe(true);
    if (mode !== "Publish")
      expect(r.permissionProvenance.some((d) => d.action === "catalog.option_set.publish")).toBe(
        false,
      );
  },
);
it.each(["Read", "SubmitReview"] as const)(
  "late actual %s permission withdrawal still prevents COMMIT",
  async (mode) => {
    const f = runtime(mode);
    await expect(
      f.run((s) =>
        s.withCurrentAssessment(fixture(), async () => {
          f.withdraw();
          return "tentative";
        }),
      ),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.committed()).toBe(false);
  },
);
it("qualification server mode cannot change after original source admission", async () => {
  const f = runtime("Read");
  await expect(
    f.run((s) =>
      s.withCurrentAssessment(fixture(), async () => {
        const o = f.options();
        if (!o) throw Error("missing fixture options");
        Object.assign(o, { qualificationAction: "Publish" });
        return "tentative";
      }),
    ),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.committed()).toBe(false);
});
it("invalid server qualification mode is rejected before source calls", async () => {
  const f = runtime();
  await expect(
    f.run(async () => {
      const o = f.options();
      if (!o) throw Error("missing fixture options");
      Object.assign(o, { qualificationAction: "Allow" });
      return createCurrentOptionSetPublicationBrandPolicySource(o);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(owner.policy).not.toHaveBeenCalled();
});

// Controlled full public Permission decisions; every callback creates a fresh
// packet. Production owning acquisition is exercised by the separate SQL gate.
function combinedDecisions(actions: readonly string[], invalid = "") {
  const values = actions.map((action) => ({
    effect: "Allow" as const,
    reason: "ROLE_PERMISSION" as const,
    source: "RolePermission" as const,
    action: parseBusinessAction(action),
    scopeKind: "Brand" as const,
    policySnapshotReference: parsePolicyReference(id(80)),
    policyVersion: parsePolicyVersion(1),
    audit: {
      effect: "Allow" as const,
      reason: "ROLE_PERMISSION" as const,
      source: "RolePermission" as const,
    },
  }));
  if (invalid === "count") values.pop();
  if (invalid === "order") values.reverse();
  const first = values[0];
  if (first) {
    if (invalid === "deny") Object.assign(first, { effect: "Deny" });
    if (invalid === "scope") Object.assign(first, { scopeKind: "Store" });
    if (invalid === "audit") Object.assign(first.audit, { reason: "EXPLICIT_ALLOW" });
    if (invalid === "version") Object.assign(first, { policyVersion: 0 });
    if (invalid === "extra") Object.assign(first, { callerPass: true });
    if (invalid === "getter")
      Object.defineProperty(first, "action", {
        enumerable: true,
        get() {
          throw Error("Accessor must never be called");
        },
      });
  }
  if (invalid === "mutable") return values;
  for (const value of values) {
    Object.freeze(value.audit);
    Object.freeze(value);
  }
  return Object.freeze(values);
}

it("uses a fresh combined full permission checkpoint through callback and COMMIT without legacy singleton work", async () => {
  const f = runtime(undefined, true);
  await f.run((source) =>
    source.withCurrentAssessment(fixture(), async () => {
      expect(f.combined).toHaveBeenCalled();
      expect(f.legacyCapability).not.toHaveBeenCalled();
      expect(f.authorize).not.toHaveBeenCalled();
    }),
  );
  expect(f.committed()).toBe(true);
  expect(f.combined.mock.calls.length).toBeGreaterThan(1);
  expect(f.legacyCapability).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
  for (const [actions] of f.combined.mock.calls) {
    expect(actions).toContain("catalog.manage");
    expect(actions).toContain("catalog.option_set.read");
    expect(Object.isFrozen(actions)).toBe(true);
  }
});
it.each(["count", "order", "deny", "scope", "audit", "version", "extra", "getter", "mutable"])(
  "refuses malformed combined %s before acquiring owner facts",
  async (invalid) => {
    const f = runtime(undefined, true);
    f.invalidCombined(invalid);
    await expect(
      f.run((source) => source.withCurrentAssessment(fixture(), async () => undefined)),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
    expect(f.legacyCapability).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  },
);
it.each(["withdrawal", "deny", "expiry", "port"])(
  "rechecks combined %s at final current guards",
  async (change) => {
    const f = runtime(undefined, true);
    await expect(
      f.run((source) =>
        source.withCurrentAssessment(fixture(), async () => {
          if (change === "withdrawal") f.withdraw();
          if (change === "deny") f.invalidCombined("deny");
          if (change === "expiry") f.time(until);
          if (change === "port") {
            const options = f.options();
            if (!options) throw Error("Missing captured options");
            options.capability.holdUntilCommitWithDecisions = async (actions) =>
              combinedDecisions(actions);
          }
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);

it.each(["add", "remove"])(
  "rejects optional combined port %s after original capture",
  async (change) => {
    const f = runtime(undefined, change === "remove");
    await expect(
      f.run((source) =>
        source.withCurrentAssessment(fixture(), async () => {
          const options = f.options();
          if (!options) throw Error("Missing captured options");
          if (change === "remove")
            Reflect.deleteProperty(options.capability, "holdUntilCommitWithDecisions");
          else
            options.capability.holdUntilCommitWithDecisions = async (actions) =>
              combinedDecisions(actions);
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);
