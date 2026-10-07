import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { parseProductPublicationCommandV2 } from "../contracts/product-publication-v2.js";
import { bindCatalogProductPublicationValidationContextV2 } from "../contracts/product-publication-validation-context-v2.js";
import {
  buildCatalogProductPublicationReferenceRequestV2,
  parseCatalogProductPublicationReferenceRequestV2,
} from "../contracts/product-publication-reference-request-v2.js";
import {
  buildMenuReferenceSourceSnapshot,
  parseMenuReferenceSourceSnapshot,
  buildProductPublicationMenuReferenceSourceSnapshotV2,
  parseProductPublicationMenuReferenceSourceSnapshotV2,
  productPublicationMenuReferenceSourceFieldsV2,
} from "../contracts/menu-reference-source.js";
import {
  buildBundleReferenceSourceSnapshot,
  parseBundleReferenceSourceSnapshot,
  buildProductPublicationBundleReferenceSourceSnapshotV2,
  parseProductPublicationBundleReferenceSourceSnapshotV2,
  productPublicationBundleReferenceSourceFieldsV2,
} from "../contracts/bundle-reference-source.js";
import {
  buildAvailabilityReferenceSourceSnapshot,
  parseAvailabilityReferenceSourceSnapshot,
  buildProductPublicationAvailabilityReferenceSourceSnapshotV2,
  parseProductPublicationAvailabilityReferenceSourceSnapshotV2,
  productPublicationAvailabilityReferenceSourceFieldsV2,
} from "../contracts/availability-reference-source.js";
import {
  createPostgresProductPublicationMenuReferenceSourceV2,
  type MenuReferenceTransaction,
} from "../infrastructure/persistence/menu-reference-source-store.js";
import { createPostgresProductPublicationBundleReferenceSourceV2 } from "../infrastructure/persistence/bundle-reference-source-store.js";
import { createPostgresProductPublicationAvailabilityReferenceSourceV2 } from "../infrastructure/persistence/availability-reference-source-store.js";

// Synthetic SQL/authority collaborators exercise the real closed protocols and
// commit-boundary behavior. Native acceptance owns actual stored graph evidence.
const id = (n: number) => `01902463-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-04T12:00:00.000Z",
  plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString(),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function request(exact = false, milliseconds = 5000) {
  const aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "REFERENCE_SOURCE",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(3),
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic references" },
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        skus: [],
        optionBindings: [],
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = { level: "Store", reference: id(30), channelCodes: [], orderTypeCodes: [] },
    intentBody = exact
      ? {
          profile: "CatalogProductExactStoreSelectorReplacementV1",
          mode: "PermanentSelectorRetirement",
          previousVersionReference: id(40),
          previousPublicationOperationReference: id(41),
          expectedPreviousPublicationVersion: 2,
          previousIntentDigest: hash("old intent"),
          previousScopeDigest: hash([selector]),
          previousPeriodDigest: hash("old period"),
          previousSelectorIndex: 0,
          previousSelectorDigest: hash(selector),
        }
      : { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    replacementIntent = { ...intentBody, digest: hash(intentBody) },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(8),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [selector],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_SOURCE",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    });
  return buildCatalogProductPublicationReferenceRequestV2(
    bindCatalogProductPublicationValidationContextV2({
      command,
      aggregate,
      current: null,
      content: null,
      observedAt: at,
    }),
    plus(milliseconds),
  );
}
function menu(empty = false) {
  const parent = {
    reviewReference: id(10),
    brandReference: id(2),
    menuReference: id(11),
    menuVersionReference: id(12),
    snapshotDigest: hash("menu"),
  };
  return {
    generation: empty ? null : "1",
    observedAt: at,
    counts: {
      reviews: empty ? "0" : "1",
      placements: empty ? "0" : "2",
      revisions: empty ? "0" : "1",
      releases: "0",
      periods: "0",
    },
    reviews: empty ? [] : [{ ...parent, createdAt: at, precise: true }],
    placements: empty
      ? []
      : [60, 70].map((n) => ({
          reviewReference: id(10),
          sectionReference: id(13),
          placementReference: id(n),
          skuReference: id(n + 1),
          productVersionReference: id(n + 2),
        })),
    revisions: empty
      ? []
      : [{ ...parent, lifecycleVersion: 1, state: "InReview", changedAt: at, precise: true }],
    releases: [],
    periods: [],
  };
}
function bundle(empty = false) {
  const root = { bundleReference: id(10), brandReference: id(2) },
    versions = [11, 12].map((n) => ({
      ...root,
      bundleVersionReference: id(n),
      versionStatus: n === 11 ? "Draft" : "Published",
      versionUpdatedAt: at,
      publishedAt: n === 11 ? null : at,
      validationDigest: n === 11 ? null : hash("bundle"),
      precise: true,
    })),
    groups = [11, 12].map((n) => ({
      ...root,
      groupReference: id(n + 20),
      bundleVersionReference: id(n),
    }));
  return {
    generation: empty ? null : "1",
    observedAt: at,
    counts: {
      bundles: empty ? "0" : "1",
      versions: empty ? "0" : "2",
      groups: empty ? "0" : "2",
      members: empty ? "0" : "2",
    },
    bundles: empty
      ? []
      : [
          {
            ...root,
            aggregateVersion: 1,
            lifecycle: "Draft",
            currentVersionReference: id(11),
            updatedAt: at,
            precise: true,
          },
        ],
    versions: empty ? [] : versions,
    groups: empty ? [] : groups,
    members: empty
      ? []
      : groups.map((group, index) => ({
          ...group,
          sellableType: index ? "Sku" : "Product",
          sellableReference: id(index ? 61 : 5),
        })),
  };
}
function availability(empty = false) {
  return {
    generation: empty ? null : "1",
    observedAt: at,
    rootCount: empty ? "0" : "2",
    rules: empty
      ? []
      : [60, 70].map((n) => ({
          ruleReference: id(n),
          brandReference: id(2),
          sellableType: n === 60 ? "Product" : "Sku",
          sellableReference: id(n === 60 ? 5 : 61),
          storeReference: null,
          aggregateVersion: 1,
          lifecycle: "Draft",
          effectiveFrom: plus(10000),
          effectiveUntil: null,
          updatedAt: at,
          precise: true,
        })),
  };
}
const entries = [
  {
    kind: "Menu",
    raw: menu,
    create: createPostgresProductPublicationMenuReferenceSourceV2,
    build: buildProductPublicationMenuReferenceSourceSnapshotV2,
    parse: parseProductPublicationMenuReferenceSourceSnapshotV2,
    oldBuild: buildMenuReferenceSourceSnapshot,
    oldParse: parseMenuReferenceSourceSnapshot,
    fields: productPublicationMenuReferenceSourceFieldsV2,
  },
  {
    kind: "Bundle",
    raw: bundle,
    create: createPostgresProductPublicationBundleReferenceSourceV2,
    build: buildProductPublicationBundleReferenceSourceSnapshotV2,
    parse: parseProductPublicationBundleReferenceSourceSnapshotV2,
    oldBuild: buildBundleReferenceSourceSnapshot,
    oldParse: parseBundleReferenceSourceSnapshot,
    fields: productPublicationBundleReferenceSourceFieldsV2,
  },
  {
    kind: "Availability",
    raw: availability,
    create: createPostgresProductPublicationAvailabilityReferenceSourceV2,
    build: buildProductPublicationAvailabilityReferenceSourceSnapshotV2,
    parse: parseProductPublicationAvailabilityReferenceSourceSnapshotV2,
    oldBuild: buildAvailabilityReferenceSourceSnapshot,
    oldParse: parseAvailabilityReferenceSourceSnapshot,
    fields: productPublicationAvailabilityReferenceSourceFieldsV2,
  },
] as const;
type Entry = (typeof entries)[number];
type Snapshot = ReturnType<Entry["build"]>;
interface Source {
  withCurrentSnapshot<T>(
    input: ReturnType<typeof request>,
    work: (snapshot: Snapshot, tx: MenuReferenceTransaction) => Promise<T>,
  ): Promise<T>;
}
function harness(entry: Entry, empty = false, actorKind: "User" | "System" = "User") {
  const state = {
    at,
    generation: empty ? "0" : "1",
    raw: entry.raw(empty),
    isolation: "read committed",
    denied: false,
    swallow: false,
    double: false,
    mode: "normal",
    committed: false,
    asyncPassed: false,
    beforeGuards: undefined as (() => void) | undefined,
    later: undefined as (() => Promise<void>) | undefined,
    guards: [] as { guard: () => Promise<void>; final: () => void }[],
    statements: [] as { sql: string; values: readonly unknown[] }[],
  };
  const tx: MenuReferenceTransaction = {
    async query<R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      state.statements.push({ sql, values });
      let rows: readonly Record<string, unknown>[] = [];
      if (sql.includes("AS isolation")) rows = [{ isolation: state.isolation }];
      else if (sql.startsWith("SELECT jsonb_build_object")) rows = [{ source: state.raw }];
      else if (sql.includes("AS generation")) rows = [{ generation: state.generation }];
      return { rows: rows as readonly R[] };
    },
  };
  let depth = 0;
  const authority = {
    holdUntilTransactionCompletes: vi.fn(async (_tx: MenuReferenceTransaction, _input: unknown) => {
      void _tx;
      void _input;
      if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
  };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind,
    clock: { now: () => state.at },
    authority,
    registerBeforeCommit: async (
      actual: MenuReferenceTransaction,
      guard: () => Promise<void>,
      final: () => void,
    ) => {
      expect(actual).toBe(tx);
      state.guards.push({ guard, final });
    },
    transactions: {
      async run<T>(work: (tx: MenuReferenceTransaction) => Promise<T>): Promise<T> {
        if (depth > 0) return work(tx);
        depth++;
        try {
          let result: T;
          try {
            result = await work(tx);
          } catch (error) {
            if (!state.swallow) throw error;
            result = {} as T;
          }
          if (state.double) {
            try {
              await work(tx);
            } catch {
              /* Deliberate hostile runner. */
            }
          }
          state.beforeGuards?.();
          for (const { guard } of state.guards) await guard();
          state.asyncPassed = true;
          await state.later?.();
          for (const { final } of state.guards) expect(final()).toBeUndefined();
          state.committed = true;
          return state.mode === "result" ? ({} as T) : result;
        } finally {
          depth--;
        }
      },
    },
  };
  const source: Source = entry.create(options);
  return { state, tx, options, authority, source };
}
for (const entry of entries)
  describe(entry.kind + " publication reference source V2", () => {
    it.each([false, true])(
      "binds the full None/Exact request and all stored references (Exact=%s)",
      async (exact) => {
        const input = request(exact),
          f = harness(entry),
          work = vi.fn(async (snapshot: unknown, actual: MenuReferenceTransaction) => {
            expect(actual).toBe(f.tx);
            return snapshot;
          });
        const result = await f.source.withCurrentSnapshot(input, work);
        expect(result).toMatchObject({
          request: input,
          coverage: "CompleteStoredReferences",
          consistency: "StatementSnapshot",
          applicability: "Unavailable",
          validUntil: input.validUntil,
        });
        expect(entry.parse(result, input, at)).toEqual(result);
        expect(work).toHaveBeenCalledOnce();
        expect(f.state.committed).toBe(true);
        expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(4);
        expect(
          f.authority.holdUntilTransactionCompletes.mock.calls.every(
            ([actual, packet]) =>
              actual === f.tx &&
              canonicalizeRfc8785((packet as { request: unknown }).request) ===
                canonicalizeRfc8785(input),
          ),
        ).toBe(true);
        expect(f.authority.holdUntilTransactionCompletes.mock.calls[0]?.[1]).toMatchObject({
          actorKind: "User",
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_" + entry.kind.toUpperCase() + "_SOURCE_READ",
          requiredFields: entry.fields,
        });
        expect(
          f.state.statements.some(
            ({ values }) => values[0] === "Catalog" + entry.kind + "ReferenceV1:" + id(2),
          ),
        ).toBe(true);
        expect(
          f.state.statements
            .filter(({ sql }) => sql.includes("set_config('bop.tenant_id'"))
            .every(
              ({ values }) => canonicalizeRfc8785(values) === canonicalizeRfc8785([id(1), id(2)]),
            ),
        ).toBe(true);
      },
    );
    it("preserves a genuinely empty never-written Brand without inventing source generation", async () => {
      const f = harness(entry, true),
        result = await f.source.withCurrentSnapshot(request(), async (value) => value);
      expect(result.generation).toBe("0");
      expect(result.applicability).toBe("Unavailable");
    });
    it("hashes observation and original deadline without renewing either", () => {
      const input = request(),
        original = entry.build(entry.raw(), input, at),
        later = entry.build({ ...entry.raw(), observedAt: plus(1) }, input, plus(1));
      expect(later.digest).not.toBe(original.digest);
      expect(later.validUntil).toBe(input.validUntil);
      expect(() => entry.build(entry.raw(), input, plus(5000))).toThrow();
      expect(() => entry.parse({ ...original, validUntil: plus(6000) }, input, at)).toThrow();
      expect(() =>
        entry.parse(
          { ...original, request: { ...input, aggregateSnapshotDigest: hash("another root") } },
          input,
          at,
        ),
      ).toThrow();
    });
    it("keeps legacy lifecycle requests and snapshot profiles closed", () => {
      const input = request(),
        raw = entry.raw(),
        snapshot = entry.build(raw, input, at);
      // Each legacy purpose stays specific; no fabricated LifecycleReview enters
      // a V2 source. The existing V1 suites cover unchanged canonical snapshots.
      if (entry.kind === "Menu") {
        const old = {
          purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ" as const,
          brandReference: id(2),
          actorReference: id(3),
          operationReference: id(8),
          catalogIntentDigest: hash("lifecycle"),
        };
        expect(() => parseMenuReferenceSourceSnapshot(snapshot, old, at)).toThrow();
        expect(() =>
          buildProductPublicationMenuReferenceSourceSnapshotV2(raw, old as never, at),
        ).toThrow();
        expect(() =>
          parseProductPublicationMenuReferenceSourceSnapshotV2(
            buildMenuReferenceSourceSnapshot(raw, old, at),
            input,
            at,
          ),
        ).toThrow();
      } else if (entry.kind === "Bundle") {
        const old = {
          purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ" as const,
          brandReference: id(2),
          actorReference: id(3),
          operationReference: id(8),
          catalogIntentDigest: hash("lifecycle"),
        };
        expect(() => parseBundleReferenceSourceSnapshot(snapshot, old, at)).toThrow();
        expect(() =>
          buildProductPublicationBundleReferenceSourceSnapshotV2(raw, old as never, at),
        ).toThrow();
        expect(() =>
          parseProductPublicationBundleReferenceSourceSnapshotV2(
            buildBundleReferenceSourceSnapshot(raw, old, at),
            input,
            at,
          ),
        ).toThrow();
      } else {
        const old = {
          purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ" as const,
          brandReference: id(2),
          actorReference: id(3),
          operationReference: id(8),
          catalogIntentDigest: hash("lifecycle"),
        };
        expect(() => parseAvailabilityReferenceSourceSnapshot(snapshot, old, at)).toThrow();
        expect(() =>
          buildProductPublicationAvailabilityReferenceSourceSnapshotV2(raw, old as never, at),
        ).toThrow();
        expect(() =>
          parseProductPublicationAvailabilityReferenceSourceSnapshotV2(
            buildAvailabilityReferenceSourceSnapshot(raw, old, at),
            input,
            at,
          ),
        ).toThrow();
      }
    });
    it("rejects another Brand's stored graph before the consumer", async () => {
      const f = harness(entry),
        work = vi.fn(async () => true),
        raw = f.state.raw;
      if ("reviews" in raw)
        raw.reviews = raw.reviews.map((value) => ({ ...value, brandReference: id(99) }));
      else if ("bundles" in raw)
        raw.bundles = raw.bundles.map((value) => ({ ...value, brandReference: id(99) }));
      else raw.rules = raw.rules.map((value) => ({ ...value, brandReference: id(99) }));
      await expect(f.source.withCurrentSnapshot(request(), work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
      expect(f.state.committed).toBe(false);
    });
    it.each(["generation", "isolation", "initial-denial", "nonvoid-holder"])(
      "fails closed before consumer: %s",
      async (fault) => {
        const f = harness(entry),
          work = vi.fn(async () => true);
        if (fault === "generation") f.state.raw.generation = null;
        if (fault === "isolation") f.state.isolation = "repeatable read";
        if (fault === "initial-denial") f.state.denied = true;
        if (fault === "nonvoid-holder")
          f.authority.holdUntilTransactionCompletes.mockResolvedValue(true as never);
        await expect(f.source.withCurrentSnapshot(request(), work)).rejects.toThrow();
        expect(work).not.toHaveBeenCalled();
        expect(f.state.committed).toBe(false);
      },
    );
    it.each(["generation", "initial-denial"])(
      "poisons an early refusal swallowed by a borrowed runner: %s",
      async (fault) => {
        const f = harness(entry);
        f.state.swallow = true;
        if (fault === "generation") f.state.raw.generation = null;
        else f.state.denied = true;
        await expect(f.source.withCurrentSnapshot(request(), async () => true)).rejects.toThrow();
        expect(f.state.guards).toHaveLength(1);
        expect(f.state.committed).toBe(false);
      },
    );
    it.each(["generation", "denial", "query", "clock", "reentry"])(
      "refuses changed original source through consumer completion: %s",
      async (fault) => {
        const f = harness(entry);
        await expect(
          f.source.withCurrentSnapshot(request(), async () => {
            if (fault === "generation") f.state.generation = "2";
            if (fault === "denial") f.state.denied = true;
            if (fault === "query") f.tx.query = async () => ({ rows: [] });
            if (fault === "clock") f.state.at = plus(-1);
            if (fault === "reentry")
              await f.source
                .withCurrentSnapshot(request(), async () => true)
                .catch(() => undefined);
            return true;
          }),
        ).rejects.toThrow();
        expect(f.state.committed).toBe(false);
      },
    );
    it("refuses a shorter original lease after a later awaited guard", async () => {
      const f = harness(entry);
      f.state.later = async () => {
        await Promise.resolve();
        f.state.at = plus(1000);
      };
      await expect(
        f.source.withCurrentSnapshot(request(false, 1000), async () => true),
      ).rejects.toThrow();
      expect(f.state.asyncPassed).toBe(true);
      expect(f.state.committed).toBe(false);
    });
    it.each(["generation", "denial"])(
      "rechecks the held source at outer commit: %s",
      async (fault) => {
        const f = harness(entry),
          work = vi.fn(async () => true);
        f.state.beforeGuards = () => {
          if (fault === "generation") f.state.generation = "2";
          else f.state.denied = true;
        };
        await expect(f.source.withCurrentSnapshot(request(), work)).rejects.toThrow();
        expect(work).toHaveBeenCalledOnce();
        expect(f.state.committed).toBe(false);
      },
    );
    it("captures ports and refuses substituted or repeated runner outcomes", async () => {
      const f = harness(entry);
      f.options.clock.now = () => {
        throw new Error("replaced clock");
      };
      Object.assign(f.options.authority, {
        holdUntilTransactionCompletes: vi.fn(async () => {
          throw new Error("replaced authority");
        }),
      });
      f.options.registerBeforeCommit = async () => {
        throw new Error("replaced hook");
      };
      await expect(f.source.withCurrentSnapshot(request(), async () => true)).resolves.toBe(true);
      const repeated = harness(entry);
      repeated.state.double = true;
      await expect(
        repeated.source.withCurrentSnapshot(request(), async () => true),
      ).rejects.toThrow();
      expect(repeated.state.committed).toBe(false);
      const changed = harness(entry);
      changed.state.mode = "result";
      await expect(
        changed.source.withCurrentSnapshot(request(), async () => true),
      ).rejects.toThrow();
      // A dishonest runner result is rejected; this is not a rollback claim.
    });
    it("accepts a complete System activation command without converting it to Validate", async () => {
      const initial = request(),
        command = parseProductPublicationCommandV2({
          ...initial.command,
          action: "ActivateScheduled",
          actorKind: "System",
          expectedPublicationVersion: 1,
          scheduleReference: id(90),
          successorDraftVersionReference: id(91),
        }),
        input = parseCatalogProductPublicationReferenceRequestV2({
          ...initial,
          command,
          originalIntentDigest: hash(command),
          currentPublicationDigest: hash("scheduled publication"),
        }),
        f = harness(entry, false, "System");
      const result = await f.source.withCurrentSnapshot(input, async (value) => value);
      expect(result.request.command.action).toBe("ActivateScheduled");
      expect(result.request.originalIntentDigest).toBe(hash(command));
      const user = harness(entry);
      await expect(user.source.withCurrentSnapshot(input, async () => true)).rejects.toThrow();
      expect(user.state.statements).toHaveLength(0);
    });
  });
