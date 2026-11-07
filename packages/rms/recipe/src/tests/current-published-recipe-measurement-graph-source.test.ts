import { createEffectivePeriod } from "@bop/effective-period";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it } from "vitest";
import {
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  createCurrentPublishedRecipeMeasurementGraphSource as create,
  createPinnedPublishedRecipeMeasurementGraphSource,
  currentPublishedRecipeDependencyGraphFields,
  currentPublishedRecipeMeasurementGraphFields,
  digestRecipeMeasurementContentV2,
  requireRecipeMeasurementContentDigest,
  type RecipeSnapshot,
  type CurrentPublishedRecipeMeasurementGraphOptions,
} from "../index.js";
const id = (n: number) =>
  parseRecipeReference(`018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-13T18:00:00.000Z";
const period = createEffectivePeriod({
  timeZone: "America/Toronto",
  effectiveFrom: {
    instant: "2026-08-01T04:00:00.000Z" as never,
    localDateTime: "2026-08-01T00:00:00.000",
    utcOffsetMinutes: -240,
  },
  effectiveUntil: null,
});
function recipe(
  options: { version?: number; lifecycle?: RecipeSnapshot["lifecycle"]; sub?: RecipeSnapshot } = {},
): RecipeSnapshot {
  const version = options.version ?? 1;
  return {
    recipeReference: id(1),
    versionReference: id(version + 1),
    brandReference: id(10),
    stableCode: parseRecipeCode("SYNTHETIC_RECIPE"),
    aggregateVersion: version,
    versionNumber: version,
    snapshotDigest: parseRecipeDigest(`sha256:${version.toString(16).repeat(64)}`),
    lifecycle: options.lifecycle ?? "Draft",
    displayNameCode: parseRecipeCode("SYNTHETIC_NAME"),
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: parseRecipeCode("PORTION"),
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(20),
        sourceKind: options.sub ? "SubRecipe" : "InventoryItem",
        sourceReference: options.sub?.recipeReference ?? id(21),
        sourceVersionReference: options.sub?.versionReference ?? id(22),
        quantityMicrounits: "1000000",
        unitDimension: "Mass",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 1000,
        unitCostMinorNumerator: "3",
        unitCostDenominator: "1000000",
        allergens: [{ allergenReference: id(30), evidenceReference: id(31), verified: true }],
      },
    ],
    preparationVersionReference: id(40),
    steps: [
      {
        stepReference: id(41),
        sequenceGroup: 0,
        instructionCode: parseRecipeCode("MIX"),
        durationSeconds: 60,
        capabilityCode: parseRecipeCode("PREP"),
      },
    ],
    substitutionPolicyReference: null,
    effectivePeriod: period,
    invalidationReasonCode:
      options.lifecycle === "Invalidated" ? parseRecipeCode("SAFETY_REVIEW") : null,
    createdAt: at,
  };
}

type Tx = Parameters<
  Parameters<CurrentPublishedRecipeMeasurementGraphOptions["transactions"]["run"]>[0]
>[0];
function harness(expiring = false, withChild = false) {
  let clock = at,
    denied = false,
    missing = false,
    duplicate = false,
    changed = false,
    reviewChanged = false,
    invalidRecord = false,
    loads = 0,
    precise = true,
    measurementDenied = false,
    measurementMissing = false,
    measurementDuplicate = false,
    measurementBadDigest = false,
    measurementChanged = false,
    attachmentReads = 0,
    measurementHolds = 0;
  let snapshot: RecipeSnapshot = {
    ...recipe({ lifecycle: "Published" }),
    effectivePeriod: expiring
      ? createEffectivePeriod({
          timeZone: "America/Toronto",
          effectiveFrom: period.effectiveFrom,
          effectiveUntil: {
            instant: "2026-08-13T18:00:02.000Z" as never,
            localDateTime: "2026-08-13T14:00:02.000",
            utcOffsetMinutes: -240,
          },
        })
      : period,
  };
  let child: RecipeSnapshot = {
    ...recipe({ lifecycle: "Published" }),
    recipeReference: id(100),
    versionReference: id(101),
    stableCode: parseRecipeCode("SYNTHETIC_CHILD"),
  };
  let childRoot: RecipeSnapshot = {
    ...child,
    versionReference: id(102),
    aggregateVersion: 2,
    lifecycle: "Draft",
  };
  if (withChild)
    Object.assign(snapshot, {
      ingredients: [
        {
          ...snapshot.ingredients[0],
          sourceKind: "SubRecipe",
          sourceReference: child.recipeReference,
          sourceVersionReference: child.versionReference,
          unitDimension: child.yieldDimension,
        },
      ],
    });
  const full = (value: RecipeSnapshot) => {
    const raw = {
      profile: "RecipeMeasurementContentV2",
      snapshot: value,
      measurements: value.ingredients.map((i) => ({
        requirementReference: i.requirementReference,
        usageUnitCode: i.sourceKind === "SubRecipe" ? "PORTION" : "KG",
        usageDimension: i.unitDimension,
        targetUnitCode: i.sourceKind === "SubRecipe" ? "PORTION" : "KG",
        targetDimension: i.unitDimension,
        conversionKind:
          i.sourceKind === "SubRecipe"
            ? "PinnedSubrecipeYieldIdentity"
            : "InventoryBaseUnitIdentity",
        conversionReference: null,
      })),
    };
    return requireRecipeMeasurementContentDigest({
      ...raw,
      snapshot: { ...value, snapshotDigest: digestRecipeMeasurementContentV2(raw) },
    });
  };
  const rootContent = full(snapshot),
    childContent = full(child);
  snapshot = rootContent.snapshot;
  child = childContent.snapshot;
  const evidence = {
    recipeReference: snapshot.recipeReference,
    versionReference: snapshot.versionReference,
    brandReference: snapshot.brandReference,
    snapshotDigest: snapshot.snapshotDigest,
    draftAuthorActorReference: id(3),
    reviews: [
      {
        reviewReference: id(51),
        reviewKind: "Cost",
        reviewerActorReference: id(52),
        evidenceDigest: "sha256:" + "b".repeat(64),
        decision: "Approved",
        reviewedAt: at,
      },
      {
        reviewReference: id(53),
        reviewKind: "FoodSafety",
        reviewerActorReference: id(54),
        evidenceDigest: "sha256:" + "c".repeat(64),
        decision: "Approved",
        reviewedAt: at,
      },
    ],
  };
  const publication = {
    action: "Publish",
    operationReference: id(70),
    operationIntentHash: "sha256:" + "a".repeat(64),
    actorReference: id(3),
    aggregate: snapshot,
    publicationEvidence: evidence,
    event: {
      eventType: "RecipePublished",
      recipeReference: snapshot.recipeReference,
      versionReference: snapshot.versionReference,
      brandReference: snapshot.brandReference,
      aggregateVersion: snapshot.aggregateVersion,
      lifecycle: snapshot.lifecycle,
      snapshotDigest: snapshot.snapshotDigest,
      occurredAt: at,
    },
  };
  const queries: string[] = [];
  const queryRaw = async (
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly unknown[] }> => {
    queries.push(sql);
    if (sql.includes("SELECT content_json,content_digest")) {
      expect(measurementHolds).toBeGreaterThan(0);
      attachmentReads++;
      const content = values[1] === child.versionReference ? childContent : rootContent;
      const row = {
        content_json: measurementChanged ? { ...content, measurements: [] } : content,
        content_digest: measurementBadDigest
          ? "sha256:" + "0".repeat(64)
          : content.snapshot.snapshotDigest,
      };
      return { rows: measurementMissing ? [] : measurementDuplicate ? [row, row] : [row] };
    }
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    const target = values[1] === id(100) ? child : snapshot;
    const targetEvidence = {
      ...evidence,
      recipeReference: target.recipeReference,
      versionReference: target.versionReference,
      snapshotDigest: target.snapshotDigest,
    };
    const targetPublication = {
      ...publication,
      operationReference: target === child ? id(170) : id(70),
      aggregate: target,
      publicationEvidence: targetEvidence,
      event: {
        ...publication.event,
        recipeReference: target.recipeReference,
        versionReference: target.versionReference,
        aggregateVersion: target.aggregateVersion,
        lifecycle: target.lifecycle,
        snapshotDigest: target.snapshotDigest,
      },
    };
    if (sql.includes("created_at=date_trunc"))
      return { rows: missing ? [] : [{ snapshot: target, precise }] };
    if (sql.includes("snapshot_json AS snapshot")) {
      loads++;
      return {
        rows: missing
          ? []
          : [
              {
                snapshot:
                  target === child
                    ? childRoot
                    : changed
                      ? { ...snapshot, displayNameCode: "CHANGED" }
                      : snapshot,
                version: target === child ? childRoot.aggregateVersion : 1,
              },
            ],
      };
    }
    if (sql.includes("operation_id AS operation"))
      return {
        rows: duplicate
          ? [{ operation: id(70) }, { operation: id(71) }]
          : [{ operation: target === child ? id(170) : id(70) }],
      };
    if (sql.includes("record_json AS record")) {
      const aggregate = values[1] === id(170) ? child : snapshot;
      const proof = {
        ...evidence,
        recipeReference: aggregate.recipeReference,
        versionReference: aggregate.versionReference,
        snapshotDigest: aggregate.snapshotDigest,
      };
      return {
        rows: [
          {
            record: {
              ...publication,
              operationReference: values[1],
              aggregate,
              publicationEvidence: invalidRecord
                ? { ...proof, reviews: [proof.reviews[0], proof.reviews[0]] }
                : proof,
              event: {
                ...publication.event,
                recipeReference: aggregate.recipeReference,
                versionReference: aggregate.versionReference,
                aggregateVersion: aggregate.aggregateVersion,
                lifecycle: aggregate.lifecycle,
                snapshotDigest: aggregate.snapshotDigest,
              },
            },
          },
        ],
      };
    }
    if (sql.includes("review_id AS"))
      return {
        rows: targetPublication.publicationEvidence.reviews.map((r) => ({
          ...r,
          precise: !reviewChanged,
        })),
      };
    return { rows: [] };
  };
  const tx: Tx = {
    async query<T>(sql: string, values: readonly unknown[]) {
      const result = await queryRaw(sql, values);
      return { rows: result.rows as readonly T[] };
    },
  };
  const options = {
    tenantReference: id(9),
    brandReference: id(10),
    actorReference: id(3),
    clock: { now: () => clock },
    transactions: {
      async run<T>(work: (actual: typeof tx) => Promise<T>) {
        return work(tx);
      },
    },
    measurementAuthority: {
      async holdUntilTransactionCompletes(actual: typeof tx, input: unknown) {
        expect(actual).toBe(tx);
        expect(input).toMatchObject({
          tenantReference: id(9),
          permission: "recipe.manage",
          requiredScope: "FullBrandScope",
          requiredFields: currentPublishedRecipeMeasurementGraphFields,
        });
        measurementHolds++;
        if (measurementDenied) throw Error("synthetic field denial");
      },
    },
    authority: {
      async holdUntilTransactionCompletes(actual: typeof tx, input: unknown) {
        expect(actual).toBe(tx);
        expect(input).toMatchObject({
          tenantReference: id(9),
          permission: "recipe.manage",
          requiredScope: "FullBrandScope",
          requiredFields: currentPublishedRecipeDependencyGraphFields,
        });
        if (denied) throw new Error("synthetic denial");
      },
    },
  };
  const source = create(options);
  const input = {
    request: {
      purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
      brandReference: id(10),
      actorReference: id(3),
      operationReference: id(80),
      catalogIntentDigest: "sha256:" + "d".repeat(64),
    },
    observedAt: at,
    validUntil: "2026-08-13T18:00:20.000Z",
    activationAt: "2026-08-14T00:00:00.000Z",
    recipeVersions: [{ recipeReference: id(1), versionReference: id(2) }],
  };
  return {
    source,
    input,
    tx,
    options,
    snapshot,
    evidence,
    queries,
    get loads() {
      return loads;
    },
    setClock: (v: string) => {
      clock = v;
    },
    deny: () => {
      denied = true;
    },
    missing: () => {
      missing = true;
    },
    duplicate: () => {
      duplicate = true;
    },
    change: () => {
      changed = true;
    },
    changeReview: () => {
      reviewChanged = true;
    },
    invalidRecord: () => {
      invalidRecord = true;
    },
    setChild: (v: Partial<RecipeSnapshot>) => {
      child = { ...child, ...v };
    },
    setChildRoot: (v: Partial<RecipeSnapshot>) => {
      childRoot = { ...childRoot, ...v };
    },
    get child() {
      return child;
    },
    get attachmentReads() {
      return attachmentReads;
    },
    denyMeasurement: () => {
      measurementDenied = true;
    },
    missingMeasurement: () => {
      measurementMissing = true;
    },
    duplicateMeasurement: () => {
      measurementDuplicate = true;
    },
    badMeasurementDigest: () => {
      measurementBadDigest = true;
    },
    changeMeasurement: () => {
      measurementChanged = true;
    },
    imprecise: () => {
      precise = false;
    },
  };
}

describe("held actual owning core plus complete V2 attachment protocol", () => {
  it("reads and rereads full representation with independent current field permission and source digest", async () => {
    const h = harness();
    const answer = await h.source.withCurrentGraph(h.input, async (graph) => {
      expect(graph.profile).toBe("CurrentPublishedRecipeMeasurementGraphV2");
      expect(graph.contents[0]?.content.snapshot).toEqual(h.snapshot);
      expect(graph.measurementRepresentation).toBe("CompleteV2");
      expect(graph.unitArithmetic).toBe("NotEvaluated");
      expect(graph.publishValidation).toBe("Incomplete");
      const { digest, ...body } = graph;
      expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
      return Object.freeze({ original: true });
    });
    expect(answer).toEqual({ original: true });
    expect(h.attachmentReads).toBe(2);
    expect(h.queries.every((sql) => !/^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql))).toBe(true);
  });
  it("preserves exact complete pinned historical child when its current root is a newer Draft", async () => {
    const h = harness(false, true);
    await h.source.withCurrentGraph(h.input, async (graph) => {
      expect(graph.contents).toHaveLength(2);
      const child = graph.contents.find(
        (c) => c.snapshot.recipeReference === h.child.recipeReference,
      );
      expect(child?.content.snapshot).toEqual(h.child);
      expect(child?.currentRootVersionReference).toBe(id(102));
    });
    expect(h.attachmentReads).toBe(4);
  });
  for (const mode of [
    "denyMeasurement",
    "missingMeasurement",
    "duplicateMeasurement",
    "badMeasurementDigest",
    "changeMeasurement",
    "deny",
    "missing",
    "invalidRecord",
    "imprecise",
  ] as const)
    it("refuses " + mode + " before work", async () => {
      const h = harness();
      h[mode]();
      let entered = false;
      await expect(
        h.source.withCurrentGraph(h.input, async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
      expect(entered).toBe(false);
      if (mode === "denyMeasurement") expect(h.attachmentReads).toBe(0);
    });
  for (const mode of [
    "denyMeasurement",
    "missingMeasurement",
    "badMeasurementDigest",
    "changeMeasurement",
    "deny",
    "change",
    "changeReview",
  ] as const)
    it("rereads and refuses late " + mode + " and poisons the original Tx", async () => {
      const h = harness();
      let entered = false;
      await expect(
        h.source.withCurrentGraph(h.input, async () => {
          entered = true;
          h[mode]();
        }),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
      expect(entered).toBe(true);
      await expect(h.source.withCurrentGraph(h.input, async () => undefined)).rejects.toMatchObject(
        { code: "RECIPE_DEPENDENCY_UNAVAILABLE" },
      );
    });
  for (const time of ["2026-08-13T18:00:05.000Z", "2026-08-13T17:59:59.999Z"])
    it("refuses exclusive expiry or reverse clock " + time, async () => {
      const h = harness();
      await expect(
        h.source.withCurrentGraph(h.input, async () => h.setClock(time)),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    });
  it("retains period expiry and proposed activation checks", async () => {
    const h = harness(true);
    let entered = false;
    await expect(
      h.source.withCurrentGraph(h.input, async () => {
        entered = true;
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    expect(entered).toBe(false);
  });
  it("refuses original query substitution and reentry", async () => {
    const h = harness();
    await expect(
      h.source.withCurrentGraph(h.input, async () => {
        h.tx.query = async () => ({ rows: [] });
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    const nested = harness();
    await expect(
      nested.source.withCurrentGraph(nested.input, async () => {
        await expect(
          nested.source.withCurrentGraph(nested.input, async () => undefined),
        ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  });
  for (const mode of ["zero", "duplicate", "substitute"] as const)
    it("guards transaction callback/result protocol " + mode, async () => {
      const h = harness();
      h.options.transactions.run = async <T>(work: (tx: Tx) => Promise<T>) => {
        if (mode === "zero") return undefined as T;
        const answer = await work(h.tx);
        if (mode === "duplicate") return work(h.tx);
        expect(answer).toEqual({ original: true });
        return { substituted: true } as T;
      };
      const source = create(h.options);
      await expect(
        source.withCurrentGraph(h.input, async () => Object.freeze({ original: true })),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    });
  it("retains closed source input and Brand/Actor selector validation", async () => {
    for (const changed of [
      { ...harness().input, extra: true },
      { ...harness().input, request: { ...harness().input.request, brandReference: id(99) } },
      { ...harness().input, recipeVersions: [] },
    ]) {
      const h = harness();
      await expect(h.source.withCurrentGraph(changed, async () => undefined)).rejects.toMatchObject(
        { code: "RECIPE_DEPENDENCY_UNAVAILABLE" },
      );
    }
  });
});

it("exact pinned factory has a distinct profile and retains physical Published pin after newer current Draft", async () => {
  const h = harness(false, true),
    source = createPinnedPublishedRecipeMeasurementGraphSource(h.options);
  const input = {
    ...h.input,
    recipeVersions: [
      { recipeReference: h.child.recipeReference, versionReference: h.child.versionReference },
    ],
  };
  await source.withCurrentGraph(input, async (graph) => {
    expect(graph.profile).toBe("PinnedPublishedRecipeMeasurementGraphV2");
    expect(graph.contents).toHaveLength(1);
    expect(graph.contents[0]?.content.snapshot).toEqual(h.child);
    expect(graph.contents[0]?.currentRootVersionReference).toBe(id(102));
  });
  let entered = false;
  await expect(
    h.source.withCurrentGraph(input, async () => {
      entered = true;
    }),
  ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  expect(entered).toBe(false);
});
it("exact pinned factory still refuses unavailable child root and missing full V2", async () => {
  for (const mode of ["missingMeasurement", "denyMeasurement", "deny"] as const) {
    const h = harness(false, true);
    h[mode]();
    const source = createPinnedPublishedRecipeMeasurementGraphSource(h.options);
    await expect(
      source.withCurrentGraph(
        {
          ...h.input,
          recipeVersions: [
            {
              recipeReference: h.child.recipeReference,
              versionReference: h.child.versionReference,
            },
          ],
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  }
});
