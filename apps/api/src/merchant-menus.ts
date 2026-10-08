import { createHash } from "node:crypto";
import { loadOutboxEnvelope, type ConsumerTransaction } from "@bop/eventing";
import {
  CatalogError,
  createCategoryMenuService,
  createPostgresMenuDraftSource,
  createPostgresMenuDraftStore,
  createPostgresMenuReviewContentStore,
  createPostgresPublishedMenuConsumerService,
  currentAllergenRegistry,
  listBrandMenus,
  listBrandSkuChoices,
  parseCatalogHash,
  parseCatalogReference,
  type MenuAggregate,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  createPostgresPriceBookRepository,
  currentStorePriceBook,
  type CurrencyMetadataSnapshot,
} from "@rms/pricing";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import { localBoundary } from "./merchant-prices.js";
import { derivedReference } from "./merchant-products.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-MENU-REVISION: CAT-MENU-LIST / CAT-MENU-BUILDER for the selected Store's Brand. The current
 * Menu version is edited (catalog.menu.update) until it is submitted for review (catalog.menu.submit,
 * which also prepares the allergen-checked review content); someone else approves it
 * (catalog.menu.approve, Publishing approval) and it is published (catalog.menu.publish), effective at
 * once in the Store's time zone. Publishing updates the customer menu projection in the same flow.
 * A submitted or published version is frozen: changes start a revision (catalog.menu.update).
 */
export class MerchantMenuError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "Frozen"
      | "NotRevisable"
      | "ReviewBlocked"
      | "ApprovalRequired"
      | "Lifecycle"
      | "Invalid",
  ) {
    super(code);
    this.name = "MerchantMenuError";
  }
}
const fail = (code: MerchantMenuError["code"]): never => {
  throw new MerchantMenuError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const version = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");
const digestOf = (value: unknown): string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : fail("Invalid");
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string") return fail("Invalid");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : fail("Invalid");
};
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;

export interface MenuSectionInput {
  readonly sectionReference: string | null;
  readonly code: string;
  readonly name: string;
  readonly items: readonly { readonly skuReference: string; readonly featured: boolean }[];
}
export type MenuCommandBody =
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
      readonly name: string;
      readonly sections: readonly MenuSectionInput[];
    }
  | {
      readonly action: "Revise";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      readonly action: "Submit";
      readonly operationReference: string;
      readonly menuReference: string;
    }
  | {
      readonly action: "Approve" | "Publish";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly menuVersionReference: string;
      readonly expectedVersion: number;
      readonly snapshotDigest: string;
    }
  | {
      readonly action: "Rebuild";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly publishOperationReference: string;
    };
export function parseMenuCommandBody(value: unknown): MenuCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (
    r.action === "SaveDraft" &&
    keys === "action,expectedAggregateVersion,menuReference,name,operationReference,sections"
  ) {
    if (!Array.isArray(r.sections) || r.sections.length < 1 || r.sections.length > 40)
      return fail("Invalid");
    const sections = r.sections.map((candidate: unknown) => {
      const s = candidate as Record<string, unknown> | null;
      if (
        s === null ||
        typeof s !== "object" ||
        Object.keys(s).sort().join(",") !== "code,items,name,sectionReference" ||
        !Array.isArray(s.items) ||
        s.items.length > 200
      )
        return fail("Invalid");
      const sectionCode = typeof s.code === "string" ? s.code.trim().toUpperCase() : "";
      if (!code.test(sectionCode)) return fail("Invalid");
      const items = s.items.map((item: unknown) => {
        const i = item as Record<string, unknown> | null;
        if (
          i === null ||
          typeof i !== "object" ||
          Object.keys(i).sort().join(",") !== "featured,skuReference" ||
          typeof i.featured !== "boolean"
        )
          return fail("Invalid");
        return { skuReference: ref(i.skuReference), featured: i.featured };
      });
      if (new Set(items.map((item) => item.skuReference)).size !== items.length)
        return fail("Invalid");
      return {
        sectionReference: s.sectionReference === null ? null : ref(s.sectionReference),
        code: sectionCode,
        name: text(s.name, 80),
        items,
      };
    });
    if (
      new Set(sections.map((s) => s.code)).size !== sections.length ||
      new Set(sections.map((s) => s.name.toLowerCase())).size !== sections.length
    )
      return fail("Invalid");
    return {
      action: "SaveDraft",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
      name: text(r.name, 120),
      sections,
    };
  }
  if (
    r.action === "Revise" &&
    keys === "action,expectedAggregateVersion,menuReference,operationReference"
  )
    return {
      action: "Revise",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
    };
  if (r.action === "Submit" && keys === "action,menuReference,operationReference")
    return {
      action: "Submit",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
    };
  if (
    (r.action === "Approve" || r.action === "Publish") &&
    keys ===
      "action,expectedVersion,menuReference,menuVersionReference,operationReference,snapshotDigest"
  )
    return {
      action: r.action,
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      menuVersionReference: ref(r.menuVersionReference),
      expectedVersion: version(r.expectedVersion),
      snapshotDigest: digestOf(r.snapshotDigest),
    };
  if (
    r.action === "Rebuild" &&
    keys === "action,menuReference,operationReference,publishOperationReference"
  )
    return {
      action: "Rebuild",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      publishOperationReference: ref(r.publishOperationReference),
    };
  return fail("Invalid");
}

const catalogErrors: Partial<Record<CatalogError["code"], MerchantMenuError["code"]>> = {
  CATALOG_PERMISSION_DENIED: "PermissionDenied",
  CATALOG_VERSION_CONFLICT: "Conflict",
  CATALOG_IDEMPOTENCY_CONFLICT: "Conflict",
  CATALOG_LIFECYCLE_CONFLICT: "Lifecycle",
  CATALOG_INPUT_INVALID: "Invalid",
  CATALOG_UNAVAILABLE: "NotFound",
  CATALOG_CODE_CONFLICT: "Invalid",
};

export function createMerchantMenus(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  currencyMetadata: CurrencyMetadataSnapshot;
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const ptx = (tx: unknown) => tx as ProductLifecycleTransaction;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const decision = (action: string) => scope.authorizeAction(action);
    const may = async (action: string) => (await decision(action))?.effect === "Allow";
    const permissions = {
      mayRead: await may("catalog.menu.read"),
      mayEdit: await may("catalog.menu.update"),
      maySubmit: await may("catalog.menu.submit"),
      mayApprove: await may("catalog.menu.approve"),
      mayPublish: await may("catalog.menu.publish"),
    };
    if (!permissions.mayRead) fail("PermissionDenied");
    return {
      scope,
      decision,
      owner: {
        tenantReference: String(scope.tenantReference),
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.selectedStoreReference),
      },
      timeZone: scope.selectedStoreTimeZone,
      actor: String(scope.actorReference),
      permissions,
    };
  }
  type Scope = Awaited<ReturnType<typeof scopeFor>>;
  const brandScope = (tx: unknown, brand: string) =>
    ptx(tx).query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  const draft = async (tx: unknown, s: Scope, menu: string) =>
    createPostgresMenuDraftSource({
      brandReference: s.owner.brandReference,
      transactions: { run: (work) => work(ptx(tx)) },
      authorize: async () => true,
    }).load(menu, options.persistence.now());
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;
  /** Selling sizes with product names and this Store's current price (cents) when it has one. */
  const sellables = async (tx: unknown, s: Scope) => {
    const skus = await listBrandSkuChoices(ptx(tx) as never, s.owner);
    const assignment = await currentStorePriceBook(ptx(tx) as never, s.owner);
    const prices = new Map<string, string>();
    if (assignment !== null) {
      const book = await createPostgresPriceBookRepository({
        brandReference: s.owner.brandReference,
        currencyMetadata: options.currencyMetadata,
        transactions: { run: (work) => work(ptx(tx) as never) },
        authorize: async (_tx, input) => !input.write,
        appendEvent: async () => {
          throw new Error("MENU_READ_ONLY");
        },
      }).load(assignment.priceBookReference as never);
      for (const entry of book?.entries ?? [])
        if (entry.scopeKind === "Brand" && entry.channelCode === null && entry.orderType === null)
          prices.set(entry.sellableReference, entry.amount.amountMinor.toString());
    }
    await brandScope(tx, s.owner.brandReference);
    return skus.map((sku) => ({
      skuReference: sku.skuReference,
      skuCode: sku.skuCode,
      productName: name(sku.productLocalizedNames, ""),
      sizeName: name(sku.localizedNames, sku.skuCode),
      active: sku.active,
      priceMinor: prices.get(sku.skuReference) ?? null,
    }));
  };
  const menuView = (aggregate: MenuAggregate) => ({
    menuReference: aggregate.menuReference,
    internalCode: aggregate.internalCode,
    aggregateVersion: aggregate.aggregateVersion,
    versionReference: aggregate.draft.versionReference,
    name: name(aggregate.draft.localizedNames, aggregate.internalCode),
    storeReferences: aggregate.draft.storeReferences,
    channelCodes: aggregate.draft.channelCodes,
    orderTypeCodes: aggregate.draft.orderTypeCodes,
    sections: [...aggregate.draft.sections]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((section) => ({
        sectionReference: section.sectionReference,
        code: section.internalCode,
        name: name(section.localizedNames, section.internalCode),
        items: [...section.placements]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((placement) => ({
            placementReference: placement.placementReference,
            skuReference: placement.sellableReference,
            featured: placement.presentationRole === "Featured",
          })),
      })),
  });

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    menuReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const menus = await listBrandMenus(ptx(tx) as never, s.owner);
        const base = {
          sourceAsOf: options.persistence.now(),
          viewer: s.actor,
          permissions: s.permissions,
          menus,
        };
        if (input.menuReference === null) return { screenId: "CAT-MENU-LIST" as const, ...base };
        const summary = menus.find((menu) => menu.menuReference === input.menuReference);
        if (summary === undefined) return fail("NotFound");
        const loaded = await draft(tx, s, input.menuReference);
        if (loaded === null) return fail("NotFound");
        const submitter =
          summary.publication === null
            ? null
            : ((
                await ptx(tx).query(
                  "SELECT actor_reference::text actor FROM platform_audit.audit_record WHERE brand_id=$1 AND action_code='CATALOG_MENU_SUBMITREVIEW' AND target_id=$2 ORDER BY occurred_at DESC LIMIT 1",
                  [s.owner.brandReference, summary.currentVersionReference],
                )
              ).rows[0]?.actor ?? null);
        return {
          screenId: "CAT-MENU-BUILDER" as const,
          ...base,
          menu: menuView(loaded.aggregate),
          publication: summary.publication,
          latestRelease: summary.latestRelease,
          submittedBy: typeof submitter === "string" ? submitter : null,
          sellables: await sellables(tx, s),
          allergenRegistry: (await currentAllergenRegistry(ptx(tx) as never, s.owner)) !== null,
        };
      }),
    );
  };

  const publication = createMerchantMenuPublicationCommand({
    merchant: options.persistence,
    authentication: options.authentication,
    reviewCreation: {
      budget: { maximumConfigurations: 10000, maximumSearchSteps: 1000000 },
      reference: (purpose, operation) => derivedReference(operation, "review:" + purpose),
    },
    reviewApproval: {
      reference: (purpose, operation) => derivedReference(operation, "approval:" + purpose),
      validUntil: (input) => input.validationValidUntil,
    },
    binding: async (tx, input) => {
      const row = (
        await tx.query<{ digest: string }>(
          "SELECT snapshot_digest digest FROM rms_catalog.menu_review_content WHERE brand_id=$1 AND menu_id=$2 AND menu_version_id=$3 ORDER BY snapshot_digest LIMIT 2",
          [input.brandReference, input.menuReference, input.menuVersionReference],
        )
      ).rows;
      if (row.length !== 1 || !row[0]) return null;
      const record = await createPostgresMenuReviewContentStore({
        brandReference: input.brandReference,
        menuReference: input.menuReference,
        authorize: async () => true,
      }).read(tx, input.menuVersionReference, row[0].digest, options.persistence.now());
      return record === null
        ? null
        : {
            lifecycleReference: record.lifecycleReference,
            snapshotDigest: record.snapshotDigest,
            configurationDigest: record.configurationDigest,
          };
    },
    reference: (purpose, operation) => derivedReference(operation, "publication:" + purpose),
    ...(options.resolveScope === undefined ? {} : { resolveScope: options.resolveScope }),
  });

  /** Projects a publication's MenuPublished event into the customer menu (idempotent). */
  const project = async (
    sessionCookie: unknown,
    sessionReference: string,
    publishOperation: string,
  ) =>
    retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, sessionCookie, sessionReference);
        if (!s.permissions.mayPublish) fail("PermissionDenied");
        await brandScope(tx, s.owner.brandReference);
        const envelope = await loadOutboxEnvelope(
          tx as unknown as ConsumerTransaction,
          derivedReference(publishOperation, "publication:Event"),
        );
        if (envelope === null) return fail("NotFound");
        const result = await createPostgresPublishedMenuConsumerService({
          brandReference: s.owner.brandReference,
          authorize: async () => true,
          generateGeneration: () => derivedReference(publishOperation, "projection"),
          now: () => options.persistence.now(),
        }).consume(tx as unknown as ConsumerTransaction, envelope);
        return result;
      }),
    );

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseMenuCommandBody(input.body);
    const current = await session(input);
    try {
      if (body.action === "Submit" || body.action === "Approve" || body.action === "Publish") {
        // Facts the publication command needs that the client does not supply.
        const prepared = await retryTransactionConflict(() =>
          options.persistence.transactions.run(async (tx) => {
            const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
            const allowed =
              body.action === "Submit"
                ? s.permissions.maySubmit
                : body.action === "Approve"
                  ? s.permissions.mayApprove
                  : s.permissions.mayPublish;
            if (!allowed) fail("PermissionDenied");
            if (body.action !== "Submit") return { s, loaded: null, registry: null };
            const loaded = await draft(tx, s, body.menuReference);
            const registry = await currentAllergenRegistry(ptx(tx) as never, s.owner);
            if (loaded === null) return fail("NotFound");
            if (registry === null) return fail("ReviewBlocked");
            return { s, loaded, registry };
          }),
        );
        const { loaded, registry } = prepared;
        const commandBody =
          body.action === "Submit"
            ? loaded === null || registry === null
              ? fail("ReviewBlocked")
              : {
                  action: "CreateReview",
                  operationReference: body.operationReference,
                  menuReference: body.menuReference,
                  menuVersionReference: loaded.aggregate.draft.versionReference,
                  configurationDigest: loaded.configurationDigest,
                  registryVersionReference: registry.registryVersionReference,
                  expectedVersion: 1,
                }
            : {
                action: body.action,
                operationReference: body.operationReference,
                menuReference: body.menuReference,
                menuVersionReference: body.menuVersionReference,
                expectedVersion: body.expectedVersion,
                snapshotDigest: body.snapshotDigest,
                effectivePeriod:
                  body.action === "Publish"
                    ? {
                        timeZone: prepared.s.timeZone,
                        effectiveFrom: localBoundary(
                          options.persistence.now(),
                          prepared.s.timeZone,
                        ),
                        effectiveUntil: null,
                      }
                    : null,
              };
        const result = await publication({
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
          command: commandBody,
        });
        if (body.action === "Publish")
          return {
            ...result,
            projection: await project(
              input.sessionCookie,
              current.sessionReference,
              body.operationReference,
            ),
          };
        return result;
      }
      if (body.action === "Rebuild")
        return {
          projection: await project(
            input.sessionCookie,
            current.sessionReference,
            body.publishOperationReference,
          ),
        };
      if (body.action !== "SaveDraft" && body.action !== "Revise") return fail("Invalid");
      const edit = body;
      return await retryTransactionConflict(() =>
        options.persistence.transactions.run(async (tx) => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          if (!s.permissions.mayEdit) fail("PermissionDenied");
          const at = options.persistence.now();
          const brand = s.owner.brandReference;
          const menus = createPostgresMenuDraftStore({
            brandReference: brand,
            transactions: { run: (work) => work(ptx(tx)) },
            now: () => options.persistence.now(),
            authorize: async () => true,
          });
          // A retried operation returns its recorded result.
          const recorded = await menus.resolveOperation(
            parseCatalogReference(edit.operationReference),
          );
          if (recorded !== null) {
            if (recorded.aggregate.menuReference !== edit.menuReference) fail("Conflict");
            return { status: "AlreadyApplied", menu: menuView(recorded.aggregate) };
          }
          const service = createCategoryMenuService({
            menus,
            categories: {} as never,
            facts: {
              validateStores: async (value) =>
                value.storeReferences.every((store) => store === s.owner.storeReference),
              validateCategories: async (value) => value.categoryReferences.length === 0,
              validateSellables: async (value) => {
                const active = new Set(
                  (await listBrandSkuChoices(ptx(tx) as never, s.owner))
                    .filter((sku) => sku.active)
                    .map((sku) => sku.skuReference),
                );
                return value.sellableReferences.every((sku) => active.has(sku));
              },
            },
            references: {
              generate: () => options.references.next(),
              hashIntent: (value) =>
                parseCatalogHash(createHash("sha256").update(value).digest("hex")),
              equals: (a, b) => a === b,
            },
            authorization: {
              authorize: async (request) => {
                const permission = await s.decision("catalog.menu.manage");
                if (permission?.effect !== "Allow") return null;
                await brandScope(tx, brand);
                return {
                  tenantContext: s.scope.context,
                  permission,
                  audit: {
                    auditId: derivedReference(edit.operationReference, "audit"),
                    brandId: brand,
                    actor: { type: "User", reference: s.actor },
                    actionCode: "CATALOG_MENU_" + request.action.toUpperCase(),
                    targetType: "CatalogMenu",
                    targetId: request.aggregateReference,
                    correlationId: edit.operationReference,
                    occurredAt: request.observedAt,
                    reasonCode: "AUTHORIZED_OPERATION",
                    sourceChannel: "MERCHANT_WEB",
                    dataClassification: "Internal",
                    retentionPolicyCode: "CONFIGURATION_AUDIT",
                    retentionPolicyVersion: 1,
                  },
                };
              },
            },
          });
          if (edit.action === "Revise") {
            const result = await service.reviseMenu({
              menuReference: edit.menuReference,
              expectedAggregateVersion: edit.expectedAggregateVersion,
              operationReference: edit.operationReference,
              requestedAt: at,
            });
            return { status: result.status, menu: menuView(result.aggregate) };
          }
          const loaded = await draft(tx, s, edit.menuReference);
          if (loaded === null) return fail("NotFound");
          const currentMenu = loaded.aggregate;
          if (currentMenu.aggregateVersion !== edit.expectedAggregateVersion) fail("Conflict");
          const locale = currentMenu.draft.defaultLocale;
          const sections = edit.sections.map((input, sortOrder) => {
            const existing =
              input.sectionReference === null
                ? undefined
                : currentMenu.draft.sections.find(
                    (section) => section.sectionReference === input.sectionReference,
                  );
            if (input.sectionReference !== null && existing === undefined) fail("Invalid");
            if (existing !== undefined && existing.internalCode !== input.code) fail("Invalid");
            const sectionReference =
              existing?.sectionReference ??
              parseCatalogReference(
                derivedReference(edit.operationReference, "section:" + input.code),
              );
            return {
              sectionReference,
              menuReference: currentMenu.menuReference,
              brandReference: currentMenu.brandReference,
              internalCode: input.code,
              localizedNames: { ...(existing?.localizedNames ?? {}), [locale]: input.name },
              sortOrder,
              categoryReferences: existing?.categoryReferences ?? [],
              placements: input.items.map((item, itemOrder) => {
                const role = item.featured ? "Featured" : "Standard";
                const kept = existing?.placements.find(
                  (p) => p.sellableReference === item.skuReference && p.presentationRole === role,
                );
                return {
                  placementReference:
                    kept?.placementReference ??
                    parseCatalogReference(
                      derivedReference(
                        edit.operationReference,
                        "placement:" + input.code + ":" + item.skuReference + ":" + role,
                      ),
                    ),
                  menuReference: currentMenu.menuReference,
                  sectionReference,
                  brandReference: currentMenu.brandReference,
                  sellableReference: item.skuReference,
                  sellableType: "Sku" as const,
                  presentationRole: role,
                  sortOrder: itemOrder,
                  pinned: kept?.pinned ?? false,
                  localizedNameOverrides: kept?.localizedNameOverrides ?? {},
                  createdAt: kept?.createdAt ?? at,
                  createdByActorReference: kept?.createdByActorReference ?? s.actor,
                };
              }),
            };
          });
          const stores = [
            ...new Set([...currentMenu.draft.storeReferences, s.owner.storeReference]),
          ];
          const result = await service.replaceMenuDraft({
            menuReference: currentMenu.menuReference,
            expectedAggregateVersion: currentMenu.aggregateVersion,
            operationReference: edit.operationReference,
            requestedAt: at,
            draft: {
              ...currentMenu.draft,
              localizedNames: { ...currentMenu.draft.localizedNames, [locale]: edit.name },
              storeReferences: stores,
              sections,
              updatedAt: at,
            },
          });
          return { status: result.status, menu: menuView(result.aggregate) };
        }),
      );
    } catch (error) {
      if (error instanceof MerchantMenuError) throw error;
      if (error instanceof CatalogError) {
        if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && body.action === "SaveDraft")
          return fail("Frozen");
        if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && body.action === "Revise")
          return fail("NotRevisable");
        if (error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" && body.action === "Submit")
          return fail("ReviewBlocked");
        if (error.code === "CATALOG_PERMISSION_DENIED" && body.action === "Approve")
          return fail("ApprovalRequired");
        return fail(catalogErrors[error.code] ?? "Invalid");
      }
      throw error;
    }
  };
  return { query, command };
}
