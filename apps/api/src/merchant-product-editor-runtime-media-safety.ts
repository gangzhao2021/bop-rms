import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { mediaEditorReadFields, parseMediaEditorReadRequest } from "@bop/media";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductEditorAllergenRegistryRequest,
  productEditorAllergenRegistryFields,
} from "@rms/catalog";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import {
  createMerchantProductEditorMediaSafetyAuthority,
  type MerchantProductEditorMediaSafetyRemainingAuthority,
} from "./merchant-product-editor-media-safety-authority.js";

type Options = Parameters<typeof createMerchantProductEditorMediaSafetyAuthority>[0];
type Transaction = Parameters<Options["registerBeforeCommit"]>[0];
export interface MerchantProductEditorRuntimeMediaSafetyHost {
  readonly transaction: Transaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly action: "Create" | "ReplaceDraft";
  readonly expectedAggregateVersion: number | null;
  readonly originalValidUntil: string;
  readonly currentAuthorization: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  readonly registerBeforeCommit: Options["registerBeforeCommit"];
  readonly clock: Options["clock"];
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Compose the actual owning readers with the command's real Session/IAM holder.
 * The server selects an existing vocabulary version; it supplies no dictionary,
 * media readiness, Nutrition facts or field-policy approval. */
export function createMerchantProductEditorRuntimeMediaSafetyAuthority(
  host: MerchantProductEditorRuntimeMediaSafetyHost,
  options: {
    readonly allergenRegistryVersionReference: string | null;
    readonly remainingAuthority: MerchantProductEditorMediaSafetyRemainingAuthority;
  },
) {
  if (
    typeof host.transaction?.query !== "function" ||
    typeof host.clock?.now !== "function" ||
    typeof host.currentAuthorization?.authorizeActions !== "function" ||
    typeof host.currentAuthorization?.assertCurrent !== "function" ||
    typeof host.registerBeforeCommit !== "function" ||
    typeof options?.remainingAuthority !== "function"
  )
    return unavailable();
  const tx = host.transaction,
    query = tx.query,
    now = host.clock.now.bind(host.clock),
    authorize = host.currentAuthorization.authorizeActions.bind(host.currentAuthorization),
    assertCurrent = host.currentAuthorization.assertCurrent.bind(host.currentAuthorization),
    register = host.registerBeforeCommit.bind(host),
    remaining = options.remainingAuthority,
    identity = Object.freeze({
      tenantReference: parseCatalogReference(host.tenantReference),
      brandReference: parseCatalogReference(host.brandReference),
      storeReference: parseCatalogReference(host.storeReference),
      actorReference: parseCatalogReference(host.actorReference),
      sessionReference: parseCatalogReference(host.sessionReference),
      productReference: parseCatalogReference(host.productReference),
      operationReference: parseCatalogReference(host.operationReference),
    }),
    action = host.action,
    expected = host.expectedAggregateVersion,
    registry =
      options.allergenRegistryVersionReference === null
        ? null
        : parseCatalogReference(options.allergenRegistryVersionReference),
    originalUntil = parseCatalogInstant(host.originalValidUntil);
  let latest = parseCatalogInstant(now()),
    failed = false,
    active = false,
    authorizing = false,
    registered = false,
    ready = false,
    guardRan = false,
    finalized = false,
    mediaFingerprint: string | undefined,
    safetyFingerprint: string | undefined;
  const actions = new Set<string>();
  if (
    (action === "Create"
      ? expected !== null
      : action !== "ReplaceDraft" ||
        !Number.isSafeInteger(expected) ||
        (expected as number) < 1 ||
        (expected as number) >= 2147483647) ||
    originalUntil <= latest ||
    Date.parse(originalUntil) - Date.parse(latest) > 5000
  )
    return unavailable();
  function fail(error?: unknown): never {
    failed = true;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
    return unavailable();
  }
  function check() {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || at < latest || at >= originalUntil) return fail();
      assertCurrent();
      latest = at;
      return at;
    } catch (error) {
      return fail(error);
    }
  }
  async function hold(selected: readonly string[]) {
    check();
    if (authorizing || finalized) return fail();
    authorizing = true;
    try {
      selected.forEach((value) => actions.add(value));
      // Each port obtains fresh decisions for its own required actions. The
      // accumulated union is passed explicitly by the final COMMIT guard.
      if ((await authorize(Object.freeze([...new Set(selected)].sort()))) !== undefined)
        return fail();
      check();
    } catch (error) {
      return fail(error);
    } finally {
      authorizing = false;
    }
  }
  function sourceIdentity(request: {
    tenantReference: string;
    actorReference: string;
    operationReference: string;
    intentKind: string;
    observedAt: string;
    validUntil: string;
  }) {
    if (
      request.tenantReference !== identity.tenantReference ||
      request.actorReference !== identity.actorReference ||
      request.operationReference !== identity.operationReference ||
      request.intentKind !== (action === "Create" ? "EditorCreate" : "DraftReplace") ||
      request.observedAt > check() ||
      request.validUntil <= check()
    )
      return fail();
  }
  const source = createMerchantProductEditorMediaSafetyAuthority({
    ...identity,
    allergenRegistryVersionReference: registry,
    registerBeforeCommit: register,
    clock: { now },
    remainingAuthority: remaining,
    mediaAuthority: {
      async holdUntilTransactionCompletes(actual, value) {
        try {
          const input = readClosedRecord(copyCategoryPersistenceValue(value), [
              "request",
              "action",
              "purposeCode",
              "requiredFields",
            ]),
            request = parseMediaEditorReadRequest(input.request);
          sourceIdentity(request);
          if (
            actual !== tx ||
            input.action !== "media.asset.access" ||
            input.purposeCode !== "CATALOG_PRODUCT_EDITOR_MEDIA_READ" ||
            !equal(input.requiredFields, mediaEditorReadFields) ||
            request.actorKind !== "User" ||
            request.scope.kind !== "Brand" ||
            String(request.scope.brandReference) !== identity.brandReference ||
            request.productReference !== identity.productReference ||
            request.expectedAggregateVersion !== (action === "Create" ? 0 : expected)
          )
            return fail();
          const fingerprint = canonicalizeRfc8785(request);
          if (mediaFingerprint !== undefined && mediaFingerprint !== fingerprint) return fail();
          mediaFingerprint = fingerprint;
          await hold(["catalog.manage", "catalog.product.manage", "media.asset.access"]);
          return {
            observedAt: request.observedAt,
            validUntil: request.validUntil < originalUntil ? request.validUntil : originalUntil,
          };
        } catch (error) {
          return fail(error);
        }
      },
    },
    safetyAuthority: {
      async holdUntilTransactionCompletes(actual, value) {
        try {
          const input = readClosedRecord(copyCategoryPersistenceValue(value), [
              "request",
              "actorKind",
              "purposeCode",
              "permission",
              "owningAction",
              "requiredFields",
            ]),
            request = parseProductEditorAllergenRegistryRequest(input.request);
          sourceIdentity(request);
          if (
            actual !== tx ||
            input.actorKind !== "User" ||
            input.purposeCode !== "CATALOG_PRODUCT_EDITOR_ALLERGEN_REGISTRY_READ" ||
            input.permission !== "catalog.manage" ||
            input.owningAction !== "catalog.product.manage" ||
            !equal(input.requiredFields, productEditorAllergenRegistryFields) ||
            request.brandReference !== identity.brandReference ||
            request.registryVersionReference !== registry ||
            request.aggregate.productReference !== identity.productReference ||
            request.aggregate.aggregateVersion !==
              (action === "Create" ? 1 : (expected as number) + 1)
          )
            return fail();
          const fingerprint = canonicalizeRfc8785(request);
          if (safetyFingerprint !== undefined && safetyFingerprint !== fingerprint) return fail();
          safetyFingerprint = fingerprint;
          await hold(["catalog.manage", "catalog.product.manage"]);
        } catch (error) {
          return fail(error);
        }
      },
    },
  });
  return async (actual: Parameters<typeof source>[0], value: Parameters<typeof source>[1]) => {
    try {
      check();
      if (actual !== tx || active || finalized) return fail();
      active = true;
      // The owning composition below validates the full closed field packet.
      // Capture it before registration or authorization can yield.
      const input = copyCategoryPersistenceValue(value) as typeof value;
      for (const [key, expectedValue] of Object.entries(identity))
        if (input[key as keyof typeof input] !== expectedValue) return fail();
      if (
        input.purposeCode !==
        (action === "Create" ? "CATALOG_PRODUCT_CREATE" : "CATALOG_PRODUCT_DRAFT_REPLACE")
      )
        return fail();
      // Editor packets have their own original five-second lease, captured after
      // request admission. Keep that identity intact and independently enforce
      // the earlier host deadline; the Media hold below clamps source metadata.
      if (
        parseCatalogInstant(input.observedAt) > check() ||
        parseCatalogInstant(input.validUntil) <= check()
      )
        return fail();
      if (!registered) {
        registered = true;
        if (
          (await register(
            tx,
            async () => {
              check();
              if (!ready || active || guardRan || finalized) return fail();
              guardRan = true;
              await hold(
                actions.size ? [...actions] : ["catalog.manage", "catalog.product.manage"],
              );
            },
            () => {
              check();
              if (!ready || active || !guardRan || finalized) return fail();
              finalized = true;
            },
          )) !== undefined
        )
          return fail();
      }
      check();
      await source(tx, input);
      check();
      ready = true;
    } catch (error) {
      return fail(error);
    } finally {
      active = false;
    }
  };
}
