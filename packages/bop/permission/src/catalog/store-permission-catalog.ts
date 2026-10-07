/**
 * DEC-PERM-CATALOG (WP-2423): the single versioned catalog of Brand/Store permission action codes.
 * Codes named in Handoff Section 88 are used verbatim; the rest follow its `module.resource.action`
 * convention. Database definitions, Store role templates and code checks all derive from this list.
 */
/**
 * Bump on any change to codes, risks, legacy replacements or role templates; the installed digest
 * covers all of them. v2 (2026-10-07): Store Manager may approve role changes (DEC-PERM-CATALOG A).
 * v3 (2026-10-07): Brand role templates for Brand-level master data (DEC-PERM-BRAND-ROLES).
 * v4 (2026-10-07): Menu review actions, legacy names still checked by Catalog/Pricing services, and
 * the Brand Menu Manager template (second person for menu and price approval).
 */
export const storePermissionCatalogVersion = 4 as const;
export type PermissionRisk = "Low" | "Medium" | "High";
export interface StorePermissionDefinition {
  readonly code: string;
  readonly module: string;
  readonly description: string;
  readonly risk: PermissionRisk;
  /** True when Section 88 names this code explicitly. */
  readonly specified: boolean;
}
const define = (
  module: string,
  entries: readonly (readonly [
    code: string,
    description: string,
    risk: PermissionRisk,
    specified?: boolean,
  ])[],
): StorePermissionDefinition[] =>
  entries.map(([code, description, risk, specified = false]) =>
    Object.freeze({ code, module, description, risk, specified }),
  );

const catalog: readonly StorePermissionDefinition[] = Object.freeze([
  ...define("merchant", [
    ["merchant.access", "Enter the Merchant workspace for an assigned Store", "Low"],
  ]),
  ...define("organization", [
    ["organization.store.read", "Read Store profile, hours and service configuration", "Low"],
    ["organization.store.update", "Edit Store profile, hours and service drafts", "Medium"],
    ["organization.store.publish", "Publish or schedule Store configuration", "High"],
    ["organization.staff.read", "Read Store staff and assignments", "Low"],
    ["organization.staff.manage", "Invite, assign, suspend and remove Store staff", "High"],
    ["organization.brand.manage", "Manage Brand-level configuration", "High"],
  ]),
  ...define("identity", [
    ["identity.role.read", "Read Store roles and their permissions", "Low"],
    ["identity.role.create", "Create or duplicate a Store role", "High"],
    ["identity.role.change", "Edit and submit a Store role draft", "High"],
    ["identity.role.approve", "Approve or reject a Store role change", "High"],
    ["identity.role.activate", "Activate an approved Store role version", "High"],
    ["identity.role.deactivate", "Deactivate a Store role", "High"],
  ]),
  ...define("feature", [
    ["feature.control.change", "Edit Store feature control drafts", "High"],
    ["feature.control.approve", "Approve feature control changes", "High"],
    ["feature.control.publish", "Publish feature control changes", "High"],
    ["feature.control.activate", "Activate a published feature control", "High"],
    ["feature.control.recover", "Recover a feature control after failure", "High"],
  ]),
  ...define("effective", [
    ["effective.period.schedule", "Schedule an effective period", "Medium"],
    ["effective.period.renew", "Renew an effective period", "Medium"],
  ]),
  ...define("catalog", [
    ...[
      "category.archive",
      "category.create",
      "category.export",
      "category.history.read",
      "category.import",
      "category.read",
      "category.reorder",
      "category.restore",
      "category.update",
      "option_set.archive",
      "option_set.create",
      "option_set.export",
      "option_set.history.read",
      "option_set.import",
      "option_set.read",
      "option_set.restore",
      "option_set.update",
      "product.approve",
      "product.archive",
      "product.availability.manage",
      "product.create",
      "product.discontinue",
      "product.export",
      "product.history.read",
      "product.identity.update",
      "product.import",
      "product.publish",
      "product.read",
      "product.restore",
      "product.resume",
      "product.submit",
      "product.suspend",
      "product.update",
      "product.validate",
      "sku.activate",
      "sku.archive",
      "sku.availability.manage",
      "sku.barcode.manage",
      "sku.create",
      "sku.discontinue",
      "sku.export",
      "sku.history.read",
      "sku.import",
      "sku.read",
      "sku.replace",
      "sku.restore",
      "sku.resume",
      "sku.suspend",
      "sku.update",
    ].map(
      (suffix) =>
        [
          "catalog." + suffix,
          "Catalog " + suffix.replaceAll(".", " ").replaceAll("_", " "),
          /approve|publish|archive|discontinue|import/u.test(suffix)
            ? "High"
            : /read|export/u.test(suffix)
              ? "Low"
              : "Medium",
          true,
        ] as const,
    ),
    ["catalog.option_set.submit", "Submit an Option Set for review", "Medium"],
    ["catalog.option_set.approve", "Approve an Option Set", "High"],
    ["catalog.option_set.publish", "Publish an Option Set release", "High"],
    ["catalog.menu.read", "Read Menu drafts and releases", "Low"],
    ["catalog.menu.update", "Edit Menu drafts", "Medium"],
    ["catalog.menu.publish", "Publish or schedule a Menu release", "High"],
    ["catalog.menu.submit", "Submit a Menu version for review", "Medium"],
    ["catalog.menu.approve", "Approve a submitted Menu version", "High"],
    ["catalog.menu.archive", "Archive a Menu release", "High"],
    ["catalog.content_registry.read", "Read registered product content", "Low"],
    ["catalog.content_registry.manage", "Register product content", "Medium"],
  ]),
  ...define("pricing", [
    ["pricing.price_book.read", "Read price books", "Low"],
    ["pricing.price_book.update", "Edit price book drafts", "Medium"],
    ["pricing.price_book.approve", "Approve price book changes", "High"],
    ["pricing.promotion.manage", "Manage promotions", "High"],
    ["pricing.tax_config.read", "Read tax configuration", "Low"],
    ["pricing.tax_config.manage", "Edit and submit tax configuration", "High"],
  ]),
  ...define("recipe", [
    ["recipe.read", "Read recipes and their ingredient requirements", "Low"],
    ["recipe.update", "Create and edit recipe drafts", "Medium"],
    ["recipe.approve", "Approve recipe versions (cost and food-safety review)", "High"],
    ["recipe.publish", "Publish recipe versions", "High"],
  ]),
  ...define("inventory", [
    ...[
      "adjustment.execute",
      "count.execute",
      "item.archive",
      "item.barcode.manage",
      "item.create",
      "item.deactivate",
      "item.export",
      "item.history.read",
      "item.import",
      "item.read",
      "item.reorder.manage",
      "item.restore",
      "item.tracking.manage",
      "item.unit.manage",
      "item.update",
      "movement.read",
      "transfer.execute",
      "waste.record",
    ].map(
      (suffix) =>
        [
          "inventory." + suffix,
          "Inventory " + suffix.replaceAll(".", " "),
          /archive|import|tracking|unit|adjustment/u.test(suffix)
            ? "High"
            : /read|export/u.test(suffix)
              ? "Low"
              : "Medium",
          true,
        ] as const,
    ),
    ["inventory.item.activate", "Activate an Inventory Item", "Medium"],
    ["inventory.location.read", "Read Stock Sites and Storage Locations", "Low"],
    [
      "inventory.location.manage",
      "Create, rename, rezone and deactivate Storage Locations",
      "Medium",
    ],
    ["inventory.stock.read", "Read on-hand, reserved and available stock", "Low"],
    ["inventory.receipt.read", "Read goods receipts", "Low"],
    ["inventory.receipt.post", "Post goods receipts (Store direct or PO-linked)", "Medium"],
    ["inventory.receipt.correct", "Adjust or void a posted goods receipt", "High"],
    ["inventory.opening_balance.post", "Post the audited opening stock initialization", "High"],
    ["inventory.count.read", "Read stock counts", "Low"],
    ["inventory.count.manage", "Create and assign stock counts", "Medium"],
    ["inventory.count.approve", "Approve count variances above threshold", "High"],
    ["inventory.adjustment.read", "Read stock adjustments", "Low"],
    ["inventory.adjustment.approve", "Approve adjustments above threshold", "High"],
    ["inventory.waste.read", "Read waste records", "Low"],
    ["inventory.waste.approve", "Approve waste above threshold", "High"],
    ["inventory.transfer.read", "Read stock transfers", "Low"],
    ["inventory.transfer.approve", "Approve stock transfers", "High"],
    [
      "inventory.movement.correct",
      "Correct a stock movement through a compensating movement",
      "High",
    ],
    ["inventory.lot.hold.manage", "Place or release a lot quality hold", "High"],
  ]),
  ...define("ordering", [
    ["ordering.order.read", "Read the Store order queue and order details", "Low", true],
    ["ordering.order.create_staff", "Create an order on behalf of a customer", "Medium", true],
    ["ordering.order.accept", "Accept a submitted order batch", "Medium"],
    ["ordering.order.amend", "Amend an order under policy", "Medium"],
    ["ordering.order.cancel", "Cancel an order or batch under policy", "High"],
    ["ordering.order.close", "Close an order", "Medium"],
    ["ordering.order.fulfill", "Mark an order fulfilled", "Medium"],
  ]),
  ...define("kitchen", [
    ["kitchen.work_item.read", "Read the Kitchen board and work items", "Low", true],
    ["kitchen.work_item.accept", "Accept a Kitchen work item", "Low"],
    ["kitchen.work_item.start", "Start a Kitchen work item", "Low"],
    ["kitchen.work_item.complete", "Record completed quantity and mark items ready", "Low"],
    ["kitchen.exception.manage", "Report, acknowledge and resolve Kitchen exceptions", "Medium"],
    ["kitchen.production.manage", "Manage production batches", "Medium"],
  ]),
  ...define("fulfillment", [
    ["fulfillment.pickup.read", "Read the pickup queue", "Low", true],
    ["fulfillment.pickup.complete", "Verify pickup proof and record handoff", "Medium", true],
  ]),
  ...define("dining", [
    ["dining.table.read", "Read tables and their availability", "Low"],
    ["dining.session.manage", "Start, join, move and regenerate dining sessions", "Medium"],
    ["dining.host.transfer", "Transfer the dining host", "Medium"],
    ["dining.item.serve", "Record items served", "Low"],
    ["dining.session.close", "Close a dining session and release the table", "Medium"],
  ]),
  ...define("payment", [
    ["payment.refund.request", "Request an ordinary refund within policy", "High"],
    ["payment.refund.approve", "Approve a refund above the requester's limit", "High"],
    ["payment.refund.execute", "Execute an approved refund", "High"],
  ]),
  ...define("operations", [
    ["operations.order_exception.manage", "Handle payment and order exceptions", "High"],
  ]),
  ...define("task", [
    ["task.read", "Read the Store task inbox", "Low"],
    ["task.create", "Create a Store task", "Medium"],
    ["task.assign", "Assign a Store task", "Medium"],
    ["task.claim", "Claim a Store task", "Low"],
    ["task.complete", "Complete a Store task", "Low"],
    ["task.cancel", "Cancel a Store task", "Medium"],
    ["task.escalate", "Escalate a Store task", "Medium"],
    ["task.fail", "Record a Store task failure", "Medium"],
  ]),
  ...define("workflow", [["workflow.operate", "Operate workflow transitions", "Medium"]]),
  ...define("publishing", [
    ["publishing.draft.create", "Create publishing drafts", "Medium"],
    ["publishing.review.submit", "Submit drafts for review", "Medium"],
    ["publishing.review.approve", "Approve reviewed drafts", "High"],
    ["publishing.release.publish", "Publish releases", "High"],
    ["publishing.release.archive", "Archive releases", "High"],
    ["publishing.release.rollback", "Roll back to an earlier release", "High"],
    ["publishing.livegate.submit", "Submit Store live-gate evidence", "High"],
    ["publishing.livegate.attach", "Attach live-gate evidence", "Medium"],
    ["publishing.livegate.approve", "Approve the Store live gate", "High"],
    ["publishing.livegate.reopen", "Reopen the Store live gate", "High"],
  ]),
  ...define("integration", [
    ["integration.receipt_template.manage", "Manage digital receipt templates", "Medium"],
  ]),
  ...define("media", [
    ["media.upload.create", "Upload media", "Low"],
    ["media.asset.access", "Access stored media", "Low"],
    ["media.asset.finalize", "Finalize uploaded media", "Low"],
  ]),
  ...define("audit", [
    ["audit.catalog.category.read", "Read Category audit", "Low", true],
    ["audit.catalog.option_set.read", "Read Option Set audit", "Low", true],
    ["audit.catalog.product.read", "Read Product audit", "Low", true],
    ["audit.catalog.sku.read", "Read SKU audit", "Low", true],
    ["audit.inventory.item.read", "Read Inventory Item audit", "Low", true],
  ]),
]);

export function storePermissionCatalog(): readonly StorePermissionDefinition[] {
  return catalog;
}
export const storePermissionCodes: ReadonlySet<string> = new Set(
  catalog.map((entry) => entry.code),
);

/**
 * Legacy consolidated codes still checked by some modules, each with the catalog codes that replace
 * it. A module moves to the replacements when its back office is connected (DEC-PERM-CATALOG step 4).
 */
export const legacyPermissionReplacements: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "kitchen.operate": [
      "kitchen.work_item.read",
      "kitchen.work_item.accept",
      "kitchen.work_item.start",
      "kitchen.work_item.complete",
    ],
    "inventory.manage": [
      "inventory.item.read",
      "inventory.item.create",
      "inventory.item.update",
      "inventory.item.activate",
      "inventory.item.deactivate",
      "inventory.location.read",
      "inventory.location.manage",
    ],
    "inventory.receive": ["inventory.receipt.post"],
    "dining.operate": ["dining.table.read", "dining.session.manage"],
    "ordering.operate": ["ordering.order.read"],
    "order.accept": ["ordering.order.accept"],
    "order.close": ["ordering.order.close"],
    "order.fulfill": ["ordering.order.fulfill"],
    "fulfillment.operate": ["fulfillment.pickup.read"],
    "recipe.manage": ["recipe.read", "recipe.update", "recipe.approve", "recipe.publish"],
    "catalog.manage": [
      "catalog.product.read",
      "catalog.product.update",
      "catalog.category.read",
      "catalog.category.update",
      "catalog.option_set.read",
      "catalog.option_set.update",
      "catalog.menu.read",
      "catalog.menu.update",
    ],
    "catalog.product.manage": ["catalog.product.create", "catalog.product.update"],
    "catalog.menu.manage": ["catalog.menu.update"],
    "catalog.content-registry.read": ["catalog.content_registry.read"],
    "catalog.content-registry.manage": ["catalog.content_registry.manage"],
    "organization.manage": [
      "organization.store.read",
      "organization.store.update",
      "organization.store.publish",
      "organization.brand.manage",
    ],
    "store.service.read": ["organization.store.read"],
    "pricing.price-book.manage": ["pricing.price_book.update"],
    // v4: names still checked by the Catalog/Pricing services (DEC-PERM-CATALOG step-wise migration).
    "pricing.price-book.approve": ["pricing.price_book.approve"],
    "catalog.option_set.manage": ["catalog.option_set.create", "catalog.option_set.update"],
    "catalog.category.manage": ["catalog.category.create", "catalog.category.update"],
    "pricing.tax-config.manage": ["pricing.tax_config.manage"],
    "operations.order-exception.manage": ["operations.order_exception.manage"],
    "integration.manage": ["integration.receipt_template.manage"],
  });

export type StoreRoleTemplateCode =
  "owner" | "store-manager" | "front-of-house" | "kitchen" | "inventory-manager";
const pick = (prefixes: readonly string[]) =>
  catalog
    .map((entry) => entry.code)
    .filter((code) => prefixes.some((prefix) => code === prefix || code.startsWith(prefix)));

/** DEC-PERM-CATALOG Store role templates; an Owner may adjust a Store's copy. */
export const storeRoleTemplates: Readonly<Record<StoreRoleTemplateCode, readonly string[]>> =
  Object.freeze({
    owner: Object.freeze(catalog.map((entry) => entry.code)),
    "store-manager": Object.freeze([
      "merchant.access",
      "organization.store.read",
      "organization.staff.read",
      "identity.role.read",
      "identity.role.approve",
      ...pick([
        "ordering.order.",
        "kitchen.",
        "fulfillment.",
        "dining.",
        "operations.",
        "task.",
        "workflow.",
      ]),
      "payment.refund.request",
      "payment.refund.execute",
      ...pick([
        "inventory.item.read",
        "inventory.item.history.read",
        "inventory.item.reorder.manage",
        "inventory.location.",
        "inventory.stock.read",
        "inventory.receipt.",
        "inventory.count.",
        "inventory.waste.",
        "inventory.transfer.",
        "inventory.movement.read",
        "inventory.adjustment.read",
        "inventory.adjustment.execute",
      ]),
      "catalog.product.read",
      "catalog.sku.read",
      "catalog.menu.read",
      "catalog.product.availability.manage",
      "catalog.sku.availability.manage",
      "catalog.product.suspend",
      "catalog.product.resume",
      "catalog.sku.suspend",
      "catalog.sku.resume",
      "recipe.read",
    ]),
    "front-of-house": Object.freeze([
      "merchant.access",
      "ordering.order.read",
      "ordering.order.accept",
      "ordering.order.create_staff",
      "fulfillment.pickup.read",
      "fulfillment.pickup.complete",
      "dining.table.read",
      "dining.session.manage",
      "dining.item.serve",
      "inventory.waste.record",
      "task.read",
      "task.claim",
      "task.complete",
    ]),
    kitchen: Object.freeze([
      "merchant.access",
      "kitchen.work_item.read",
      "kitchen.work_item.accept",
      "kitchen.work_item.start",
      "kitchen.work_item.complete",
      "kitchen.exception.manage",
      "inventory.waste.record",
    ]),
    "inventory-manager": Object.freeze([
      "merchant.access",
      ...pick(["inventory."]).filter((code) => code !== "inventory.opening_balance.post"),
      "recipe.read",
    ]),
  });

export const storeRoleTemplateCodes: readonly StoreRoleTemplateCode[] = Object.freeze([
  "owner",
  "store-manager",
  "front-of-house",
  "kitchen",
  "inventory-manager",
]);
/** Store role code (database grammar is lowercase snake case) and display text per template. */
export const storeRoleTemplateProfiles: Readonly<
  Record<
    StoreRoleTemplateCode,
    { readonly roleCode: string; readonly displayName: string; readonly description: string }
  >
> = Object.freeze({
  owner: {
    roleCode: "store_owner",
    displayName: "Owner",
    description: "All Store permissions, including staff, roles, finance and refund approval",
  },
  "store-manager": {
    roleCode: "store_manager",
    displayName: "Store Manager",
    description:
      "Orders, exceptions, refunds within limit, kitchen, pickup, stock and availability",
  },
  "front-of-house": {
    roleCode: "front_of_house",
    displayName: "Front of House",
    description: "View and accept orders, staff-entered orders, pickup handoff and waste records",
  },
  kitchen: {
    roleCode: "kitchen",
    displayName: "Kitchen",
    description: "Kitchen display work items and kitchen exceptions",
  },
  "inventory-manager": {
    roleCode: "inventory_manager",
    displayName: "Inventory Manager",
    description: "Inventory items, receiving, counts, adjustments and waste",
  },
});
/**
 * Exact actions a provisioned template role holds: its catalog codes plus each legacy consolidated
 * code whose replacements the role holds completely, so a module still checking a legacy code is
 * never granted more than the template intends.
 */
export function storeRoleTemplateActions(template: StoreRoleTemplateCode): readonly string[] {
  return withLegacyEquivalents(storeRoleTemplates[template]);
}
/**
 * Catalog codes plus every legacy consolidated code whose replacements are all present; used for
 * template and Custom roles alike. Legacy codes cannot be selected directly.
 */
export function withLegacyEquivalents(catalogCodes: readonly string[]): readonly string[] {
  const codes = new Set(catalogCodes);
  for (const [legacy, replacements] of Object.entries(legacyPermissionReplacements))
    if (replacements.every((code) => codes.has(code))) codes.add(legacy);
  return Object.freeze([...codes].sort());
}

export type BrandRoleTemplateCode =
  "brand-owner" | "recipe-developer" | "recipe-reviewer" | "menu-manager";
/**
 * DEC-PERM-BRAND-ROLES: Brand-level System roles for facts every Store of the Brand shares (Recipes,
 * Catalog, pricing, Inventory Item master data). Grants apply to the Brand and every Store of it.
 */
export const brandRoleTemplates: Readonly<Record<BrandRoleTemplateCode, readonly string[]>> =
  Object.freeze({
    "brand-owner": Object.freeze(
      pick([
        "merchant.access",
        "organization.staff.",
        "organization.brand.manage",
        "identity.role.",
        "catalog.",
        "pricing.",
        "recipe.",
        "inventory.item.",
        "media.",
        "audit.catalog.",
        "audit.inventory.item.",
      ]),
    ),
    "recipe-developer": Object.freeze([
      "merchant.access",
      "recipe.read",
      "recipe.update",
      "inventory.item.read",
    ]),
    "recipe-reviewer": Object.freeze([
      "merchant.access",
      "recipe.read",
      "recipe.approve",
      "inventory.item.read",
    ]),
    "menu-manager": Object.freeze(
      pick([
        "merchant.access",
        "catalog.",
        "pricing.price_book.",
        "pricing.tax_config.read",
        "recipe.read",
        "inventory.item.read",
      ]),
    ),
  });
export const brandRoleTemplateCodes: readonly BrandRoleTemplateCode[] = Object.freeze([
  "brand-owner",
  "recipe-developer",
  "recipe-reviewer",
  "menu-manager",
]);
export const brandRoleTemplateProfiles: Readonly<
  Record<
    BrandRoleTemplateCode,
    { readonly roleCode: string; readonly displayName: string; readonly description: string }
  >
> = Object.freeze({
  "brand-owner": {
    roleCode: "brand_owner",
    displayName: "Brand Owner",
    description: "Recipes, menu and products, pricing, supply items and Brand staff roles",
  },
  "recipe-developer": {
    roleCode: "recipe_developer",
    displayName: "Recipe Developer",
    description: "Write and revise recipe drafts",
  },
  "recipe-reviewer": {
    roleCode: "recipe_reviewer",
    displayName: "Recipe Reviewer",
    description: "Review recipe cost and food safety before publication",
  },
  "menu-manager": {
    roleCode: "menu_manager",
    displayName: "Menu Manager",
    description: "Products, menus and prices, including approving another person's changes",
  },
});
export function brandRoleTemplateActions(template: BrandRoleTemplateCode): readonly string[] {
  return withLegacyEquivalents(brandRoleTemplates[template]);
}
