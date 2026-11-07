import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  assessCatalogProductContentPolicy,
  contentRegistryFields,
  copyCategoryPersistenceValue,
  createPostgresProductContentRegistryStore,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductContentRegistry,
  parseCatalogProductPublicationValidationDetails,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  validateCatalogProductRegisteredContent,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type ProductPublicationQualificationContext,
} from "./product-publication-qualification-context.js";
import type { CurrentProductPublicationContentPolicy } from "./current-product-publication-content-policy.js";
import type { CurrentProductPublicationMedia } from "./current-product-publication-media.js";
import type { CurrentProductPublicationOptionSelection } from "./current-product-publication-option-selection.js";
import type { CurrentProductPublicationVariantMapping } from "./current-product-publication-variant-mapping.js";
import type { MerchantProductPublicationContentAuthorityV2 } from "./merchant-product-publication-content-authority-v2.js";

type RegistryOptions = Parameters<typeof createPostgresProductContentRegistryStore>[0];
type RegistryAuthority = RegistryOptions["authority"]["holdUntilTransactionCompletes"];
type Transaction = Parameters<RegistryAuthority>[0];
type Context = ProductPublicationQualificationContext;
export interface ProductPublicationRegisteredContentProofs {
  readonly policy: CurrentProductPublicationContentPolicy;
  readonly media: CurrentProductPublicationMedia;
  readonly options: CurrentProductPublicationOptionSelection;
  readonly variant: CurrentProductPublicationVariantMapping;
}
export interface ProductPublicationRegisteredContentAuthority {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: Parameters<RegistryAuthority>[1] & {
      readonly command: Context["command"];
      readonly commandPurposeCode: Context["command"]["purposeCode"];
      readonly originalIntentDigest: string;
      readonly requestObservedAt: string;
      readonly requestValidUntil: string;
    },
  ): Promise<void>;
}
export interface CurrentProductPublicationRegisteredContent {
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly registeredContent: ReturnType<typeof validateCatalogProductRegisteredContent>;
  readonly requiredReferenceChecks: typeof productEditorContentReferenceChecks;
  readonly findings: readonly [];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const leafKeys = [
  "originalIntentDigest",
  "contentDigest",
  "configurationDigest",
  "check",
  "findings",
  "sources",
  "observedAt",
  "validUntil",
] as const;

/** An integrity/reference holder for the actual nested publication sources.
 * It does not grant their authority or require business checks to be Pass.
 * Unmapped registry failures, Safety/Nutrition references and unevaluated Brand
 * requirements stay unavailable; no thirteenth check or fabricated finding. */
export function createCurrentProductPublicationRegisteredContentSource(options: {
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly registryAuthority: ProductPublicationRegisteredContentAuthority;
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => void | Promise<void>;
}) {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.registryAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    hold = options.registryAuthority.holdUntilTransactionCompletes.bind(options.registryAuthority),
    register = options.registerBeforeCommit.bind(options);
  let failed = false,
    active = false,
    used = false,
    ready = false,
    committing = false,
    latest: string | undefined,
    deadline: string | undefined,
    originalIntentDigest: string | undefined,
    registration: Promise<void> | undefined,
    asyncCalls = 0,
    asyncComplete = false,
    finalCalls = 0,
    context: Context | undefined,
    publishAggregateDigest: string | undefined,
    heldRegistry: Parameters<RegistryAuthority>[1] | undefined;
  const protect = (error: unknown): never => {
    failed = true;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(now()),
        descriptor = Object.getOwnPropertyDescriptor(tx, "query");
      if (
        failed ||
        !latest ||
        !deadline ||
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.value !== query ||
        at < latest ||
        at >= deadline
      )
        return fail();
      latest = at;
      return at;
    } catch (error) {
      return protect(error);
    }
  };
  const bindClock = (observedAt: string, validUntil: string, intent: string) => {
    if (
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      (originalIntentDigest !== undefined && originalIntentDigest !== intent)
    )
      return fail();
    originalIntentDigest = intent;
    latest ??= observedAt;
    deadline = deadline === undefined || validUntil < deadline ? validUntil : deadline;
  };
  const authorize = async (value: Parameters<RegistryAuthority>[1]) => {
    if (!context) return fail();
    check();
    if (
      (await hold(
        tx,
        Object.freeze({
          ...value,
          command: context.command,
          commandPurposeCode: context.command.purposeCode,
          originalIntentDigest: context.originalIntentDigest,
          requestObservedAt: context.observedAt,
          requestValidUntil: context.validUntil,
        }),
      )) !== undefined
    )
      return fail();
    check();
  };
  const ensureRegistered = () => {
    registration ??= (async () => {
      if (
        (await register(
          tx,
          async () => {
            try {
              if (++asyncCalls !== 1 || !ready || active) return fail();
              committing = true;
              check();
              if (heldRegistry)
                await authorize(Object.freeze({ ...heldRegistry, observedAt: check() }));
              check();
              asyncComplete = true;
            } catch (error) {
              return protect(error);
            }
          },
          () => {
            try {
              if (++finalCalls !== 1 || asyncCalls !== 1 || !asyncComplete || !ready || active)
                return fail();
              check();
            } catch (error) {
              return protect(error);
            }
          },
        )) !== undefined
      )
        return fail();
    })().catch(protect);
    return registration;
  };

  function captureProofs(bound: Context, value: ProductPublicationRegisteredContentProofs) {
    const r = readClosedRecord(value, ["policy", "media", "options", "variant"]);
    const policy = copyCategoryPersistenceValue(r.policy) as CurrentProductPublicationContentPolicy;
    readClosedRecord(policy, [
      "originalIntentDigest",
      "replacementIntentDigest",
      "contentDigest",
      "configurationDigest",
      "brand",
      "policy",
      "assessment",
      "check",
      "requiredMediaPresence",
      "findings",
      "sources",
      "brandFieldRequirements",
      "mediaReadiness",
      "publishValidation",
      "observedAt",
      "validUntil",
    ]);
    const leaf = (
      raw: unknown,
      code: "DefaultLocaleName" | "MediaReady" | "OptionSelection" | "VariantMapping",
      extra: readonly string[],
    ) => {
      // The heavy, independently bounded provenance object is owned and retained
      // by the Variant source. This holder consumes only its bound assessment.
      const fields = readClosedRecord(raw, [...leafKeys, ...extra]);
      const v = copyCategoryPersistenceValue(
        Object.fromEntries(leafKeys.map((key) => [key, fields[key]])),
      ) as Pick<CurrentProductPublicationMedia, (typeof leafKeys)[number]>;
      const from = parseCatalogInstant(v.observedAt),
        until = parseCatalogInstant(v.validUntil);
      readClosedRecord(v.check, ["code", "outcome"]);
      if (
        v.originalIntentDigest !== bound.originalIntentDigest ||
        v.contentDigest !== bound.contentDigest ||
        v.configurationDigest !== bound.configurationDigest ||
        from < bound.observedAt ||
        until > bound.validUntil ||
        from >= until ||
        v.check.code !== code ||
        (v.check.outcome !== "Pass" && v.check.outcome !== "HardError")
      )
        return fail();
      const details = parseCatalogProductPublicationValidationDetails({
        coverage: "Complete",
        impact: "Recorded",
        findings: v.findings,
        sources: v.sources,
      });
      if (
        details.coverage !== "Complete" ||
        details.findings.some((f) => f.checkCode !== code || f.outcome !== "HardError") ||
        (v.check.outcome === "HardError") !== details.findings.length > 0 ||
        details.sources.some(
          (s) =>
            s.observedAt < bound.observedAt ||
            s.observedAt > from ||
            s.validUntil < until ||
            s.validUntil > bound.validUntil,
        )
      )
        return fail();
      return { fields, value: v, details };
    };
    const media = leaf(r.media, "MediaReady", ["replacementIntentDigest"]),
      option = leaf(r.options, "OptionSelection", []),
      variant = leaf(r.variant, "VariantMapping", ["historyDigest", "referenceProvenance"]),
      policyLeaf = leaf(policy, "DefaultLocaleName", [
        "replacementIntentDigest",
        "brand",
        "policy",
        "assessment",
        "requiredMediaPresence",
        "brandFieldRequirements",
        "mediaReadiness",
        "publishValidation",
      ]);
    // The held Product determines the source inventory. A proof cannot retarget
    // a CurrentPublished binding into Pinned provenance (or vice versa).
    const optionSourceCodes = new Set<string>();
    for (const binding of bound.aggregate.draft.optionBindings) {
      const rule = bound.aggregate.draft.editorContent?.optionRules.find(
        (candidate) => candidate.bindingReference === binding.bindingReference,
      );
      if (!rule) return fail();
      if (rule.versionResolution === "Pinned") optionSourceCodes.add("PINNED_OPTION_RULES");
      else if (rule.versionResolution === "CurrentPublished")
        optionSourceCodes.add("CURRENT_PUBLISHED_OPTION_RULES");
      else return fail();
    }
    // Empty and legacy Pinned-only packets retain their existing single group.
    if (optionSourceCodes.size === 0) optionSourceCodes.add("PINNED_OPTION_RULES");
    if (
      option.details.sources.length !== optionSourceCodes.size ||
      new Set(option.details.sources.map((source) => source.sourceCode)).size !==
        optionSourceCodes.size ||
      option.details.sources.some((source) => !optionSourceCodes.has(source.sourceCode))
    )
      return fail();
    if (
      media.fields.replacementIntentDigest !== bound.replacementIntentDigest ||
      policy.replacementIntentDigest !== bound.replacementIntentDigest ||
      policy.brand.tenantReference !== bound.tenantReference ||
      policy.brand.brandReference !== bound.brandReference ||
      policy.brand.originalIntentDigest !== bound.originalIntentDigest ||
      policy.brand.observedAt !== bound.observedAt ||
      !Array.isArray(policy.brand.hardRequirementFieldCodes) ||
      policy.brand.hardRequirementFieldCodes.length !== 0 ||
      policy.policy.observedAt !== bound.observedAt ||
      policy.observedAt !== bound.observedAt ||
      policy.policy.validUntil !== policy.validUntil ||
      policy.brand.validUntil < policy.validUntil ||
      variant.details.sources.length !== 1 ||
      variant.details.sources[0]?.sourceCode !== "VARIANT_IDENTITY_HISTORY" ||
      variant.details.sources[0]?.sourceDigest !== variant.fields.historyDigest ||
      media.details.sources.length !== 1 ||
      media.details.sources[0]?.sourceCode !== "MEDIA_READINESS" ||
      policy.brandFieldRequirements !== "NotEvaluated" ||
      policy.mediaReadiness !== "NotEvaluated" ||
      policy.publishValidation !== "Incomplete"
    )
      return fail();
    const assessment = assessCatalogProductContentPolicy(
      bound.aggregate,
      {
        tenantReference: policy.brand.tenantReference,
        brandReference: policy.brand.brandReference,
        brandVersion: policy.brand.brandVersion,
        configurationVersionReference: policy.brand.configurationVersionReference,
        contentDigest: policy.brand.contentDigest,
        currentPublicationReference: policy.brand.currentPublicationReference,
        supportedLocales: policy.brand.supportedLocales,
        originalIntentDigest: bound.originalIntentDigest,
        observedAt: bound.observedAt,
        validUntil: policy.brand.validUntil,
      },
      policy.policy.content,
      {
        tenantReference: bound.tenantReference,
        productReference: bound.productReference,
        versionReference: bound.versionReference,
        expectedAggregateVersion: bound.aggregateVersion,
        contentDigest: bound.contentDigest,
        configurationDigest: bound.configurationDigest,
        originalIntentDigest: bound.originalIntentDigest,
        observedAt: bound.observedAt,
        validUntil: policy.validUntil,
      },
    );
    if (
      !equal(assessment, policy.assessment) ||
      !equal(
        policy.requiredMediaPresence,
        assessment.checks.find((c) => c.code === "RequiredMediaPresence"),
      ) ||
      policy.check.outcome !==
        (assessment.checks.some(
          (c) => c.code !== "RequiredMediaPresence" && c.outcome === "HardError",
        )
          ? "HardError"
          : "Pass")
    )
      return fail();
    const recordedPolicy =
      bound.kind === "Publication" && bound.command.action === "Validate"
        ? null
        : bound.recordedPolicy;
    if (
      recordedPolicy !== null &&
      (policy.policy.content.policyReference !== recordedPolicy.policyReference ||
        policy.policy.content.policyVersion !== recordedPolicy.policyVersion)
    )
      return fail();
    return Object.freeze({
      observedAts: Object.freeze([
        media.value.observedAt,
        option.value.observedAt,
        variant.value.observedAt,
        policyLeaf.value.observedAt,
      ]),
      validUntil:
        [
          media.value.validUntil,
          option.value.validUntil,
          variant.value.validUntil,
          policyLeaf.value.validUntil,
        ].sort()[0] ?? fail(),
    });
  }

  async function run<T>(
    bind: () => Context,
    proofs: ProductPublicationRegisteredContentProofs,
    work: (value: CurrentProductPublicationRegisteredContent) => Promise<T>,
  ): Promise<T> {
    if (failed || active || used || committing) return protect(undefined);
    active = true;
    used = true;
    ready = false;
    let bound: Context | undefined, captured: ReturnType<typeof captureProofs> | undefined;
    try {
      try {
        bound = bind();
        bindClock(bound.observedAt, bound.validUntil, bound.originalIntentDigest);
        captured = captureProofs(bound, proofs);
        const content = bound.aggregate.draft.editorContent;
        if (
          !content ||
          content.allergenReferences.length !== 0 ||
          content.nutritionProfile !== null
        )
          return fail();
        deadline = [deadline ?? fail(), captured.validUntil].sort()[0] ?? fail();
        context = bound;
      } catch {
        failed = true;
      }
      await ensureRegistered();
      if (!bound || !captured || failed || typeof work !== "function") return fail();
      const current = bound;
      if (captured.observedAts.some((at) => at > check())) return fail();
      let transactions = 0,
        callbacks = 0,
        completed: { value: T } | undefined;
      const registry = createPostgresProductContentRegistryStore({
        tenantReference: current.tenantReference,
        brandReference: current.brandReference,
        actorReference: current.actorReference,
        actorKind: current.actorKind,
        clock: { now: check },
        transactions: {
          async run(callback) {
            try {
              if (++transactions !== 1) return fail();
              check();
              const result = await callback(tx);
              check();
              return result;
            } catch (error) {
              return protect(error);
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes(actual, raw) {
            try {
              check();
              const input = readClosedRecord(copyCategoryPersistenceValue(raw), [
                "tenantReference",
                "brandReference",
                "actorReference",
                "actorKind",
                "purposeCode",
                "permission",
                "action",
                "registry",
                "requiredFields",
                "observedAt",
              ]);
              const observedAt = parseCatalogInstant(input.observedAt);
              if (
                actual !== tx ||
                input.tenantReference !== current.tenantReference ||
                input.brandReference !== current.brandReference ||
                input.actorReference !== current.actorReference ||
                input.actorKind !== current.actorKind ||
                input.purposeCode !== "CATALOG_PRODUCT_CONTENT_REGISTRY" ||
                input.permission !== "catalog.manage" ||
                input.action !== "catalog.content-registry.read" ||
                !equal(input.requiredFields, contentRegistryFields) ||
                observedAt < current.observedAt ||
                observedAt > check()
              )
                return fail();
              const parsedRegistry =
                input.registry === null ? null : parseCatalogProductContentRegistry(input.registry);
              if (
                parsedRegistry !== null &&
                (parsedRegistry.tenantReference !== current.tenantReference ||
                  parsedRegistry.brandReference !== current.brandReference)
              )
                return fail();
              const inputToHold: Parameters<RegistryAuthority>[1] = Object.freeze({
                tenantReference: current.tenantReference,
                brandReference: current.brandReference,
                actorReference: current.actorReference,
                actorKind: current.actorKind,
                purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
                permission: "catalog.manage",
                action: "catalog.content-registry.read",
                registry: parsedRegistry,
                requiredFields: contentRegistryFields,
                observedAt,
              });
              await authorize(inputToHold);
              if (parsedRegistry !== null) heldRegistry = inputToHold;
            } catch (error) {
              return protect(error);
            }
          },
        },
      });
      const observation = Object.freeze({
        originalIntentDigest: current.originalIntentDigest,
        observedAt: current.observedAt,
        validUntil: deadline ?? fail(),
      });
      const result = await registry.withCurrentRegistry(observation, async (raw, actual) => {
        try {
          if (++callbacks !== 1 || actual !== tx) return fail();
          const packet = readClosedRecord(copyCategoryPersistenceValue(raw), [
              "registry",
              "snapshotDigest",
              "observation",
              "eligibility",
            ]),
            snapshot = parseCatalogProductContentRegistry(packet.registry);
          if (
            !equal(packet.observation, observation) ||
            packet.eligibility !== "NotEvaluated" ||
            snapshot.tenantReference !== current.tenantReference ||
            snapshot.brandReference !== current.brandReference ||
            snapshot.registeredAt > current.observedAt ||
            packet.snapshotDigest !== hash(snapshot) ||
            !heldRegistry ||
            !equal(heldRegistry.registry, snapshot)
          )
            return fail();
          check();
          // The owning gate has no accepted twelve-check error mapping. Preserve
          // its invalid-content refusal; business HardErrors from the four
          // separately held sources above are deliberately not required to Pass.
          const registeredContent = validateCatalogProductRegisteredContent(
              current.aggregate,
              snapshot,
            ),
            content = current.aggregate.draft.editorContent ?? fail(),
            tagIds = new Set(content.tagReferences),
            attributeIds = new Set([
              ...content.attributeValues.map((a) => a.attributeReference),
              ...content.variantDimensions.flatMap((d) =>
                d.values.flatMap((v) =>
                  v.attributeReference === null ? [] : [v.attributeReference],
                ),
              ),
            ]),
            relevantReferenceDigest = hash({
              tags: snapshot.tags
                .filter((t) => tagIds.has(t.tagReference))
                .map((t) => ({
                  tagReference: t.tagReference,
                  code: t.code,
                  lifecycle: t.lifecycle,
                })),
              attributes: snapshot.attributes
                .filter((a) => attributeIds.has(a.attributeReference))
                .map((a) => {
                  const { localizedNames, ...definition } = a;
                  void localizedNames;
                  if (definition.type !== "Enum") return definition;
                  const selected = content.attributeValues.find(
                    (v) => v.attributeReference === a.attributeReference,
                  );
                  return {
                    ...definition,
                    values: definition.values
                      .filter(
                        (v) =>
                          selected?.type === "Enum" && v.valueReference === selected.valueReference,
                      )
                      .map((v) => ({
                        valueReference: v.valueReference,
                        code: v.code,
                        lifecycle: v.lifecycle,
                      })),
                  };
                }),
            });
          if (registeredContent.snapshotDigest !== packet.snapshotDigest) return fail();
          publishAggregateDigest = hash(current.aggregate);
          const assessment: CurrentProductPublicationRegisteredContent = Object.freeze({
            originalIntentDigest: current.originalIntentDigest,
            replacementIntentDigest: current.replacementIntentDigest,
            contentDigest: current.contentDigest,
            configurationDigest: current.configurationDigest,
            registeredContent,
            requiredReferenceChecks: productEditorContentReferenceChecks,
            findings: Object.freeze([] as const),
            sources: Object.freeze([
              Object.freeze({
                sourceCode: "CONTENT_REGISTRY",
                sourceDigest: packet.snapshotDigest as string,
                generation: String(snapshot.registryVersion),
                relevantReferenceDigest,
                observedAt: current.observedAt,
                validUntil: deadline ?? fail(),
              }),
            ]),
            observedAt: current.observedAt,
            validUntil: deadline ?? fail(),
          });
          const value = await work(assessment);
          check();
          completed = { value };
          return completed;
        } catch (error) {
          return protect(error);
        }
      });
      if (
        transactions !== 1 ||
        callbacks !== 1 ||
        !completed ||
        result !== completed ||
        !heldRegistry
      )
        return fail();
      check();
      ready = true;
      return completed.value;
    } catch (error) {
      return protect(error);
    } finally {
      active = false;
    }
  }

  const editorContentAuthority: MerchantProductPublicationContentAuthorityV2 = async (
    actual,
    raw,
  ) => {
    try {
      let captured: { mode: "Read" | "Publish"; aggregateDigest: string } | undefined;
      try {
        const r = readClosedRecord(copyCategoryPersistenceValue(raw), [
            "mode",
            "aggregate",
            "requiredFields",
            "requiredReferenceChecks",
            "tenantReference",
            "brandReference",
            "storeReference",
            "actorReference",
            "sessionReference",
            "productReference",
            "operationReference",
            "permission",
            "owningAction",
            "purposeCode",
            "command",
            "originalIntentDigest",
            "replacementIntentDigest",
            "observedAt",
            "validUntil",
          ]),
          command = parseProductPublicationCommandV2(r.command),
          aggregate = parseProductAggregate(r.aggregate),
          observedAt = parseCatalogInstant(r.observedAt),
          validUntil = parseCatalogInstant(r.validUntil);
        parseCatalogReference(r.storeReference);
        parseCatalogReference(r.sessionReference);
        if (
          actual !== tx ||
          (r.mode !== "Read" && r.mode !== "Publish") ||
          r.permission !== "catalog.manage" ||
          r.owningAction !== "catalog.product.read" ||
          r.purposeCode !== "CATALOG_PRODUCT_VERSION_PUBLICATION" ||
          command.actorKind !== "User" ||
          command.tenantReference !== r.tenantReference ||
          command.brandReference !== r.brandReference ||
          command.actorReference !== r.actorReference ||
          command.productReference !== r.productReference ||
          command.operationReference !== r.operationReference ||
          r.originalIntentDigest !== hash(command) ||
          r.replacementIntentDigest !== command.replacementIntentDigest ||
          aggregate.brandReference !== r.brandReference ||
          aggregate.productReference !== r.productReference ||
          aggregate.draft.editorContent === undefined ||
          !equal(r.requiredFields, productEditorContentFields) ||
          !equal(
            r.requiredReferenceChecks,
            r.mode === "Read" ? [] : productEditorContentReferenceChecks,
          )
        )
          return fail();
        bindClock(observedAt, validUntil, hash(command));
        captured = { mode: r.mode, aggregateDigest: hash(aggregate) };
      } catch {
        failed = true;
      }
      await ensureRegistered();
      if (!captured || failed) return fail();
      check();
      if (
        captured.mode === "Publish" &&
        (!context || !publishAggregateDigest || captured.aggregateDigest !== publishAggregateDigest)
      )
        return fail();
      // Read applies to the original replay or actual resulting successor, and
      // must not reacquire today's registry or full publication qualifications.
      if (!active) ready = true;
    } catch (error) {
      return protect(error);
    }
  };
  return Object.freeze({
    editorContentAuthority,
    withPublication<T>(
      input: Parameters<typeof bindPublicationQualificationInput>[0],
      originalValidUntil: string,
      proofs: ProductPublicationRegisteredContentProofs,
      work: (value: CurrentProductPublicationRegisteredContent) => Promise<T>,
    ) {
      return run(() => bindPublicationQualificationInput(input, originalValidUntil), proofs, work);
    },
    withAcknowledgement<T>(
      input: Parameters<typeof bindWarningAcknowledgementQualificationInput>[0],
      proofs: ProductPublicationRegisteredContentProofs,
      work: (value: CurrentProductPublicationRegisteredContent) => Promise<T>,
    ) {
      return run(() => bindWarningAcknowledgementQualificationInput(input), proofs, work);
    },
  });
}
