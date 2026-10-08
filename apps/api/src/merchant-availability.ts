import { createHash } from "node:crypto";
import {
  availabilityTargetExists,
  CatalogError,
  createAvailabilityService,
  createPostgresAvailabilityRuleRepository,
  listBrandSkuChoices,
  listStoreAvailabilityRules,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
  resolveStoreAvailability,
  type AvailabilityRuleAggregate,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { storeDayEndExpiryCutoff } from "@rms/inventory";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { localBoundary } from "./merchant-prices.js";
import { derivedReference } from "./merchant-products.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 8.5: CAT-AVAILABILITY for the selected Store — which items this Store sells now. Offering
 * an item at the Store (or stopping) is a Brand decision; marking an item sold out (until the end of
 * the business day or until it is back) and back in stock is also open to the Store's own manager.
 * Both use `catalog.sku.availability.manage`; rules are recorded by the Catalog availability service.
 */
export class MerchantAvailabilityError extends Error {
  constructor(readonly code: "PermissionDenied" | "NotFound" | "Conflict" | "Invalid") {
    super(code);
    this.name = "MerchantAvailabilityError";
  }
}
const fail = (code: MerchantAvailabilityError["code"]): never => {
  throw new MerchantAvailabilityError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
export type AvailabilityCommandBody =
  | {
      readonly action: "Offer" | "StopOffering" | "BackInStock";
      readonly operationReference: string;
      readonly skuReference: string;
    }
  | {
      readonly action: "SoldOut";
      readonly operationReference: string;
      readonly skuReference: string;
      readonly until: "EndOfDay" | "UntilBack";
    };
export function parseAvailabilityCommandBody(value: unknown): AvailabilityCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (
    (r.action === "Offer" || r.action === "StopOffering" || r.action === "BackInStock") &&
    keys === "action,operationReference,skuReference"
  )
    return {
      action: r.action,
      operationReference: ref(r.operationReference),
      skuReference: ref(r.skuReference),
    };
  if (
    r.action === "SoldOut" &&
    keys === "action,operationReference,skuReference,until" &&
    (r.until === "EndOfDay" || r.until === "UntilBack")
  )
    return {
      action: "SoldOut",
      operationReference: ref(r.operationReference),
      skuReference: ref(r.skuReference),
      until: r.until,
    };
  return fail("Invalid");
}

/** Customer ordering combinations an item's status is shown for. */
const contexts = [
  ["CUSTOMER_PWA", "PICKUP"],
  ["CUSTOMER_PWA", "DINE_IN"],
] as const;
export type ItemAvailabilityStatus =
  "Available" | "SoldOut" | "Unavailable" | "NotOffered" | "Varies";
const soldOutReason = "SOLD_OUT";
const offeredReason = "STORE_OFFERED";
const effectiveAt = (rule: AvailabilityRuleAggregate, at: string) =>
  rule.lifecycle === "Active" &&
  Date.parse(rule.effectiveFrom) <= Date.parse(at) &&
  (rule.effectiveUntil === null || Date.parse(at) < Date.parse(rule.effectiveUntil));
/** One item's status at the Store from its rules (Inventory and Kill Switch are checked at order time). */
export function itemAvailability(
  rules: readonly AvailabilityRuleAggregate[],
  scope: { readonly brandReference: string; readonly storeReference: string },
  skuReference: string,
  at: string,
): { status: ItemAvailabilityStatus; soldOutUntil: string | null } {
  const own = rules.filter((rule) => rule.sellableReference === skuReference);
  const results = contexts.map(
    ([channel, orderType]) =>
      resolveStoreAvailability({
        brandReference: parseCatalogReference(scope.brandReference),
        storeReference: parseCatalogReference(scope.storeReference),
        sellableReference: parseCatalogReference(skuReference),
        channelCode: parseCatalogCode(channel),
        orderTypeCode: parseCatalogCode(orderType),
        at: parseCatalogInstant(at),
        rules: own,
        safetyEvidence: [],
      }).status,
  );
  const soldOut = own.filter(
    (rule) =>
      rule.storeReference === scope.storeReference &&
      rule.reasonCode === soldOutReason &&
      effectiveAt(rule, at),
  );
  const soldOutUntil = soldOut.some((rule) => rule.effectiveUntil === null)
    ? null
    : (soldOut
        .map((rule) => rule.effectiveUntil ?? "")
        .sort()
        .at(-1) ?? null);
  if (results.every((status) => status === "Available"))
    return { status: "Available", soldOutUntil: null };
  if (results.every((status) => status === "Unavailable"))
    return soldOut.length > 0
      ? { status: "SoldOut", soldOutUntil }
      : { status: "Unavailable", soldOutUntil: null };
  if (results.every((status) => status === "Indeterminate"))
    return { status: "NotOffered", soldOutUntil: null };
  return { status: "Varies", soldOutUntil: null };
}

const catalogErrors: Partial<Record<CatalogError["code"], MerchantAvailabilityError["code"]>> = {
  CATALOG_PERMISSION_DENIED: "PermissionDenied",
  CATALOG_VERSION_CONFLICT: "Conflict",
  CATALOG_IDEMPOTENCY_CONFLICT: "Conflict",
  CATALOG_LIFECYCLE_CONFLICT: "Conflict",
  CATALOG_UNAVAILABLE: "NotFound",
  CATALOG_INPUT_INVALID: "Invalid",
  CATALOG_CODE_CONFLICT: "Invalid",
};

export function createMerchantAvailability(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
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
  const action = "catalog.sku.availability.manage";
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const allow = <T extends { readonly effect: string } | null>(decision: T) =>
      decision?.effect === "Allow" ? decision : null;
    const brandDecision = async () => allow(await scope.authorizeAction(action));
    const storeDecision = async () => allow(await scope.authorizeStoreAction(action));
    const mayRead =
      (await scope.authorizeAction("catalog.sku.read"))?.effect === "Allow" ||
      (await scope.authorizeStoreAction("catalog.sku.read"))?.effect === "Allow";
    if (!mayRead) fail("PermissionDenied");
    const mayOffer = (await brandDecision()) !== null;
    const mayMarkSoldOut = mayOffer || (await storeDecision()) !== null;
    return {
      scope,
      brandDecision,
      storeDecision,
      owner: {
        tenantReference: String(scope.tenantReference),
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.selectedStoreReference),
      },
      timeZone: scope.selectedStoreTimeZone,
      actor: String(scope.actorReference),
      permissions: { mayOffer, mayMarkSoldOut },
    };
  }
  type Scope = Awaited<ReturnType<typeof scopeFor>>;
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;

  const query = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const at = options.persistence.now();
        const skus = (await listBrandSkuChoices(ptx(tx), s.owner)).filter((sku) => sku.active);
        const rules = await listStoreAvailabilityRules(ptx(tx), s.owner);
        return {
          screenId: "CAT-AVAILABILITY" as const,
          sourceAsOf: at,
          viewer: s.actor,
          timeZone: s.timeZone,
          permissions: s.permissions,
          items: skus
            .map((sku) => ({
              skuReference: sku.skuReference,
              skuCode: sku.skuCode,
              productName: name(sku.productLocalizedNames, sku.skuCode),
              sizeName: name(sku.localizedNames, sku.skuCode),
              ...itemAvailability(rules, s.owner, sku.skuReference, at),
            }))
            .sort(
              (a, b) =>
                a.productName.localeCompare(b.productName) || a.skuCode.localeCompare(b.skuCode),
            ),
        };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseAvailabilityCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const at = options.persistence.now();
        const brandWide = body.action === "Offer" || body.action === "StopOffering";
        if (brandWide ? !s.permissions.mayOffer : !s.permissions.mayMarkSoldOut)
          fail("PermissionDenied");
        const sku = (await listBrandSkuChoices(ptx(tx), s.owner)).find(
          (candidate) => candidate.skuReference === body.skuReference && candidate.active,
        );
        if (sku === undefined) return fail("NotFound");
        const service = availabilityService(tx, s, body.operationReference, !brandWide);
        const rules = (await listStoreAvailabilityRules(ptx(tx), s.owner)).filter(
          (rule) =>
            rule.sellableReference === sku.skuReference &&
            rule.storeReference === s.owner.storeReference,
        );
        const step = (purpose: string) => derivedReference(body.operationReference, purpose);
        const setLifecycle = (rule: AvailabilityRuleAggregate, target: "Active" | "Inactive") =>
          service.changeLifecycle({
            ruleReference: rule.ruleReference,
            targetLifecycle: target,
            expectedAggregateVersion: rule.aggregateVersion,
            operationReference: step(target + ":" + rule.ruleReference),
            requestedAt: at,
          });
        const createActive = async (rule: {
          internalCode: string;
          decision: "Available" | "Unavailable";
          priority: number;
          reasonCode: string;
          effectiveUntil: string | null;
        }) => {
          const created = await service.create({
            ...rule,
            sellableReference: sku.skuReference,
            sellableType: "Sku",
            storeReference: s.owner.storeReference,
            channelCodes: [],
            orderTypeCodes: [],
            effectiveFrom: at,
            operationReference: step("create"),
            requestedAt: at,
          });
          return created.aggregate.lifecycle === "Active"
            ? created
            : setLifecycle(created.aggregate, "Active");
        };
        const store8 = s.owner.storeReference.replaceAll("-", "").slice(0, 8).toUpperCase();
        try {
          const before = itemAvailability(rules, s.owner, sku.skuReference, at);
          if (body.action === "Offer") {
            const stopped = rules.find(
              (rule) => rule.reasonCode === offeredReason && rule.lifecycle !== "Active",
            );
            if (before.status === "Available" || before.status === "SoldOut")
              return { status: "Unchanged", item: before };
            if (stopped !== undefined) await setLifecycle(stopped, "Active");
            else
              await createActive({
                internalCode: ("OFFER-" + store8 + "-" + sku.skuCode).slice(0, 64),
                decision: "Available",
                priority: 100,
                reasonCode: offeredReason,
                effectiveUntil: null,
              });
          } else if (body.action === "StopOffering") {
            const offers = rules.filter(
              (rule) => rule.decision === "Available" && rule.lifecycle === "Active",
            );
            for (const rule of offers) await setLifecycle(rule, "Inactive");
          } else if (body.action === "SoldOut") {
            if (before.status === "SoldOut") return { status: "Unchanged", item: before };
            if (before.status !== "Available" && before.status !== "Varies") fail("Conflict");
            const today = localBoundary(at, s.timeZone).localDateTime.slice(0, 10);
            await createActive({
              internalCode:
                "SOLDOUT-" +
                store8 +
                "-" +
                step("code").replaceAll("-", "").slice(-16).toUpperCase(),
              decision: "Unavailable",
              priority: 900,
              reasonCode: soldOutReason,
              effectiveUntil:
                body.until === "EndOfDay" ? storeDayEndExpiryCutoff(today, s.timeZone) : null,
            });
          } else {
            const marks = rules.filter(
              (rule) =>
                rule.reasonCode === soldOutReason &&
                rule.lifecycle === "Active" &&
                (rule.effectiveUntil === null || Date.parse(at) < Date.parse(rule.effectiveUntil)),
            );
            for (const rule of marks) await setLifecycle(rule, "Inactive");
          }
          const after = (await listStoreAvailabilityRules(ptx(tx), s.owner)).filter(
            (rule) => rule.sellableReference === sku.skuReference,
          );
          return {
            status: "Applied",
            item: itemAvailability(after, s.owner, sku.skuReference, at),
          };
        } catch (error) {
          const mapped = error instanceof CatalogError ? catalogErrors[error.code] : undefined;
          if (mapped !== undefined) return fail(mapped);
          throw error;
        }
      }),
    );
  };

  /** The Catalog availability service with the Brand authority, or the Store's for sold-out marks. */
  function availabilityService(tx: Tx, s: Scope, operation: string, storeAllowed: boolean) {
    const authority = async () => {
      const brand = await s.brandDecision();
      if (brand !== null) return { decision: brand, context: s.scope.context, store: null };
      const store = storeAllowed ? await s.storeDecision() : null;
      return store === null
        ? null
        : { decision: store, context: s.scope.storeContext, store: s.owner.storeReference };
    };
    return createAvailabilityService({
      authorization: {
        authorize: async (request) => {
          const current = await authority();
          if (current === null) return null;
          return {
            tenantContext: current.context,
            permission: current.decision,
            audit: {
              auditId: derivedReference(
                operation,
                "audit:" + request.action + ":" + request.operationReference,
              ),
              brandId: s.owner.brandReference,
              ...(current.store === null ? {} : { storeId: current.store }),
              actor: { type: "User", reference: s.actor },
              actionCode: "CATALOG_AVAILABILITY_" + request.action.toUpperCase(),
              targetType: "CatalogAvailabilityRule",
              targetId: request.ruleReference,
              correlationId: operation,
              occurredAt: request.observedAt,
              reasonCode: "AUTHORIZED_OPERATION",
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Internal",
              retentionPolicyCode: "CONFIGURATION_AUDIT",
              retentionPolicyVersion: 1,
            },
          } as never;
        },
      },
      references: {
        generate: () => derivedReference(operation, "rule"),
        hashIntent: (value) => parseCatalogHash(createHash("sha256").update(value).digest("hex")),
        equals: (a, b) => a === b,
      },
      facts: {
        validate: async (input) =>
          input.brandReference === s.owner.brandReference &&
          input.storeReference === s.owner.storeReference &&
          input.sellableType === "Sku" &&
          availabilityTargetExists(ptx(tx), {
            brandReference: s.owner.brandReference,
            sellableReference: input.sellableReference,
          }),
      },
      repository: createPostgresAvailabilityRuleRepository({
        brandReference: s.owner.brandReference,
        transactions: { run: (work) => work(ptx(tx)) },
        references: { generate: () => options.references.next() },
        authorize: async () => (await authority()) !== null,
      }),
    });
  }
  return { query, command };
}
