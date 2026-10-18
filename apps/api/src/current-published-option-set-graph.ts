import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { createPostgresPublishingMutationStore, createPublishingScope } from "@bop/publishing";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  evaluateCatalogOptionSetRuleSatisfiability,
  createPostgresFrozenFullOptionSetContentStore,
  createPostgresOptionSetReviewContentStore,
  frozenFullOptionSetContentFields,
  optionSetReleaseRecordFields,
  parseCatalogFullOptionSetPublicationContent,
  parseCatalogOptionSetReleaseRecord,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import type { MerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Transaction = Parameters<Host["registerBeforeCommit"]>[0];
type PublishingOwner = ReturnType<typeof createPostgresPublishingMutationStore>;
type ReleaseProof = Awaited<ReturnType<PublishingOwner["resolveCurrentOptionSetRelease"]>>;
type ReleaseRecord = ReturnType<typeof parseCatalogOptionSetReleaseRecord>;
type Frozen = ReturnType<typeof parseCatalogFullOptionSetPublicationContent>;
interface Node {
  readonly proof: ReleaseProof;
  readonly linkage: ReleaseRecord;
  readonly content: Frozen;
}
export interface CurrentPublishedOptionSetGraphOptions {
  readonly transaction: Transaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly currentAuthorization: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  readonly capability: MerchantProductStoreCapabilityGuard;
  /** Fixed server host admission; never a browser-selected permission. */
  readonly capabilityPermissionAction?: "catalog.manage" | "pricing.price-book.manage";
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
  readonly events: { generateReference(): string };
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const stableProof = ({ observedAt, ...proof }: ReleaseProof) => {
  void observedAt;
  return proof;
};

/** Actual current Publishing head joined to immutable Catalog linkage and full
 * sealed preimage in one request-owned transaction. Explicit child version pins
 * must still be current: they are never upgraded. This source does not establish
 * Pricing/consumption/Media/Binding applicability or full publish admission. */
export function createCurrentPublishedOptionSetGraphSource(
  options: CurrentPublishedOptionSetGraphOptions,
) {
  const tx = options.transaction,
    query = tx?.query;
  const capabilityPermissionAction = options.capabilityPermissionAction;
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    store = parseCatalogReference(options.storeReference),
    actor = parseCatalogReference(options.actorReference),
    session = parseCatalogReference(options.sessionReference);
  if (
    (capabilityPermissionAction !== undefined &&
      capabilityPermissionAction !== "catalog.manage" &&
      capabilityPermissionAction !== "pricing.price-book.manage") ||
    typeof query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.currentAuthorization?.authorizeActions !== "function" ||
    typeof options.currentAuthorization?.assertCurrent !== "function" ||
    typeof options.currentAuthorization?.leaseDeadline !== "function" ||
    (options.capability?.holdUntilCommitWithDecisions !== undefined &&
      typeof options.capability.holdUntilCommitWithDecisions !== "function") ||
    typeof options.capability?.holdUntilCommit !== "function" ||
    typeof options.capability?.leaseDeadline !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.events?.generateReference !== "function"
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const clock = options.clock.now.bind(options.clock),
    authorizePort = options.currentAuthorization.authorizeActions,
    authorize = authorizePort.bind(options.currentAuthorization),
    assertPort = options.currentAuthorization.assertCurrent,
    assertCurrent = assertPort.bind(options.currentAuthorization),
    leasePort = options.currentAuthorization.leaseDeadline,
    lease = leasePort.bind(options.currentAuthorization),
    combinedPort = options.capability.holdUntilCommitWithDecisions,
    combined = combinedPort?.bind(options.capability),
    capabilityPort = options.capability.holdUntilCommit,
    holdCapability = capabilityPort.bind(options.capability),
    capabilityLeasePort = options.capability.leaseDeadline,
    capabilityLease = capabilityLeasePort.bind(options.capability),
    registerPort = options.registerBeforeCommit,
    register = registerPort.bind(options),
    eventPort = options.events.generateReference,
    generateEvent = eventPort.bind(options.events);
  const startedAt = parseCatalogInstant(clock()),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (originalDeadline <= startedAt || Date.parse(originalDeadline) - Date.parse(startedAt) > 5000)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let latest = startedAt,
    deadline = originalDeadline,
    failed = false,
    active = false,
    entered = false,
    ready = false,
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0,
    finalized = false;
  const nodes = new Map<string, Node>();
  const expected = new Map<
    string,
    { version: string; proof: ReleaseProof; record: ReleaseRecord | null }
  >();
  const poison = (): never => {
    failed = true;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
      throw error;
    return poison();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(clock());
      if (
        failed ||
        tx.query !== query ||
        options.capabilityPermissionAction !== capabilityPermissionAction ||
        at < latest ||
        at >= deadline ||
        options.clock.now !== clockPort ||
        options.currentAuthorization.authorizeActions !== authorizePort ||
        options.currentAuthorization.assertCurrent !== assertPort ||
        options.currentAuthorization.leaseDeadline !== leasePort ||
        options.capability.holdUntilCommit !== capabilityPort ||
        options.capability.holdUntilCommitWithDecisions !== combinedPort ||
        options.capability.leaseDeadline !== capabilityLeasePort ||
        options.registerBeforeCommit !== registerPort ||
        options.events.generateReference !== eventPort
      )
        return poison();
      assertCurrent();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const clockPort = options.clock.now;
  const tighten = () => {
    const a = parseCatalogInstant(lease()),
      b = parseCatalogInstant(capabilityLease());
    if (a < deadline) deadline = a;
    if (b < deadline) deadline = b;
    return check();
  };
  const hold = async () => {
    check();
    const actions = Object.freeze(
      capabilityPermissionAction === "pricing.price-book.manage"
        ? ["catalog.manage", "catalog.option_set.read", "pricing.price-book.manage"]
        : ["catalog.manage", "catalog.option_set.read"],
    );
    if (combined) {
      const current = await combined(actions);
      check();
      if (
        !Array.isArray(current) ||
        !Object.isFrozen(current) ||
        Object.getPrototypeOf(current) !== Array.prototype ||
        current.length !== actions.length ||
        Reflect.ownKeys(current).length !== actions.length + 1
      )
        return poison();
      const evidence = copyCategoryPersistenceValue(current);
      if (!Array.isArray(evidence) || evidence.length !== actions.length) return poison();
      for (let i = 0; i < evidence.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(i));
        if (
          !descriptor?.enumerable ||
          !("value" in descriptor) ||
          !Object.isFrozen(descriptor.value)
        )
          return poison();
        const audit = Object.getOwnPropertyDescriptor(descriptor.value, "audit");
        if (!audit || !("value" in audit) || !Object.isFrozen(audit.value)) return poison();
        const d = readClosedRecord(evidence[i], [
          "effect",
          "reason",
          "source",
          "action",
          "scopeKind",
          "policySnapshotReference",
          "policyVersion",
          "audit",
        ]);
        const a = readClosedRecord(d.audit, ["effect", "reason", "source"]);
        if (
          d.action !== actions[i] ||
          d.effect !== "Allow" ||
          d.scopeKind !== "Brand" ||
          !(
            (d.reason === "ROLE_PERMISSION" && d.source === "RolePermission") ||
            (d.reason === "EXPLICIT_ALLOW" && d.source === "ExplicitAllow")
          ) ||
          a.effect !== d.effect ||
          a.reason !== d.reason ||
          a.source !== d.source
        )
          return poison();
        parseBusinessAction(d.action);
        parsePolicyReference(d.policySnapshotReference);
        parsePolicyVersion(d.policyVersion);
      }
    } else {
      if ((await holdCapability()) !== undefined) return poison();
      check();
      // Restore actual Brand scope after the legacy Store Feature read.
      if ((await authorize(actions)) !== undefined) return poison();
    }
    return tighten();
  };
  const evidence = async (observedAt: string) => {
    const at = parseCatalogInstant(observedAt);
    if (at < startedAt || at > check()) return poison();
    await hold();
    return Object.freeze({ observedAt: at, validUntil: parseCatalogInstant(deadline) });
  };
  const publishing = createPostgresPublishingMutationStore(
    { run: (work) => work(tx) },
    tenant,
    createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
  );
  const releaseStore = createPostgresOptionSetReviewContentStore({
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    clock: { now: check },
    registerBeforeCommit: register,
    events: { generateReference: generateEvent },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        const entry = expected.get(input.optionSetReference);
        if (
          actual !== tx ||
          !entry ||
          input.tenantReference !== tenant ||
          input.brandReference !== brand ||
          input.actorReference !== actor ||
          input.actorKind !== "User" ||
          input.permission !== "catalog.manage" ||
          input.action !== "catalog.option_set.read" ||
          input.phase !== "Read" ||
          input.purposeCode !== "CATALOG_OPTION_SET_RELEASE_RECORD" ||
          !equal(input.requiredFields, optionSetReleaseRecordFields)
        )
          return poison();
        if (input.record !== null) {
          const record = parseCatalogOptionSetReleaseRecord(input.record);
          if (
            record.optionSetReference !== input.optionSetReference ||
            record.versionReference !== entry.version ||
            !equal(record.release, entry.proof.release) ||
            (entry.record !== null && !equal(record, entry.record))
          )
            return poison();
        }
        return evidence(input.observedAt);
      },
    },
  });
  const frozenStore = createPostgresFrozenFullOptionSetContentStore({
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    clock: { now: check },
    transactions: { run: (work) => work(tx) },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        const entry = expected.get(input.optionSetReference);
        if (
          actual !== tx ||
          !entry?.record ||
          input.tenantReference !== tenant ||
          input.brandReference !== brand ||
          input.actorReference !== actor ||
          input.actorKind !== "User" ||
          input.permission !== "catalog.manage" ||
          input.action !== "catalog.option_set.read" ||
          input.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
          input.versionReference !== entry.version ||
          !equal(input.requiredFields, frozenFullOptionSetContentFields)
        )
          return poison();
        if (input.content !== null) {
          const content = parseCatalogFullOptionSetPublicationContent(input.content);
          if (
            content.digest !== entry.record.sealRecordDigest ||
            content.supportedContent.versionReference !== entry.version ||
            content.supportedContent.optionSetReference !== input.optionSetReference ||
            content.supportedContent.publicationOperationReference !==
              entry.record.sealOperationReference
          )
            return poison();
        }
        return evidence(input.observedAt);
      },
    },
  });
  const currentProof = async (set: string) => {
    await hold();
    const at = check(),
      proof = await publishing.resolveCurrentOptionSetRelease({
        familyReference: set,
        observedAt: at,
      });
    check();
    if (
      proof.observedAt !== at ||
      String(proof.release.familyReference) !== set ||
      proof.release.configurationType !== "CATALOG_OPTION_SET" ||
      proof.release.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
      proof.release.scope.kind !== "Brand" ||
      String(proof.release.scope.brandReference) !== brand ||
      proof.release.scope.storeReference !== null ||
      proof.lifecycle.state !== "Published" ||
      proof.lifecycle.snapshotDigest !== proof.release.snapshotDigest ||
      proof.lifecycle.snapshotReference !== proof.release.snapshotReference ||
      String(proof.release.sourceLifecycleId) !== String(proof.lifecycle.lifecycleId) ||
      String(proof.release.createdAt) > at
    )
      return poison();
    // The public reference reader also verifies that this exact published release
    // is the current head; a historical published record is insufficient.
    const referenced = await publishing.resolveCurrentOptionSetReleaseForReference({
      publicationReference: String(proof.release.releaseId),
      observedAt: at,
    });
    check();
    if (
      referenced.observedAt !== at ||
      !equal(stableProof(referenced.current), stableProof(proof)) ||
      !equal(referenced.recorded, stableProof(proof))
    )
      return poison();
    return immutable(proof);
  };
  return Object.freeze({
    async withCurrentGraph<T>(
      value: unknown,
      work: (source: {
        readonly profile: "CurrentPublishedOptionSetGraphV1";
        readonly graph: {
          readonly brandReference: string;
          readonly rootOptionSetReference: string;
          readonly rootVersionReference: string;
          readonly contents: readonly Frozen["editorContent"][];
        };
        readonly sourceRecords: readonly {
          readonly optionSetReference: string;
          readonly versionReference: string;
          readonly publicationReference: string;
          readonly releaseRecordDigest: string;
          readonly sealRecordDigest: string;
          readonly approvalDisposition: ReleaseProof["approvalDisposition"];
        }[];
        readonly graphDigest: string;
        readonly rules: {
          readonly status: ReturnType<typeof evaluateCatalogOptionSetRuleSatisfiability>["status"];
          readonly reason: string | null;
          readonly searchNodes: number;
        };
        readonly originalObservedAt: string;
        readonly observedAt: string;
        readonly validUntil: string;
        readonly sourceAuthority: "CurrentPublishingReleaseAndFrozenContent";
        readonly referenceEligibility: "NotEvaluated";
        readonly eligibility: "NotEvaluated";
        readonly publishValidation: "Incomplete";
      }) => Promise<T>,
    ): Promise<T> {
      if (entered || active || finalized) return poison();
      entered = true;
      active = true;
      try {
        // Mandatory host poison/final guard is registered before parsing or exposing errors.
        if (
          (await register(
            tx,
            async () => {
              if (!ready || active || ++guardCalls !== 1) return poison();
              active = true;
              try {
                await hold();
                for (const [set, node] of nodes) {
                  const proof = await currentProof(set);
                  if (!equal(stableProof(proof), stableProof(node.proof))) return poison();
                }
                check();
                guardComplete = true;
              } catch (error) {
                return reject(error);
              } finally {
                active = false;
              }
            },
            () => {
              if (!ready || active || guardCalls !== 1 || !guardComplete || ++finalCalls !== 1)
                return poison();
              tighten();
              finalized = true;
            },
          )) !== undefined
        )
          return poison();
        const request = readClosedRecord(copyCategoryPersistenceValue(value), [
          "optionSetReference",
          "versionReference",
        ]);
        const root = parseCatalogReference(request.optionSetReference),
          pin =
            request.versionReference === null
              ? null
              : parseCatalogReference(request.versionReference);
        if (typeof work !== "function") return poison();
        const pending: { set: string; version: string | null }[] = [{ set: root, version: pin }];
        for (const candidate of pending) {
          check();
          const existing = expected.get(candidate.set);
          if (existing) {
            if (candidate.version !== null && existing.version !== candidate.version)
              return poison();
            continue;
          }
          if (expected.size >= 32) return poison();
          const proof = await currentProof(candidate.set),
            version = String(proof.release.snapshotReference);
          if (candidate.version !== null && candidate.version !== version) {
            // Only a known initial root head mismatch is an expected-version
            // conflict. Contradictory triggered children remain unavailable.
            if (candidate.set === root && expected.size === 0 && pin !== null)
              return reject(new CatalogError("CATALOG_VERSION_CONFLICT"));
            return poison();
          }
          const entry = { version, proof, record: null as ReleaseRecord | null };
          expected.set(candidate.set, entry);
          const raw = await releaseStore.readReleaseForPublication(
            tx,
            String(proof.release.releaseId),
            candidate.set,
          );
          if (!raw) return poison();
          const record = parseCatalogOptionSetReleaseRecord(raw);
          if (
            record.tenantReference !== tenant ||
            record.brandReference !== brand ||
            record.optionSetReference !== candidate.set ||
            record.versionReference !== version ||
            !equal(record.release, proof.release)
          )
            return poison();
          entry.record = record;
          const observed = await frozenStore.readPinned({
            optionSetReference: candidate.set,
            versionReference: version,
            expectedRecordDigest: record.sealRecordDigest,
          });
          check();
          const content = parseCatalogFullOptionSetPublicationContent(observed.content),
            supported = content.supportedContent;
          if (
            observed.eligibility !== "NotEvaluated" ||
            content.digest !== record.sealRecordDigest ||
            supported.tenantReference !== tenant ||
            supported.brandReference !== brand ||
            supported.optionSetReference !== candidate.set ||
            supported.versionReference !== version ||
            supported.publicationOperationReference !== record.sealOperationReference ||
            String(supported.sealedAt) > String(record.recordedAt)
          )
            return poison();
          const observedAt = parseCatalogInstant(observed.observedAt),
            until = parseCatalogInstant(observed.validUntil);
          if (observedAt < startedAt || observedAt > latest || until <= observedAt) return poison();
          if (until < deadline) deadline = until;
          check();
          nodes.set(candidate.set, immutable({ proof, linkage: record, content }));
          for (const option of content.editorContent.sourceAggregate.draft.options) {
            if (option.triggeredOptionSetReference === null) continue;
            const version = content.editorContent.optionDetails.find(
              (detail) => detail.optionReference === option.optionReference,
            )?.triggeredOptionSetVersionReference;
            if (!version) return poison();
            const set = String(option.triggeredOptionSetReference),
              child = String(version);
            const reached = expected.get(set);
            if (reached && reached.version !== child) return poison();
            const queued = pending.find((item) => item.set === set);
            if (queued && queued.version !== null && queued.version !== child) return poison();
            if (!queued) {
              if (pending.length >= 32) return poison();
              pending.push({ set, version: child });
            }
          }
        }
        const rootNode = nodes.get(root);
        if (!rootNode) return poison();
        const ordered = [...nodes.entries()].sort(([a], [b]) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        );
        const graph = immutable({
          brandReference: String(brand),
          rootOptionSetReference: String(root),
          rootVersionReference: String(rootNode.proof.release.snapshotReference),
          contents: ordered.map(([, node]) => node.content.editorContent),
        });
        const sourceRecords = immutable(
          ordered.map(([set, node]) => ({
            optionSetReference: set,
            versionReference: String(node.proof.release.snapshotReference),
            publicationReference: String(node.proof.release.releaseId),
            releaseRecordDigest: String(node.linkage.digest),
            sealRecordDigest: String(node.content.digest),
            approvalDisposition: node.proof.approvalDisposition,
          })),
        );
        // Use Catalog's normalized graph identity and actual mechanical result.
        // Even Satisfiable does not certify the remaining publication prerequisites.
        const assessment = evaluateCatalogOptionSetRuleSatisfiability(graph);
        const source = immutable({
          profile: "CurrentPublishedOptionSetGraphV1" as const,
          graph,
          sourceRecords,
          graphDigest: assessment.graphDigest,
          rules: {
            status: assessment.status,
            reason: "reason" in assessment ? assessment.reason : null,
            searchNodes: assessment.searchNodes,
          },
          originalObservedAt: startedAt,
          observedAt: check(),
          validUntil: deadline,
          sourceAuthority: "CurrentPublishingReleaseAndFrozenContent" as const,
          referenceEligibility: "NotEvaluated" as const,
          eligibility: "NotEvaluated" as const,
          publishValidation: "Incomplete" as const,
        });
        const result = await work(source);
        check();
        await hold();
        ready = true;
        return result;
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
    /** Original guards must have run in the actual outer host before this lease is exposed. */
    assertFinalized(): string {
      if (
        !entered ||
        !ready ||
        active ||
        !finalized ||
        guardCalls !== 1 ||
        !guardComplete ||
        finalCalls !== 1
      )
        return poison();
      tighten();
      return deadline;
    },
    context: Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      storeReference: store,
      actorReference: actor,
      sessionReference: session,
    }),
  });
}
