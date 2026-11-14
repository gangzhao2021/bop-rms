import { createPublishingScope, type PublishingProductPublicationPolicy } from "@bop/publishing";
import { createPostgresPublishingMutationStore } from "@bop/publishing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductPublicationVersion,
  type ProductPublicationStoreOptions,
} from "@rms/catalog";
export const currentProductPolicyFields = Object.freeze([
  "productPublicationPolicy",
  "scopeOrder",
  "approvalPolicy",
  "warningOverrideAllowed",
  "requiredLocales",
  "mediaRequirement",
  "effectivePeriod",
] as const);
export function createCurrentProductPublicationPolicySource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: Parameters<
        NonNullable<ProductPublicationStoreOptions["sources"]["withHeldScopePolicy"]>
      >[0],
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly actorKind: "User" | "System";
        readonly purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION";
        readonly policyReference: string;
        readonly requiredFields: typeof currentProductPolicyFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}) {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    actorKind = options.actorKind;
  if (
    !["User", "System"].includes(actorKind) ||
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const withCurrentPolicy = async <T>(
    tx: Parameters<
      NonNullable<ProductPublicationStoreOptions["sources"]["withHeldScopePolicy"]>
    >[0],
    input: {
      readonly policyReference: string;
      readonly policyVersion: number;
      readonly observedAt: string;
    },
    work: (source: CurrentProductPublicationPolicy) => Promise<T>,
  ): Promise<T> => {
    if (
      !input ||
      typeof input !== "object" ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).length !== 3
    )
      return fail();
    const fields = ["policyReference", "policyVersion", "observedAt"] as const;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (fields.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key])))
      return fail();
    const policyReference = parseCatalogReference(descriptors.policyReference?.value),
      policyVersion = descriptors.policyVersion?.value,
      observedAt = parseCatalogInstant(descriptors.observedAt?.value);
    if (
      typeof policyVersion !== "number" ||
      !Number.isSafeInteger(policyVersion) ||
      policyVersion < 1 ||
      policyVersion > 2147483647
    )
      return fail();
    const check = async () => {
      const current = parseCatalogInstant(options.clock.now());
      if (current < observedAt || Date.parse(current) - Date.parse(observedAt) >= 30_000)
        return fail();
      await options.authority.holdUntilTransactionCompletes(tx, {
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind,
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        policyReference,
        requiredFields: currentProductPolicyFields,
        observedAt: current,
      });
    };
    await check();
    let source;
    try {
      source = await createPostgresPublishingMutationStore(
        { run: (work) => work(tx) },
        tenant,
        createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
      ).resolveCurrentProductPublicationPolicy({ policyReference, policyVersion, observedAt });
    } catch {
      return fail();
    }
    const content = source.content;
    const validUntil = [
      new Date(Date.parse(observedAt) + 30_000).toISOString(),
      ...(content.effectiveUntil === null ? [] : [content.effectiveUntil]),
    ].sort()[0];
    if (!validUntil || parseCatalogInstant(options.clock.now()) >= validUntil) return fail();
    const result = await work(
      Object.freeze({
        content,
        currentPublicationReference: source.current.release.releaseId,
        observedAt,
        validUntil,
      }),
    );
    await check();
    if (parseCatalogInstant(options.clock.now()) >= validUntil) return fail();
    return result;
  };
  const withHeldScopePolicy: NonNullable<
    ProductPublicationStoreOptions["sources"]["withHeldScopePolicy"]
  > = async (tx, input, work) => {
    const p = parseProductPublicationVersion(input.publication),
      observedAt = parseCatalogInstant(input.observedAt);
    if (
      p.tenantReference !== tenant ||
      p.brandReference !== brand ||
      p.actorReference !== actor ||
      p.actorKind !== actorKind ||
      p.state !== "Published"
    )
      return fail();
    return withCurrentPolicy(
      tx,
      { policyReference: p.policyReference, policyVersion: p.policyVersion, observedAt },
      async (source) => {
        if (source.content.approvalPolicy !== p.approvalPolicy) return fail();
        return work(
          Object.freeze({
            policyReference: p.policyReference,
            policyVersion: p.policyVersion,
            policyEvidenceReference: source.currentPublicationReference,
            scopeOrder: source.content.scopeOrder,
            observedAt,
            validUntil: source.validUntil,
          }),
        );
      },
    );
  };
  return Object.freeze({
    withHeldScopePolicy,
    withCurrentPolicy,
    context: Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind,
    }),
  });
}
export interface CurrentProductPublicationPolicy {
  readonly content: PublishingProductPublicationPolicy;
  readonly currentPublicationReference: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
