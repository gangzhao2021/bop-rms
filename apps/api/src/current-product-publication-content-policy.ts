import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingDigest,
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
  type PublishingProductPublicationPolicy,
} from "@bop/publishing";
import {
  createPostgresTenantBrandConfigurationContentSource,
  parseTenantBrandConfigurationContentRequest,
  tenantBrandConfigurationRequiredFields,
  type TenantBrandConfigurationContentRequest,
  type TenantBrandConfigurationTransaction,
} from "@bop/tenant";
import {
  CatalogError,
  assessCatalogProductContentPolicy,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  type CatalogProductContentPolicyAssessment,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  createCurrentBrandConfigurationContentSource,
  type CurrentBrandConfigurationContent,
} from "./current-brand-configuration-content.js";
import { currentProductPolicyFields } from "./current-product-publication-policy.js";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type ProductPublicationQualificationContext,
} from "./product-publication-qualification-context.js";

type Transaction = TenantBrandConfigurationTransaction;
type Context = ProductPublicationQualificationContext;
interface IntentAuthority {
  readonly command: Context["command"];
  readonly actorKind: Context["actorKind"];
  readonly purposeCode: Context["command"]["purposeCode"];
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
}
export interface ProductPublicationBrandContentAuthorityInput extends IntentAuthority {
  readonly request: TenantBrandConfigurationContentRequest;
  readonly requiredFields: typeof tenantBrandConfigurationRequiredFields;
}
export interface ProductPublicationContentPolicyAuthorityInput extends IntentAuthority {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly requiredFields: typeof currentProductPolicyFields;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface CurrentProductPublicationContentPolicy {
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly brand: CurrentBrandConfigurationContent;
  readonly policy: {
    readonly content: PublishingProductPublicationPolicy;
    readonly currentPublicationReference: string;
    readonly observedAt: string;
    readonly validUntil: string;
  };
  readonly assessment: CatalogProductContentPolicyAssessment;
  readonly check: { readonly code: "DefaultLocaleName"; readonly outcome: "Pass" | "HardError" };
  readonly requiredMediaPresence: {
    readonly code: "RequiredMediaPresence";
    readonly outcome: "Pass" | "HardError";
  };
  readonly findings: readonly CatalogProductPublicationValidationFinding[];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly brandFieldRequirements: "NotEvaluated";
  readonly mediaReadiness: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    return fail();
  return value;
};
const safeError = (error: unknown): error is CatalogError =>
  error instanceof CatalogError &&
  (error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" || error.code === "CATALOG_PERMISSION_DENIED");
const brandKeys = [
  "profile",
  "tenantReference",
  "brandReference",
  "brandVersion",
  "configurationVersionReference",
  "configurationVersion",
  "contentDigest",
  "originalPublicationReference",
  "currentPublicationReference",
  "defaultLocale",
  "supportedLocales",
  "overrideAllowedFieldCodes",
  "hardRequirementFieldCodes",
  "catalogSourceReference",
  "platformTemplateReference",
  "effectiveFrom",
  "effectiveUntil",
  "originalIntentDigest",
  "observedAt",
  "validUntil",
  "eligibility",
] as const;
function captureBrand(value: unknown): CurrentBrandConfigurationContent {
  const copied = copyCategoryPersistenceValue(value);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) return fail();
  const r = copied as Record<string, unknown>;
  if (
    Object.keys(r).length !== brandKeys.length ||
    brandKeys.some((key) => !Object.hasOwn(r, key)) ||
    r.profile !== "CurrentBrandConfigurationContentV1" ||
    r.eligibility !== "NotEvaluated"
  )
    return fail();
  const strings = (value: unknown, locale: boolean) => {
    if (!Array.isArray(value) || value.length > 100 || (locale && value.length === 0))
      return fail();
    const result = value.map((item: unknown) => {
      if (locale) return parseCatalogLocale(item);
      if (typeof item !== "string" || !/^[A-Z][A-Z0-9_.:-]{0,63}$/.test(item)) return fail();
      return item;
    });
    if (new Set(result).size !== result.length) return fail();
    return Object.freeze(result);
  };
  return Object.freeze({
    profile: "CurrentBrandConfigurationContentV1",
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    brandVersion: integer(r.brandVersion),
    configurationVersionReference: parseCatalogReference(r.configurationVersionReference),
    configurationVersion: integer(r.configurationVersion),
    contentDigest: parsePublishingDigest(r.contentDigest),
    originalPublicationReference: parseCatalogReference(r.originalPublicationReference),
    currentPublicationReference: parseCatalogReference(r.currentPublicationReference),
    defaultLocale: parseCatalogLocale(r.defaultLocale),
    supportedLocales: strings(r.supportedLocales, true),
    overrideAllowedFieldCodes: strings(r.overrideAllowedFieldCodes, false),
    hardRequirementFieldCodes: strings(r.hardRequirementFieldCodes, false),
    catalogSourceReference: parseCatalogReference(r.catalogSourceReference),
    platformTemplateReference: parseCatalogReference(r.platformTemplateReference),
    effectiveFrom: parseCatalogInstant(r.effectiveFrom),
    effectiveUntil: r.effectiveUntil === null ? null : parseCatalogInstant(r.effectiveUntil),
    originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
    observedAt: parseCatalogInstant(r.observedAt),
    validUntil: parseCatalogInstant(r.validUntil),
    eligibility: "NotEvaluated",
  });
}
/** Only owning current Brand/Publishing reads and the action-neutral pure rules.
 * The original command is never changed into Validate or a User command. */
export function createCurrentProductPublicationContentPolicySource(options: {
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly configurationVersionReference: string;
  readonly expectedBrandVersion: number;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly brandAuthority: {
    withCurrentContentRead<T>(
      tx: Transaction,
      input: ProductPublicationBrandContentAuthorityInput,
      work: () => Promise<T>,
    ): Promise<T>;
    isCurrent(
      tx: Transaction,
      input: ProductPublicationBrandContentAuthorityInput,
    ): Promise<boolean>;
  };
  readonly policyAuthority: {
    holdUntilTransactionCompletes(
      tx: Transaction,
      input: ProductPublicationContentPolicyAuthorityInput,
    ): Promise<void>;
  };
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => void | Promise<void>;
}) {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.brandAuthority?.withCurrentContentRead !== "function" ||
    typeof options.brandAuthority?.isCurrent !== "function" ||
    typeof options.policyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    brandHold = options.brandAuthority.withCurrentContentRead.bind(options.brandAuthority),
    brandCurrent = options.brandAuthority.isCurrent.bind(options.brandAuthority),
    policyHold = options.policyAuthority.holdUntilTransactionCompletes.bind(
      options.policyAuthority,
    ),
    register = options.registerBeforeCommit.bind(options),
    configurationVersionReference = parseCatalogReference(options.configurationVersionReference),
    expectedBrandVersion = integer(options.expectedBrandVersion),
    configuredPolicyReference = parseCatalogReference(options.policyReference),
    configuredPolicyVersion = integer(options.policyVersion);
  let active = false,
    failed = false;
  async function run<T>(
    bind: () => Context,
    work: (value: CurrentProductPublicationContentPolicy) => Promise<T>,
  ): Promise<T> {
    if (active || failed) {
      failed = true;
      return fail();
    }
    active = true;
    let ready = false,
      guardCalls = 0,
      finalCalls = 0,
      checkLease: (() => string) | undefined,
      reauthorize: (() => Promise<void>) | undefined,
      preservedError: CatalogError | undefined;
    const poison = (error: unknown): never => {
      failed = true;
      if (safeError(error)) {
        preservedError ??= error;
        throw error;
      }
      if (preservedError) throw preservedError;
      return fail();
    };
    try {
      let context: Context | undefined, captureError: unknown;
      try {
        context = bind();
      } catch (error) {
        failed = true;
        captureError = error;
      }
      const finalCheck = () => {
        if (failed || !ready || !checkLease) return fail();
        checkLease();
      };
      if (
        (await register(
          tx,
          async () => {
            try {
              if (++guardCalls !== 1 || !reauthorize) return fail();
              finalCheck();
              await reauthorize();
              finalCheck();
            } catch (error) {
              return poison(error);
            }
          },
          () => {
            try {
              if (guardCalls !== 1 || ++finalCalls !== 1) return fail();
              finalCheck();
            } catch (error) {
              return poison(error);
            }
          },
        )) !== undefined
      )
        return fail();
      if (!context) throw captureError;
      const c = context;
      if (typeof work !== "function" || c.aggregate.draft.editorContent === undefined)
        return fail();
      let latest: string = c.observedAt,
        deadline: string = c.validUntil;
      const check = () => {
        try {
          const at = parseCatalogInstant(now());
          if (failed || tx.query !== query || at < latest || at >= deadline) return fail();
          latest = at;
          return at;
        } catch (error) {
          return poison(error);
        }
      };
      checkLease = check;
      check();
      const intent = {
        command: c.command,
        actorKind: c.actorKind,
        purposeCode: c.command.purposeCode,
        originalIntentDigest: c.originalIntentDigest,
        replacementIntentDigest: c.replacementIntentDigest,
      } as const;
      const request = parseTenantBrandConfigurationContentRequest({
        tenantReference: c.tenantReference,
        brandReference: c.brandReference,
        actorReference: c.actorReference,
        purposeCode: "CATALOG_PRODUCT_CONTENT",
        configurationVersionReference,
        expectedBrandVersion,
        originalIntentDigest: c.originalIntentDigest,
        observedAt: c.observedAt,
        validUntil: c.validUntil,
      });
      const brandInput: ProductPublicationBrandContentAuthorityInput = Object.freeze({
        ...intent,
        request,
        requiredFields: tenantBrandConfigurationRequiredFields,
      });
      // A saved Draft may be revalidated against the configured current policy.
      // Review/publication and Ack retain the policy bound to their actual head/report.
      const selectedPolicy =
        c.kind === "Publication" && c.command.action === "Validate" ? null : c.recordedPolicy;
      const policyReference = selectedPolicy?.policyReference ?? configuredPolicyReference,
        policyVersion = selectedPolicy?.policyVersion ?? configuredPolicyVersion;
      const policyInput: ProductPublicationContentPolicyAuthorityInput = Object.freeze({
        ...intent,
        tenantReference: c.tenantReference,
        brandReference: c.brandReference,
        actorReference: c.actorReference,
        policyReference,
        policyVersion,
        requiredFields: currentProductPolicyFields,
        observedAt: c.observedAt,
        validUntil: c.validUntil,
      });
      async function currentBrand() {
        try {
          check();
          if ((await brandCurrent(tx, brandInput)) !== true)
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          check();
        } catch (error) {
          return poison(error);
        }
      }
      async function withBrand<R>(callback: () => Promise<R>): Promise<R> {
        let calls = 0,
          completed: { value: R } | undefined;
        try {
          check();
          const result = await brandHold(tx, brandInput, async () => {
            if (++calls !== 1) return poison(new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"));
            try {
              check();
              await currentBrand();
              const value = await callback();
              check();
              await currentBrand();
              completed = { value };
              return completed;
            } catch (error) {
              return poison(error);
            }
          });
          check();
          if (!completed || calls !== 1 || result !== completed) return fail();
          return completed.value;
        } catch (error) {
          return poison(error);
        }
      }
      const holdPolicy = async () => {
        try {
          check();
          if ((await policyHold(tx, policyInput)) !== undefined) return fail();
          check();
        } catch (error) {
          return poison(error);
        }
      };
      // Both Publishing resolvers hold SHARE on their mutation table; Tenant
      // holds the actual Brand FOR SHARE. These locks survive this callback in
      // the borrowed transaction. Recheck authority, not the complete SQL graph.
      reauthorize = () =>
        withBrand(async () => {
          await holdPolicy();
        });
      let transactionCalls = 0,
        sourceCalls = 0,
        completed: { value: T } | undefined;
      const recorded = createPostgresTenantBrandConfigurationContentSource({
        brandReference: c.brandReference,
        clock: check,
        transactions: {
          run: async (callback) => {
            try {
              if (++transactionCalls !== 1) return fail();
              check();
              const value = await callback(tx);
              check();
              return value;
            } catch (error) {
              return poison(error);
            }
          },
        },
        authority: {
          withCurrentContentRead: async (actual, fields, callback) => {
            try {
              if (
                hash(copyCategoryPersistenceValue(actual)) !== hash(request) ||
                hash(copyCategoryPersistenceValue(fields)) !==
                  hash(tenantBrandConfigurationRequiredFields)
              )
                return fail();
              return await withBrand(callback);
            } catch (error) {
              return poison(error);
            }
          },
          isCurrent: async (actual, actualRequest, fields) => {
            try {
              if (
                actual !== tx ||
                hash(copyCategoryPersistenceValue(actualRequest)) !== hash(request) ||
                hash(copyCategoryPersistenceValue(fields)) !==
                  hash(tenantBrandConfigurationRequiredFields)
              )
                return fail();
              await currentBrand();
              return true;
            } catch (error) {
              return poison(error);
            }
          },
        },
      });
      const result = await createCurrentBrandConfigurationContentSource(
        recorded,
      ).withCurrentContent(request, async (rawBrand, actualTx) => {
        try {
          if (++sourceCalls !== 1 || actualTx !== tx) return fail();
          check();
          const brand = captureBrand(rawBrand);
          if (
            brand.tenantReference !== c.tenantReference ||
            brand.brandReference !== c.brandReference ||
            brand.brandVersion !== expectedBrandVersion ||
            brand.configurationVersionReference !== configurationVersionReference ||
            brand.originalIntentDigest !== c.originalIntentDigest ||
            brand.observedAt !== c.observedAt ||
            brand.validUntil > c.validUntil ||
            brand.validUntil <= c.observedAt ||
            brand.effectiveFrom > c.observedAt ||
            (brand.effectiveUntil !== null &&
              (brand.effectiveUntil <= c.observedAt || brand.validUntil > brand.effectiveUntil)) ||
            !brand.supportedLocales.includes(brand.defaultLocale)
          )
            return fail();
          deadline = [deadline, brand.validUntil].sort()[0] ?? fail();
          await holdPolicy();
          const owner = createPostgresPublishingMutationStore(
            {
              run: async (callback) => {
                try {
                  check();
                  const value = await callback(tx);
                  check();
                  return value;
                } catch (error) {
                  return poison(error);
                }
              },
            },
            c.tenantReference,
            createPublishingScope({
              kind: "Brand",
              brandReference: c.brandReference,
              storeReference: null,
            }),
          );
          const raw = await owner.resolveCurrentProductPublicationPolicy({
            policyReference,
            policyVersion,
            observedAt: c.observedAt,
          });
          check();
          const content = parsePublishingProductPublicationPolicy(
            copyCategoryPersistenceValue(raw.content),
          );
          if (
            parseCatalogInstant(raw.observedAt) !== c.observedAt ||
            content.policyReference !== policyReference ||
            content.policyVersion !== policyVersion ||
            content.tenantReference !== c.tenantReference ||
            content.brandReference !== c.brandReference
          )
            return fail();
          const currentPublicationReference = parseCatalogReference(raw.current.release.releaseId);
          if (content.effectiveUntil !== null)
            deadline = [deadline, content.effectiveUntil].sort()[0] ?? fail();
          check();
          const assessment = assessCatalogProductContentPolicy(
            c.aggregate,
            {
              tenantReference: brand.tenantReference,
              brandReference: brand.brandReference,
              brandVersion: brand.brandVersion,
              configurationVersionReference: brand.configurationVersionReference,
              contentDigest: brand.contentDigest,
              currentPublicationReference: brand.currentPublicationReference,
              supportedLocales: brand.supportedLocales,
              originalIntentDigest: c.originalIntentDigest,
              observedAt: c.observedAt,
              validUntil: brand.validUntil,
            },
            content,
            {
              tenantReference: c.tenantReference,
              productReference: c.productReference,
              versionReference: c.versionReference,
              expectedAggregateVersion: c.aggregateVersion,
              contentDigest: c.contentDigest,
              configurationDigest: c.configurationDigest,
              originalIntentDigest: c.originalIntentDigest,
              observedAt: c.observedAt,
              validUntil: deadline,
            },
          );
          const policyDigest = publishingProductPublicationPolicyDigest(content);
          const sources: readonly CatalogProductPublicationValidationSourceEvidence[] =
            Object.freeze([
              Object.freeze({
                sourceCode: "BRAND_CONTENT_POLICY",
                sourceDigest: brand.contentDigest,
                generation: String(brand.brandVersion),
                relevantReferenceDigest: hash({
                  brandReference: c.brandReference,
                  supportedLocales: [...brand.supportedLocales].sort(),
                }),
                observedAt: c.observedAt,
                validUntil: deadline,
              }),
              Object.freeze({
                sourceCode: "PRODUCT_PUBLICATION_POLICY",
                sourceDigest: policyDigest,
                generation: String(content.policyVersion),
                relevantReferenceDigest: hash({
                  policyReference,
                  policyVersion,
                  currentPublicationReference,
                  policyDigest,
                }),
                observedAt: c.observedAt,
                validUntil: deadline,
              }),
            ]);
          const localeChecks = assessment.checks.filter(
            (item) => item.code === "SupportedLocales" || item.code === "RequiredProductNames",
          );
          const findings: readonly CatalogProductPublicationValidationFinding[] = Object.freeze(
            localeChecks
              .filter((item) => item.outcome === "HardError")
              .map((item) =>
                Object.freeze({
                  checkCode: "DefaultLocaleName" as const,
                  ruleCode:
                    item.code === "SupportedLocales"
                      ? "PRODUCT_LOCALES_SUPPORTED"
                      : "REQUIRED_PRODUCT_NAMES",
                  outcome: "HardError" as const,
                  subjectReference: c.productReference,
                  reasonCode:
                    item.code === "SupportedLocales"
                      ? "PRODUCT_LOCALE_UNSUPPORTED"
                      : "REQUIRED_PRODUCT_NAME_MISSING",
                  references: Object.freeze([
                    Object.freeze({
                      sourceCode: "BRAND_CONTENT_POLICY",
                      resourceReference: c.brandReference,
                      versionReference: brand.configurationVersionReference,
                      referenceDigest: brand.contentDigest,
                    }),
                    Object.freeze({
                      sourceCode: "PRODUCT_PUBLICATION_POLICY",
                      resourceReference: policyReference,
                      versionReference: currentPublicationReference,
                      referenceDigest: policyDigest,
                    }),
                  ]),
                }),
              ),
          );
          const mediaCheck =
            assessment.checks.find((item) => item.code === "RequiredMediaPresence") ?? fail();
          const requiredMediaPresence = Object.freeze({
            code: "RequiredMediaPresence" as const,
            outcome: mediaCheck.outcome,
          });
          const proof: CurrentProductPublicationContentPolicy = Object.freeze({
            originalIntentDigest: c.originalIntentDigest,
            replacementIntentDigest: c.replacementIntentDigest,
            contentDigest: c.contentDigest,
            configurationDigest: c.configurationDigest,
            brand,
            policy: Object.freeze({
              content,
              currentPublicationReference,
              observedAt: c.observedAt,
              validUntil: deadline,
            }),
            assessment,
            check: Object.freeze({
              code: "DefaultLocaleName",
              outcome: findings.length ? "HardError" : "Pass",
            }),
            requiredMediaPresence,
            findings,
            sources,
            brandFieldRequirements: "NotEvaluated",
            mediaReadiness: "NotEvaluated",
            publishValidation: "Incomplete",
            observedAt: c.observedAt,
            validUntil: deadline,
          });
          const value = await work(proof);
          check();
          await holdPolicy();
          check();
          completed = { value };
          return completed;
        } catch (error) {
          return poison(error);
        }
      });
      check();
      if (!completed || result !== completed || sourceCalls !== 1 || transactionCalls !== 1)
        return fail();
      ready = true;
      return completed.value;
    } catch (error) {
      return poison(error);
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    withPublication<T>(
      input: Parameters<typeof bindPublicationQualificationInput>[0],
      originalValidUntil: string,
      work: (value: CurrentProductPublicationContentPolicy) => Promise<T>,
    ) {
      return run(() => bindPublicationQualificationInput(input, originalValidUntil), work);
    },
    withAcknowledgement<T>(
      input: Parameters<typeof bindWarningAcknowledgementQualificationInput>[0],
      work: (value: CurrentProductPublicationContentPolicy) => Promise<T>,
    ) {
      return run(() => bindWarningAcknowledgementQualificationInput(input), work);
    },
  });
}
