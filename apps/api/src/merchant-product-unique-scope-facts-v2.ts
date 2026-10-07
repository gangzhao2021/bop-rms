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
  parseCatalogHash,
  parseCatalogReference,
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  productValidationCandidateFieldsV2,
  productPublicationWriteFieldsV2,
  frozenFullOptionSetContentFields,
  productPublicationSourceFieldsV2,
  productVariantHistoryFields,
  applyCatalogProductCandidateValidationV2,
  applyCatalogProductContentPolicyValidationV2,
  bindCatalogProductValidationToPolicyV2,
  type ProductPublicationFactsV2,
  type ProductPublicationStoreOptionsV2,
} from "@rms/catalog";
import { createCurrentProductCandidateUniqueScopeSourceV2 } from "./current-product-candidate-unique-scope-v2.js";
import {
  createCurrentProductPublicationPolicySource,
  currentProductPolicyFields,
  type CurrentProductPublicationPolicy,
} from "./current-product-publication-policy.js";
import type { HeldProductContentPolicyConfiguration } from "./current-product-held-content-policy.js";
type SourceOptions = Parameters<typeof createCurrentProductCandidateUniqueScopeSourceV2>[0];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
type Port = ProductPublicationStoreOptionsV2["sources"]["withHeldCurrentFacts"];
export interface MerchantProductUniqueScopeConfigurationV2 {
  readonly candidateAuthority: SourceOptions["candidateAuthority"];
  readonly variantHistoryAuthority?: SourceOptions["variantHistoryAuthority"];
  readonly optionAuthority?: SourceOptions["optionAuthority"];
  readonly historyAuthority: SourceOptions["historyAuthority"];
  readonly tenantAuthority: SourceOptions["tenantAuthority"];
  readonly policyAuthority: PolicyOptions["authority"];
  readonly categoryAssignments?: SourceOptions["categoryAssignments"];
  readonly contentPolicy: HeldProductContentPolicyConfiguration;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export function captureMerchantProductUniqueScopeConfigurationV2(
  value: MerchantProductUniqueScopeConfigurationV2,
): MerchantProductUniqueScopeConfigurationV2 {
  if (
    typeof value?.candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.policyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.tenantAuthority?.withCurrentBrandReferenceRead !== "function" ||
    typeof value?.tenantAuthority?.isCurrent !== "function" ||
    (value.variantHistoryAuthority !== undefined &&
      typeof value.variantHistoryAuthority.holdUntilTransactionCompletes !== "function") ||
    (value.optionAuthority !== undefined &&
      typeof value.optionAuthority.holdUntilTransactionCompletes !== "function") ||
    (value.categoryAssignments !== undefined &&
      typeof value.categoryAssignments.holdUntilTransactionCompletes !== "function") ||
    value.contentPolicy == null ||
    typeof value.contentPolicy.brandAuthority?.withCurrentContentRead !== "function" ||
    typeof value.contentPolicy.brandAuthority?.isCurrent !== "function" ||
    !Number.isSafeInteger(value.contentPolicy.expectedBrandVersion) ||
    value.contentPolicy.expectedBrandVersion < 1 ||
    value.contentPolicy.expectedBrandVersion > 2147483647
  )
    return fail();
  return Object.freeze({
    ...(value.variantHistoryAuthority === undefined
      ? {}
      : {
          variantHistoryAuthority: Object.freeze({
            holdUntilTransactionCompletes:
              value.variantHistoryAuthority.holdUntilTransactionCompletes.bind(
                value.variantHistoryAuthority,
              ),
          }),
        }),
    contentPolicy: Object.freeze({
      configurationVersionReference: parseCatalogReference(
        value.contentPolicy.configurationVersionReference,
      ),
      expectedBrandVersion: value.contentPolicy.expectedBrandVersion,
      brandAuthority: Object.freeze({
        withCurrentContentRead: value.contentPolicy.brandAuthority.withCurrentContentRead.bind(
          value.contentPolicy.brandAuthority,
        ),
        isCurrent: value.contentPolicy.brandAuthority.isCurrent.bind(
          value.contentPolicy.brandAuthority,
        ),
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
/** Actual candidate/history/registered roster/policy and current Brand
 * content-policy necessary conditions. Remaining full checks stay mandatory;
 * operational topology, full validation and qualification are never synthesized. */
export function createMerchantProductUniqueScopeFactsV2(options: {
  readonly configuration: MerchantProductUniqueScopeConfigurationV2;
  readonly transaction: Parameters<Port>[0];
  readonly command: Parameters<Port>[1]["command"];
  readonly sources: ProductPublicationStoreOptionsV2["sources"];
  readonly validationAuthority: SourceOptions["validationAuthority"];
  readonly clock: { now(): string };
  readonly assertAdmission: (
    sourceReadsRequired: boolean,
    optionReadRequired?: boolean,
  ) => Promise<void>;
}) {
  const configuration = captureMerchantProductUniqueScopeConfigurationV2(options.configuration);
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.validationAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.assertAdmission !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    command = parseProductPublicationCommandV2(copyCategoryPersistenceValue(options.command)),
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
    policyCallbacks = 0,
    writerPolicyCalls = 0;
  const withCurrentPolicy: typeof owningPolicySource.withCurrentPolicy = async (
    actual,
    input,
    work,
  ) =>
    protect(async () => {
      if (actual !== tx || ++policyCalls !== 1) return fail();
      let completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
      const result = await owningPolicySource.withCurrentPolicy(actual, input, async (value) => {
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
        const reply = await work(currentPolicy);
        completed = { value: reply };
        return completed;
      });
      if (policyCalls !== 1 || policyCallbacks !== 1 || !completed || result !== completed)
        return fail();
      check();
      return completed.value;
    });
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
  const source = createCurrentProductCandidateUniqueScopeSourceV2({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    clock: { now: check },
    policySource,
    ...(configuration.variantHistoryAuthority === undefined
      ? {}
      : {
          variantHistoryAuthority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (
                actual !== tx ||
                !context(input) ||
                input.purposeCode !== "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY" ||
                input.permission !== "catalog.product.history.read" ||
                input.request.productReference !== command.productReference ||
                input.request.expectedAggregateVersion !==
                  command.expectedProductAggregateVersion ||
                input.request.originalIntentDigest !== intent ||
                JSON.stringify(input.requiredFields) !== JSON.stringify(productVariantHistoryFields)
              )
                return fail();
              await held("variant-history", input, (packet) =>
                (configuration.variantHistoryAuthority ?? fail()).holdUntilTransactionCompletes(
                  tx,
                  packet,
                ),
              );
            },
          },
        }),
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
        if (
          actual !== tx ||
          canonical(input.command) !== canonical(command) ||
          input.requiredScope !== "FullBrandScope" ||
          JSON.stringify(input.requiredPermissions) !==
            JSON.stringify(["catalog.product.read", "catalog.product.validate"]) ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(productPublicationWriteFieldsV2)
        )
          return fail();
        await held("validation", input, (packet) => validationHold(tx, packet));
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
          JSON.stringify(input.requiredFields) !==
            JSON.stringify(productValidationCandidateFieldsV2)
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
                canonical(input.command) !== canonical(command) ||
                input.originalIntentDigest !== intent ||
                input.replacementIntentDigest !== command.replacementIntentDigest ||
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
          input.actorKind !== "User" ||
          JSON.stringify(input.owningActions) !==
            JSON.stringify(["catalog.product.history.read"]) ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(productPublicationSourceFieldsV2)
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
      const result = await remaining(tx, input, async (value, details) => {
        if (++calls !== 1) return fail();
        const facts = immutable(value) as ProductPublicationFactsV2;
        const capturedDetails = details === undefined ? undefined : immutable(details);
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
        const validation = parseProductPublicationValidationV2(facts.validation);
        // Keep the independent producer's original deadline through outer COMMIT,
        // including when it is earlier than every newly acquired prerequisite.
        sourceUntil = [sourceUntil ?? until, validation.validUntil].sort()[0] ?? fail();
        check();
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
              proof.tenantReference !== command.tenantReference ||
              proof.brandReference !== command.brandReference ||
              proof.productReference !== command.productReference ||
              proof.versionReference !== command.versionReference ||
              proof.aggregateVersion !== command.expectedProductAggregateVersion ||
              proof.originalIntentDigest !== intent ||
              proof.replacementIntentDigest !== command.replacementIntentDigest ||
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
            if (
              (configuration.variantHistoryAuthority !== undefined) !==
              (proof.variantMappingAssessment !== undefined)
            )
              return fail();
            const proofUntil = parseCatalogInstant(proof.validUntil);
            sourceUntil =
              sourceUntil === undefined || proofUntil < sourceUntil ? proofUntil : sourceUntil;
            check();
            if (!proof.contentPolicyAssessment) return fail();
            await native();
            let candidateValidation = applyCatalogProductCandidateValidationV2(
              command,
              bindCatalogProductValidationToPolicyV2(command, validation, currentPolicy.content),
              {
                profile: "CatalogProductCandidateValidationBindingV2",
                scopeAssessment: proof.scopeAssessment,
                candidateObservedAt: proof.candidateObservedAt,
                candidateValidUntil: proof.candidateValidUntil,
                validUntil: sourceUntil ?? fail(),
                skuPrerequisite: proof.skuPrerequisite,
                internalCodeCheck: proof.internalCodeCheck,
                variantMappingPrerequisite: proof.variantMappingPrerequisite,
                optionSelectionPrerequisite: proof.optionSelectionPrerequisite,
                optionRulePrerequisite: proof.optionRulePrerequisite,
              },
              check(),
            );
            if (proof.variantMappingAssessment !== undefined) {
              const variant = readClosedRecord(immutable(proof.variantMappingAssessment), [
                  "check",
                  "originalIntentDigest",
                  "replacementIntentDigest",
                  "historyDigest",
                  "observedAt",
                  "validUntil",
                ]),
                mapping = readClosedRecord(variant.check, ["code", "outcome"]),
                variantAt = parseCatalogInstant(variant.observedAt),
                variantUntil = parseCatalogInstant(variant.validUntil);
              if (
                mapping.code !== "VariantMapping" ||
                !["Pass", "HardError"].includes(mapping.outcome as string) ||
                variant.originalIntentDigest !== intent ||
                variant.replacementIntentDigest !== command.replacementIntentDigest ||
                typeof variant.historyDigest !== "string" ||
                !variant.historyDigest.startsWith("sha256:") ||
                variantAt > check() ||
                variantUntil <= variantAt ||
                variantUntil < proof.validUntil ||
                Date.parse(variantUntil) - Date.parse(variantAt) > 5000
              )
                return fail();
              parseCatalogHash(variant.historyDigest.slice(7));
              // Historical identity reuse is an independent negative, even when
              // all current explicit combinations still map mechanically.
              if (mapping.outcome === "HardError")
                candidateValidation = parseProductPublicationValidationV2({
                  ...candidateValidation,
                  checks: candidateValidation.checks.map((item) =>
                    item.code === "VariantMapping" || item.code === "HardErrorsCleared"
                      ? { ...item, outcome: "HardError" }
                      : item,
                  ),
                });
            }
            const reply = await work(
              {
                ...facts,
                validation: applyCatalogProductContentPolicyValidationV2(
                  command,
                  candidateValidation,
                  proof.contentPolicyAssessment,
                  check(),
                ),
              },
              capturedDetails,
            );
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
    assertLeaseCurrent() {
      try {
        check();
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
    sources: Object.freeze({
      withHeldCurrentFacts,
      async withCurrentPolicy<T>(
        actual: Parameters<ProductPublicationStoreOptionsV2["sources"]["withCurrentPolicy"]>[0],
        input: Parameters<ProductPublicationStoreOptionsV2["sources"]["withCurrentPolicy"]>[1],
        work: (policy: unknown) => Promise<T>,
      ): Promise<T> {
        return protect(async () => {
          if (actual !== tx || !active || !currentPolicy || ++writerPolicyCalls !== 1)
            return fail();
          await native();
          let calls = 0,
            completed: { value: T } | undefined;
          const result = await owningPolicySource.withCurrentPolicy(
            actual,
            input,
            async (policy) => {
              if (
                ++calls !== 1 ||
                !currentPolicy ||
                policy.currentPublicationReference !== currentPolicy.currentPublicationReference ||
                publishingProductPublicationPolicyDigest(policy.content) !==
                  publishingProductPublicationPolicyDigest(currentPolicy.content)
              )
                return fail();
              sourceUntil = [sourceUntil ?? until, policy.validUntil].sort()[0] ?? fail();
              await native();
              const value = await work(policy);
              await assertCurrent();
              completed = { value };
              return completed;
            },
          );
          if (calls !== 1 || !completed || result !== completed) return fail();
          await assertCurrent();
          return completed.value;
        });
      },
    }),
  });
}
function canonical(value: unknown) {
  return canonicalizeRfc8785(parseProductPublicationCommandV2(copyCategoryPersistenceValue(value)));
}
