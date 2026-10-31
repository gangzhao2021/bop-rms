import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createMediaScope,
  createPostgresMediaEditorReadSource,
  mediaEditorReadFields,
  parseMediaEditorReadRequest,
  parseMediaEditorReadSnapshot,
} from "@bop/media";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductEditorAllergenRegistrySource,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
  productEditorAllergenRegistryFields,
} from "@rms/catalog";
import {
  remainingProductEditorVariantReferenceChecks,
  type MerchantProductEditorVariantRemainingAuthority,
} from "./merchant-product-editor-variant-content-authority.js";

type MediaOptions = Parameters<typeof createPostgresMediaEditorReadSource>[0];
type SafetyOptions = Parameters<typeof createPostgresProductEditorAllergenRegistrySource>[0];
type Input = Parameters<MerchantProductEditorVariantRemainingAuthority>[1];
type Tx = Parameters<MerchantProductEditorVariantRemainingAuthority>[0];
export const remainingProductEditorMediaSafetyChecks = Object.freeze(
  remainingProductEditorVariantReferenceChecks.filter(
    (check) => check !== "Media" && check !== "SafetyVocabulary",
  ),
);
export type MerchantProductEditorMediaSafetyRemainingAuthority = (
  tx: Tx,
  input: Omit<Input, "requiredReferenceChecks"> & {
    readonly requiredReferenceChecks: typeof remainingProductEditorMediaSafetyChecks;
  },
) => Promise<void>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** Recorded editor references only. Unready Media may remain in a Draft; this
 * holder never grants publication readiness, Contains/free-from or Nutrition.
 * Caller/source authorities independently retain actual Session/fine permission. */
export function createMerchantProductEditorMediaSafetyAuthority(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly allergenRegistryVersionReference: string | null;
  readonly mediaAuthority: MediaOptions["authority"];
  readonly safetyAuthority: SafetyOptions["authority"];
  readonly remainingAuthority: MerchantProductEditorMediaSafetyRemainingAuthority;
  readonly registerBeforeCommit: MediaOptions["registerBeforeCommit"];
  readonly clock: { now(): string };
}): MerchantProductEditorVariantRemainingAuthority {
  if (
    typeof options.mediaAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.safetyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.remainingAuthority !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.clock?.now !== "function"
  )
    return fail();
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    registry =
      options.allergenRegistryVersionReference === null
        ? null
        : parseCatalogReference(options.allergenRegistryVersionReference),
    mediaHold = options.mediaAuthority.holdUntilTransactionCompletes.bind(options.mediaAuthority),
    safetyHold = options.safetyAuthority.holdUntilTransactionCompletes.bind(
      options.safetyAuthority,
    ),
    remaining = options.remainingAuthority,
    register = options.registerBeforeCommit.bind(options),
    now = options.clock.now.bind(options.clock);
  interface State {
    readonly query: Tx["query"];
    failed: boolean;
    active: boolean;
    ready: boolean;
    finalized: boolean;
    guardRan: boolean;
    latest: string;
    deadline: string;
    tuple?: string;
    write?: string;
  }
  const states = new WeakMap<object, State>();
  return async (tx, value) => {
    if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
    let captured: unknown,
      captureFailed = false;
    try {
      captured = copyCategoryPersistenceValue(value);
    } catch {
      captureFailed = true;
    }
    let state = states.get(tx);
    if (!state) {
      state = {
        query: tx.query,
        failed: false,
        active: false,
        ready: false,
        finalized: false,
        guardRan: false,
        latest: parseCatalogInstant(now()),
        deadline: "",
      };
      states.set(tx, state);
      // Install the poison guard before exposing malformed input to a caller.
      try {
        state.active = true;
        if (
          (await register(
            tx,
            async () => {
              check();
              if (!state || state.active || !state.ready || state.guardRan) return poison();
              state.guardRan = true;
            },
            () => {
              check();
              if (!state || !state.ready || state.active || !state.guardRan || state.finalized)
                return poison();
              state.finalized = true;
            },
          )) !== undefined
        )
          return poison();
        state.active = false;
      } catch {
        return poison();
      }
    }
    function poison(): never {
      if (state) state.failed = true;
      return fail();
    }
    function check(allowFinal = false) {
      try {
        const at = parseCatalogInstant(now());
        if (
          !state ||
          state.failed ||
          (state.finalized && !allowFinal) ||
          tx.query !== state.query ||
          at < state.latest ||
          (state.deadline && at >= state.deadline)
        )
          return poison();
        state.latest = at;
        return at;
      } catch {
        return poison();
      }
    }
    try {
      const heldState = state;
      check();
      if (state.active) return poison();
      state.active = true;
      if (captureFailed) return poison();
      const raw = readClosedRecord(captured, [
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
          "observedAt",
          "validUntil",
          "mode",
          "aggregate",
          "requiredFields",
          "requiredReferenceChecks",
        ]),
        aggregate = parseProductAggregate(raw.aggregate),
        observedAt = parseCatalogInstant(raw.observedAt),
        validUntil = parseCatalogInstant(raw.validUntil);
      if (
        raw.tenantReference !== tenantReference ||
        raw.brandReference !== brandReference ||
        raw.actorReference !== actorReference ||
        raw.permission !== "catalog.manage" ||
        raw.owningAction !== "catalog.product.manage" ||
        (raw.purposeCode !== "CATALOG_PRODUCT_CREATE" &&
          raw.purposeCode !== "CATALOG_PRODUCT_DRAFT_REPLACE") ||
        (raw.mode !== "Read" && raw.mode !== "DraftWrite") ||
        Date.parse(validUntil) - Date.parse(observedAt) !== 5000 ||
        !equal(raw.requiredFields, productEditorContentFields) ||
        !equal(
          raw.requiredReferenceChecks,
          raw.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
        ) ||
        aggregate.brandReference !== brandReference ||
        aggregate.productReference !== raw.productReference ||
        aggregate.draft.editorContent === undefined ||
        (raw.purposeCode === "CATALOG_PRODUCT_CREATE" &&
          (raw.mode !== "DraftWrite" ||
            aggregate.aggregateVersion !== 1 ||
            aggregate.lifecycle !== "Draft" ||
            aggregate.createdByActorReference !== actorReference))
      )
        return poison();
      const content = aggregate.draft.editorContent;
      const tuple = {
          tenantReference,
          brandReference,
          actorReference,
          storeReference: parseCatalogReference(raw.storeReference),
          sessionReference: parseCatalogReference(raw.sessionReference),
          productReference: parseCatalogReference(raw.productReference),
          operationReference: parseCatalogReference(raw.operationReference),
          permission: "catalog.manage" as const,
          owningAction: "catalog.product.manage" as const,
          purposeCode: raw.purposeCode as
            "CATALOG_PRODUCT_CREATE" | "CATALOG_PRODUCT_DRAFT_REPLACE",
          observedAt,
          validUntil,
        },
        tupleKey = canonicalizeRfc8785(tuple),
        input = Object.freeze({
          ...tuple,
          mode: raw.mode,
          aggregate,
          requiredFields: productEditorContentFields,
          requiredReferenceChecks:
            raw.mode === "Read" ? Object.freeze([]) : remainingProductEditorMediaSafetyChecks,
        });
      if ((state.tuple && state.tuple !== tupleKey) || observedAt > check()) return poison();
      state.tuple = tupleKey;
      state.deadline = state.deadline && state.deadline < validUntil ? state.deadline : validUntil;
      check();
      const holdRemaining = async () => {
        check();
        if ((await remaining(tx, input)) !== undefined) return poison();
        check();
      };
      if (raw.mode === "Read") {
        await holdRemaining();
        state.ready = true;
        return;
      }
      const fingerprint = canonicalizeRfc8785({ ...tuple, aggregate });
      if (state.write) {
        if (state.write !== fingerprint) return poison();
        await holdRemaining();
        return;
      }
      state.write = fingerprint;
      const sourceAt = check(),
        identity = deriveCatalogProductPublicationContentIdentity(aggregate),
        originalIntentDigest = hash({ ...tuple, aggregate }),
        intentKind =
          raw.purposeCode === "CATALOG_PRODUCT_CREATE"
            ? ("EditorCreate" as const)
            : ("DraftReplace" as const),
        request = parseMediaEditorReadRequest({
          profile: "MediaEditorReadRequestV1",
          intentKind,
          tenantReference,
          scope: createMediaScope({
            kind: "Brand",
            brandReference: String(brandReference),
            storeReference: null,
          } as Parameters<typeof createMediaScope>[0]),
          actorReference,
          actorKind: "User",
          operationReference: tuple.operationReference,
          originalIntentDigest,
          productReference: tuple.productReference,
          versionReference: aggregate.draft.versionReference,
          expectedAggregateVersion:
            intentKind === "EditorCreate" ? 0 : aggregate.aggregateVersion - 1,
          aggregateSnapshotDigest: hash(aggregate),
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          references: content.media.map(
            ({
              mediaReference,
              assetReference,
              assetVersionReference,
              cropReference,
              focusReference,
            }) => ({
              mediaReference,
              assetReference,
              assetVersionReference,
              cropReference,
              focusReference,
            }),
          ),
          observedAt: sourceAt,
          validUntil,
        }),
        media = createPostgresMediaEditorReadSource({
          tenantReference,
          scope: request.scope,
          actorReference,
          actorKind: "User",
          clock: { now: () => check(true) },
          registerBeforeCommit: register,
          authority: {
            async holdUntilTransactionCompletes(actual, value) {
              check();
              const held = readClosedRecord(copyCategoryPersistenceValue(value), [
                "request",
                "action",
                "purposeCode",
                "requiredFields",
              ]);
              if (
                actual !== tx ||
                held.action !== "media.asset.access" ||
                held.purposeCode !== "CATALOG_PRODUCT_EDITOR_MEDIA_READ" ||
                !equal(held.requiredFields, mediaEditorReadFields) ||
                !equal(parseMediaEditorReadRequest(held.request), request)
              )
                return poison();
              const lease = readClosedRecord(
                  copyCategoryPersistenceValue(await mediaHold(actual, value)),
                  ["observedAt", "validUntil"],
                ),
                end = parseCatalogInstant(lease.validUntil);
              if (
                lease.observedAt !== request.observedAt ||
                end > heldState.deadline ||
                end <= check()
              )
                return poison();
              heldState.deadline = end;
              check();
              return { observedAt: request.observedAt, validUntil: end };
            },
          },
        });
      let mediaCalls = 0,
        safetyCalls = 0;
      let knownFailure: CatalogError | undefined;
      const answer = await media.withCurrentReferences(tx, request, async (value, actual) => {
        if (++mediaCalls !== 1 || actual !== tx) return poison();
        const snapshot = parseMediaEditorReadSnapshot(value);
        if (
          !equal(snapshot.request, request) ||
          snapshot.observedAt < sourceAt ||
          snapshot.observedAt > check() ||
          snapshot.validUntil > heldState.deadline
        )
          return poison();
        heldState.deadline = snapshot.validUntil;
        check();
        try {
          if (content.allergenReferences.length === 0) {
            await holdRemaining();
            return;
          }
          if (!registry) return poison();
          const safetyRequest = {
              profile: "CatalogProductEditorAllergenRegistryRequestV1" as const,
              intentKind,
              tenantReference,
              brandReference,
              actorReference,
              operationReference: tuple.operationReference,
              aggregate,
              registryVersionReference: registry,
              originalIntentDigest,
              observedAt: sourceAt,
              validUntil: heldState.deadline,
            },
            safety = createPostgresProductEditorAllergenRegistrySource({
              tenantReference,
              brandReference,
              actorReference,
              clock: { now: () => check(true) },
              registerBeforeCommit: register,
              authority: {
                async holdUntilTransactionCompletes(actual, value) {
                  check();
                  const held = readClosedRecord(copyCategoryPersistenceValue(value), [
                    "request",
                    "actorKind",
                    "purposeCode",
                    "permission",
                    "owningAction",
                    "requiredFields",
                  ]);
                  if (
                    actual !== tx ||
                    held.actorKind !== "User" ||
                    held.purposeCode !== "CATALOG_PRODUCT_EDITOR_ALLERGEN_REGISTRY_READ" ||
                    held.permission !== "catalog.manage" ||
                    held.owningAction !== "catalog.product.manage" ||
                    !equal(held.requiredFields, productEditorAllergenRegistryFields) ||
                    !equal(held.request, safetyRequest)
                  )
                    return poison();
                  if ((await safetyHold(actual, value)) !== undefined) return poison();
                  check();
                },
              },
            });
          if (
            (await safety.withCurrentRegistry(tx, safetyRequest, async (snapshot) => {
              if (
                ++safetyCalls !== 1 ||
                snapshot.profile !== "CatalogProductEditorAllergenRegistrySnapshotV1" ||
                !equal(snapshot.request, safetyRequest) ||
                snapshot.registryVersionReference !== registry ||
                snapshot.vocabularyIntegrity !== "Registered" ||
                snapshot.eligibility !== "NotEvaluated" ||
                snapshot.observedAt !== sourceAt ||
                snapshot.validUntil !== safetyRequest.validUntil
              )
                return poison();
              const { digest, ...body } = snapshot;
              if (digest !== hash(body)) return poison();
              await holdRemaining();
            })) !== undefined ||
            safetyCalls !== 1
          )
            return poison();
        } catch (error) {
          // Only a known business conflict/denial is deferred until Media's
          // original final authority checks. Malformed sources still refuse.
          if (
            !(error instanceof CatalogError) ||
            (error.code !== "CATALOG_LIFECYCLE_CONFLICT" &&
              error.code !== "CATALOG_PERMISSION_DENIED")
          )
            throw error;
          knownFailure = error;
        }
      });
      if (answer !== undefined || mediaCalls !== 1) return poison();
      check();
      if (knownFailure) throw knownFailure;
      state.ready = true;
    } catch (error) {
      state.failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      state.active = false;
    }
  };
}
