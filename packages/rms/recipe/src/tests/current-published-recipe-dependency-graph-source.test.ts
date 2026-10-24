import { createEffectivePeriod } from "@bop/effective-period";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it } from "vitest";
import {
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  createCurrentPublishedRecipeDependencyGraphSource as create,
  currentPublishedRecipeDependencyGraphFields,
  type RecipeSnapshot,
  type CurrentPublishedRecipeDependencyGraphOptions,
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
        conversionNumerator: "2",
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
  Parameters<CurrentPublishedRecipeDependencyGraphOptions["transactions"]["run"]>[0]
>[0];
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw Error("fixture missing");
  return row;
}
function harness(expiring = false, withChild = false) {
  let clock = at,
    denied = false,
    missing = false,
    duplicate = false,
    changed = false,
    reviewChanged = false,
    invalidRecord = false,
    loads = 0,
    precise = true;
  const snapshot: RecipeSnapshot = {
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
    imprecise: () => {
      precise = false;
    },
  };
}
describe("current complete Published Recipe owning source", () => {
  it("narrows to the owning half-open period and rejects activation exactly at expiry", async () => {
    const h = harness(true);
    h.input.activationAt = "2026-08-13T18:00:01.000Z";
    await expect(
      h.source.withCurrentGraph(h.input, async (content) => {
        expect(content.validUntil).toBe("2026-08-13T18:00:02.000Z");
        h.setClock(content.validUntil);
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    const next = harness(true);
    next.input.activationAt = "2026-08-13T18:00:02.000Z";
    let entered = false;
    await expect(
      next.source.withCurrentGraph(next.input, async () => {
        entered = true;
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    expect(entered).toBe(false);
  });
  it("keeps an immediate intended activation while work progresses inside its original lease", async () => {
    const h = harness();
    h.input.activationAt = at;
    await expect(
      h.source.withCurrentGraph(h.input, async () => {
        h.setClock("2026-08-13T18:00:00.001Z");
        return "ok";
      }),
    ).resolves.toBe("ok");
  });

  it("reads complete owner content and both stored independent reviews, then rereads under held fields", async () => {
    const h = harness();
    const answer = await h.source.withCurrentGraph(h.input, async (c) => {
      expect(c.contents[0]?.snapshot).toEqual(h.snapshot);
      expect(c.contents[0]?.publicationOperationReference).toBe(id(70));
      expect(c.subrecipeGraph).toBe("PassForPinnedPublishedSubrecipes");
      expect(c.inventoryReferences).toBe("NotEvaluated");
      expect(c.publishValidation).toBe("Incomplete");
      expect(c.eligibility).toBe("NotEvaluated");
      expect(c.validUntil).toBe("2026-08-13T18:00:05.000Z");
      const { digest, ...body } = c;
      expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
      return "ok";
    });
    expect(answer).toBe("ok");
    expect(h.loads).toBe(2);
    expect(h.queries.some((q) => q.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  });
  it.each(["missing", "duplicate", "invalidRecord", "changeReview", "deny", "imprecise"] as const)(
    "refuses %s before work",
    async (key) => {
      const h = harness();
      h[key]();
      let entered = false;
      await expect(
        h.source.withCurrentGraph(h.input, async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
      expect(entered).toBe(false);
    },
  );
  it.each(["change", "changeReview", "deny", "expiry", "rollbackClock", "query"] as const)(
    "refuses late %s after work and poisons the same UoW",
    async (key) => {
      const h = harness();
      let entered = false;
      await expect(
        h.source.withCurrentGraph(h.input, async () => {
          entered = true;
          if (key === "expiry") h.setClock("2026-08-13T18:00:05.000Z");
          else if (key === "rollbackClock") h.setClock("2026-08-13T17:59:59.999Z");
          else if (key === "query") h.tx.query = async () => ({ rows: [] });
          else h[key]();
        }),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
      expect(entered).toBe(true);
      await expect(h.source.withCurrentGraph(h.input, async () => "no")).rejects.toMatchObject({
        code: "RECIPE_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each(["scope", "extra", "empty", "duplicate", "version", "createdBefore", "activation"])(
    "refuses closed selector %s",
    async (key) => {
      const h = harness();
      const input = structuredClone(h.input);
      if (key === "scope") input.request.brandReference = id(99);
      if (key === "extra") Object.assign(input, { contents: [h.snapshot] });
      if (key === "empty") input.recipeVersions = [];
      if (key === "duplicate")
        input.recipeVersions.push({ recipeReference: id(1), versionReference: id(2) });
      if (key === "version")
        input.recipeVersions = [{ recipeReference: id(1), versionReference: id(99) }];
      if (key === "createdBefore") {
        input.observedAt = "2026-08-13T17:59:59.999Z";
        h.setClock(input.observedAt);
      }
      if (key === "activation") input.activationAt = "2026-07-01T00:00:00.000Z";
      let entered = false;
      await expect(
        h.source.withCurrentGraph(input, async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
      expect(entered).toBe(false);
    },
  );
  it("captures fixed scope, holder and clock methods", async () => {
    const h = harness();
    h.options.brandReference = id(99);
    h.options.clock.now = () => "invalid";
    h.options.authority.holdUntilTransactionCompletes = async () => {
      throw new Error("replacement");
    };
    await expect(h.source.withCurrentGraph(h.input, async () => "ok")).resolves.toBe("ok");
  });
  it("refuses swallowed nested entry", async () => {
    const h = harness();
    await expect(
      h.source.withCurrentGraph(h.input, async () => {
        await h.source.withCurrentGraph(h.input, async () => "no").catch(() => undefined);
        return "no";
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  });
  it("refuses runner substitution and repeated callbacks", async () => {
    for (const repeated of [false, true]) {
      const h = harness();
      const source = create({
        ...h.options,
        transactions: {
          async run<T>(work: (actual: typeof h.tx) => Promise<T>) {
            const result = await work(h.tx);
            return repeated ? work(h.tx) : ({ substituted: result } as T);
          },
        },
      });
      await expect(source.withCurrentGraph(h.input, async () => "ok")).rejects.toMatchObject({
        code: "RECIPE_DEPENDENCY_UNAVAILABLE",
      });
    }
  });
});

// Exact pinned child fixtures are synthetic; SQL acceptance separately proves owner records.
describe("pinned Subrecipe graph", () => {
  it("retains the Published child version when its root advances to a Draft", async () => {
    const h = harness(false, true);
    await h.source.withCurrentGraph(h.input, async (c) => {
      expect(c.contents).toHaveLength(2);
      expect(c.contents.find((x) => x.snapshot.recipeReference === id(100))).toMatchObject({
        snapshot: { versionReference: id(101), lifecycle: "Published" },
        currentRootVersionReference: id(102),
        currentRootAggregateVersion: 2,
        currentRootLifecycle: "Draft",
      });
      expect(c.rootVersionReferences).toEqual([id(2)]);
      expect(c.unitsAndConversions).toBe("NotEvaluated");
    });
  });
  it.each(["yield", "cycle", "archived", "invalidated", "missingVersion", "scope"] as const)(
    "denies child %s before downstream",
    async (kind) => {
      const h = harness(false, true);
      if (kind === "yield") h.setChild({ yieldDimension: "Mass" });
      if (kind === "cycle")
        h.setChild({
          ingredients: [
            {
              ...first(h.child.ingredients),
              sourceKind: "SubRecipe",
              sourceReference: id(1),
              sourceVersionReference: id(2),
              unitDimension: "Count",
            },
          ],
        });
      if (kind === "archived") h.setChildRoot({ lifecycle: "Archived" });
      if (kind === "invalidated")
        h.setChildRoot({
          lifecycle: "Invalidated",
          invalidationReasonCode: parseRecipeCode("DENIED"),
        });
      if (kind === "missingVersion") h.setChild({ versionReference: id(103) });
      if (kind === "scope") h.setChild({ brandReference: id(99) });
      let entered = false;
      await expect(
        h.source.withCurrentGraph(h.input, async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
      expect(entered).toBe(false);
    },
  );
  it("detects a late current child root advance and poisons reuse", async () => {
    const h = harness(false, true);
    await expect(
      h.source.withCurrentGraph(h.input, async () => {
        h.setChildRoot({ versionReference: id(103), aggregateVersion: 3 });
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    await expect(
      h.source.withCurrentGraph(h.input, async () => "unreachable"),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  });
});

it("refuses a current child root newer than the original observation before work", async () => {
  const h = harness(false, true);
  h.setChildRoot({ createdAt: "2026-08-13T18:00:00.001Z" });
  let entered = false;
  await expect(
    h.source.withCurrentGraph(h.input, async () => {
      entered = true;
    }),
  ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  expect(entered).toBe(false);
});
