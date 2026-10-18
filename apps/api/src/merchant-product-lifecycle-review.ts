import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductLifecycleReviewRequest,
  validateProductLifecycleReviewEvidence,
  type ProductLifecycleReviewRequest,
  type ProductLifecycleReviewEvidence,
} from "@rms/catalog";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { createMerchantBrandScope } from "./merchant-brand-scope.js";
type Tx = Parameters<
  ReturnType<typeof createMerchantCategoryTransactions>["registerBeforeCommit"]
>[0];
type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantBrandScope>>>;
export const lifecycleReviewFields = Object.freeze([
  "reviewReference",
  "request",
  "policyReference",
  "policyVersion",
  "decision",
  "checkedAt",
  "validUntil",
  "sources",
] as const);
export type MerchantProductLifecycleReview = (
  tx: Tx,
  input: {
    readonly tenantReference: string;
    readonly storeReference: string;
    readonly sessionReference: string;
    readonly mode: "Apply" | "Replay";
    readonly request: ProductLifecycleReviewRequest;
    readonly actionPermission: string;
    readonly requiredReadFields: typeof lifecycleReviewFields;
    readonly observedAt: string;
  },
) => Promise<ProductLifecycleReviewEvidence>;
/** Provider holds current public owner sources/policy, not a supplied approval or empty lookup. */
export function createMerchantProductLifecycleReviewLease(options: {
  readonly transaction: Tx;
  readonly scope: Scope;
  readonly sessionReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly mode: "Apply" | "Replay";
  readonly actionPermission: string;
  readonly review: MerchantProductLifecycleReview | undefined;
  readonly now: () => string;
  readonly registerBeforeCommit: ReturnType<
    typeof createMerchantCategoryTransactions
  >["registerBeforeCommit"];
}) {
  const unavailable = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (typeof options.review !== "function") return unavailable();
  const review = options.review,
    request = parseProductLifecycleReviewRequest(options.request);
  let parent;
  try {
    if (
      request.brandReference !==
        parseCatalogReference(options.scope.context.brand.brandReference) ||
      request.actorReference !== parseCatalogReference(options.scope.actorReference) ||
      (options.mode !== "Apply" && options.mode !== "Replay")
    )
      return unavailable();
    const action = (
      {
        Suspended: "suspend",
        Discontinued: "discontinue",
        Archived: "archive",
        Draft: "restore",
      } as const
    )[request.targetLifecycle as "Suspended" | "Discontinued" | "Archived" | "Draft"];
    if (
      options.actionPermission !==
      `${request.skuReference === null ? "catalog.product" : "catalog.sku"}.${action}`
    )
      return unavailable();
    parent = Object.freeze({
      tenantReference: parseCatalogReference(options.scope.tenantReference),
      storeReference: parseCatalogReference(options.scope.selectedStoreReference),
      sessionReference: parseCatalogReference(options.sessionReference),
      mode: options.mode,
      request,
      actionPermission: options.actionPermission,
      requiredReadFields: lifecycleReviewFields,
    });
  } catch {
    return unavailable();
  }
  let pinned: ProductLifecycleReviewEvidence | null = null,
    registered = false,
    failed = false;
  const hold = async () => {
    if (failed) return unavailable();
    try {
      const observedAt = parseCatalogInstant(options.now()),
        evidence = validateProductLifecycleReviewEvidence(
          await review(options.transaction, Object.freeze({ ...parent, observedAt })),
          request,
          observedAt,
        );
      if (pinned !== null && canonicalizeRfc8785(pinned) !== canonicalizeRfc8785(evidence))
        throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      pinned = evidence;
      return evidence;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return unavailable();
    }
  };
  return Object.freeze({
    hold,
    async holdAndRegister() {
      if (registered) {
        failed = true;
        return unavailable();
      }
      await hold();
      registered = true;
      await options.registerBeforeCommit(options.transaction, async () => {
        await hold();
      });
    },
    async withCurrentReview<T>(
      value: ProductLifecycleReviewRequest,
      mutate: (evidence: ProductLifecycleReviewEvidence) => Promise<T>,
    ) {
      if (!registered || failed) return unavailable();
      if (
        canonicalizeRfc8785(parseProductLifecycleReviewRequest(value)) !==
        canonicalizeRfc8785(request)
      ) {
        failed = true;
        return unavailable();
      }
      const evidence = await hold();
      return mutate(evidence);
    },
  });
}
