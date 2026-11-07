import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresCurrentFullOptionSetDraftStore,
  createPostgresFullOptionSetSealHandoffStore,
  parseFullOptionSetPublicationSealIdentity,
  frozenFullOptionSetContentFields,
  type FullOptionSetPublicationSealIdentity,
  currentFullOptionSetDraftReviewFields,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import {
  createCurrentPublishedOptionSetGraphSource,
  type CurrentPublishedOptionSetGraphOptions,
} from "./current-published-option-set-graph.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type RootOwner = ReturnType<typeof createPostgresCurrentFullOptionSetDraftStore>;
type Root = Awaited<ReturnType<RootOwner["readCurrentForReview"]>>;
type Published = Parameters<
  Parameters<ReturnType<typeof createCurrentPublishedOptionSetGraphSource>["withCurrentGraph"]>[1]
>[0];
interface Request {
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function prepared(value: unknown) {
  const record = readClosedRecord(copyCategoryPersistenceValue(value), [
    "profile",
    "sourceAggregate",
    "optionDetails",
    "conditionalRules",
    "conflictRules",
    "scopeSet",
    "effectivePeriod",
  ]);
  const { sourceAggregate, ...additional } = record;
  return parseCatalogOptionSetEditorContent(sourceAggregate, additional);
}
const stableRoot = ({ observedAt, validUntil, ...value }: Root) => {
  void observedAt;
  void validUntil;
  return value;
};

/** Actual editable Draft/provenance plus held CurrentPublished trigger children.
 * Every root tuple is compared with owning data; sourceOperationReference comes
 * solely from readCurrentForReview. Neither caller pins nor mechanical rules
 * certify the remaining references, policy, topology or approval prerequisites. */
export function createCurrentOptionSetPublicationDraftGraphSource(
  options: CurrentPublishedOptionSetGraphOptions & {
    readonly originalObservedAt?: string;
    readonly publicationSeal?: FullOptionSetPublicationSealIdentity;
  },
) {
  const tx = options.transaction,
    query = tx?.query,
    tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    store = parseCatalogReference(options.storeReference),
    actor = parseCatalogReference(options.actorReference),
    session = parseCatalogReference(options.sessionReference);
  if (
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
  const clockPort = options.clock.now,
    clock = clockPort.bind(options.clock),
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
    eventPort = options.events.generateReference;
  const currentStartedAt = parseCatalogInstant(clock()),
    startedAt = parseCatalogInstant(options.originalObservedAt ?? currentStartedAt),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (
    currentStartedAt < startedAt ||
    currentStartedAt >= originalDeadline ||
    originalDeadline <= startedAt ||
    Date.parse(originalDeadline) - Date.parse(startedAt) > 5000
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let latest = currentStartedAt,
    deadline = originalDeadline,
    failed = false,
    entered = false,
    active = false,
    ready = false,
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0,
    finalized = false;
  const sealIdentity =
    options.publicationSeal === undefined
      ? undefined
      : parseFullOptionSetPublicationSealIdentity(options.publicationSeal);
  let ownSealAdmitted = false;
  let request: Request | undefined, acquired: Root | undefined;
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
      // Shared child/owner clocks still sample during their later final assertions.
      if (
        failed ||
        tx.query !== query ||
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
  const tighten = () => {
    const a = parseCatalogInstant(lease()),
      b = parseCatalogInstant(capabilityLease());
    if (a < deadline) deadline = a;
    if (b < deadline) deadline = b;
    return check();
  };
  const hold = async () => {
    check();
    const actions = Object.freeze(["catalog.manage", "catalog.option_set.read"]);
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
  const rootOwner = createPostgresCurrentFullOptionSetDraftStore({
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    clock: { now: check },
    transactions: { run: (work) => work(tx) },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          !request ||
          input.tenantReference !== tenant ||
          input.brandReference !== brand ||
          input.actorReference !== actor ||
          input.actorKind !== "User" ||
          input.permission !== "catalog.manage" ||
          input.action !== "catalog.option_set.read" ||
          input.purposeCode !== "CATALOG_OPTION_SET_DRAFT" ||
          input.optionSetReference !== request.optionSetReference ||
          !equal(input.requiredFields, currentFullOptionSetDraftReviewFields)
        )
          return poison();
        const observedAt = parseCatalogInstant(input.observedAt);
        if (observedAt < startedAt || observedAt > check()) return poison();
        if (input.content !== null) {
          const full = prepared(input.content),
            source = full.content.sourceAggregate;
          if (
            source.brandReference !== brand ||
            source.optionSetReference !== request.optionSetReference ||
            source.draft.versionReference !== request.versionReference ||
            source.aggregateVersion !== request.expectedAggregateVersion ||
            full.sourceDigest !== request.sourceDigest ||
            full.contentDigest !== request.contentDigest ||
            full.configurationDigest !== request.configurationDigest
          )
            return poison();
        }
        await hold();
        return Object.freeze({ observedAt, validUntil: parseCatalogInstant(deadline) });
      },
    },
  });
  const handoffOwner = sealIdentity
    ? createPostgresFullOptionSetSealHandoffStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        originalObservedAt: startedAt,
        originalValidUntil: originalDeadline,
        sealIdentity,
        clock: { now: check },
        transactions: {
          async run(action) {
            check();
            const result = await action(tx);
            check();
            return result;
          },
        },
        currentDraftAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            if (
              actual !== tx ||
              !request ||
              input.tenantReference !== tenant ||
              input.brandReference !== brand ||
              input.actorReference !== actor ||
              input.actorKind !== "User" ||
              input.permission !== "catalog.manage" ||
              input.action !== "catalog.option_set.read" ||
              input.purposeCode !== "CATALOG_OPTION_SET_DRAFT" ||
              input.optionSetReference !== request.optionSetReference ||
              !equal(input.requiredFields, currentFullOptionSetDraftReviewFields) ||
              parseCatalogInstant(input.observedAt) < currentStartedAt ||
              parseCatalogInstant(input.observedAt) > check()
            )
              return poison();
            await hold();
            return Object.freeze({ observedAt: input.observedAt, validUntil: deadline });
          },
        },
        frozenAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            if (
              actual !== tx ||
              !request ||
              input.tenantReference !== tenant ||
              input.brandReference !== brand ||
              input.actorReference !== actor ||
              input.actorKind !== "User" ||
              input.permission !== "catalog.manage" ||
              input.action !== "catalog.option_set.read" ||
              input.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
              input.optionSetReference !== request.optionSetReference ||
              input.versionReference !== request.versionReference ||
              !equal(input.requiredFields, frozenFullOptionSetContentFields) ||
              parseCatalogInstant(input.observedAt) < currentStartedAt ||
              parseCatalogInstant(input.observedAt) > check()
            )
              return poison();
            await hold();
            return Object.freeze({ observedAt: input.observedAt, validUntil: deadline });
          },
        },
      })
    : undefined;
  const readRoot = async () => {
    if (!request) return poison();
    await hold();
    const value = await rootOwner.readCurrentForReview({
      optionSetReference: request.optionSetReference,
      expectedAggregateVersion: request.expectedAggregateVersion,
    });
    const full = prepared(value.content),
      source = full.content.sourceAggregate,
      tuple = value.sourceSnapshotTuple;
    const operation = parseCatalogReference(value.sourceOperationReference);
    if (
      value.referenceEligibility !== "NotEvaluated" ||
      source.brandReference !== brand ||
      source.optionSetReference !== request.optionSetReference ||
      source.draft.versionReference !== request.versionReference ||
      source.aggregateVersion !== request.expectedAggregateVersion ||
      full.sourceDigest !== request.sourceDigest ||
      full.contentDigest !== request.contentDigest ||
      full.configurationDigest !== request.configurationDigest ||
      value.sourceDigest !== full.sourceDigest ||
      value.contentDigest !== full.contentDigest ||
      value.configurationDigest !== full.configurationDigest ||
      tuple.tenantReference !== tenant ||
      tuple.brandReference !== brand ||
      tuple.optionSetReference !== request.optionSetReference ||
      tuple.versionReference !== request.versionReference ||
      tuple.aggregateVersion !== request.expectedAggregateVersion ||
      tuple.sourceDigest !== full.sourceDigest ||
      tuple.contentDigest !== full.contentDigest ||
      tuple.configurationDigest !== full.configurationDigest
    )
      return poison();
    const observedAt = parseCatalogInstant(value.observedAt),
      until = parseCatalogInstant(value.validUntil);
    if (observedAt < startedAt || observedAt > check() || until <= observedAt) return poison();
    if (until < deadline) deadline = until;
    check();
    return immutable({ ...value, sourceOperationReference: operation });
  };
  return Object.freeze({
    async admitOwnSeal(receipt: unknown) {
      if (
        !handoffOwner ||
        !acquired ||
        !ready ||
        active ||
        ownSealAdmitted ||
        finalized ||
        guardCalls !== 0
      )
        return poison();
      active = true;
      try {
        const proof = await handoffOwner.admit(acquired, receipt);
        if (proof.validUntil < deadline) deadline = proof.validUntil;
        check();
        ownSealAdmitted = true;
        return proof;
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
    async withCurrentGraph<T>(
      value: unknown,
      work: (source: {
        readonly profile: "CurrentOptionSetPublicationDraftGraphV1";
        readonly graph: Published["graph"];
        readonly sourceRecords: Published["sourceRecords"];
        readonly sourceOperationReference: Root["sourceOperationReference"];
        readonly sourceSnapshotTuple: Root["sourceSnapshotTuple"];
        readonly aggregateVersion: number;
        readonly sourceDigest: string;
        readonly contentDigest: string;
        readonly configurationDigest: string;
        readonly graphDigest: string;
        readonly rules: Published["rules"];
        readonly originalObservedAt: string;
        readonly observedAt: string;
        readonly validUntil: string;
        readonly sourceAuthority: "CurrentDraftRootAndCurrentPublishedChildren";
        readonly referenceEligibility: "NotEvaluated";
        readonly eligibility: "NotEvaluated";
        readonly publishValidation: "Incomplete";
      }) => Promise<T>,
    ): Promise<T> {
      if (entered || active || finalized) return poison();
      entered = true;
      active = true;
      try {
        if (
          (await register(
            tx,
            async () => {
              if (!ready || active || !acquired || ++guardCalls !== 1) return poison();
              active = true;
              try {
                if (ownSealAdmitted) {
                  if (!handoffOwner) return poison();
                  await hold();
                  const proof = await handoffOwner.revalidate();
                  if (proof.validUntil < deadline) deadline = proof.validUntil;
                } else {
                  const current = await readRoot();
                  if (!equal(stableRoot(current), stableRoot(acquired))) return poison();
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
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
          "optionSetReference",
          "versionReference",
          "expectedAggregateVersion",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
        ]);
        if (
          !Number.isSafeInteger(input.expectedAggregateVersion) ||
          (input.expectedAggregateVersion as number) < 1 ||
          (input.expectedAggregateVersion as number) > 2147483647 ||
          typeof work !== "function"
        )
          return poison();
        for (const key of ["sourceDigest", "contentDigest", "configurationDigest"] as const)
          if (typeof input[key] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input[key]))
            return poison();
        request = immutable({
          optionSetReference: String(parseCatalogReference(input.optionSetReference)),
          versionReference: String(parseCatalogReference(input.versionReference)),
          expectedAggregateVersion: input.expectedAggregateVersion as number,
          sourceDigest: String(input.sourceDigest),
          contentDigest: String(input.contentDigest),
          configurationDigest: String(input.configurationDigest),
        });
        acquired = await readRoot();
        const contents = new Map<string, Published["graph"]["contents"][number]>([
            [request.optionSetReference, acquired.content],
          ]),
          records = new Map<string, Published["sourceRecords"][number]>();
        const pins = new Map<string, string>();
        for (const option of acquired.content.sourceAggregate.draft.options) {
          if (option.triggeredOptionSetReference === null) continue;
          const version = acquired.content.optionDetails.find(
            (detail) => detail.optionReference === option.optionReference,
          )?.triggeredOptionSetVersionReference;
          if (!version) return poison();
          const set = String(option.triggeredOptionSetReference),
            pin = String(version);
          const existing = pins.get(set);
          if (existing && existing !== pin) return poison();
          pins.set(set, pin);
        }
        for (const [set, version] of pins) {
          const present = contents.get(set);
          if (present) {
            if (String(present.sourceAggregate.draft.versionReference) !== version) return poison();
            if (set !== request.optionSetReference) continue;
          }
          const child = createCurrentPublishedOptionSetGraphSource({
            ...options,
            clock: { now: check },
            originalValidUntil: deadline,
          });
          await child.withCurrentGraph(
            { optionSetReference: set, versionReference: version },
            async (source) => {
              const observedAt = parseCatalogInstant(source.observedAt),
                until = parseCatalogInstant(source.validUntil);
              const childAssessment = evaluateCatalogOptionSetRuleSatisfiability(source.graph);
              if (
                "reason" in childAssessment &&
                (childAssessment.reason === "IncompleteTriggerGraph" ||
                  childAssessment.reason === "AmbiguousTriggerVersion")
              )
                return poison();
              if (
                source.profile !== "CurrentPublishedOptionSetGraphV1" ||
                source.sourceAuthority !== "CurrentPublishingReleaseAndFrozenContent" ||
                source.referenceEligibility !== "NotEvaluated" ||
                source.eligibility !== "NotEvaluated" ||
                source.publishValidation !== "Incomplete" ||
                source.graph.brandReference !== brand ||
                source.graph.rootOptionSetReference !== set ||
                source.graph.rootVersionReference !== version ||
                observedAt < startedAt ||
                observedAt > check() ||
                until <= observedAt ||
                source.graph.contents.length > 32 ||
                source.graphDigest !== childAssessment.graphDigest
              )
                return poison();
              if (until < deadline) deadline = until;
              for (const value of source.graph.contents) {
                const full = prepared(value),
                  key = String(full.content.sourceAggregate.optionSetReference);
                if (full.content.sourceAggregate.brandReference !== brand) return poison();
                const prior = contents.get(key);
                if (prior && !equal(prior, full.content)) return poison();
                if (!prior) {
                  if (contents.size >= 32) return poison();
                  contents.set(key, immutable(full.content));
                }
              }
              for (const record of source.sourceRecords) {
                const content = contents.get(record.optionSetReference);
                if (
                  !content ||
                  String(content.sourceAggregate.draft.versionReference) !==
                    record.versionReference ||
                  record.optionSetReference === request?.optionSetReference
                )
                  return poison();
                const prior = records.get(record.optionSetReference);
                if (prior && !equal(prior, record)) return poison();
                records.set(record.optionSetReference, immutable(record));
              }
              if (source.sourceRecords.length !== source.graph.contents.length) return poison();
              check();
            },
          );
        }
        const ordered = [...contents.entries()].sort(([a], [b]) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        );
        const graph = immutable({
          brandReference: String(brand),
          rootOptionSetReference: request.optionSetReference,
          rootVersionReference: request.versionReference,
          contents: ordered.map(([, content]) => content),
        });
        for (const [set, content] of contents) {
          if (set === request.optionSetReference) continue;
          const record = records.get(set);
          if (
            !record ||
            record.versionReference !== String(content.sourceAggregate.draft.versionReference)
          )
            return poison();
        }
        const assessment = evaluateCatalogOptionSetRuleSatisfiability(graph);
        if (
          "reason" in assessment &&
          (assessment.reason === "IncompleteTriggerGraph" ||
            assessment.reason === "AmbiguousTriggerVersion")
        )
          return poison();
        const source = immutable({
          profile: "CurrentOptionSetPublicationDraftGraphV1" as const,
          graph,
          sourceRecords: [...records.entries()]
            .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
            .map(([, record]) => record),
          sourceOperationReference: acquired.sourceOperationReference,
          sourceSnapshotTuple: acquired.sourceSnapshotTuple,
          aggregateVersion: request.expectedAggregateVersion,
          sourceDigest: acquired.sourceDigest,
          contentDigest: acquired.contentDigest,
          configurationDigest: acquired.configurationDigest,
          graphDigest: assessment.graphDigest,
          rules: {
            status: assessment.status,
            reason: "reason" in assessment ? assessment.reason : null,
            searchNodes: assessment.searchNodes,
          },
          originalObservedAt: startedAt,
          observedAt: check(),
          validUntil: deadline,
          sourceAuthority: "CurrentDraftRootAndCurrentPublishedChildren" as const,
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
    context: Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      storeReference: store,
      actorReference: actor,
      sessionReference: session,
    }),
  });
}
