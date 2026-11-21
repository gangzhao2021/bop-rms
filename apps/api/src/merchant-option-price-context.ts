import { createPostgresPublishingMutationStore, createPublishingScope } from "@bop/publishing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductOptionPriceContextSourceStore,
  createPostgresFrozenFullOptionSetContentStore,
  frozenFullOptionSetContentFields,
  parseCatalogFullOptionSetPublicationContent,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductOptionPriceContextSnapshot,
  parseProductOptionPriceContextRequest,
  productOptionPriceContextSourceFields,
} from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
  OptionPriceAuthoringError,
  type CurrencyMetadataSnapshot,
} from "@rms/pricing";
import {
  createCurrentPublishedOptionSetGraphSource,
  type CurrentPublishedOptionSetGraphOptions,
} from "./current-published-option-set-graph.js";
import type { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { createMerchantStoreScope } from "./merchant-store-scope.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type Transaction = CurrentPublishedOptionSetGraphOptions["transaction"];
type BrandScope = Pick<
  Awaited<ReturnType<ReturnType<typeof createMerchantBrandScope>>>,
  "tenantReference" | "context" | "actorReference" | "selectedStoreReference"
>;
type ActualStoreScope = Awaited<ReturnType<ReturnType<typeof createMerchantStoreScope>>>;
type StoreScope = Pick<
  ActualStoreScope,
  "context" | "store" | "actorReference" | "sessionReference"
> & {
  readonly selected: Pick<ActualStoreScope["selected"], "tenantReference">;
};
type ProductSnapshot = ReturnType<typeof parseProductOptionPriceContextSnapshot>;
type OptionContent = ReturnType<
  typeof parseCatalogFullOptionSetPublicationContent
>["editorContent"];
export interface MerchantOptionPriceContextOptions extends CurrentPublishedOptionSetGraphOptions {
  readonly brandScope: BrandScope;
  readonly storeScope: StoreScope;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  /** Server-only write admission for an ordinary Pricing review. Never request data. */
  readonly publicationReviewWriteFamilyReference?: string;
}
export interface MerchantOptionPriceContextRequest {
  readonly productReference: string;
  readonly expectedProductAggregateVersion: number;
  readonly bindingReference: string;
  readonly optionReference: string | null;
}
export interface MerchantOptionPriceContext {
  readonly profile: "MerchantOptionPriceContextV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly productReference: string;
  readonly productAggregateVersion: number;
  readonly productVersionReference: string;
  readonly productSnapshotDigest: string;
  readonly binding: ProductSnapshot["binding"];
  readonly versionResolution: "Pinned" | "CurrentPublished";
  readonly optionReference: string | null;
  readonly optionSetReference: string;
  readonly optionSetVersionReference: string;
  readonly optionSourceDigest: string;
  readonly optionSourceAuthority: "RecordedFrozen" | "CurrentPublishingReleaseAndFrozenContent";
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly choices: readonly {
    readonly optionReference: string;
    readonly stableCode: string;
    readonly lifecycle: OptionContent["sourceAggregate"]["draft"]["options"][number]["lifecycle"];
    readonly localizedNames: Readonly<Record<string, string>>;
  }[];
  readonly skus: readonly {
    readonly skuReference: string;
    readonly skuCode: string;
    readonly lifecycle: ProductSnapshot["skus"][number]["lifecycle"];
    readonly localizedNames: Readonly<Record<string, string>>;
  }[];
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly referenceEligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (
  code: ConstructorParameters<
    typeof OptionPriceAuthoringError
  >[0] = "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new OptionPriceAuthoringError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const configuredCurrency = (value: unknown) => {
  try {
    const r = readClosedRecord(copyCategoryPersistenceValue(value), [
      "currencyCode",
      "minorUnitExponent",
      "metadataVersion",
      "metadataVersionReference",
      "metadataDigest",
    ]);
    if (typeof r.minorUnitExponent !== "number" || typeof r.metadataVersion !== "number")
      return fail();
    return createCurrencyMetadataSnapshot({
      currencyCode: parseCurrencyCode(r.currencyCode),
      minorUnitExponent: r.minorUnitExponent,
      metadataVersion: r.metadataVersion,
      metadataVersionReference: parsePricingReference(r.metadataVersionReference),
      metadataDigest: parsePricingDigest(r.metadataDigest),
    });
  } catch {
    return fail();
  }
};

/** Internal composition only. The actual Pricing host supplies captured owner
 * ports; neither a browser context packet nor this read grants publish rights.
 * Catalog is acquired before Publishing and the consumer's Pricing locks. */
export function createMerchantOptionPriceContextSource(options: MerchantOptionPriceContextOptions) {
  const tx = options.transaction,
    query = tx.query,
    clockOwner = options.clock,
    clockPort = clockOwner.now,
    authorization = options.currentAuthorization,
    assertPort = authorization.assertCurrent,
    leasePort = authorization.leaseDeadline,
    authorizePort = authorization.authorizeActions,
    storePort = authorization.withCurrentStoreScope,
    capability = options.capability,
    capabilityPort = capability.holdUntilCommit,
    capabilityLeasePort = capability.leaseDeadline,
    registerPort = options.registerBeforeCommit,
    tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    store = parseCatalogReference(options.storeReference),
    actor = parseCatalogReference(options.actorReference),
    session = parseCatalogReference(options.sessionReference),
    brandScope = options.brandScope,
    storeScope = options.storeScope,
    currency = configuredCurrency(options.currencyMetadata),
    reviewWriteFamily =
      options.publicationReviewWriteFamilyReference === undefined
        ? undefined
        : String(parseCatalogReference(options.publicationReviewWriteFamilyReference));
  if (
    [
      clockPort,
      assertPort,
      leasePort,
      authorizePort,
      storePort,
      capabilityPort,
      capabilityLeasePort,
      registerPort,
    ].some((port) => typeof port !== "function")
  )
    return fail();
  // Capture mandatory leases without replacing them with an invented default.
  if (typeof leasePort !== "function" || typeof capabilityLeasePort !== "function") return fail();
  const now = clockPort.bind(clockOwner),
    assertCurrent = assertPort.bind(authorization),
    authorize = authorizePort.bind(authorization),
    currentStore = storePort.bind(authorization),
    lease = leasePort.bind(authorization),
    capabilityLease = capabilityLeasePort.bind(capability),
    holdCapability = capabilityPort.bind(capability),
    register = registerPort.bind(options);
  const origin = parseCatalogInstant(now()),
    originalUntil = parseCatalogInstant(options.originalValidUntil);
  if (originalUntil <= origin || Date.parse(originalUntil) - Date.parse(origin) > 5000)
    return fail();
  let latest = origin,
    deadline = originalUntil,
    failed = false,
    active = false,
    started = false,
    complete = false,
    guarded = false,
    finalized = false,
    publishedGraph: ReturnType<typeof createCurrentPublishedOptionSetGraphSource> | undefined,
    productSourceFinal: ((actual: Transaction) => string) | undefined;
  const reject = (error: unknown): never => {
    failed = true;
    if (error instanceof MerchantProductWriteFeatureDisabled) throw error;
    if (error instanceof OptionPriceAuthoringError) throw error;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
      return fail("OPTION_PRICE_PERMISSION_DENIED");
    if (error instanceof CatalogError && error.code === "CATALOG_VERSION_CONFLICT")
      return fail("OPTION_PRICE_VERSION_CONFLICT");
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(now());
      if (
        failed ||
        tx.query !== query ||
        at < latest ||
        at >= deadline ||
        options.tenantReference !== tenant ||
        options.brandReference !== brand ||
        options.storeReference !== store ||
        options.actorReference !== actor ||
        options.sessionReference !== session ||
        options.originalValidUntil !== originalUntil ||
        options.transaction !== tx ||
        options.clock !== clockOwner ||
        options.clock.now !== clockPort ||
        options.currentAuthorization !== authorization ||
        authorization.assertCurrent !== assertPort ||
        authorization.authorizeActions !== authorizePort ||
        authorization.withCurrentStoreScope !== storePort ||
        authorization.leaseDeadline !== leasePort ||
        options.capability !== capability ||
        capability.holdUntilCommit !== capabilityPort ||
        capability.leaseDeadline !== capabilityLeasePort ||
        options.registerBeforeCommit !== registerPort ||
        options.brandScope !== brandScope ||
        options.storeScope !== storeScope ||
        options.publicationReviewWriteFamilyReference !== reviewWriteFamily ||
        !equal(options.currencyMetadata, currency)
      )
        return fail();
      scopeMatches();
      assertCurrent();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const tighten = (at: string, until: string) => {
    const observed = parseCatalogInstant(at),
      valid = parseCatalogInstant(until);
    if (observed < origin || observed > check() || valid <= observed || valid > originalUntil)
      return fail();
    if (valid < deadline) deadline = valid;
    check();
  };
  const scopeMatches = () => {
    if (
      brandScope.tenantReference !== tenant ||
      String(brandScope.context.brand.brandReference) !== brand ||
      String(brandScope.actorReference) !== actor ||
      String(brandScope.selectedStoreReference) !== store ||
      storeScope.selected.tenantReference !== tenant ||
      String(storeScope.context.brand.brandReference) !== brand ||
      String(storeScope.store.storeReference) !== store ||
      String(storeScope.store.brandReference) !== brand ||
      String(storeScope.actorReference) !== actor ||
      String(storeScope.sessionReference) !== session ||
      brandScope.context.brand.currencyCode !== currency.currencyCode ||
      storeScope.context.brand.currencyCode !== currency.currencyCode ||
      storeScope.store.currencyCode !== currency.currencyCode
    )
      return fail();
  };
  scopeMatches();
  const hold = async () => {
    check();
    scopeMatches();
    let calls = 0;
    const scoped = await currentStore(
      {
        brandReference: brand,
        storeReference: store,
        capabilityKey: "pricing.price_book_editor",
        observedAt: check(),
      },
      async (context) => {
        if (
          ++calls !== 1 ||
          String(context.brand.brandReference) !== brand ||
          context.store === null ||
          String(context.store.storeReference) !== store ||
          String(context.store.brandReference) !== brand ||
          String(context.actor.actorReference) !== actor ||
          context.brand.currencyCode !== currency.currencyCode ||
          context.store.currencyCode !== currency.currencyCode
        )
          return fail();
        return undefined;
      },
    );
    if (calls !== 1 || scoped !== undefined || (await holdCapability()) !== undefined)
      return fail();
    // Restore Brand RLS via the actual full current authorization after Store admission.
    if (
      (await authorize([
        "catalog.manage",
        "catalog.product.read",
        "catalog.sku.read",
        "catalog.option_set.read",
        "pricing.price-book.manage",
      ])) !== undefined
    )
      return fail();
    for (const until of [lease(), capabilityLease()]) {
      const valid = parseCatalogInstant(until);
      if (valid < deadline) deadline = valid;
    }
    check();
  };
  return Object.freeze({
    async withCurrentContext<T>(
      actual: Transaction,
      value: MerchantOptionPriceContextRequest,
      work: (context: MerchantOptionPriceContext) => Promise<T>,
    ): Promise<T> {
      try {
        if (actual !== tx || started || typeof work !== "function") return fail();
        started = true;
        active = true;
        check();
        const parsedRequest = (() => {
          try {
            const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
              "productReference",
              "expectedProductAggregateVersion",
              "bindingReference",
              "optionReference",
            ]);
            return {
              request: parseProductOptionPriceContextRequest({
                productReference: raw.productReference,
                expectedAggregateVersion: raw.expectedProductAggregateVersion,
                bindingReference: raw.bindingReference,
                optionReference: raw.optionReference,
              }),
              choice:
                raw.optionReference === null ? null : parseCatalogReference(raw.optionReference),
            };
          } catch {
            return fail("OPTION_PRICE_INPUT_INVALID");
          }
        })();
        const { request, choice } = parsedRequest;
        let pinned: string | undefined;
        const productSource = createPostgresProductOptionPriceContextSourceStore({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: originalUntil,
          registerBeforeCommit: register,
          transactions: {
            async run(callback) {
              check();
              const result = await callback(tx);
              check();
              return result;
            },
          },
          authority: {
            async holdUntilTransactionCompletes(candidate, input) {
              readClosedRecord(copyCategoryPersistenceValue(input), [
                "tenantReference",
                "brandReference",
                "actorReference",
                "actorKind",
                "productReference",
                "request",
                "purposeCode",
                "permission",
                "owningAction",
                "requiredFields",
                "observedAt",
                "validUntil",
              ]);
              const observed = parseCatalogInstant(input.observedAt),
                sourceUntil = parseCatalogInstant(input.validUntil);
              if (
                candidate !== tx ||
                input.tenantReference !== tenant ||
                input.brandReference !== brand ||
                input.actorReference !== actor ||
                input.actorKind !== "User" ||
                input.productReference !== request.productReference ||
                !equal(input.request, request) ||
                input.purposeCode !== "CATALOG_PRODUCT_OPTION_PRICE_CONTEXT_READ" ||
                input.permission !== "catalog.manage" ||
                input.owningAction !== "catalog.product.read" ||
                !equal(input.requiredFields, productOptionPriceContextSourceFields) ||
                observed < origin ||
                observed > check() ||
                sourceUntil > originalUntil ||
                sourceUntil <= observed
              )
                return fail();
              await hold();
              if (sourceUntil < deadline) deadline = sourceUntil;
              check();
              return Object.freeze({ validUntil: deadline });
            },
          },
        });
        productSourceFinal = productSource.assertFinalized.bind(productSource);
        const frozen = createPostgresFrozenFullOptionSetContentStore({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: check },
          transactions: { run: (callback) => callback(tx) },
          authority: {
            async holdUntilTransactionCompletes(candidate, input) {
              const observed = parseCatalogInstant(input.observedAt);
              const binding = snapshot?.binding;
              if (
                candidate !== tx ||
                !binding ||
                input.tenantReference !== tenant ||
                input.brandReference !== brand ||
                input.actorReference !== actor ||
                input.actorKind !== "User" ||
                input.permission !== "catalog.manage" ||
                input.action !== "catalog.option_set.read" ||
                input.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
                input.optionSetReference !== binding.optionSetReference ||
                input.versionReference !== binding.optionSetVersionReference ||
                !equal(input.requiredFields, frozenFullOptionSetContentFields) ||
                observed < origin ||
                observed > check()
              )
                return fail();
              await hold();
              return Object.freeze({ observedAt: check(), validUntil: deadline });
            },
          },
        });
        const readProduct = async (baseline?: ProductSnapshot) =>
          productSource.withCurrentSnapshot(request, async (packet, candidate) => {
            if (candidate !== tx) return fail();
            const parsed = parseProductOptionPriceContextSnapshot(packet);
            if (
              parsed.tenantReference !== tenant ||
              parsed.brandReference !== brand ||
              parsed.actorReference !== actor ||
              parsed.productReference !== request.productReference ||
              parsed.aggregateVersion !== request.expectedAggregateVersion ||
              parsed.binding.bindingReference !== request.bindingReference
            )
              return fail();
            if (
              baseline &&
              !equal(
                { ...parsed, observedAt: null, validUntil: null, productSnapshotDigest: null },
                { ...baseline, observedAt: null, validUntil: null, productSnapshotDigest: null },
              )
            )
              return fail("OPTION_PRICE_VERSION_CONFLICT");
            const until = parseCatalogInstant(parsed.validUntil);
            if (until < deadline) deadline = until;
            check();
            return parsed;
          });
        const readFrozen = async () => {
          const binding = snapshot?.binding;
          if (!binding) return fail();
          const observation = await frozen.readPinned({
              optionSetReference: binding.optionSetReference,
              versionReference: binding.optionSetVersionReference,
              expectedRecordDigest: pinned ?? null,
            }),
            content = parseCatalogFullOptionSetPublicationContent(observation.content);
          if (
            observation.eligibility !== "NotEvaluated" ||
            content.supportedContent.tenantReference !== tenant ||
            content.supportedContent.brandReference !== brand ||
            content.supportedContent.optionSetReference !== binding.optionSetReference ||
            content.supportedContent.versionReference !== binding.optionSetVersionReference ||
            (pinned && pinned !== content.digest)
          )
            return fail();
          tighten(observation.observedAt, observation.validUntil);
          return content;
        };
        if (
          (await register(
            tx,
            async () => {
              try {
                if (active || !complete || guarded) return fail();
                await hold();
                await readProduct(snapshot);
                if (pinned) await readFrozen();
                await hold();
                guarded = true;
              } catch (error) {
                return reject(error);
              }
            },
            () => {
              try {
                if (active || !complete || !guarded || finalized) return fail();
                check();
                finalized = true;
              } catch (error) {
                return reject(error);
              }
            },
          )) !== undefined
        )
          return fail();
        await hold();
        const snapshot = await readProduct();
        const binding = snapshot.binding,
          rule = snapshot.optionRule;
        if (!binding || !rule) return fail("OPTION_PRICE_VERSION_CONFLICT");
        let content: OptionContent,
          sourceDigest: string,
          authority: MerchantOptionPriceContext["optionSourceAuthority"];
        if (rule.versionResolution === "Pinned") {
          const original = await readFrozen();
          pinned = original.digest;
          content = original.editorContent;
          sourceDigest = original.digest;
          authority = "RecordedFrozen";
        } else {
          if (reviewWriteFamily !== undefined) {
            // The actual Catalog snapshot barrier is already held. Acquire the
            // owning Publishing writer lock before any graph SHARE acquisition;
            // the original transaction retains it through its real COMMIT.
            const borrowed = Object.freeze({
              async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
                const at = check(),
                  remaining = Math.floor(Date.parse(deadline) - Date.parse(at));
                if (remaining < 1) return fail();
                await tx.query(
                  "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
                  [String(remaining)],
                );
                check();
                const result = await tx.query<Row>(sql, values);
                check();
                return result;
              },
            });
            const publishing = createPostgresPublishingMutationStore(
              { run: (work) => work(borrowed) },
              tenant,
              createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
            );
            let admissionCalls = 0;
            const admitted = await publishing.withOptionPriceReview(
              { familyReference: reviewWriteFamily, mode: "Write" },
              async () => {
                if (++admissionCalls !== 1) return fail();
                check();
              },
            );
            if (admissionCalls !== 1 || admitted !== undefined) return fail();
            check();
          }
          const graph = createCurrentPublishedOptionSetGraphSource({
            ...options,
            capabilityPermissionAction: "pricing.price-book.manage",
            clock: { now: check },
            originalValidUntil: deadline,
          });
          publishedGraph = graph;
          let calls = 0;
          const held = await graph.withCurrentGraph(
            {
              optionSetReference: binding.optionSetReference,
              versionReference: binding.optionSetVersionReference,
            },
            async (packet) => {
              if (
                ++calls !== 1 ||
                packet.sourceAuthority !== "CurrentPublishingReleaseAndFrozenContent" ||
                packet.graph.brandReference !== brand ||
                packet.graph.rootOptionSetReference !== binding.optionSetReference ||
                packet.graph.rootVersionReference !== binding.optionSetVersionReference ||
                packet.referenceEligibility !== "NotEvaluated" ||
                packet.publishValidation !== "Incomplete" ||
                packet.eligibility !== "NotEvaluated"
              )
                return fail();
              tighten(packet.observedAt, packet.validUntil);
              return packet;
            },
          );
          const root = held.graph.contents.find(
            (item) =>
              item.sourceAggregate.optionSetReference === binding.optionSetReference &&
              item.sourceAggregate.draft.versionReference === binding.optionSetVersionReference,
          );
          if (calls !== 1 || !root) return fail();
          content = root;
          sourceDigest = held.graphDigest;
          authority = "CurrentPublishingReleaseAndFrozenContent";
        }
        const choices = content.sourceAggregate.draft.options.filter((item) =>
          binding.enabledOptionReferences.includes(item.optionReference),
        );
        if (
          choices.length !== binding.enabledOptionReferences.length ||
          (choice !== null && !choices.some((item) => item.optionReference === choice))
        )
          return fail("OPTION_PRICE_VERSION_CONFLICT");
        const context: MerchantOptionPriceContext = Object.freeze({
          profile: "MerchantOptionPriceContextV1",
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          actorReference: actor,
          productReference: snapshot.productReference,
          productAggregateVersion: snapshot.aggregateVersion,
          productVersionReference: snapshot.productVersionReference,
          productSnapshotDigest: snapshot.productSnapshotDigest,
          binding,
          versionResolution: rule.versionResolution,
          optionReference: choice,
          optionSetReference: binding.optionSetReference,
          optionSetVersionReference: binding.optionSetVersionReference,
          optionSourceDigest: sourceDigest,
          optionSourceAuthority: authority,
          defaultLocale: content.sourceAggregate.draft.defaultLocale,
          localizedNames: content.sourceAggregate.draft.localizedNames,
          choices: Object.freeze(
            choices.map((item) =>
              Object.freeze({
                optionReference: item.optionReference,
                stableCode: item.stableCode,
                lifecycle: item.lifecycle,
                localizedNames: item.localizedNames,
              }),
            ),
          ),
          skus: Object.freeze(
            snapshot.skus.map((item) =>
              Object.freeze({
                skuReference: item.skuReference,
                skuCode: item.skuCode,
                lifecycle: item.lifecycle,
                localizedNames: item.localizedNames,
              }),
            ),
          ),
          currencyMetadata: currency,
          referenceEligibility: "NotEvaluated",
          publishValidation: "Incomplete",
          observedAt: check(),
          validUntil: deadline,
        });
        const result = await work(context);
        await hold();
        await readProduct(snapshot);
        if (pinned) await readFrozen();
        check();
        active = false;
        complete = true;
        return result;
      } catch (error) {
        return reject(error);
      }
    },
    assertFinalized(actual: Transaction): string {
      try {
        if (actual !== tx || !finalized || !complete || active) return fail();
        if (!productSourceFinal) return fail();
        const productUntil = parseCatalogInstant(productSourceFinal(actual));
        if (productUntil < deadline) deadline = productUntil;
        if (publishedGraph) {
          const until = parseCatalogInstant(publishedGraph.assertFinalized());
          if (until < deadline) deadline = until;
        }
        check();
        return deadline;
      } catch (error) {
        return reject(error);
      }
    },
  });
}
