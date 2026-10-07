import { expect, it, vi } from "vitest";
import {
  CatalogError,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createCurrentOptionSetPublicationPriceInventorySource as create,
  type CurrentOptionSetPublicationPriceInventoryOptions as Options,
} from "./current-option-set-publication-price-inventory.js";
type Graph = Parameters<ReturnType<typeof create>["withCurrentAssessment"]>[0]["graph"];
const id = (n: number) => "01902421-6781-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
function node(n: number, references: boolean, child: number | null = null) {
  return parseCatalogOptionSetEditorContent(
    {
      optionSetReference: id(n),
      brandReference: id(2),
      internalCode: "SET_" + n,
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(4),
      updatedAt: at,
      draft: {
        versionReference: id(n + 1),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic choices" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        createdAt: at,
        updatedAt: at,
        options: [
          {
            optionReference: id(n + 2),
            optionSetReference: id(n),
            brandReference: id(2),
            stableCode: "CHOICE",
            lifecycle: "Inactive",
            localizedNames: { "en-CA": "Synthetic choice" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: false,
            triggeredOptionSetReference: child === null ? null : id(child),
            conflictOptionReferences: [],
            createdAt: at,
            createdByActorReference: id(4),
          },
        ],
      },
    },
    {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          optionReference: id(n + 2),
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: references ? { reference: id(400), versionReference: id(401) } : null,
          consumption: references
            ? {
                kind: "Inventory",
                reference: id(500),
                versionReference: id(501),
                quantity: "2",
                unitCode: "CASE",
              }
            : null,
          triggeredOptionSetVersionReference: child === null ? null : id(child + 1),
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
  );
}
function input(references = true, childReferences = false) {
  const root = node(100, references, childReferences ? 200 : null),
    graphValue = {
      brandReference: id(2),
      rootOptionSetReference: id(100),
      rootVersionReference: id(101),
      contents: childReferences ? [root.content, node(200, true).content] : [root.content],
    },
    rule = evaluateCatalogOptionSetRuleSatisfiability(graphValue),
    tuple = {
      tenantReference: parseCatalogReference(id(1)),
      brandReference: parseCatalogReference(id(2)),
      optionSetReference: root.content.sourceAggregate.optionSetReference,
      versionReference: root.content.sourceAggregate.draft.versionReference,
      aggregateVersion: 1,
      sourceDigest: root.sourceDigest,
      contentDigest: root.contentDigest,
      configurationDigest: root.configurationDigest,
    };
  // Supplied held graph fixture: owning SQL/current IAM proof belongs to native
  // acceptance. Pricing/Inventory factories and pure validators below are real.
  const graph: Graph = {
    profile: "CurrentOptionSetPublicationDraftGraphV1",
    graph: graphValue,
    sourceRecords: [],
    sourceOperationReference: parseCatalogReference(id(90)),
    sourceSnapshotTuple: tuple,
    aggregateVersion: 1,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
    graphDigest: rule.graphDigest,
    rules: {
      status: rule.status,
      reason: "reason" in rule ? rule.reason : null,
      searchNodes: rule.searchNodes,
    },
    originalObservedAt: at,
    observedAt: at,
    validUntil: until,
    sourceAuthority: "CurrentDraftRootAndCurrentPublishedChildren",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  };
  return {
    graph,
    binding: {
      ...tuple,
      expectedAggregateVersion: 1,
      aggregateVersion: undefined,
      graphDigest: rule.graphDigest,
      originalIntentDigest: digest,
      observedAt: at,
      validUntil: until,
      activationAt: "2026-10-05T12:00:04.000Z",
    },
  };
}
function closedInput(references = true, childReferences = false) {
  const value = input(references, childReferences),
    { aggregateVersion, ...binding } = value.binding;
  void aggregateVersion;
  return { graph: value.graph, binding };
}
function fixture(configure: (options: Options) => void = () => undefined) {
  let clock = at,
    deny = "",
    committed = false,
    changed = false,
    generation = "1",
    multiplier = "6",
    pricing = false,
    storeDecision = false,
    priceExpiry: string | null = null,
    inventoryActive = true,
    conversionAvailable = true,
    currentPriceVersion: string | null = id(401);
  const sqlCalls: string[] = [];
  const scope = { tenantReference: id(1), brandReference: id(2) };
  const query = vi.fn(
    async <T extends Record<string, unknown>>(sql: string): Promise<{ rows: readonly T[] }> => {
      sqlCalls.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.includes(" AS units"))
        rows = [
          {
            units: {
              items: [
                {
                  itemReference: id(500),
                  itemVersion: "1",
                  operationReference: id(501),
                  recordedAt: at,
                  precise: true,
                  baseUnit: {
                    unitCode: "EA",
                    dimension: "Count",
                    displayPrecision: 0,
                    ledgerPrecision: 0,
                    roundingMode: "HalfEven",
                  },
                  unitConversions: conversionAvailable
                    ? [
                        {
                          conversionReference: id(502),
                          fromUnitCode: "CASE",
                          toBaseUnitCode: "EA",
                          multiplier,
                          effectiveFrom: at,
                          reasonCode: "INITIAL_CONFIGURATION",
                          status: "Active",
                        },
                      ]
                    : [],
                },
              ],
            },
          },
        ];
      else if (sql.includes(" AS header")) rows = [{ header: { generation } }];
      else if (sql.includes("'counts'"))
        rows = [
          {
            source: {
              generation: "1",
              observedAt: at,
              counts: { items: "1", versions: "1", operations: "1" },
              items: [
                {
                  ...scope,
                  itemReference: id(500),
                  itemType: "FinishedGood",
                  createdAt: at,
                  precise: true,
                },
              ],
              versions: [
                {
                  ...scope,
                  itemReference: id(500),
                  itemVersion: "1",
                  itemType: "FinishedGood",
                  lifecycle: inventoryActive ? "Active" : "Inactive",
                  recordedAt: at,
                  precise: true,
                },
              ],
              operations: [
                {
                  ...scope,
                  itemReference: id(500),
                  itemVersion: "1",
                  operationReference: id(501),
                  action: "Create",
                },
              ],
            },
          },
        ];
      else if (sql.includes("has_source"))
        rows = [{ generation: pricing ? "1" : "0", has_source: pricing }];
      else if (
        pricing &&
        sql.startsWith("SELECT jsonb_build_object('observedAt'") &&
        sql.includes("FROM rms_pricing.option_price_rule")
      )
        rows = [
          {
            source: {
              observedAt: at,
              references: [
                {
                  root: {
                    ruleReference: id(400),
                    brandReference: id(2),
                    bindingReference: id(990),
                    optionReference: id(102),
                    aggregateVersion: "1",
                    currentVersionReference: currentPriceVersion,
                    rootCreatedAt: at,
                    updatedAt: at,
                  },
                  version: {
                    versionReference: id(401),
                    versionNumber: "1",
                    snapshotDigest: digest,
                    lifecycle: "Published",
                    skuReference: null,
                    scopeKind: "Brand",
                    scopeReference: null,
                    channelCode: null,
                    orderType: null,
                    timeZone: "UTC",
                    effectiveFrom: at,
                    effectiveUntil: priceExpiry,
                    createdAt: at,
                  },
                  precise: true,
                },
              ],
            },
          },
        ];
      else if (sql.startsWith("SELECT jsonb_build_object('observedAt'"))
        rows = [{ source: { observedAt: at, references: [] } }];
      // Controlled SQL result materialization, not a production source or decision.
      return { rows: rows as T[] };
    },
  );
  const authorize = vi.fn(async (actions: readonly string[]) => {
    if (actions.includes(deny)) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  const host = createMerchantCategoryTransactions({
    async run(work) {
      const result = await work({ query });
      committed = true;
      return result;
    },
  });
  let captured: Options | undefined;
  const run = <T>(work: (source: ReturnType<typeof create>) => Promise<T>) =>
    host.transactions.run(async (tx) => {
      const options: Options = {
        transaction: tx,
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        actorReference: id(4),
        sessionReference: id(6),
        operationReference: id(7),
        clock: { now: () => clock },
        originalValidUntil: until,
        currentAuthorization: {
          authorizeActions: authorize,
          async authorizeActionsWithDecisions(actions) {
            await authorize(actions);
            return actions.map((action) => ({
              effect: "Allow" as const,
              reason: "ROLE_PERMISSION" as const,
              source: "RolePermission" as const,
              action: parseBusinessAction(action),
              scopeKind: storeDecision ? ("Store" as const) : ("Brand" as const),
              policySnapshotReference: parsePolicyReference(id(9)),
              policyVersion: parsePolicyVersion(1),
              audit: {
                effect: "Allow" as const,
                reason: "ROLE_PERMISSION" as const,
                source: "RolePermission" as const,
              },
            }));
          },
          assertCurrent: () => parseCatalogInstant(clock),
          leaseDeadline: () => until,
          async withCurrentStoreScope() {
            throw Error("controlled unused scope");
          },
        },
        capability: {
          async holdUntilCommit() {
            if (changed) throw Error("controlled Feature withdrawn");
          },
          leaseDeadline: () => until,
        },
        registerBeforeCommit: host.registerBeforeCommit,
        events: { generateReference: () => id(8) },
      };
      configure(options);
      captured = options;
      return work(create(options));
    });
  return {
    run,
    query,
    sqlCalls,
    authorize,
    committed: () => committed,
    deny: (action: string) => {
      deny = action;
    },
    time: (value: string) => {
      clock = value;
    },
    feature: () => {
      changed = true;
    },
    generation: () => {
      generation = "2";
    },
    multiplier: () => {
      multiplier = "0.333";
    },
    pricing: () => {
      pricing = true;
    },
    storeDecision: () => {
      storeDecision = true;
    },
    priceExpiry: (value: string) => {
      priceExpiry = value;
    },
    inactiveInventory: () => {
      inventoryActive = false;
    },
    missingConversion: () => {
      conversionAvailable = false;
    },
    stalePrice: () => {
      currentPriceVersion = null;
    },
    options: () => {
      if (!captured) throw Error("fixture not entered");
      return captured;
    },
  };
}
it("holds real public source factories, all inactive choice pins and exact units without claiming full eligibility", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(), async (packet) => {
      const node = packet.nodes[0];
      expect(node).toBeDefined();
      expect(node?.price?.references[0]?.status).toBe("MissingRule");
      expect(node?.price?.bindingMembership).toBe("NotEvaluated");
      expect(node?.inventory?.matches[0]?.status).toBe("CurrentActiveMetadata");
      expect(node?.inventoryUnits?.matches[0]?.status).toBe("ExactBaseQuantity");
      expect(packet.operationReference).toBe(id(7));
      expect(node?.inventory?.sourceOperationReference).toBe(id(7));
      expect(packet.eligibility).toBe("NotEvaluated");
      expect(packet.publishValidation).toBe("Incomplete");
    }),
  );
  expect(f.committed()).toBe(true);
  expect(f.authorize.mock.calls.flatMap(([actions]) => actions)).toEqual(
    expect.arrayContaining([
      "catalog.manage",
      "catalog.option_set.read",
      "pricing.price-book.manage",
      "pricing.promotion.manage",
      "inventory.item.read",
      "inventory.item.history.read",
    ]),
  );
});
it("derives applicable pins from child nodes even when the root has no references", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(false, true), async (packet) => {
      expect(packet.nodes.map((n) => n.priceCoverage)).toEqual(["NoReferences", "AllRecordedPins"]);
      expect(packet.nodes[1]?.inventoryUnits?.matches).toHaveLength(1);
      expect(packet.nodes[1]?.price?.optionSetReference).toBe(id(200));
    }),
  );
});
it("reports true NoReferences without acquiring invented empty owning packets", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(false), async (packet) => {
      expect(packet.nodes[0]).toMatchObject({
        price: null,
        inventory: null,
        inventoryUnits: null,
        priceCoverage: "NoReferences",
        inventoryCoverage: "NoReferences",
      });
    }),
  );
  expect(f.sqlCalls).toHaveLength(0);
});
it.each([
  "pricing.price-book.manage",
  "pricing.promotion.manage",
  "inventory.item.read",
  "inventory.item.history.read",
  "catalog.option_set.read",
])("refuses late withdrawal of %s before outer commit", async (action) => {
  const f = fixture();
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(closedInput(), async () => {
        f.deny(action);
      }),
    ),
  ).rejects.toThrow();
  expect(f.committed()).toBe(false);
});
it.each([
  "deadline",
  "clockBack",
  "Feature",
  "query",
  "clockPort",
  "operation",
  "sourceGeneration",
])("poisons late %s despite a swallowed source refusal", async (cause) => {
  const f = fixture();
  await expect(
    f.run(async (source) => {
      await source
        .withCurrentAssessment(closedInput(), async () => {
          if (cause === "deadline") f.time(until);
          if (cause === "clockBack") f.time("2026-10-05T11:59:59.999Z");
          if (cause === "Feature") f.feature();
          if (cause === "query") f.options().transaction.query = async () => ({ rows: [] });
          if (cause === "clockPort") f.options().clock.now = () => at;
          if (cause === "operation") Object.assign(f.options(), { operationReference: id(99) });
          if (cause === "sourceGeneration") f.generation();
        })
        .catch(() => undefined);
    }),
  ).rejects.toThrow();
  expect(f.committed()).toBe(false);
});
it.each([
  "brandReference",
  "optionSetReference",
  "versionReference",
  "sourceDigest",
  "graphDigest",
  "originalIntentDigest",
])("rejects changed %s binding without acquiring sources", async (field) => {
  const f = fixture(),
    value = closedInput();
  const changed = {
    ...value,
    binding: { ...value.binding, [field]: field.includes("Digest") ? "invalid" : id(99) },
  };
  await expect(
    f.run((source) => source.withCurrentAssessment(changed, async () => undefined)),
  ).rejects.toThrow();
  expect(f.sqlCalls).toHaveLength(0);
});
it("rejects a second use and preserves the poisoned outer transaction", async () => {
  const f = fixture();
  await expect(
    f.run(async (source) => {
      await source.withCurrentAssessment(closedInput(false), async () => undefined);
      await source
        .withCurrentAssessment(closedInput(false), async () => undefined)
        .catch(() => undefined);
    }),
  ).rejects.toThrow();
  expect(f.committed()).toBe(false);
});

it("retains actual Published price metadata without requiring independent Option Product Binding or SKU", async () => {
  const f = fixture();
  f.pricing();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(), async (packet) => {
      expect(packet.nodes[0]?.price?.references[0]?.status).toBe("CurrentPublishedMetadata");
      expect(packet.nodes[0]?.price?.decision).toBe("PassForMetadata");
      expect(packet.nodes[0]?.price?.skuMembership).toBe("NotEvaluated");
      expect(packet.eligibility).toBe("NotEvaluated");
    }),
  );
});
it("retains genuine unit rounding refusal instead of inventing exact consumption", async () => {
  const f = fixture();
  f.multiplier();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(), async (packet) => {
      expect(packet.nodes[0]?.inventoryUnits?.matches[0]?.status).toBe("RoundingRequired");
      expect(packet.nodes[0]?.inventoryUnits?.unitArithmetic).toBe("HardError");
    }),
  );
});
it("rejects a global graph larger than32 nodes before any owning acquisition", async () => {
  const f = fixture(),
    value = closedInput(false);
  const graph = {
    ...value.graph,
    graph: {
      ...value.graph.graph,
      contents: Array.from({ length: 33 }, (_, i) => node(100 + i * 10, false).content),
    },
  };
  await expect(
    f.run((source) => source.withCurrentAssessment({ ...value, graph }, async () => undefined)),
  ).rejects.toThrow();
  expect(f.sqlCalls).toHaveLength(0);
});
it("uses the shortest original graph lease rather than issuing a fresh source deadline", async () => {
  const f = fixture(),
    value = closedInput(false),
    short = "2026-10-05T12:00:01.000Z";
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(
        { ...value, graph: { ...value.graph, validUntil: short } },
        async (packet) => {
          expect(packet.validUntil).toBe(short);
          f.time(short);
        },
      ),
    ),
  ).rejects.toThrow();
  expect(f.committed()).toBe(false);
});
it("preserves all32 graph nodes and distinct per-node NoReferences coverage", async () => {
  const f = fixture(),
    value = closedInput(false),
    root = node(100, false, 110);
  const graphValue = {
    ...value.graph.graph,
    contents: Array.from(
      { length: 32 },
      (_, i) => node(100 + i * 10, false, i === 31 ? null : 110 + i * 10).content,
    ),
  };
  const rule = evaluateCatalogOptionSetRuleSatisfiability(graphValue);
  const tuple = {
    ...value.graph.sourceSnapshotTuple,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
  };
  const graph: Graph = {
    ...value.graph,
    graph: graphValue,
    sourceSnapshotTuple: tuple,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
    graphDigest: rule.graphDigest,
  };
  const binding = {
    ...value.binding,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
    graphDigest: rule.graphDigest,
  };
  await f.run((source) =>
    source.withCurrentAssessment({ graph, binding }, async (packet) => {
      expect(packet.nodes).toHaveLength(32);
      expect(
        packet.nodes.every(
          (n) => n.priceCoverage === "NoReferences" && n.inventoryCoverage === "NoReferences",
        ),
      ).toBe(true);
    }),
  );
  expect(f.sqlCalls).toHaveLength(0);
});
it("rejects a substituted Store decision despite a positive-looking permission effect", async () => {
  const f = fixture();
  f.storeDecision();
  await expect(
    f.run((source) => source.withCurrentAssessment(closedInput(), async () => undefined)),
  ).rejects.toThrow();
  expect(f.committed()).toBe(false);
  expect(f.sqlCalls).toHaveLength(0);
});

it("keeps original immediate activation through forward real owner reads without extending its lease", async () => {
  const f = fixture();
  f.pricing();
  f.time("2026-10-05T12:00:01.000Z");
  const input = closedInput();
  input.binding.activationAt = at;
  await f.run((source) =>
    source.withCurrentAssessment(input, async (packet) => {
      expect(packet.binding.activationAt).toBe(at);
      expect(packet.nodes[0]?.price?.decision).toBe("PassForMetadata");
      expect(packet.nodes[0]?.inventory?.decision).toBe("PassForMetadata");
      expect(packet.nodes[0]?.inventoryUnits?.unitArithmetic).toBe("Pass");
      expect(packet.nodes[0]?.inventoryUnits?.assessedAt).toBe("2026-10-05T12:00:01.000Z");
      expect(packet.validUntil).toBe(until);
    }),
  );
});

it("reports independent publication reference checks from exact owning facts without changing Product/sale evidence", async () => {
  const f = fixture();
  f.pricing();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(), async (packet) => {
      expect(packet.standaloneReferenceAssessment).toMatchObject({
        phase: "OptionSetPublication",
        decision: "Pass",
        productBinding: "NotApplicableForIndependentOptionSet",
        skuMembership: "NotApplicableForIndependentOptionSet",
        saleQuote: "NotApplicableForIndependentOptionSet",
        inventoryBalance: "NotApplicableForIndependentOptionSet",
      });
      expect(packet.standaloneReferenceAssessment.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "PRICE_PIN_CURRENT_EFFECTIVE",
            outcome: "Satisfied",
            optionReference: id(102),
            reference: id(400),
            reasonCode: "CurrentPublishedMetadata",
          }),
          expect.objectContaining({
            code: "INVENTORY_PIN_CURRENT_ACTIVE",
            outcome: "Satisfied",
            reference: id(500),
          }),
          expect.objectContaining({
            code: "INVENTORY_CONFIGURED_QUANTITY_UNITS",
            outcome: "Satisfied",
            reasonCode: "ExactBaseQuantity",
          }),
        ]),
      );
      expect(packet.nodes[0]?.price?.bindingMembership).toBe("NotEvaluated");
      expect(packet.nodes[0]?.price?.priceAmounts).toBe("NotEvaluated");
      expect(packet.nodes[0]?.inventoryUnits?.quantityPolicy).toBe("NotEvaluated");
      expect(packet.eligibility).toBe("NotEvaluated");
    }),
  );
});
it.each(["MissingRule", "InactiveItem", "MissingConversion", "RoundingRequired"])(
  "reports concrete %s refusal rather than renaming metadata Pass",
  async (reason) => {
    const f = fixture();
    if (reason !== "MissingRule") f.pricing();
    if (reason === "InactiveItem") f.inactiveInventory();
    if (reason === "MissingConversion") f.missingConversion();
    if (reason === "RoundingRequired") f.multiplier();
    await f.run((source) =>
      source.withCurrentAssessment(closedInput(), async (packet) => {
        expect(packet.standaloneReferenceAssessment.decision).toBe("HardError");
        expect(packet.standaloneReferenceAssessment.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "HardError", reasonCode: reason }),
          ]),
        );
        if (reason === "InactiveItem") {
          expect(packet.nodes[0]).toMatchObject({
            inventoryCoverage: "AllRecordedPins",
            inventoryUnitCoverage: "BlockedByReferenceErrors",
            inventoryUnits: null,
          });
          expect(packet.nodes[0]?.inventory?.matches[0]?.status).toBe("InactiveItem");
        }
      }),
    );
  },
);
it("does not waive invalid child pins because the root has no price or Inventory references", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(false, true), async (packet) => {
      expect(packet.standaloneReferenceAssessment.decision).toBe("HardError");
      expect(packet.standaloneReferenceAssessment.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "PRICE_PIN_CURRENT_EFFECTIVE",
            outcome: "HardError",
            optionSetReference: id(200),
            optionReference: id(202),
            reasonCode: "MissingRule",
          }),
        ]),
      );
    }),
  );
});
it("limits true NoReferences success to declared reference presence", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(false), async (packet) => {
      expect(packet.standaloneReferenceAssessment.decision).toBe("Pass");
      expect(
        packet.standaloneReferenceAssessment.checks.every(
          (value) =>
            value.reasonCode === "NoReferences" &&
            value.optionReference === null &&
            value.reference === null,
        ),
      ).toBe(true);
      expect(packet.publishValidation).toBe("Incomplete");
    }),
  );
});
it.each(["callback", "outer"])(
  "retains pinned price's earlier half-open expiry through late %s checks",
  async (phase) => {
    const f = fixture(),
      value = closedInput();
    f.pricing();
    const expiry = "2026-10-05T12:00:03.000Z";
    f.priceExpiry(expiry);
    value.binding.activationAt = at;
    await expect(
      f.run(async (source) => {
        await source.withCurrentAssessment(value, async (packet) => {
          expect(packet.validUntil).toBe(expiry);
          expect(packet.standaloneReferenceAssessment.decision).toBe("Pass");
          if (phase === "callback") f.time(expiry);
        });
        if (phase === "outer") f.time(expiry);
      }),
    ).rejects.toThrow();
    expect(f.committed()).toBe(false);
  },
);
it("keeps activation-period invalidity a concrete owning reference failure", async () => {
  const f = fixture();
  f.pricing();
  f.priceExpiry("2026-10-05T12:00:03.000Z");
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(), async (packet) => {
      expect(packet.standaloneReferenceAssessment.decision).toBe("HardError");
      expect(packet.standaloneReferenceAssessment.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "PRICE_PIN_CURRENT_EFFECTIVE",
            reasonCode: "ActivationOutsidePeriod",
          }),
        ]),
      );
    }),
  );
});
it("retains a stale pinned price version as a current-reference HardError", async () => {
  const f = fixture();
  f.pricing();
  f.stalePrice();
  await f.run((source) =>
    source.withCurrentAssessment(closedInput(), async (packet) => {
      expect(packet.standaloneReferenceAssessment.decision).toBe("HardError");
      expect(packet.standaloneReferenceAssessment.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "PRICE_PIN_CURRENT_EFFECTIVE",
            outcome: "HardError",
            reasonCode: "NotCurrent",
          }),
        ]),
      );
    }),
  );
});
it("refuses invalid configured consumption quantity before source acquisition", async () => {
  const f = fixture(),
    value = closedInput(),
    original = value.graph.graph.contents[0];
  if (!original) throw Error("fixture root missing");
  const graph = {
    ...value.graph,
    graph: {
      ...value.graph.graph,
      contents: [
        {
          ...original,
          optionDetails: original.optionDetails.map((detail) => ({
            ...detail,
            consumption: detail.consumption ? { ...detail.consumption, quantity: "0" } : null,
          })),
        },
      ],
    },
  };
  await expect(
    f.run((source) => source.withCurrentAssessment({ ...value, graph }, async () => undefined)),
  ).rejects.toThrow();
  expect(f.sqlCalls).toHaveLength(0);
});
it("reports genuine conditional complexity limits as Indeterminate despite valid references", async () => {
  const f = fixture(),
    value = closedInput(true, true);
  f.pricing();
  const rootContent = value.graph.graph.contents[0];
  if (!rootContent) throw Error("fixture root missing");
  const expanded = (content: typeof rootContent, count: number, start: number) => {
    const option = content.sourceAggregate.draft.options[0],
      detail = content.optionDetails[0];
    if (!option || !detail) throw Error("fixture choice missing");
    const options = Array.from(
      { length: count - content.sourceAggregate.draft.options.length },
      (_, i) => ({
        ...option,
        optionReference: id(start + i),
        stableCode: "EXTRA_" + i,
        sortOrder:
          Math.max(...content.sourceAggregate.draft.options.map((value) => value.sortOrder)) +
          i +
          1,
        triggeredOptionSetReference: null,
      }),
    );
    const details = options.map((option) => ({
      ...detail,
      optionReference: option.optionReference,
      pricingRule: null,
      consumption: null,
      triggeredOptionSetVersionReference: null,
    }));
    const { sourceAggregate, ...additional } = content;
    return parseCatalogOptionSetEditorContent(
      {
        ...sourceAggregate,
        draft: {
          ...sourceAggregate.draft,
          options: [...sourceAggregate.draft.options, ...options],
        },
      },
      { ...additional, optionDetails: [...content.optionDetails, ...details] },
    );
  };
  const root = expanded(rootContent, 100, 2000),
    child = expanded(node(200, false).content, 29, 3000);
  const graphValue = { ...value.graph.graph, contents: [root.content, child.content] },
    rule = evaluateCatalogOptionSetRuleSatisfiability(graphValue);
  expect(rule.status).toBe("Indeterminate");
  const tuple = {
    ...value.graph.sourceSnapshotTuple,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
  };
  const graph: Graph = {
    ...value.graph,
    graph: graphValue,
    sourceSnapshotTuple: tuple,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
    graphDigest: rule.graphDigest,
  };
  const binding = {
    ...value.binding,
    sourceDigest: root.sourceDigest,
    contentDigest: root.contentDigest,
    configurationDigest: root.configurationDigest,
    graphDigest: rule.graphDigest,
  };
  await f.run((source) =>
    source.withCurrentAssessment({ graph, binding }, async (packet) => {
      expect(packet.nodes[0]?.price?.decision).toBe("PassForMetadata");
      expect(packet.standaloneReferenceAssessment.decision).toBe("Indeterminate");
      expect(packet.standaloneReferenceAssessment.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "OPTION_CONDITIONAL_RULES",
            outcome: "Indeterminate",
            reasonCode: "ComplexityLimit",
          }),
        ]),
      );
    }),
  );
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
  const f = fixture((options: Options) => {
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
  await f.run((source) => source.withCurrentAssessment(closedInput(), async (packet) => packet));
  expect(standalone).not.toHaveBeenCalled();
  expect(sequence).toBeGreaterThan(1);
  expect(new Set(snapshots).size).toBe(sequence);
  expect(batches.flat()).toContain("catalog.option_set.read");
});
it("rechecks combined current permission at the original final checkpoint", async () => {
  let sequence = 0,
    withdraw = false;
  const f = fixture((options) => {
    options.capability.holdUntilCommitWithDecisions = async (actions) => {
      if (withdraw) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return combinedDecisionPacket(actions, ++sequence);
    };
  });
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(closedInput(), async (packet) => {
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
    const f = fixture((options) => {
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
      f.run((source) => source.withCurrentAssessment(closedInput(), async (packet) => packet)),
    ).rejects.toThrow();
    expect(readAccessor).not.toHaveBeenCalled();
  });
it("rejects combined port drift rather than falling back during final admission", async () => {
  const f = fixture((options) => {
    options.capability.holdUntilCommitWithDecisions = async (actions) =>
      combinedDecisionPacket(actions, 1);
  });
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(closedInput(), async (packet) => {
        const options = f.options();
        if (!options) throw Error("fixture missing");
        options.capability.holdUntilCommitWithDecisions = async () => [];
        return packet;
      }),
    ),
  ).rejects.toThrow();
});
it("rejects a present non-function combined port before legacy fallback", async () => {
  const f = fixture((options) => {
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      value: 42,
      enumerable: true,
    });
  });
  await expect(
    f.run((source) => source.withCurrentAssessment(closedInput(), async (packet) => packet)),
  ).rejects.toThrow();
});

it("rejects an absent-to-present combined port change after legacy admission", async () => {
  const f = fixture();
  await expect(
    f.run((source) =>
      source.withCurrentAssessment(closedInput(), async (packet) => {
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
  const f = fixture((options) => {
    options.capability.leaseDeadline = () => short;
    options.capability.holdUntilCommitWithDecisions = async (actions) =>
      combinedDecisionPacket(actions, 1);
  });
  const packet = await f.run((source) =>
    source.withCurrentAssessment(closedInput(), async (packet) => packet),
  );
  expect(packet.validUntil).toBe(short);
});
