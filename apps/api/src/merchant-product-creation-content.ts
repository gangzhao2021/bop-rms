import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogReference,
  parseCatalogInstant,
} from "@rms/catalog";
import { createMerchantProductEditorRegisteredContentAuthority } from "./merchant-product-editor-registered-content-authority.js";
import { createMerchantProductEditorVariantContentAuthority } from "./merchant-product-editor-variant-content-authority.js";
import { createMerchantProductEditorPolicyContentAuthority } from "./merchant-product-editor-policy-content-authority.js";
import { createMerchantProductEditorPinnedOptionAuthority } from "./merchant-product-editor-pinned-option-authority.js";
import type { MerchantProductEditorContentAuthority } from "./merchant-product-editor-content-authority.js";
import { createMerchantProductEditorMediaSafetyAuthority } from "./merchant-product-editor-media-safety-authority.js";
import { createMerchantProductEditorRuntimeMediaSafetyAuthority } from "./merchant-product-editor-runtime-media-safety.js";
import {
  createMerchantProductEditorRuntimeBrandSources,
  parseMerchantProductAuthoringSources,
  type MerchantProductAuthoringSources,
} from "./merchant-product-editor-runtime-brand-sources.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";

type Registry = Parameters<typeof createMerchantProductEditorRegisteredContentAuthority>[0];
type Variant = Parameters<typeof createMerchantProductEditorVariantContentAuthority>[0];
type Policy = Parameters<typeof createMerchantProductEditorPolicyContentAuthority>[0];
type Pinned = Parameters<typeof createMerchantProductEditorPinnedOptionAuthority>[0];
interface RegisteredProductCreationContentBase {
  readonly registryAuthority: Registry["registryAuthority"];
  readonly creationAuthority: NonNullable<Variant["creation"]>["authority"];
  readonly contentPolicy: Pick<
    Policy,
    | "configurationVersionReference"
    | "expectedBrandVersion"
    | "policyReference"
    | "policyVersion"
    | "brandAuthority"
    | "policyAuthority"
  >;
  readonly optionAuthority: Pinned["optionAuthority"];
}
type MediaSafety = Omit<
  Parameters<typeof createMerchantProductEditorMediaSafetyAuthority>[0],
  "tenantReference" | "brandReference" | "actorReference" | "registerBeforeCommit" | "clock"
>;
export type RegisteredProductCreationContent = RegisteredProductCreationContentBase &
  (
    | { readonly remainingAuthority: Pinned["remainingAuthority"]; readonly mediaSafety?: never }
    | { readonly remainingAuthority?: never; readonly mediaSafety: MediaSafety }
  );
interface CreationContext {
  readonly runtimeBrandSources?: ReturnType<typeof createMerchantProductEditorRuntimeBrandSources>;
  readonly currentAuthorization?: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  readonly originalValidUntil?: string;
  readonly transaction: Parameters<MerchantProductEditorContentAuthority>[0];
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly clock: Policy["clock"];
  readonly registerBeforeCommit: NonNullable<Variant["creation"]>["registerBeforeCommit"];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Capture server ports before session/source awaits. The remaining holder is
 * mandatory: actual Media/Safety/Nutrition/field policy is never inferred here. */
export function createMerchantProductCreationContentFactory(
  value:
    | RegisteredProductCreationContent
    | { readonly authoringSources: MerchantProductAuthoringSources },
) {
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "authoringSources")) {
    const raw = readClosedRecord(value, ["authoringSources"]),
      selected = parseMerchantProductAuthoringSources(raw.authoringSources);
    return (context: CreationContext): MerchantProductEditorContentAuthority => {
      if (context.currentAuthorization === undefined || context.originalValidUntil === undefined)
        return fail();
      const sourceHost = {
        ...context,
        action: "Create" as const,
        expectedAggregateVersion: null,
        currentAuthorization: context.currentAuthorization,
        originalValidUntil: context.originalValidUntil,
      };
      const sources =
        context.runtimeBrandSources ??
        createMerchantProductEditorRuntimeBrandSources(sourceHost, selected);
      const remaining = createMerchantProductEditorRuntimeMediaSafetyAuthority(sourceHost, {
        allergenRegistryVersionReference: selected.allergenRegistryVersionReference,
        remainingAuthority: sources.remainingAuthority,
      });
      // All these ports are actual producers bound to this original runtime host.
      // Reuse the existing complete composition without callback scaffolding.
      const compose = createCapturedProductCreationContentFactory(
        {
          registryAuthority: sources.registryAuthority,
          creationAuthority: sources.creationAuthority,
          optionAuthority: sources.optionAuthority,
          contentPolicy: {
            ...selected,
            brandAuthority: sources.brandAuthority,
            policyAuthority: sources.policyAuthority,
          },
          remainingAuthority: remaining,
        },
        async (actual, input) => {
          if (input.mode !== "Read" || JSON.stringify(input.requiredReferenceChecks) !== "[]")
            return fail();
          // Stored Read/replay authorizes complete recorded fields. It never
          // reacquires Create absence or evaluates current reference eligibility.
          await sources.remainingAuthority(actual, {
            ...input,
            requiredReferenceChecks: Object.freeze([]),
          });
        },
        sources,
      );
      const {
        currentAuthorization: _authorization,
        originalValidUntil: _deadline,
        runtimeBrandSources: _sources,
        ...compositionContext
      } = context;
      void _authorization;
      void _deadline;
      void _sources;
      return compose(compositionContext);
    };
  }
  const legacy = value as RegisteredProductCreationContent;
  const compose = createCapturedProductCreationContentFactory(legacy);
  return (context: CreationContext): MerchantProductEditorContentAuthority => {
    if (
      context.currentAuthorization !== undefined ||
      context.originalValidUntil !== undefined ||
      context.runtimeBrandSources !== undefined
    )
      return fail();
    return compose(context);
  };
}
function createCapturedProductCreationContentFactory(
  value: RegisteredProductCreationContent,
  recordedReadAuthority?: MerchantProductEditorContentAuthority,
  runtimeBrandSources?: ReturnType<typeof createMerchantProductEditorRuntimeBrandSources>,
) {
  if (
    typeof value?.registryAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.creationAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.contentPolicy?.brandAuthority?.withCurrentContentRead !== "function" ||
    typeof value?.contentPolicy?.brandAuthority?.isCurrent !== "function" ||
    typeof value?.contentPolicy?.policyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.optionAuthority?.holdUntilTransactionCompletes !== "function" ||
    (value?.mediaSafety === undefined
      ? typeof value?.remainingAuthority !== "function"
      : value.mediaSafety === null ||
        value.remainingAuthority !== undefined ||
        typeof value.mediaSafety.mediaAuthority?.holdUntilTransactionCompletes !== "function" ||
        typeof value.mediaSafety.safetyAuthority?.holdUntilTransactionCompletes !== "function" ||
        typeof value.mediaSafety.remainingAuthority !== "function") ||
    !Number.isSafeInteger(value.contentPolicy.expectedBrandVersion) ||
    value.contentPolicy.expectedBrandVersion < 1 ||
    value.contentPolicy.expectedBrandVersion > 2147483647 ||
    !Number.isSafeInteger(value.contentPolicy.policyVersion) ||
    value.contentPolicy.policyVersion < 1 ||
    value.contentPolicy.policyVersion > 2147483647
  )
    return fail();
  const registryAuthority = Object.freeze({
      holdUntilTransactionCompletes: value.registryAuthority.holdUntilTransactionCompletes.bind(
        value.registryAuthority,
      ),
    }),
    creationAuthority = Object.freeze({
      holdUntilTransactionCompletes: value.creationAuthority.holdUntilTransactionCompletes.bind(
        value.creationAuthority,
      ),
    }),
    optionAuthority = Object.freeze({
      holdUntilTransactionCompletes: value.optionAuthority.holdUntilTransactionCompletes.bind(
        value.optionAuthority,
      ),
    }),
    contentPolicy = Object.freeze({
      configurationVersionReference: parseCatalogReference(
        value.contentPolicy.configurationVersionReference,
      ),
      expectedBrandVersion: value.contentPolicy.expectedBrandVersion,
      policyReference: parseCatalogReference(value.contentPolicy.policyReference),
      policyVersion: value.contentPolicy.policyVersion,
      brandAuthority: Object.freeze({
        withCurrentContentRead: value.contentPolicy.brandAuthority.withCurrentContentRead.bind(
          value.contentPolicy.brandAuthority,
        ),
        isCurrent: value.contentPolicy.brandAuthority.isCurrent.bind(
          value.contentPolicy.brandAuthority,
        ),
      }),
      policyAuthority: Object.freeze({
        holdUntilTransactionCompletes:
          value.contentPolicy.policyAuthority.holdUntilTransactionCompletes.bind(
            value.contentPolicy.policyAuthority,
          ),
      }),
    }),
    remainingAuthority = value.remainingAuthority,
    mediaSafety =
      value.mediaSafety === undefined
        ? undefined
        : Object.freeze({
            allergenRegistryVersionReference:
              value.mediaSafety.allergenRegistryVersionReference === null
                ? null
                : parseCatalogReference(value.mediaSafety.allergenRegistryVersionReference),
            mediaAuthority: Object.freeze({
              holdUntilTransactionCompletes:
                value.mediaSafety.mediaAuthority.holdUntilTransactionCompletes.bind(
                  value.mediaSafety.mediaAuthority,
                ),
            }),
            safetyAuthority: Object.freeze({
              holdUntilTransactionCompletes:
                value.mediaSafety.safetyAuthority.holdUntilTransactionCompletes.bind(
                  value.mediaSafety.safetyAuthority,
                ),
            }),
            remainingAuthority: value.mediaSafety.remainingAuthority,
          });
  return (options: CreationContext): MerchantProductEditorContentAuthority => {
    if (
      (options.currentAuthorization === undefined) !== (options.originalValidUntil === undefined) ||
      (options.currentAuthorization !== undefined && mediaSafety === undefined) ||
      (options.currentAuthorization === undefined && options.runtimeBrandSources !== undefined)
    )
      return fail();
    const tx = options.transaction,
      query = tx.query,
      now = options.clock.now.bind(options.clock),
      register = options.registerBeforeCommit.bind(options),
      identity = Object.freeze({
        tenantReference: parseCatalogReference(options.tenantReference),
        brandReference: parseCatalogReference(options.brandReference),
        storeReference: parseCatalogReference(options.storeReference),
        actorReference: parseCatalogReference(options.actorReference),
        sessionReference: parseCatalogReference(options.sessionReference),
        productReference: parseCatalogReference(options.productReference),
        operationReference: parseCatalogReference(options.operationReference),
      }),
      common = {
        tenantReference: identity.tenantReference,
        brandReference: identity.brandReference,
        actorReference: identity.actorReference,
        clock: options.clock,
      },
      finalAuthority =
        mediaSafety === undefined
          ? (remainingAuthority ?? fail())
          : createMerchantProductEditorMediaSafetyAuthority({
              ...common,
              ...mediaSafety,
              registerBeforeCommit: options.registerBeforeCommit,
            }),
      pinned = createMerchantProductEditorPinnedOptionAuthority({
        ...common,
        optionAuthority,
        remainingAuthority: finalAuthority,
      }),
      policy = createMerchantProductEditorPolicyContentAuthority({
        ...common,
        ...contentPolicy,
        ...(runtimeBrandSources === undefined ? {} : { runtimeBrandSources }),
        remainingAuthority: pinned,
      }),
      variant = createMerchantProductEditorVariantContentAuthority({
        // Create must use the independent absence source. This port cannot
        // turn a missing existing Product into a fictional history snapshot.
        variantAuthority: {
          async holdUntilTransactionCompletes() {
            return fail();
          },
        },
        creation: {
          authority: creationAuthority,
          registerBeforeCommit: options.registerBeforeCommit,
        },
        remainingAuthority: policy,
        clock: options.clock,
      }),
      registered = createMerchantProductEditorRegisteredContentAuthority({
        registryAuthority,
        remainingAuthority: variant,
        clock: options.clock,
      });
    let failed = false,
      active = false,
      registeredGuard = false,
      ready = false,
      guardComplete = false,
      finalized = false,
      guardCalls = 0;
    let lease: { observedAt: string; validUntil: string } | undefined;
    const poison = (): never => {
      failed = true;
      return fail();
    };
    const check = () => {
      if (failed || finalized || tx.query !== query) return poison();
      if (lease) {
        const at = parseCatalogInstant(now());
        if (at < lease.observedAt || at >= lease.validUntil) return poison();
      }
    };
    return async (actual, input) => {
      try {
        check();
        if (active) return fail();
        active = true;
        if (!registeredGuard) {
          registeredGuard = true;
          if (
            (await register(
              tx,
              async () => {
                check();
                if (!ready || active || ++guardCalls !== 1) return poison();
                guardComplete = true;
              },
              () => {
                check();
                if (!ready || active || !guardComplete || guardCalls !== 1) return poison();
                finalized = true;
              },
            )) !== undefined
          )
            return fail();
        }
        const raw = readClosedRecord(copyCategoryPersistenceValue(input), [
          ...Object.keys(identity),
          "permission",
          "owningAction",
          "purposeCode",
          "observedAt",
          "validUntil",
          "mode",
          "aggregate",
          "requiredFields",
          "requiredReferenceChecks",
        ]);
        if (
          failed ||
          actual !== tx ||
          (raw.mode !== "DraftWrite" &&
            !(raw.mode === "Read" && recordedReadAuthority !== undefined)) ||
          raw.purposeCode !== "CATALOG_PRODUCT_CREATE"
        )
          return fail();
        for (const key of Object.keys(identity) as (keyof typeof identity)[])
          if (raw[key] !== identity[key]) return fail();
        const observedAt = parseCatalogInstant(raw.observedAt),
          validUntil = parseCatalogInstant(raw.validUntil);
        if (lease && (lease.observedAt !== observedAt || lease.validUntil !== validUntil))
          return fail();
        lease = { observedAt, validUntil };
        check();
        if (raw.mode === "Read") {
          if (recordedReadAuthority === undefined) return fail();
          await recordedReadAuthority(actual, input);
        } else await registered(actual, input);
        check();
        ready = true;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        active = false;
      }
    };
  };
}
