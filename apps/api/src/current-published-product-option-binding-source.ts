import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductOptionBinding,
  assessCatalogFullProductOptionBindingPrerequisites,
} from "@rms/catalog";
import {
  createCurrentPublishedOptionSetGraphSource,
  type CurrentPublishedOptionSetGraphOptions,
} from "./current-published-option-set-graph.js";
import type { CurrentPublishedProductOptionBindingAssessment } from "./merchant-product-editor-pinned-option-authority.js";

type Graph = Parameters<
  ReturnType<typeof createCurrentPublishedOptionSetGraphSource>["withCurrentGraph"]
>[1] extends (source: infer S) => Promise<unknown>
  ? S
  : never;
type Transaction = CurrentPublishedOptionSetGraphOptions["transaction"];

/** One Product request's actual held Published sources. A selected version is
 * exact; neither a picker packet nor today's editable Option Draft is proof. */
export function createCurrentPublishedProductOptionBindingSource(
  options: CurrentPublishedOptionSetGraphOptions,
) {
  const tx = options.transaction,
    query = tx.query,
    clockOwner = options.clock,
    clockPort = clockOwner.now,
    clock = clockPort.bind(clockOwner),
    authorityOwner = options.currentAuthorization,
    assertPort = authorityOwner.assertCurrent,
    assertAuthority = assertPort.bind(authorityOwner),
    registerPort = options.registerBeforeCommit,
    register = registerPort.bind(options),
    originalOptions = { ...options };
  const brand = parseCatalogReference(options.brandReference),
    tenant = parseCatalogReference(options.tenantReference);
  let latest = parseCatalogInstant(clock()),
    deadline = parseCatalogInstant(options.originalValidUntil),
    failed = false;
  const sources = new Map<string, Promise<Graph>>();
  let phase: "work" | "checks" | "closed" = "work",
    finalizedGraphs = 0;
  const fail = (): never => {
    failed = true;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (deadline <= latest || Date.parse(deadline) - Date.parse(latest) > 5000) return fail();
  const check = () => {
    if (
      failed ||
      tx.query !== query ||
      options.transaction !== tx ||
      options.clock !== clockOwner ||
      clockOwner.now !== clockPort ||
      options.currentAuthorization !== authorityOwner ||
      authorityOwner.assertCurrent !== assertPort ||
      options.registerBeforeCommit !== registerPort ||
      Object.keys(originalOptions).some(
        (key) =>
          options[key as keyof typeof options] !== originalOptions[key as keyof typeof options],
      )
    )
      return fail();
    const at = parseCatalogInstant(clock());
    if (at < latest || at >= deadline) return fail();
    latest = at;
    assertAuthority();
    return at;
  };
  const graphFor = async (set: string, version: string): Promise<Graph> => {
    if (phase !== "work") return fail();
    check();
    const key = set + ":" + version;
    const existing = sources.get(key);
    if (existing) {
      const result = await existing;
      check();
      return result;
    }
    if (sources.size >= 32) return fail();
    const pending = (async () => {
      // Retain every owning guard, but use one host slot per distinct graph.
      // Finals still execute only after ALL host asynchronous guards.
      const guards = new Map<() => Promise<void>, (() => void) | undefined>();
      let ready = false,
        checking = false,
        asyncDone = false,
        finalDone = false;
      const collect: CurrentPublishedOptionSetGraphOptions["registerBeforeCommit"] = async (
        actual,
        guard,
        final,
      ) => {
        check();
        if (
          actual !== tx ||
          checking ||
          finalDone ||
          typeof guard !== "function" ||
          (final !== undefined && typeof final !== "function") ||
          (guards.has(guard) && guards.get(guard) !== final) ||
          (!guards.has(guard) && guards.size >= 128)
        )
          return fail();
        guards.set(guard, final);
      };
      await register(
        tx,
        async () => {
          if (!ready || checking || asyncDone || finalDone) return fail();
          phase = "checks";
          checking = true;
          check();
          for (const guard of guards.keys()) {
            if ((await guard()) !== undefined) return fail();
            check();
          }
          asyncDone = true;
        },
        () => {
          if (!ready || !asyncDone || finalDone) return fail();
          finalDone = true;
          check();
          for (const final of guards.values()) {
            if (final && final() !== undefined) return fail();
            check();
          }
          if (++finalizedGraphs === sources.size) phase = "closed";
        },
      );
      const source = createCurrentPublishedOptionSetGraphSource({
        ...options,
        transaction: tx,
        clock: { now: check },
        registerBeforeCommit: collect,
      });
      let calls = 0;
      const graph = await source.withCurrentGraph(
        { optionSetReference: set, versionReference: version },
        async (value) => {
          if (
            ++calls !== 1 ||
            value.graph.brandReference !== brand ||
            value.graph.rootOptionSetReference !== set ||
            value.graph.rootVersionReference !== version ||
            value.sourceAuthority !== "CurrentPublishingReleaseAndFrozenContent"
          )
            return fail();
          check();
          if (value.validUntil < deadline) deadline = parseCatalogInstant(value.validUntil);
          check();
          return value;
        },
      );
      if (calls !== 1 || guards.size === 0) return fail();
      ready = true;
      check();
      return graph;
    })().catch((error: unknown) => {
      failed = true;
      throw error;
    });
    sources.set(key, pending);
    return await pending;
  };
  return Object.freeze({
    async resolveVersion(value: unknown) {
      try {
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
          "brandReference",
          "optionSetReference",
          "optionSetVersionReference",
        ]);
        if (parseCatalogReference(input.brandReference) !== brand) return fail();
        const set = parseCatalogReference(input.optionSetReference),
          version = parseCatalogReference(input.optionSetVersionReference);
        const held = await graphFor(set, version);
        const root = held.graph.contents.find(
          (content) =>
            content.sourceAggregate.optionSetReference === set &&
            content.sourceAggregate.draft.versionReference === version,
        );
        if (!root) return fail();
        check();
        return root.sourceAggregate;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async withBindingAssessment<T>(
      actual: Transaction,
      value: unknown,
      work: (assessment: CurrentPublishedProductOptionBindingAssessment) => Promise<T>,
    ): Promise<T> {
      try {
        if (actual !== tx || typeof work !== "function") return fail();
        const binding = parseProductOptionBinding(copyCategoryPersistenceValue(value));
        const held = await graphFor(binding.optionSetReference, binding.optionSetVersionReference);
        const assessment = assessCatalogFullProductOptionBindingPrerequisites({
          graph: held.graph,
          binding,
        });
        const observedAt = check();
        const body = Object.freeze({
          profile: "CurrentPublishedProductOptionBindingAssessmentV1" as const,
          tenantReference: tenant,
          brandReference: brand,
          bindingReference: binding.bindingReference,
          bindingDigest: assessment.bindingDigest,
          rootOptionSetReference: binding.optionSetReference,
          rootVersionReference: binding.optionSetVersionReference,
          graphDigest: assessment.graphDigest,
          sourceRecords: Object.freeze(
            held.sourceRecords.map((record) =>
              Object.freeze({
                ...record,
                recordDigest: record.sealRecordDigest,
                observedAt: held.observedAt,
              }),
            ),
          ),
          rules: Object.freeze({
            status: assessment.status,
            reason: "reason" in assessment ? assessment.reason : null,
            searchNodes: assessment.searchNodes,
          }),
          observedAt,
          validUntil: deadline,
          sourceAuthority: "CurrentPublishingReleaseAndFrozenContent" as const,
          publishValidation: "Incomplete" as const,
          referenceEligibility: "NotEvaluated" as const,
          eligibility: "NotEvaluated" as const,
        });
        const result = await work(
          Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) }),
        );
        check();
        return result;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  });
}
