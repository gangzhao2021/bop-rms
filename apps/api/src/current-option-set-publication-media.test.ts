import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseBrandReference, parseStoreReference } from "@bop/tenant";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { beforeEach, expect, it, vi } from "vitest";
import {
  buildMediaOptionSetPublicationReadSnapshot,
  parseMediaOptionSetPublicationReadSnapshot,
  createMediaScope,
  mediaPublicationReadFields,
  type createPostgresMediaOptionSetPublicationReadSource,
  type MediaOptionSetPublicationReadRequest,
} from "@bop/media";
import {
  CatalogError,
  evaluateCatalogOptionSetRuleSatisfiability,
  materializeFullOptionSetCreation,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import {
  createCurrentOptionSetPublicationMediaSource,
  type CurrentOptionSetPublicationMediaOptions,
} from "./current-option-set-publication-media.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
const owner = vi.hoisted(() => ({ factory: vi.fn(), read: vi.fn() }));
vi.mock("@bop/media", async (original) => ({
  ...(await original<object>()),
  createPostgresMediaOptionSetPublicationReadSource: owner.factory,
}));
const id = (n: number) => "01902421-7981-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
type MediaOptions = Parameters<typeof createPostgresMediaOptionSetPublicationReadSource>[0];
let badRequest = false,
  cross = false,
  callbackTwice = false,
  readyMode = false;
beforeEach(() => {
  vi.clearAllMocks();
  badRequest = false;
  cross = false;
  callbackTwice = false;
  readyMode = false;
  // Controlled owning-source packets; no real IAM/scan/SQL evidence is claimed.
  owner.factory.mockImplementation((options: MediaOptions) => ({
    withCurrentReferences: owner.read.mockImplementation(
      async (
        tx: CurrentOptionSetPublicationMediaOptions["transaction"],
        request: MediaOptionSetPublicationReadRequest,
        work: (
          packet: ReturnType<typeof buildMediaOptionSetPublicationReadSnapshot>,
          actual: typeof tx,
        ) => Promise<unknown>,
      ) => {
        const hold = () =>
          options.authority.holdUntilTransactionCompletes(cross ? { query: tx.query } : tx, {
            request: badRequest ? { ...request, operationReference: id(999) } : request,
            action: "media.asset.access",
            purposeCode: "CATALOG_OPTION_SET_PUBLICATION_MEDIA_READ",
            requiredFields: mediaPublicationReadFields,
          });
        const lease = await hold();
        let done = false;
        await options.registerBeforeCommit(
          tx,
          async () => {
            await hold();
            options.clock.now();
            done = true;
          },
          () => {
            if (!done) throw new Error("guard absent");
            options.clock.now();
          },
        );
        const packet = readyMode
          ? readySnapshot(request, options.clock.now(), lease.validUntil)
          : buildMediaOptionSetPublicationReadSnapshot({
              request,
              references: request.references.map((r) => ({
                ...r,
                status: "Unavailable",
                reason: "NotFound",
              })),
              observedAt: options.clock.now(),
              validUntil: lease.validUntil,
            });
        const result = await work(packet, tx);
        if (callbackTwice) await work(packet, tx);
        return result;
      },
    ),
  }));
});
function fixture(hasMedia = true) {
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
  configure: (options: CurrentOptionSetPublicationMediaOptions) => void = () => undefined,
) {
  let clock = at,
    withdrawn = false,
    committed = false,
    lease = until,
    badDecision = "";
  let captured: CurrentOptionSetPublicationMediaOptions | undefined;
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
        reason: "ROLE_PERMISSION" as const,
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
    authorize,
    committed: () => committed,
    time: (v: string) => {
      clock = v;
    },
    withdraw: () => {
      withdrawn = true;
    },
    badDecision: (value: string) => {
      badDecision = value;
    },
    shorten: (v: string) => {
      lease = v;
    },
    options: () => captured,
    run: <T>(
      work: (source: ReturnType<typeof createCurrentOptionSetPublicationMediaSource>) => Promise<T>,
    ) =>
      host.transactions.run(async (tx) => {
        const options: CurrentOptionSetPublicationMediaOptions = {
          transaction: tx,
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          actorReference: id(4),
          sessionReference: id(6),
          operationReference: id(7),
          mediaScope: createMediaScope({
            kind: "Brand",
            brandReference: parseBrandReference(id(2)),
            storeReference: null,
          }),
          clock: { now: () => clock },
          originalValidUntil: until,
          currentAuthorization: {
            authorizeActions: async () => undefined,
            authorizeActionsWithDecisions: authorize,
            assertCurrent: () => parseCatalogInstant(clock),
            leaseDeadline: () => lease,
            async withCurrentStoreScope() {
              throw new Error("unused scope port");
            },
          },
          capability: {
            async holdUntilCommit() {
              return undefined;
            },
            leaseDeadline: () => lease,
          },
          registerBeforeCommit: host.registerBeforeCommit,
          events: { generateReference: () => id(8) },
        };
        configure(options);
        captured = options;
        return work(createCurrentOptionSetPublicationMediaSource(options));
      }),
  };
}
it("reads all recorded pins including unselected choices using the fixed Option owner, retaining concrete unavailable reasons", async () => {
  const f = runtime();
  const result = await f.run((s) => s.withCurrentAssessment(fixture(), async (v) => v));
  expect(result.nodes[0]?.snapshot.request.references).toEqual([
    {
      mediaReference: id(30),
      assetReference: id(31),
      assetVersionReference: id(32),
      cropReference: null,
      focusReference: null,
    },
  ]);
  expect(result.nodes[0]?.check.outcome).toBe("HardError");
  expect(result.nodes[0]?.findings).toEqual([{ mediaReference: id(30), reason: "NotFound" }]);
  expect(result.deliveryEligibility).toBe("NotEvaluated");
  expect(f.authorize).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.option_set.read",
    "media.asset.access",
  ]);
  expect(f.committed()).toBe(true);
});
it("empty recorded media is truthful NoReferences without inventing required-media presence", async () => {
  const f = runtime();
  const result = await f.run((s) => s.withCurrentAssessment(fixture(false), async (v) => v));
  expect(result.nodes[0]?.coverage).toBe("NoReferences");
  expect(result.nodes[0]?.check.outcome).toBe("Pass");
  expect(owner.read).toHaveBeenCalledTimes(1);
});
it.each(["root", "tuple", "graphDigest", "originalIntentScope"])(
  "rejects altered %s before owning reads",
  async (field) => {
    const f = runtime(),
      input = fixture();
    if (field === "root") input.graph.contentDigest = "sha256:" + "b".repeat(64);
    if (field === "tuple")
      input.graph.sourceSnapshotTuple.optionSetReference = parseCatalogReference(id(99));
    if (field === "graphDigest") input.graph.graphDigest = "sha256:" + "b".repeat(64);
    if (field === "originalIntentScope")
      input.binding.brandReference = parseCatalogReference(id(99));
    await expect(f.run((s) => s.withCurrentAssessment(input, async (v) => v))).rejects.toThrow();
    expect(owner.read).not.toHaveBeenCalled();
    expect(f.committed()).toBe(false);
  },
);
it.each(["permission", "expiry", "query", "port", "scope"])(
  "refuses late %s before actual host commit",
  async (change) => {
    const f = runtime();
    await expect(
      f.run((s) =>
        s.withCurrentAssessment(fixture(), async () => {
          const options = f.options();
          if (!options) throw new Error("missing captured fixture");
          if (change === "permission") f.withdraw();
          if (change === "expiry") f.time(until);
          if (change === "query") options.transaction.query = async () => ({ rows: [] });
          if (change === "port")
            options.currentAuthorization.authorizeActionsWithDecisions = async () => [];
          if (change === "scope")
            Object.assign(options, {
              mediaScope: createMediaScope({
                kind: "Store",
                brandReference: parseBrandReference(id(2)),
                storeReference: parseStoreReference(id(3)),
              }),
            });
        }),
      ),
    ).rejects.toThrow();
    expect(f.committed()).toBe(false);
  },
);
it("retains shortest actual IAM/Feature lease rather than original upper bound", async () => {
  const f = runtime();
  f.shorten("2026-10-05T12:00:02.000Z");
  const result = await f.run((s) => s.withCurrentAssessment(fixture(), async (v) => v));
  expect(result.validUntil).toBe("2026-10-05T12:00:02.000Z");
});
it.each(["request", "transaction", "callback"])(
  "rejects owning %s substitution",
  async (change) => {
    badRequest = change === "request";
    cross = change === "transaction";
    callbackTwice = change === "callback";
    const f = runtime();
    await expect(
      f.run((s) => s.withCurrentAssessment(fixture(), async (v) => v)),
    ).rejects.toThrow();
    expect(f.committed()).toBe(false);
  },
);
it("reentry poisons original guards even if consumer catches it", async () => {
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

it.each(["scope", "count", "action"])(
  "requires actual complete Brand-scoped media grant with exact %s evidence",
  async (change) => {
    const f = runtime();
    f.badDecision(change);
    await expect(
      f.run((s) => s.withCurrentAssessment(fixture(), async (v) => v)),
    ).rejects.toThrow();
    expect(owner.read).not.toHaveBeenCalled();
    expect(f.committed()).toBe(false);
  },
);

function readySnapshot(
  request: MediaOptionSetPublicationReadRequest,
  observedAt: string,
  validUntil: string,
) {
  const digest = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
  const renditions = [320, 640, 1280].flatMap((width, i) =>
    ["image/jpeg", "image/webp"].map((contentType, j) => ({
      contentType,
      width,
      height: width,
      byteSize: 100,
      checksum: "sha256:" + "a".repeat(64),
      objectEvidenceReference: id(100 + i * 4 + j * 2),
      providerObjectVersion: id(101 + i * 4 + j * 2),
    })),
  );
  const representative = renditions[4];
  if (!representative) throw new Error("missing synthetic rendition");
  const references = request.references.map((r) => ({
    ...r,
    status: "Ready",
    reason: "Ready",
    asset: {
      assetId: r.assetReference,
      purpose: "SYNTHETIC_INTERNAL_MEDIA",
      scope: request.scope,
      mediaKind: "Image",
      ownerType: "SHARED_LIBRARY",
      ownerReference: id(70),
      classification: "Internal",
    },
    assetVersion: {
      assetVersionId: r.assetVersionReference,
      assetId: r.assetReference,
      version: 1,
      ...representative,
      checkState: "Clean",
      readinessState: "Ready",
      createdAt: at,
    },
    renditions,
    provenanceDigest: "sha256:" + "b".repeat(64),
  }));
  // Version excludes rendition dimensions: retain only its owning closed fields.
  const closed = references.map((r) => ({
    ...r,
    assetVersion: {
      assetVersionId: r.assetVersion.assetVersionId,
      assetId: r.assetVersion.assetId,
      version: r.assetVersion.version,
      objectEvidenceReference: r.assetVersion.objectEvidenceReference,
      providerObjectVersion: r.assetVersion.providerObjectVersion,
      byteSize: r.assetVersion.byteSize,
      checksum: r.assetVersion.checksum,
      contentType: r.assetVersion.contentType,
      checkState: r.assetVersion.checkState,
      readinessState: r.assetVersion.readinessState,
      createdAt: r.assetVersion.createdAt,
    },
  }));
  const body = {
    profile: "MediaOptionSetPublicationReadSnapshotV1",
    request,
    references: closed,
    relevantReferenceDigest: digest(closed),
    observedAt,
    validUntil,
  };
  return parseMediaOptionSetPublicationReadSnapshot({ ...body, digest: digest(body) });
}
it("Ready preserves actual Internal classification and shared purpose/owner without inventing public delivery eligibility", async () => {
  readyMode = true;
  const f = runtime();
  const result = await f.run((s) => s.withCurrentAssessment(fixture(), async (v) => v));
  expect(result.nodes[0]?.check.outcome).toBe("Pass");
  const pin = result.nodes[0]?.snapshot.references[0];
  expect(pin?.status).toBe("Ready");
  if (pin?.status !== "Ready") throw new Error("expected controlled ready pin");
  expect(pin.asset.classification).toBe("Internal");
  expect(pin.asset.ownerReference).toBe(id(70));
  expect(pin.asset.purpose).toBe("SYNTHETIC_INTERNAL_MEDIA");
  expect(result.deliveryEligibility).toBe("NotEvaluated");
});

// Controlled complete Permission owner packets exercise composition, not native IAM.
function combinedDecisionPacket(actions: readonly string[], sequence: number) {
  return Object.freeze(
    actions.map((action) =>
      Object.freeze({
        effect: "Allow" as const,
        reason: "ROLE_PERMISSION" as const,
        source: "RolePermission" as const,
        action: parseBusinessAction(action),
        scopeKind: "Brand" as const,
        policySnapshotReference: parsePolicyReference(id(2000 + sequence)),
        policyVersion: parsePolicyVersion(sequence),
        audit: Object.freeze({
          effect: "Allow" as const,
          reason: "ROLE_PERMISSION" as const,
          source: "RolePermission" as const,
        }),
      }),
    ),
  );
}

it("uses a fresh complete combined packet at every checkpoint without duplicate standalone admission", async () => {
  let sequence = 0;
  const standalone = vi.fn(async () => {
    throw Error("duplicate standalone admission");
  });
  const batches: string[][] = [];
  const snapshots: string[] = [];
  const f = runtime((options: CurrentOptionSetPublicationMediaOptions) => {
    options.capability.holdUntilCommit = standalone;
    options.currentAuthorization.authorizeActionsWithDecisions = standalone;
    options.capability.holdUntilCommitWithDecisions = async (actions) => {
      expect(actions).toContain("catalog.manage");
      const packet = combinedDecisionPacket(actions, ++sequence);
      snapshots.push(String(packet[0]?.policySnapshotReference));
      batches.push([...actions]);
      return packet;
    };
  });
  await f.run((source) => source.withCurrentAssessment(fixture(), async (packet) => packet));
  expect(standalone).not.toHaveBeenCalled();
  expect(sequence).toBeGreaterThan(1);
  expect(new Set(snapshots).size).toBe(sequence);
  expect(batches.flat()).toContain("catalog.option_set.read");
});
it("rechecks combined current permission at the original final checkpoint", async () => {
  let sequence = 0,
    withdraw = false;
  const f = runtime((options) => {
    options.capability.holdUntilCommitWithDecisions = async (actions) => {
      if (withdraw) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return combinedDecisionPacket(actions, ++sequence);
    };
  });
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(fixture(), async (packet) => {
        withdraw = true;
        return packet;
      }),
    ),
  ).rejects.toThrow();
});
for (const malformed of [
  "missingAudit",
  "auditMismatch",
  "sparse",
  "accessor",
  "denied",
  "wrongAction",
  "badSnapshot",
  "extraField",
] as const)
  it("rejects malformed combined full evidence: " + malformed, async () => {
    const readAccessor = vi.fn();
    const f = runtime((options) => {
      options.capability.holdUntilCommitWithDecisions = async (actions) => {
        const packet = combinedDecisionPacket(actions, 1).map((row) => ({ ...row }));
        const first = packet[0];
        if (!first) throw Error("controlled empty actions");
        if (malformed === "missingAudit") Reflect.deleteProperty(first, "audit");
        if (malformed === "auditMismatch")
          Object.defineProperty(first, "audit", {
            value: { effect: "Deny", reason: "ROLE_PERMISSION", source: "RolePermission" },
            enumerable: true,
          });
        if (malformed === "sparse") Reflect.deleteProperty(packet, "0");
        if (malformed === "accessor")
          Object.defineProperty(packet, "0", {
            get() {
              readAccessor();
              return first;
            },
            enumerable: true,
          });
        if (malformed === "denied")
          Object.defineProperty(first, "effect", { value: "Deny", enumerable: true });
        if (malformed === "wrongAction")
          Object.defineProperty(first, "action", { value: "media.asset.access", enumerable: true });
        if (malformed === "badSnapshot")
          Object.defineProperty(first, "policySnapshotReference", {
            value: "bad",
            enumerable: true,
          });
        if (malformed === "extraField")
          Object.defineProperty(first, "unowned", { value: true, enumerable: true });
        return packet;
      };
    });
    await expect(
      f.run((source) => source.withCurrentAssessment(fixture(), async (packet) => packet)),
    ).rejects.toThrow();
    expect(readAccessor).not.toHaveBeenCalled();
  });
it("rejects combined port drift rather than falling back during final admission", async () => {
  const f = runtime((options) => {
    options.capability.holdUntilCommitWithDecisions = async (actions) =>
      combinedDecisionPacket(actions, 1);
  });
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(fixture(), async (packet) => {
        const options = f.options();
        if (!options) throw Error("fixture missing");
        options.capability.holdUntilCommitWithDecisions = async () => [];
        return packet;
      }),
    ),
  ).rejects.toThrow();
});
it("rejects a present non-function combined port before legacy fallback", async () => {
  const f = runtime((options) => {
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      value: 42,
      enumerable: true,
    });
  });
  await expect(
    f.run((source) => source.withCurrentAssessment(fixture(), async (packet) => packet)),
  ).rejects.toThrow();
});

it("rejects an absent-to-present combined port change after legacy admission", async () => {
  const f = runtime();
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(fixture(), async (packet) => {
        const options = f.options();
        if (!options) throw Error("fixture missing");
        options.capability.holdUntilCommitWithDecisions = async (actions) =>
          combinedDecisionPacket(actions, 1);
        return packet;
      }),
    ),
  ).rejects.toThrow();
});
it("tightens combined actual Feature lease without renewing the original window", async () => {
  const short = "2026-10-05T12:00:01.000Z";
  const f = runtime((options) => {
    options.capability.leaseDeadline = () => short;
    options.capability.holdUntilCommitWithDecisions = async (actions) =>
      combinedDecisionPacket(actions, 1);
  });
  const packet = await f.run((source) =>
    source.withCurrentAssessment(fixture(), async (packet) => packet),
  );
  expect(packet.validUntil).toBe(short);
});
