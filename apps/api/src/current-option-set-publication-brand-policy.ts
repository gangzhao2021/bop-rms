import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresTenantOptionSetBrandConfigurationContentSource,
  createPostgresTenantStoreReferenceSource,
  parseTenantOptionSetBrandConfigurationContentRequest,
  parseTenantStoreReferenceRequest,
  parseTenantStoreReferenceSnapshot,
  tenantBrandConfigurationRequiredFields,
  type TenantStoreReferenceSnapshot,
} from "@bop/tenant";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetContentPolicyBinding,
  parseCatalogOptionSetEditorContent,
  assessCatalogOptionSetBrandScope,
  assessCatalogOptionSetContentPolicy,
} from "@rms/catalog";
import {
  createCurrentOptionSetBrandConfigurationContentSource,
  type CurrentOptionSetBrandConfigurationContent,
  type CurrentBrandConfigurationContent,
} from "./current-brand-configuration-content.js";
import {
  createCurrentOptionSetPublicationPolicySource,
  currentOptionSetPolicyFields,
  type CurrentOptionSetPublicationPolicy,
  type OptionSetQualificationAction,
} from "./current-option-set-publication-policy.js";
import type { CurrentPublishedOptionSetGraphOptions } from "./current-published-option-set-graph.js";
import type { createCurrentOptionSetPublicationDraftGraphSource } from "./current-option-set-publication-draft-graph.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
type Graph = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationDraftGraphSource>["withCurrentGraph"]
  >[1]
>[0];
export interface CurrentOptionSetPublicationBrandPolicyOptions extends CurrentPublishedOptionSetGraphOptions {
  readonly operationReference: string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly brandConfigurationVersionReference: string;
  readonly expectedBrandVersion: number;
  readonly qualificationAction?: OptionSetQualificationAction;
}
export interface CurrentOptionSetPublicationBrandPolicy {
  readonly profile: "CurrentOptionSetPublicationBrandPolicyV1";
  readonly binding: ReturnType<typeof parseCatalogOptionSetContentPolicyBinding>;
  readonly operationReference: string;
  readonly graphDigest: string;
  readonly graph: Graph;
  readonly brandConfiguration: CurrentBrandConfigurationContent;
  readonly policy: CurrentOptionSetPublicationPolicy;
  readonly storeRoster: TenantStoreReferenceSnapshot;
  readonly permissionProvenance: readonly PermissionDecision[];
  readonly contentPolicy: ReturnType<typeof assessCatalogOptionSetContentPolicy>;
  readonly brandScope: ReturnType<typeof assessCatalogOptionSetBrandScope>;
  readonly brandFieldRequirements: readonly string[];
  readonly originalObservedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly eligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly sourceAuthority: "CurrentBrandPolicyAndCompleteStoreRoster";
  readonly digest: string;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
/** Single held graph consumer. Consistent supplied data is not acquisition;
 * callers retain the genuine graph callback through this source and COMMIT. */
export function createCurrentOptionSetPublicationBrandPolicySource(
  options: CurrentOptionSetPublicationBrandPolicyOptions,
) {
  const tx = options.transaction,
    query = tx?.query,
    tenant = String(parseCatalogReference(options.tenantReference)),
    brand = String(parseCatalogReference(options.brandReference)),
    store = String(parseCatalogReference(options.storeReference)),
    actor = String(parseCatalogReference(options.actorReference)),
    session = String(parseCatalogReference(options.sessionReference)),
    operation = String(parseCatalogReference(options.operationReference)),
    policyReference = String(parseCatalogReference(options.policyReference)),
    configuration = String(parseCatalogReference(options.brandConfigurationVersionReference)),
    policyVersion = options.policyVersion,
    brandVersion = options.expectedBrandVersion,
    originalQualificationAction = options.qualificationAction,
    qualificationAction =
      originalQualificationAction === undefined ? "Publish" : originalQualificationAction,
    catalogAction =
      qualificationAction === "Read"
        ? "catalog.option_set.read"
        : qualificationAction === "SubmitReview"
          ? "catalog.option_set.submit"
          : "catalog.option_set.publish";
  if (
    !["Read", "SubmitReview", "Publish"].includes(qualificationAction) ||
    !Number.isSafeInteger(policyVersion) ||
    policyVersion < 1 ||
    policyVersion > 2147483647 ||
    !Number.isSafeInteger(brandVersion) ||
    brandVersion < 1 ||
    brandVersion > 2147483647 ||
    typeof query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.currentAuthorization?.authorizeActionsWithDecisions !== "function" ||
    typeof options.currentAuthorization?.assertCurrent !== "function" ||
    typeof options.currentAuthorization?.leaseDeadline !== "function" ||
    (options.capability?.holdUntilCommitWithDecisions !== undefined &&
      typeof options.capability.holdUntilCommitWithDecisions !== "function") ||
    typeof options.capability?.holdUntilCommit !== "function" ||
    typeof options.capability?.leaseDeadline !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const clockPort = options.clock.now,
    clock = clockPort.bind(options.clock),
    decisionPort = options.currentAuthorization.authorizeActionsWithDecisions,
    decisions = decisionPort.bind(options.currentAuthorization),
    assertPort = options.currentAuthorization.assertCurrent,
    assertCurrent = assertPort.bind(options.currentAuthorization),
    leasePort = options.currentAuthorization.leaseDeadline,
    lease = leasePort.bind(options.currentAuthorization),
    combinedPort = options.capability.holdUntilCommitWithDecisions,
    combined = combinedPort?.bind(options.capability),
    capPort = options.capability.holdUntilCommit,
    capability = capPort.bind(options.capability),
    capLeasePort = options.capability.leaseDeadline,
    capLease = capLeasePort.bind(options.capability),
    registerPort = options.registerBeforeCommit,
    register = registerPort.bind(options);
  const startedAt = parseCatalogInstant(clock()),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (originalDeadline <= startedAt || Date.parse(originalDeadline) - Date.parse(startedAt) > 5000)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let permissionProvenance: readonly PermissionDecision[] = [];
  let deadline: string = originalDeadline,
    latest: string = startedAt,
    failed = false,
    entered = false,
    active = false,
    ready = false,
    guards = 0,
    complete = false,
    finals = 0;
  const fail = (): never => {
    failed = true;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
      throw error;
    return fail();
  };
  const check = () => {
    try {
      const now = parseCatalogInstant(clock());
      if (
        failed ||
        tx.query !== query ||
        now < latest ||
        now >= deadline ||
        options.clock.now !== clockPort ||
        options.currentAuthorization.authorizeActionsWithDecisions !== decisionPort ||
        options.currentAuthorization.assertCurrent !== assertPort ||
        options.currentAuthorization.leaseDeadline !== leasePort ||
        options.capability.holdUntilCommit !== capPort ||
        options.capability.holdUntilCommitWithDecisions !== combinedPort ||
        options.capability.leaseDeadline !== capLeasePort ||
        options.registerBeforeCommit !== registerPort ||
        options.tenantReference !== tenant ||
        options.brandReference !== brand ||
        options.storeReference !== store ||
        options.actorReference !== actor ||
        options.sessionReference !== session ||
        options.operationReference !== operation ||
        options.policyReference !== policyReference ||
        options.policyVersion !== policyVersion ||
        options.brandConfigurationVersionReference !== configuration ||
        options.expectedBrandVersion !== brandVersion ||
        options.qualificationAction !== originalQualificationAction
      )
        return fail();
      assertCurrent();
      latest = now;
      return now;
    } catch (error) {
      return reject(error);
    }
  };
  const shorten = (value: string) => {
    const until = parseCatalogInstant(value);
    if (until < deadline) deadline = until;
    check();
  };
  const hold = async () => {
    check();
    const actions = Object.freeze(
      [...new Set(["catalog.manage", catalogAction, "catalog.option_set.read"])].sort(),
    );
    let evidence: unknown;
    if (combined) {
      const current = await combined(actions);
      check();
      if (
        !Array.isArray(current) ||
        !Object.isFrozen(current) ||
        Object.getPrototypeOf(current) !== Array.prototype ||
        Reflect.ownKeys(current).length !== actions.length + 1 ||
        current.length !== actions.length
      )
        return fail();
      // Immutable owner results must also be data-only: copy rejects getters.
      evidence = copyCategoryPersistenceValue(current);
      for (let i = 0; i < current.length; i++) {
        const d = Object.getOwnPropertyDescriptor(current, String(i));
        if (!d?.enumerable || !("value" in d) || !Object.isFrozen(d.value)) return fail();
        const audit = Object.getOwnPropertyDescriptor(d.value, "audit");
        if (!audit || !("value" in audit) || !Object.isFrozen(audit.value)) return fail();
      }
    } else {
      if ((await capability()) !== undefined) return fail();
      check();
      evidence = await decisions(actions);
    }
    if (
      !Array.isArray(evidence) ||
      evidence.length !== actions.length ||
      evidence.some(
        (d, i) => d.action !== actions[i] || d.effect !== "Allow" || d.scopeKind !== "Brand",
      )
    )
      return fail();
    permissionProvenance = Object.freeze(
      evidence.map((value, i) => {
        const d = readClosedRecord(copyCategoryPersistenceValue(value), [
            "effect",
            "reason",
            "source",
            "action",
            "scopeKind",
            "policySnapshotReference",
            "policyVersion",
            "audit",
          ]),
          a = readClosedRecord(d.audit, ["effect", "reason", "source"]);
        const reason = d.reason,
          source = d.source;
        if (
          d.effect !== "Allow" ||
          d.scopeKind !== "Brand" ||
          d.action !== actions[i] ||
          (reason !== "EXPLICIT_ALLOW" && reason !== "ROLE_PERMISSION") ||
          (source !== "ExplicitAllow" && source !== "RolePermission") ||
          (reason === "EXPLICIT_ALLOW" && source !== "ExplicitAllow") ||
          (reason === "ROLE_PERMISSION" && source !== "RolePermission") ||
          a.effect !== d.effect ||
          a.reason !== reason ||
          a.source !== source
        )
          return fail();
        return Object.freeze({
          effect: "Allow" as const,
          reason,
          source,
          action: parseBusinessAction(d.action),
          scopeKind: "Brand" as const,
          policySnapshotReference: parsePolicyReference(d.policySnapshotReference),
          policyVersion: parsePolicyVersion(d.policyVersion),
          audit: Object.freeze({ effect: "Allow" as const, reason, source }),
        });
      }),
    );
    shorten(lease());
    shorten(capLease());
  };
  return Object.freeze({
    async withCurrentAssessment<T>(
      input: { readonly graph: Graph; readonly binding: unknown },
      work: (source: CurrentOptionSetPublicationBrandPolicy) => Promise<T>,
    ): Promise<T> {
      if (entered) return fail();
      entered = true;
      active = true;
      let reread: (() => Promise<void>) | undefined;
      try {
        if (
          (await register(
            tx,
            async () => {
              if (!ready || active || ++guards !== 1 || !reread) return fail();
              try {
                await hold();
                await reread();
                check();
                complete = true;
              } catch (error) {
                return reject(error);
              }
            },
            () => {
              if (!ready || active || !complete || guards !== 1 || ++finals !== 1) return fail();
              check();
            },
          )) !== undefined
        )
          return fail();
        const packet = readClosedRecord(copyCategoryPersistenceValue(input), ["graph", "binding"]),
          binding = parseCatalogOptionSetContentPolicyBinding(packet.binding),
          graph = readClosedRecord(copyCategoryPersistenceValue(packet.graph), [
            "profile",
            "graph",
            "sourceRecords",
            "sourceOperationReference",
            "sourceSnapshotTuple",
            "aggregateVersion",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
            "graphDigest",
            "rules",
            "originalObservedAt",
            "observedAt",
            "validUntil",
            "sourceAuthority",
            "referenceEligibility",
            "eligibility",
            "publishValidation",
          ]) as unknown as Graph;
        parseCatalogReference(graph.sourceOperationReference);
        if (graph.observedAt < graph.originalObservedAt || graph.observedAt > check())
          return fail();
        if (
          typeof work !== "function" ||
          graph.profile !== "CurrentOptionSetPublicationDraftGraphV1" ||
          graph.sourceAuthority !== "CurrentDraftRootAndCurrentPublishedChildren" ||
          graph.eligibility !== "NotEvaluated" ||
          graph.referenceEligibility !== "NotEvaluated" ||
          graph.publishValidation !== "Incomplete" ||
          binding.tenantReference !== tenant ||
          binding.brandReference !== brand ||
          graph.graph.brandReference !== brand ||
          graph.graph.rootOptionSetReference !== binding.optionSetReference ||
          graph.graph.rootVersionReference !== binding.versionReference ||
          graph.aggregateVersion !== binding.expectedAggregateVersion ||
          graph.sourceDigest !== binding.sourceDigest ||
          graph.contentDigest !== binding.contentDigest ||
          graph.configurationDigest !== binding.configurationDigest ||
          graph.graphDigest !== binding.graphDigest ||
          graph.originalObservedAt > check() ||
          binding.observedAt < graph.originalObservedAt ||
          binding.observedAt > check() ||
          graph.graph.contents.length < 1 ||
          graph.graph.contents.length > 32
        )
          return fail();
        const mechanical = evaluateCatalogOptionSetRuleSatisfiability(graph.graph);
        if (
          mechanical.graphDigest !== binding.graphDigest ||
          ("reason" in mechanical &&
            ["IncompleteTriggerGraph", "AmbiguousTriggerVersion"].includes(mechanical.reason ?? ""))
        )
          return fail();
        shorten(graph.validUntil);
        shorten(binding.validUntil);
        const contents = graph.graph.contents.map((content) => {
          const { sourceAggregate, profile, ...additional } = content;
          const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, {
            profile,
            ...additional,
          });
          if (parsed.content.sourceAggregate.brandReference !== brand) return fail();
          return parsed;
        });
        const root = contents.find(
          (n) => n.content.sourceAggregate.optionSetReference === binding.optionSetReference,
        );
        if (
          !root ||
          new Set(contents.map((n) => n.content.sourceAggregate.optionSetReference)).size !==
            contents.length ||
          root.sourceDigest !== binding.sourceDigest ||
          root.contentDigest !== binding.contentDigest ||
          root.configurationDigest !== binding.configurationDigest ||
          !equal(graph.sourceSnapshotTuple, {
            tenantReference: tenant,
            brandReference: brand,
            optionSetReference: binding.optionSetReference,
            versionReference: binding.versionReference,
            aggregateVersion: binding.expectedAggregateVersion,
            sourceDigest: binding.sourceDigest,
            contentDigest: binding.contentDigest,
            configurationDigest: binding.configurationDigest,
          })
        )
          return fail();
        await hold();
        const brandRequest = parseTenantOptionSetBrandConfigurationContentRequest({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
          configurationVersionReference: configuration,
          expectedBrandVersion: brandVersion,
          originalIntentDigest: binding.originalIntentDigest,
          observedAt: binding.observedAt,
          validUntil: deadline,
          optionSetReference: binding.optionSetReference,
          versionReference: binding.versionReference,
          expectedAggregateVersion: binding.expectedAggregateVersion,
          sourceDigest: binding.sourceDigest,
          contentDigest: binding.contentDigest,
          configurationDigest: binding.configurationDigest,
          graphDigest: binding.graphDigest,
          activationAt: binding.activationAt,
        });
        const currentBrand = createCurrentOptionSetBrandConfigurationContentSource(
          createPostgresTenantOptionSetBrandConfigurationContentSource({
            brandReference: brand,
            clock: check,
            transactions: { run: (action) => action(tx) },
            authority: {
              async withCurrentContentRead(request, fields, action) {
                if (
                  !equal(request, brandRequest) ||
                  !equal(fields, tenantBrandConfigurationRequiredFields)
                )
                  return fail();
                await hold();
                const result = await action();
                check();
                await hold();
                return result;
              },
              async isCurrent(actual, request, fields) {
                if (
                  actual !== tx ||
                  !equal(request, brandRequest) ||
                  !equal(fields, tenantBrandConfigurationRequiredFields)
                )
                  return fail();
                await hold();
                return true;
              },
            },
          }),
        );
        const policyRequest = {
          optionSetReference: binding.optionSetReference,
          policyReference,
          policyVersion,
          observedAt: binding.observedAt,
        };
        const currentPolicy = createCurrentOptionSetPublicationPolicySource({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          qualificationAction,
          clock: { now: check },
          authority: {
            async holdUntilTransactionCompletes(actual, request) {
              if (
                actual !== tx ||
                request.tenantReference !== tenant ||
                request.brandReference !== brand ||
                request.actorReference !== actor ||
                request.actorKind !== "User" ||
                request.permission !== "catalog.manage" ||
                request.action !== catalogAction ||
                request.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
                request.optionSetReference !== binding.optionSetReference ||
                request.policyReference !== policyReference ||
                request.policyVersion !== policyVersion ||
                !equal(request.requiredFields, currentOptionSetPolicyFields) ||
                request.observedAt > check() ||
                request.observedAt < binding.observedAt
              )
                return fail();
              await hold();
              return { observedAt: request.observedAt, validUntil: deadline };
            },
          },
        });
        const acquire = async <R>(
          action: (facts: {
            brand: CurrentOptionSetBrandConfigurationContent;
            policy: CurrentOptionSetPublicationPolicy;
            roster: TenantStoreReferenceSnapshot;
          }) => Promise<R>,
        ): Promise<R> => {
          let brandCalls = 0,
            policyCalls = 0,
            rosterCalls = 0;
          const answer = await currentBrand.withCurrentContent(
            brandRequest,
            async (brandSource, actual) => {
              if (
                ++brandCalls !== 1 ||
                actual !== tx ||
                !equal(brandSource.publicationIntent, brandRequest) ||
                brandSource.profile !== "CurrentOptionSetBrandConfigurationContentV1" ||
                brandSource.eligibility !== "NotEvaluated"
              )
                return fail();
              const b = brandSource.brandConfiguration;
              if (
                b.tenantReference !== tenant ||
                b.brandReference !== brand ||
                b.brandVersion !== brandVersion ||
                b.configurationVersionReference !== configuration ||
                b.originalIntentDigest !== binding.originalIntentDigest ||
                b.observedAt !== brandRequest.observedAt ||
                b.validUntil > brandRequest.validUntil ||
                b.eligibility !== "NotEvaluated"
              )
                return fail();
              shorten(b.validUntil);
              const result = await currentPolicy.withCurrentPolicy(
                tx,
                policyRequest,
                async (policySource) => {
                  if (
                    ++policyCalls !== 1 ||
                    policySource.profile !== "CurrentOptionSetPublicationPolicyV1" ||
                    policySource.optionSetReference !== binding.optionSetReference ||
                    policySource.originalObservedAt !== binding.observedAt ||
                    policySource.observedAt > check() ||
                    policySource.observedAt < binding.observedAt ||
                    String(policySource.content.policyReference) !== policyReference ||
                    policySource.content.policyVersion !== policyVersion ||
                    policySource.eligibility !== "NotEvaluated" ||
                    policySource.publishValidation !== "Incomplete"
                  )
                    return fail();
                  shorten(policySource.validUntil);
                  const rosterRequest = parseTenantStoreReferenceRequest({
                    brandReference: brand,
                    actorReference: actor,
                    purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
                    originalIntentDigest: binding.originalIntentDigest,
                    observedAt: check(),
                  });
                  const rosterOwner = createPostgresTenantStoreReferenceSource({
                    brandReference: brand,
                    transactions: { run: (action) => action(tx) },
                    authority: {
                      async withCurrentBrandReferenceRead(request, action) {
                        if (!equal(request, rosterRequest)) return fail();
                        await hold();
                        const result = await action();
                        check();
                        await hold();
                        return result;
                      },
                      async isCurrent(actual, request) {
                        if (actual !== tx || !equal(request, rosterRequest)) return fail();
                        await hold();
                        return true;
                      },
                    },
                  });
                  const result = await rosterOwner.withCurrentSnapshot(
                    rosterRequest,
                    async (value) => {
                      if (++rosterCalls !== 1) return fail();
                      const roster = parseTenantStoreReferenceSnapshot(value);
                      if (
                        roster.brandReference !== brand ||
                        roster.brandVersion !== String(brandVersion) ||
                        roster.originalIntentDigest !== binding.originalIntentDigest ||
                        roster.observedAt !== rosterRequest.observedAt
                      )
                        return fail();
                      check();
                      return action({ brand: brandSource, policy: policySource, roster });
                    },
                  );
                  if (rosterCalls !== 1) return fail();
                  return result;
                },
              );
              if (policyCalls !== 1) return fail();
              return result;
            },
          );
          if (brandCalls !== 1) return fail();
          check();
          return answer;
        };
        const identity = (facts: {
          brand: CurrentOptionSetBrandConfigurationContent;
          policy: CurrentOptionSetPublicationPolicy;
          roster: TenantStoreReferenceSnapshot;
        }) => {
          const { observedAt, validUntil, ...brandBody } = facts.brand.brandConfiguration;
          const { observedAt: rosterAt, ...rosterBody } = facts.roster;
          void observedAt;
          void validUntil;
          void rosterAt;
          return {
            brand: brandBody,
            policy: {
              content: facts.policy.content,
              currentPublicationReference: facts.policy.currentPublicationReference,
            },
            roster: rosterBody,
          };
        };
        const result = await acquire(async (facts) => {
          const stable = identity(facts);
          reread = async () =>
            acquire(async (current) => {
              if (!equal(stable, identity(current))) return fail();
            });
          const b = facts.brand.brandConfiguration,
            normalized = {
              profile: "CatalogOptionSetBrandConstraintsV1",
              tenantReference: tenant,
              brandReference: brand,
              brandVersion: b.brandVersion,
              configurationVersionReference: b.configurationVersionReference,
              contentDigest: b.contentDigest,
              currentPublicationReference: b.currentPublicationReference,
              supportedLocales: b.supportedLocales,
              effectiveFrom: b.effectiveFrom,
              effectiveUntil: b.effectiveUntil,
              originalIntentDigest: binding.originalIntentDigest,
              observedAt: b.observedAt,
              validUntil: deadline,
            };
          const contentPolicy = assessCatalogOptionSetContentPolicy(
              graph.graph,
              facts.policy.content,
              { ...binding, validUntil: deadline },
            ),
            brandScope = assessCatalogOptionSetBrandScope(graph.graph, normalized, facts.roster, {
              ...binding,
              validUntil: deadline,
            });
          const body = {
            profile: "CurrentOptionSetPublicationBrandPolicyV1" as const,
            binding,
            operationReference: operation,
            graphDigest: graph.graphDigest,
            graph,
            brandConfiguration: facts.brand.brandConfiguration,
            policy: facts.policy,
            storeRoster: facts.roster,
            permissionProvenance,
            contentPolicy,
            brandScope,
            brandFieldRequirements: Object.freeze([...b.hardRequirementFieldCodes]),
            originalObservedAt: startedAt,
            observedAt: check(),
            validUntil: deadline,
            eligibility: "NotEvaluated" as const,
            publishValidation: "Incomplete" as const,
            sourceAuthority: "CurrentBrandPolicyAndCompleteStoreRoster" as const,
          };
          const result = await work(Object.freeze({ ...body, digest: digest(body) }));
          check();
          await hold();
          return result;
        });
        active = false;
        ready = true;
        check();
        return result;
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
  });
}
