import { CatalogError, parseProductLifecycle, transitionCatalogLifecycle } from "@rms/catalog";
export type CatalogLifecycleAction =
  "activate" | "suspend" | "resume" | "discontinue" | "archive" | "restore";
/** State is read from the original owning expected-version receipt, not current
 * post-operation state or caller assertions. Product publishing is a separate workflow. */
export function resolveMerchantProductLifecycleIntent(
  kind: "Product" | "Sku",
  before: unknown,
  target: unknown,
) {
  if (kind !== "Product" && kind !== "Sku") throw new CatalogError("CATALOG_INPUT_INVALID");
  const beforeLifecycle = parseProductLifecycle(before),
    targetLifecycle = parseProductLifecycle(target);
  transitionCatalogLifecycle(beforeLifecycle, targetLifecycle);
  let action: CatalogLifecycleAction;
  if (beforeLifecycle === "Draft" && targetLifecycle === "Active") {
    if (kind === "Product") throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    action = "activate";
  } else if (beforeLifecycle === "Active" && targetLifecycle === "Suspended") action = "suspend";
  else if (beforeLifecycle === "Suspended" && targetLifecycle === "Active") action = "resume";
  else if (
    (beforeLifecycle === "Active" || beforeLifecycle === "Suspended") &&
    targetLifecycle === "Discontinued"
  )
    action = "discontinue";
  else if (
    (beforeLifecycle === "Draft" || beforeLifecycle === "Discontinued") &&
    targetLifecycle === "Archived"
  )
    action = "archive";
  else if (beforeLifecycle === "Archived" && targetLifecycle === "Draft") action = "restore";
  else throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  const actionPermission =
    `${kind === "Product" ? "catalog.product" : "catalog.sku"}.${action}` as const;
  return Object.freeze({ kind, action, actionPermission, beforeLifecycle, targetLifecycle });
}
