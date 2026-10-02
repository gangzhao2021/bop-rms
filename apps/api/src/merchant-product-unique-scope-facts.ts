import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import { readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseTenantStoreReferenceRequest,
  parseTenantBrandConfigurationContentRequest,
  tenantBrandConfigurationRequiredFields,
} from "@bop/tenant";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommand,
  parseProductPublicationValidation,
  productValidationCandidateFields,
  frozenFullOptionSetContentFields,
  productPublicationSourceFields,
  applyCatalogProductCandidateValidation,
  applyCatalogProductContentPolicyValidation,
  bindCatalogProductValidationToPolicy,
  type ProductPublicationFacts,
  type ProductPublicationStoreOptions,
  type ProductUniqueScopeValidationBinding,
} from "@rms/catalog";
import { createCurrentProductCandidateUniqueScopeSource } from "./current-product-candidate-unique-scope.js";
import {
  createCurrentProductPublicationPolicySource,
  currentProductPolicyFields,
  type CurrentProductPublicationPolicy,
} from "./current-product-publication-policy.js";
import type { HeldProductContentPolicyConfiguration } from "./current-product-held-content-policy.js";
type SourceOptions = Parameters<typeof createCurrentProductCandidateUniqueScopeSource>[0];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
type Port = ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"];
export interface MerchantProductUniqueScopeConfiguration {
  readonly candidateAuthority: SourceOptions["candidateAuthority"];
  readonly optionAuthority?: SourceOptions["optionAuthority"];
  readonly historyAuthority: SourceOptions["historyAuthority"];
  readonly tenantAuthority: SourceOptions["tenantAuthority"];
  readonly policyAuthority: PolicyOptions["authority"];
  readonly categoryAssignments?: SourceOptions["categoryAssignments"];
  readonly contentPolicy?: HeldProductContentPolicyConfiguration;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export function captureMerchantProductUniqueScopeConfiguration(
  value: MerchantProductUniqueScopeConfiguration,
): MerchantProductUniqueScopeConfiguration {
  if (
    typeof value?.candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.policyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.tenantAuthority?.withCurrentBrandReferenceRead !== "function" ||
    typeof value?.tenantAuthority?.isCurrent !== "function" ||
    (value.optionAuthority !== undefined &&
      typeof value.optionAuthority.holdUntilTransactionCompletes !== "function") ||
    (value.categoryAssignments !== undefined &&
      typeof value.categoryAssignments.holdUntilTransactionCompletes !== "function") ||
    (value.contentPolicy !== undefined &&
      (typeof value.contentPolicy.brandAuthority?.withCurrentContentRead !== "function" ||
        typeof value.contentPolicy.brandAuthority?.isCurrent !== "function" ||
        !Number.isSafeInteger(value.contentPolicy.expectedBrandVersion) ||
        value.contentPolicy.expectedBrandVersion < 1 ||
        value.contentPolicy.expectedBrandVersion > 2147483647))
  )
    return fail();
  return Object.freeze({
    ...(value.contentPolicy === undefined
      ? {}
      : {
          contentPolicy: Object.freeze({
            configurationVersionReference: parseCatalogReference(
              value.contentPolicy.configurationVersionReference,
            ),
            expectedBrandVersion: value.contentPolicy.expectedBrandVersion,
            brandAuthority: Object.freeze({
              withCurrentContentRead:
                value.contentPolicy.brandAuthority.withCurrentContentRead.bind(
                  value.contentPolicy.brandAuthority,
                ),
              isCurrent: value.contentPolicy.brandAuthority.isCurrent.bind(
                value.contentPolicy.brandAuthority,
              ),
            }),
          }),
        }),
    ...(value.optionAuthority === undefined
      ? {}
      : {
          optionAuthority: Object.freeze({
            holdUntilTransactionCompletes: value.optionAuthority.holdUntilTransactionCompletes.bind(
              value.optionAuthority,
            ),
          }),
        }),
    candidateAuthority: Object.freeze({
      holdUntilTransactionCompletes: value.candidateAuthority.holdUntilTransactionCompletes.bind(
        value.candidateAuthority,
      ),
    }),
    historyAuthority: Object.freeze({
      holdUntilTransactionCompletes: value.historyAuthority.holdUntilTransactionCompletes.bind(
        value.historyAuthority,
      ),
    }),
    policyAuthority: Object.freeze({
      holdUntilTransactionCompletes: value.policyAuthority.holdUntilTransactionCompletes.bind(
        value.policyAuthority,
      ),
    }),
    tenantAuthority: Object.freeze({
      withCurrentBrandReferenceRead: value.tenantAuthority.withCurrentBrandReferenceRead.bind(
        value.tenantAuthority,
      ),
      isCurrent: value.tenantAuthority.isCurrent.bind(value.tenantAuthority),
    }),
    ...(value.categoryAssignments === undefined
      ? {}
      : {
          categoryAssignments: Object.freeze({
            holdUntilTransactionCompletes:
              value.categoryAssignments.holdUntilTransactionCompletes.bind(
                value.categoryAssignments,
              ),
          }),
        }),
  });
}
function immutable<T>(input: T): T {
  const copy = copyCategoryPersistenceValue(input) as T;
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}
/** Actual candidate/history/registered roster/policy and optional current
 * content-policy necessary conditions. Remaining full checks stay mandatory;
 * operational topology, full validation and qualification are never synthesized. */
export function createMerchantProductUniqueScopeFacts(options: {
  readonly configuration: MerchantProductUniqueScopeConfiguration;
  readonly transaction: Parameters<Port>[0];
  readonly command: Parameters<Port>[1]["command"];
  readonly sources: ProductPublicationStoreOptions["sources"];
  readonly validationAuthority: SourceOptions["validationAuthority"];
  readonly clock: { now(): string };
  readonly assertAdmission: (
    sourceReadsRequired: boolean,
    optionReadRequired?: boolean,
  ) => Promise<void>;
}) {
  const configuration = captureMerchantProductUniqueScopeConfiguration(options.configuration);
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.assertAdmission !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    command = parseProductPublicationCommand(copyCategoryPersistenceValue(options.command)),
    now = options.clock.now.bind(options.clock),
    admission = options.assertAdmission,
    remaining = options.sources.withHeldCurrentFacts.bind(options.sources),
    validationHold = options.validationAuthority.holdUntilTransactionCompletes.bind(
      options.validationAuthority,
    ),
    observedAt = parseCatalogInstant(now()),
    until = new Date(Date.parse(observedAt) + 5000).toISOString(),
    intent = "sha256:" + sha256Hex(canonicalizeRfc8785(command));
  if (command.action !== "Validate" || command.actorKind !== "User") return fail();
  let latest = observedAt,
    failed = false,
    active = false,
    acquired = false,
    optionAcquired = false,
    sourceUntil: string | undefined,
    denied: CatalogError | undefined;
  const packets = new Map<string, () => Promise<void>>();
  let roster: ReturnType<typeof parseTenantStoreReferenceRequest> | undefined;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (
      failed ||
      tx.query !== query ||
      at < latest ||
      at >= until ||
      (sourceUntil !== undefined && at >= sourceUntil)
    )
      return fail();
    latest = at;
    return at;
  };
  const protect = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
        denied = error;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
  const native = () =>
    protect(async () => {
      check();
      if (optionAcquired) await admission(acquired, true);
      else await admission(acquired);
      check();
    });
  const held = async <T>(key: string, input: T, hold: (input: T) => Promise<void>) => {
    const packet = immutable(input);
    await native();
    if ((await protect(() => hold(packet))) !== undefined) return fail();
    check();
    packets.set(key, async () => {
      await native();
      if ((await protect(() => hold(packet))) !== undefined) return fail();
      await native();
    });
    await native();
  };
  const context = (input: {
    tenantReference: string;
    brandReference: string;
    actorReference: string;
  }) =>
    input.tenantReference === command.tenantReference &&
    input.brandReference === command.brandReference &&
    input.actorReference === command.actorReference;
  const owningPolicySource = createCurrentProductPublicationPolicySource({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    actorKind: "User",
    clock: { now: check },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          !context(input) ||
          input.actorKind !== "User" ||
          input.purposeCode !== command.purposeCode ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(currentProductPolicyFields)
        )
          return fail();
        await held("policy", input, (packet) =>
          configuration.policyAuthority.holdUntilTransactionCompletes(tx, packet),
        );
      },
    },
  });
  let currentPolicy: CurrentProductPublicationPolicy | undefined,
    policyCalls = 0,
    policyCallbacks = 0;
  const withCurrentPolicy: typeof owningPolicySource.withCurrentPolicy = async (
    actual,
    input,
    work,
  ) => {
    if (actual !== tx || ++policyCalls !== 1) return fail();
    return owningPolicySource.withCurrentPolicy(actual, input, async (value) => {
      if (++policyCallbacks !== 1) return fail();
      const heldPolicy = immutable(value);
      readClosedRecord(heldPolicy, [
        "content",
        "currentPublicationReference",
        "observedAt",
        "validUntil",
      ]);
      const content = parsePublishingProductPublicationPolicy(heldPolicy.content),
        policyObservedAt = parseCatalogInstant(heldPolicy.observedAt),
        policyValidUntil = parseCatalogInstant(heldPolicy.validUntil),
        publicationReference = parseCatalogReference(heldPolicy.currentPublicationReference);
      if (
        content.tenantReference !== command.tenantReference ||
        content.brandReference !== command.brandReference ||
        content.policyReference !== input.policyReference ||
        content.policyVersion !== input.policyVersion ||
        policyObservedAt !== input.observedAt ||
        content.effectiveFrom > (policyObservedAt as string) ||
        policyValidUntil <= policyObservedAt ||
        Date.parse(policyValidUntil) - Date.parse(policyObservedAt) > 30000 ||
        (content.effectiveUntil !== null && (policyValidUntil as string) > content.effectiveUntil)
      )
        return fail();
      currentPolicy = Object.freeze({
        content,
        currentPublicationReference: publicationReference,
        observedAt: policyObservedAt,
        validUntil: policyValidUntil,
      });
      return work(currentPolicy);
    });
  };
  const policySource = Object.freeze({ ...owningPolicySource, withCurrentPolicy });
  let brandRequest: ReturnType<typeof parseTenantBrandConfigurationContentRequest> | undefined;
  const brandPacket = (value: unknown, fields: readonly string[]) => {
    const request = parseTenantBrandConfigurationContentRequest(immutable(value));
    if (
      !configuration.contentPolicy ||
      !context(request) ||
      request.purposeCode !== "CATALOG_PRODUCT_CONTENT" ||
      request.originalIntentDigest !== intent ||
      request.configurationVersionReference !==
        configuration.contentPolicy.configurationVersionReference ||
      request.expectedBrandVersion !== configuration.contentPolicy.expectedBrandVersion ||
      JSON.stringify(fields) !== JSON.stringify(tenantBrandConfigurationRequiredFields) ||
      (brandRequest !== undefined &&
        canonicalizeRfc8785(request) !== canonicalizeRfc8785(brandRequest))
    )
      return fail();
    brandRequest = request;
    return request;
  };
  const source = createCurrentProductCandidateUniqueScopeSource({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    clock: { now: check },
    policySource,
    ...(configuration.contentPolicy === undefined
      ? {}
      : {
          contentPolicy: {
            ...configuration.contentPolicy,
            brandAuthority: {
              async withCurrentContentRead(input, fields, work) {
                const request = brandPacket(input, fields);
                await native();
                let calls = 0,
                  completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
                const result = await protect(() =>
                  (configuration.contentPolicy ?? fail()).brandAuthority.withCurrentContentRead(
                    request,
                    tenantBrandConfigurationRequiredFields,
                    async () => {
                      if (++calls !== 1) return fail();
                      await native();
                      const value = await work();
                      await native();
                      completed = { value };
                      return completed;
                    },
                  ),
                );
                if (calls !== 1 || !completed || result !== completed) return fail();
                await native();
                return completed.value;
              },
              async isCurrent(actual, input, fields) {
                if (actual !== tx) return fail();
                const request = brandPacket(input, fields);
                const hold = async () => {
                  await native();
                  const result = await protect(() =>
                    (configuration.contentPolicy ?? fail()).brandAuthority.isCurrent(
                      tx,
                      request,
                      tenantBrandConfigurationRequiredFields,
                    ),
                  );
                  await native();
                  if (result !== true) return fail();
                };
                await hold();
                packets.set("brand-content", hold);
                return true;
              },
            },
          },
        }),
    validationAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (actual !== tx || canonical(input.command) !== canonical(command)) return fail();
        await native();
        if ((await protect(() => validationHold(tx, input))) !== undefined) return fail();
        await native();
      },
    },
    candidateAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          !context(input) ||
          input.actorKind !== "User" ||
          input.productReference !== command.productReference ||
          input.purposeCode !== command.purposeCode ||
          input.permission !== "catalog.manage" ||
          input.owningAction !== "catalog.product.validate" ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(productValidationCandidateFields)
        )
          return fail();
        await held("candidate", input, (packet) =>
          configuration.candidateAuthority.holdUntilTransactionCompletes(tx, packet),
        );
      },
    },
    ...(configuration.optionAuthority === undefined
      ? {}
      : {
          optionAuthority: {
            async holdUntilTransactionCompletes(
              actual: Parameters<
                NonNullable<SourceOptions["optionAuthority"]>["holdUntilTransactionCompletes"]
              >[0],
              input: Parameters<
                NonNullable<SourceOptions["optionAuthority"]>["holdUntilTransactionCompletes"]
              >[1],
            ) {
              if (
                actual !== tx ||
                !context(input) ||
                input.actorKind !== "User" ||
                input.permission !== "catalog.manage" ||
                input.action !== "catalog.option_set.read" ||
                input.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
                JSON.stringify(input.requiredFields) !==
                  JSON.stringify(frozenFullOptionSetContentFields)
              )
                return fail();
              parseCatalogReference(input.optionSetReference);
              parseCatalogReference(input.versionReference);
              optionAcquired = true;
              const packet = immutable(input);
              const hold = async () => {
                await native();
                const evidence = immutable(
                  await protect(() =>
                    (configuration.optionAuthority ?? fail()).holdUntilTransactionCompletes(
                      tx,
                      packet,
                    ),
                  ),
                );
                readClosedRecord(evidence, ["observedAt", "validUntil"]);
                const observed = parseCatalogInstant(evidence.observedAt),
                  deadline = parseCatalogInstant(evidence.validUntil);
                if (
                  observed !== packet.observedAt ||
                  deadline <= observed ||
                  Date.parse(deadline) - Date.parse(observed) > 30000
                )
                  return fail();
                sourceUntil =
                  sourceUntil === undefined || deadline < sourceUntil ? deadline : sourceUntil;
                await native();
                return Object.freeze({ observedAt: observed, validUntil: deadline });
              };
              const evidence = await hold();
              packets.set(
                "option:" + packet.optionSetReference + ":" + packet.versionReference,
                async () => {
                  await hold();
                },
              );
              return evidence;
            },
          },
        }),
    historyAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          !context(input) ||
          input.productReference !== command.productReference ||
          input.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_SOURCE" ||
          input.permission !== "catalog.manage" ||
          input.owningAction !== "catalog.product.history.read" ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(productPublicationSourceFields)
        )
          return fail();
        await held("history", input, (packet) =>
          configuration.historyAuthority.holdUntilTransactionCompletes(tx, packet),
        );
      },
    },
    tenantAuthority: {
      async withCurrentBrandReferenceRead(input, work) {
        const request = parseTenantStoreReferenceRequest(immutable(input));
        if (
          request.brandReference !== command.brandReference ||
          request.actorReference !== command.actorReference ||
          request.purposeCode !== command.purposeCode ||
          request.originalIntentDigest !== intent
        )
          return fail();
        roster = request;
        await native();
        let calls = 0,
          completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
        const result = await protect(() =>
          configuration.tenantAuthority.withCurrentBrandReferenceRead(request, async () => {
            if (++calls !== 1) return fail();
            await native();
            const value = await work();
            await native();
            completed = { value };
            return completed;
          }),
        );
        if (calls !== 1 || !completed || result !== completed) return fail();
        await native();
        return completed.value;
      },
      async isCurrent(actual, input) {
        if (actual !== tx || !roster || canonicalizeRfc8785(input) !== canonicalizeRfc8785(roster))
          return fail();
        await native();
        const result = await protect(() =>
          configuration.tenantAuthority.isCurrent(tx, roster ?? fail()),
        );
        await native();
        if (result !== true) return fail();
        return true;
      },
    },
    ...(configuration.categoryAssignments === undefined
      ? {}
      : {
          categoryAssignments: {
            async holdUntilTransactionCompletes(
              actual: Parameters<
                NonNullable<SourceOptions["categoryAssignments"]>["holdUntilTransactionCompletes"]
              >[0],
              input: Parameters<
                NonNullable<SourceOptions["categoryAssignments"]>["holdUntilTransactionCompletes"]
              >[1],
            ) {
              if (
                actual !== tx ||
                input.mode !== "Read" ||
                input.aggregate.brandReference !== command.brandReference ||
                input.aggregate.productReference !== command.productReference
              )
                return fail();
              await held("category", input, (packet) =>
                (configuration.categoryAssignments ?? fail()).holdUntilTransactionCompletes(
                  tx,
                  packet,
                ),
              );
            },
          },
        }),
  });
  const assertCurrent = () =>
    protect(async () => {
      await native();
      for (const hold of packets.values()) await hold();
      if (roster) {
        await native();
        if (
          (await protect(() => configuration.tenantAuthority.isCurrent(tx, roster ?? fail()))) !==
          true
        )
          return fail();
        await native();
      }
      check();
    });
  const withHeldCurrentFacts: Port = async (actual, value, work) => {
    denied = undefined;
    try {
      if (actual !== tx || active) return fail();
      const input = immutable(value);
      if (canonical(input.command) !== canonical(command)) return fail();
      active = true;
      acquired = true;
      await native();
      let calls = 0,
        sourceCalls = 0,
        completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
      const result = await remaining(tx, input, async (value) => {
        if (++calls !== 1) return fail();
        const facts = immutable(value) as ProductPublicationFacts;
        readClosedRecord(facts, [
          "now",
          "productAggregateVersion",
          "contentDigest",
          "configurationDigest",
          "scopeDigest",
          "periodDigest",
          "validation",
          "approval",
          "reviewReference",
          "replacement",
        ]);
        const validation = parseProductPublicationValidation(facts.validation);
        return source.withCurrentAssessment(
          tx,
          {
            command,
            policyReference: validation.policyReference,
            policyVersion: validation.policyVersion,
          },
          async (proof) => {
            if (
              ++sourceCalls !== 1 ||
              proof.currentCandidate !== "Bound" ||
              proof.contentDigest !== command.contentDigest ||
              proof.configurationDigest !== command.configurationDigest ||
              !currentPolicy ||
              policyCalls !== 1 ||
              policyCallbacks !== 1 ||
              currentPolicy.content.policyReference !== validation.policyReference ||
              currentPolicy.content.policyVersion !== validation.policyVersion ||
              proof.policyPublicationReference !== currentPolicy.currentPublicationReference ||
              proof.policyContentDigest !==
                publishingProductPublicationPolicyDigest(currentPolicy.content) ||
              proof.observedAt !== currentPolicy.observedAt ||
              proof.validUntil > currentPolicy.validUntil
            )
              return fail();
            if (
              (configuration.contentPolicy !== undefined) !==
              (proof.contentPolicyAssessment !== undefined)
            )
              return fail();
            const proofUntil = parseCatalogInstant(proof.validUntil);
            sourceUntil =
              sourceUntil === undefined || proofUntil < sourceUntil ? proofUntil : sourceUntil;
            check();
            const binding: ProductUniqueScopeValidationBinding = {
              tenantReference: proof.tenantReference,
              brandReference: proof.brandReference,
              productReference: proof.productReference,
              versionReference: proof.versionReference,
              aggregateVersion: proof.aggregateVersion,
              contentDigest: proof.contentDigest,
              configurationDigest: proof.configurationDigest,
              originalIntentDigest: proof.originalIntentDigest,
              policyReference: proof.policyReference,
              policyVersion: proof.policyVersion,
              observedAt: proof.observedAt,
              validUntil: parseCatalogInstant(sourceUntil),
              check: proof.check,
            };
            await native();
            const candidateValidation = applyCatalogProductCandidateValidation(
              command,
              bindCatalogProductValidationToPolicy(validation, currentPolicy.content, {
                tenantReference: command.tenantReference,
                brandReference: command.brandReference,
              }),
              {
                ...binding,
                skuPrerequisite: proof.skuPrerequisite,
                internalCodeCheck: proof.internalCodeCheck,
                variantMappingPrerequisite: proof.variantMappingPrerequisite,
                optionSelectionPrerequisite: proof.optionSelectionPrerequisite,
                optionRulePrerequisite: proof.optionRulePrerequisite,
              },
              check(),
            );
            const reply = await work({
              ...facts,
              validation:
                proof.contentPolicyAssessment === undefined
                  ? candidateValidation
                  : applyCatalogProductContentPolicyValidation(
                      command,
                      candidateValidation,
                      proof.contentPolicyAssessment,
                      check(),
                    ),
            });
            await native();
            completed = { value: reply };
            return completed;
          },
        );
      });
      if (calls !== 1 || sourceCalls !== 1 || !completed || result !== completed) return fail();
      await assertCurrent();
      return completed.value;
    } catch (error) {
      failed = true;
      if (denied) throw denied;
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    assertCurrent,
    sources: Object.freeze({
      withHeldCurrentFacts,
      ...(options.sources.withHeldScopePolicy === undefined
        ? {}
        : { withHeldScopePolicy: options.sources.withHeldScopePolicy.bind(options.sources) }),
    }),
  });
}
function canonical(value: unknown) {
  return canonicalizeRfc8785(parseProductPublicationCommand(copyCategoryPersistenceValue(value)));
}
