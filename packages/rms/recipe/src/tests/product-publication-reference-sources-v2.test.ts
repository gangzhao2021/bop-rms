import { describe, expect, it, vi } from "vitest";
import {
  RecipeWorkflowError,
  createPostgresRecipeProductPublicationReferenceSourceV2,
  createPostgresRecipeInventoryProductPublicationReferenceSourceV2,
  parseRecipeProductPublicationReferenceRequestV2,
  parseRecipeInventoryProductPublicationReferenceRequestV2,
  recipeReferenceSourceFields,
  recipeInventoryReferenceFields,
  recipeProductPublicationReferenceRequestFieldsV2,
  recipeProductPublicationReferenceSourceFieldsV2,
  recipeInventoryProductPublicationReferenceSourceFieldsV2,
  type RecipeReferenceTransaction,
  type RecipeProductPublicationReferenceRequestV2,
  type RecipeInventoryProductPublicationReferenceRequestV2,
  type RecipeProductPublicationReferenceSnapshotV2,
  type RecipeInventoryProductPublicationReferenceSnapshotV2,
} from "../index.js";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchDigest as digest,
  recipeMatchRaw,
} from "./recipe-catalog-reference-matches.fixture.js";
import { recipeInventoryMatchRaw } from "./recipe-inventory-reference-matches.fixture.js";
// Deliberately controlled rows/authority exercise JS boundaries. The coordinator's
// native acceptance owns actual SQL, generation and transactional rollback evidence.
type Kind = "bindings" | "inventory";
type Request =
  RecipeProductPublicationReferenceRequestV2 | RecipeInventoryProductPublicationReferenceRequestV2;
type Snapshot =
  | RecipeProductPublicationReferenceSnapshotV2
  | RecipeInventoryProductPublicationReferenceSnapshotV2;
const plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const denied = expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
const permissionDenied = expect.objectContaining({ code: "RECIPE_PERMISSION_DENIED" });
function request(kind: Kind, actorKind: "User" | "System" = "User", duration = 5000): Request {
  const common = {
    tenantReference: id(99),
    brandReference: id(1),
    actorReference: id(2),
    actorKind,
    operationReference: id(4),
    productReference: id(3),
    versionReference: id(5),
    originalIntentDigest: digest,
    replacementIntentDigest: digest,
    aggregateSnapshotDigest: digest,
    currentPublicationDigest: null,
    observedAt: at,
    validUntil: plus(duration),
  };
  return kind === "bindings"
    ? parseRecipeProductPublicationReferenceRequestV2({
        profile: "RecipeProductPublicationReferenceRequestV2",
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
        ...common,
      })
    : parseRecipeInventoryProductPublicationReferenceRequestV2({
        profile: "RecipeInventoryProductPublicationReferenceRequestV2",
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ",
        ...common,
      });
}
function harness(kind: Kind, actorKind: "User" | "System" = "User") {
  const state = {
    now: at,
    generation: "7",
    authorityCalls: 0,
    deny: false,
    commits: 0,
    guardCalls: 0,
    finals: 0,
    queryCalls: 0,
    catchWorkFailure: false,
    consumerCalls: 0,
    afterWork: undefined as (() => void) | undefined,
    authorityTick: undefined as (() => void) | undefined,
    corrupt: false,
    doubleRunner: false,
    replaceResult: false,
  };
  const guards: { guard: () => Promise<void>; finalAssert: () => void }[] = [],
    queries: { sql: string; values: readonly unknown[] }[] = [],
    inputs: {
      request: Request;
      requiredFields: readonly string[];
      observedAt: string;
      actorKind: "User" | "System";
      purposeCode: string;
      permission: "recipe.manage";
      requiredScope: "FullBrandScope";
      tenantReference: string;
    }[] = [];
  const tx: RecipeReferenceTransaction = {
    async query<R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      expect(this).toBe(tx);
      state.queryCalls++;
      queries.push({ sql, values });
      let value: Record<string, unknown> | undefined;
      if (sql.includes("transaction_isolation")) value = { isolation: "read committed" };
      else if (sql.includes("'counts'"))
        value = {
          source: state.corrupt
            ? {}
            : kind === "bindings"
              ? recipeMatchRaw()
              : recipeInventoryMatchRaw(),
        };
      else if (sql.includes("AS header"))
        value = { header: { generation: state.generation, bindingCount: "3" } };
      else if (sql.includes("AS generation")) value = { generation: state.generation };
      return { rows: value ? [value as R] : [] };
    },
  };
  const clock = {
    now() {
      expect(this).toBe(clock);
      return state.now;
    },
  };
  const authority = {
    async holdUntilTransactionCompletes(
      actual: RecipeReferenceTransaction,
      input: (typeof inputs)[number],
    ) {
      expect(this).toBe(authority);
      expect(actual).toBe(tx);
      state.authorityCalls++;
      inputs.push(input);
      state.authorityTick?.();
      if (state.deny) throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
    },
  };
  const transactions = {
    async run<T>(work: (actual: RecipeReferenceTransaction) => Promise<T>): Promise<T> {
      expect(this).toBe(transactions);
      if (borrowed) return work(tx);
      let result: T | undefined, error: unknown;
      try {
        result = await work(tx);
        if (state.doubleRunner) result = await work(tx);
      } catch (failure) {
        if (!state.catchWorkFailure) throw failure;
        error = failure;
      }
      state.afterWork?.();
      for (const entry of guards) {
        state.guardCalls++;
        await entry.guard();
      }
      for (const entry of guards) {
        state.finals++;
        expect(entry.finalAssert()).toBeUndefined();
      }
      if (error) throw error;
      state.commits++;
      return (state.replaceResult ? {} : result) as T;
    },
  };
  let borrowed = false;
  const options = {
    tenantReference: id(99),
    brandReference: id(1),
    actorReference: id(2),
    actorKind,
    clock,
    transactions,
    authority,
    async registerBeforeCommit(
      actual: RecipeReferenceTransaction,
      guard: () => Promise<void>,
      finalAssert: () => void,
    ) {
      expect(this).toBe(options);
      expect(actual).toBe(tx);
      guards.push({ guard, finalAssert });
    },
  };
  const binding =
      kind === "bindings"
        ? createPostgresRecipeProductPublicationReferenceSourceV2(options)
        : undefined,
    inventory =
      kind === "inventory"
        ? createPostgresRecipeInventoryProductPublicationReferenceSourceV2(options)
        : undefined;
  const source = {
    async withCurrentSnapshot<T>(
      input: unknown,
      work: (snapshot: Snapshot, actual: RecipeReferenceTransaction) => Promise<T>,
    ): Promise<T> {
      if (binding)
        return binding.withCurrentSnapshot(
          parseRecipeProductPublicationReferenceRequestV2(input),
          work,
        );
      if (inventory)
        return inventory.withCurrentSnapshot(
          parseRecipeInventoryProductPublicationReferenceRequestV2(input),
          work,
        );
      throw new Error("fixture");
    },
  };
  return {
    state,
    guards,
    queries,
    inputs,
    tx,
    options,
    source,
    setBorrowed: (value: boolean) => {
      borrowed = value;
    },
  };
}
for (const kind of ["bindings", "inventory"] as const)
  describe(`held Recipe publication ${kind} source`, () => {
    it.each(["User", "System"] as const)(
      "holds actual tx, complete authority metadata and original lease for %s",
      async (actorKind) => {
        const h = harness(kind, actorKind),
          r = request(kind, actorKind),
          result = Object.freeze({ retained: true });
        expect(
          await h.source.withCurrentSnapshot(r, async (source, tx) => {
            expect(tx).toBe(h.tx);
            expect(source.request).toEqual(r);
            expect(source.applicability).toBe("Unavailable");
            return result;
          }),
        ).toBe(result);
        expect(h.state.commits).toBe(1);
        expect(h.state.guardCalls).toBe(1);
        expect(h.state.finals).toBe(1);
        expect(h.inputs).toHaveLength(4);
        for (const input of h.inputs) {
          expect(input.request).toEqual(r);
          expect(input.actorKind).toBe(actorKind);
          expect(input.purposeCode).toBe(r.purposeCode);
          expect(input.tenantReference).toBe(r.tenantReference);
          expect(input.permission).toBe("recipe.manage");
          expect(input.requiredScope).toBe("FullBrandScope");
          expect(input.requiredFields).toBe(
            kind === "bindings"
              ? recipeProductPublicationReferenceSourceFieldsV2
              : recipeInventoryProductPublicationReferenceSourceFieldsV2,
          );
        }
        const expectedFields = [
          ...new Set([
            ...(kind === "bindings" ? recipeReferenceSourceFields : recipeInventoryReferenceFields),
            ...recipeProductPublicationReferenceRequestFieldsV2,
          ]),
        ];
        expect(recipeProductPublicationReferenceRequestFieldsV2).toHaveLength(15);
        expect(h.inputs[0]?.requiredFields).toEqual(expectedFields);
        expect(h.inputs[0]?.requiredFields).toEqual(
          expect.arrayContaining([
            "tenantReference",
            "actorKind",
            "productReference",
            "versionReference",
            "operationReference",
            "originalIntentDigest",
            "replacementIntentDigest",
            "aggregateSnapshotDigest",
            "currentPublicationDigest",
            "observedAt",
            "validUntil",
            "profile",
            "purposeCode",
            "brandReference",
            "actorReference",
          ]),
        );
        expect(
          h.queries.some(
            (q) =>
              q.sql.includes("bop.tenant_id") && q.values[0] === id(99) && q.values[1] === id(1),
          ),
        ).toBe(true);
        expect(
          h.queries.some(
            (q) =>
              q.sql.includes("pg_advisory_xact_lock_shared") &&
              q.values[0] === "RecipeCatalogReferenceV1:" + id(1),
          ),
        ).toBe(true);
      },
    );
    it("captures configuration and receivers before mutable caller options are replaced", async () => {
      const h = harness(kind),
        fail = vi.fn(() => {
          throw new Error("replacement port");
        });
      h.options.clock.now = fail;
      h.options.authority.holdUntilTransactionCompletes = fail;
      h.options.transactions.run = fail;
      h.options.registerBeforeCommit = fail;
      h.options.tenantReference = id(800);
      await h.source.withCurrentSnapshot(request(kind), async () => "retained");
      expect(fail).not.toHaveBeenCalled();
      expect(h.state.commits).toBe(1);
    });
    it.each(["tenantReference", "brandReference", "actorReference", "actorKind"])(
      "rejects foreign %s before SQL and consumer",
      async (key) => {
        const h = harness(kind),
          consumer = vi.fn(async () => undefined);
        await expect(
          h.source.withCurrentSnapshot(
            { ...request(kind), [key]: key === "actorKind" ? "System" : id(999) },
            consumer,
          ),
        ).rejects.toEqual(denied);
        expect(consumer).not.toHaveBeenCalled();
        expect(h.state.queryCalls).toBe(0);
      },
    );
    it.each(["permission", "corrupt"] as const)(
      "installs poison before first %s failure, even if caller catches it",
      async (mode) => {
        const h = harness(kind),
          consumer = vi.fn(async () => undefined);
        h.state.catchWorkFailure = true;
        if (mode === "permission") h.state.deny = true;
        else h.state.corrupt = true;
        await expect(h.source.withCurrentSnapshot(request(kind), consumer)).rejects.toEqual(denied);
        expect(consumer).not.toHaveBeenCalled();
        expect(h.state.guardCalls).toBe(1);
        expect(h.state.commits).toBe(0);
      },
    );
    it("preserves permission error when authority is revoked after consumer return", async () => {
      const h = harness(kind);
      h.state.afterWork = () => {
        h.state.deny = true;
      };
      await expect(
        h.source.withCurrentSnapshot(request(kind), async () => {
          h.state.consumerCalls++;
          return "tentative";
        }),
      ).rejects.toEqual(permissionDenied);
      expect(h.state.consumerCalls).toBe(1);
      expect(h.state.commits).toBe(0);
    });
    it.each(["generation", "query", "clock"] as const)(
      "rejects late %s drift before outer commit",
      async (mode) => {
        const h = harness(kind);
        h.state.afterWork = () => {
          if (mode === "generation") h.state.generation = "8";
          if (mode === "clock") h.state.now = plus(5000);
          if (mode === "query") h.tx.query = async () => ({ rows: [] });
        };
        await expect(
          h.source.withCurrentSnapshot(request(kind), async () => "tentative"),
        ).rejects.toEqual(denied);
        expect(h.state.commits).toBe(0);
      },
    );
    it("rejects partial clock rollback still after original observation", async () => {
      const h = harness(kind);
      h.state.authorityTick = () => {
        h.state.now = plus(2);
      };
      await expect(
        h.source.withCurrentSnapshot(request(kind), async () => {
          h.state.now = plus(1);
          return "tentative";
        }),
      ).rejects.toEqual(denied);
      expect(h.state.commits).toBe(0);
    });
    it("refuses commit when a later async guard exhausts the original shorter deadline", async () => {
      const h = harness(kind);
      h.state.afterWork = () => {
        h.guards.push({
          guard: async () => {
            h.state.now = plus(1000);
          },
          finalAssert: () => undefined,
        });
      };
      await expect(
        h.source.withCurrentSnapshot(request(kind, "User", 1000), async () => {
          h.state.consumerCalls++;
          return "tentative";
        }),
      ).rejects.toEqual(denied);
      expect(h.state.authorityCalls).toBe(4);
      expect(h.state.guardCalls).toBe(2);
      expect(h.state.finals).toBe(1);
      expect(h.state.consumerCalls).toBe(1);
      expect(h.state.commits).toBe(0);
    });
    it("poisons the actual transaction when nested same-factory reentry is caught", async () => {
      const h = harness(kind),
        inner = vi.fn(async () => undefined);
      h.state.catchWorkFailure = true;
      await expect(
        h.source.withCurrentSnapshot(request(kind), async () => {
          h.state.consumerCalls++;
          h.setBorrowed(true);
          try {
            await expect(h.source.withCurrentSnapshot(request(kind), inner)).rejects.toEqual(
              denied,
            );
          } finally {
            h.setBorrowed(false);
          }
          return "caught inner";
        }),
      ).rejects.toEqual(denied);
      expect(inner).not.toHaveBeenCalled();
      expect(h.state.consumerCalls).toBe(1);
      expect(h.state.guardCalls).toBe(1);
      expect(h.state.commits).toBe(0);
    });
    it("poisons duplicate runner callbacks and preserves exact return identity", async () => {
      const h = harness(kind);
      h.state.doubleRunner = true;
      await expect(
        h.source.withCurrentSnapshot(request(kind), async () => {
          h.state.consumerCalls++;
          return "result";
        }),
      ).rejects.toEqual(denied);
      expect(h.state.consumerCalls).toBe(1);
      expect(h.state.commits).toBe(0);
      const replacement = harness(kind);
      replacement.state.replaceResult = true;
      await expect(
        replacement.source.withCurrentSnapshot(request(kind), async () => "result"),
      ).rejects.toEqual(denied);
    });
    it("rejects malformed clock and consumer failure without a successful commit", async () => {
      const h = harness(kind);
      h.state.now = "not-a-time";
      await expect(
        h.source.withCurrentSnapshot(request(kind), async () => "result"),
      ).rejects.toEqual(denied);
      expect(h.state.commits).toBe(0);
      const failure = harness(kind);
      await expect(
        failure.source.withCurrentSnapshot(request(kind), async () => {
          throw new Error("consumer");
        }),
      ).rejects.toEqual(denied);
      expect(failure.state.commits).toBe(0);
    });
  });
