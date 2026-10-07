import {
  commitOpeningCountChange,
  createPostgresInventoryItemStore,
  createPostgresStockPlaceStore,
  listOpeningCounts,
  loadOpeningCount,
  OpeningCountError,
  parseOpeningCountLines,
  postOpeningCount,
  type InventoryItemAggregate,
  type InventoryItemTransaction,
  type OpeningCount,
  type OpeningCountChange,
  type OpeningCountTransaction,
} from "@rms/inventory";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-INV-OPENING: INV-OPENING-COUNT for the selected Store. Reading needs
 * inventory.count.read; entering, submitting, reopening and cancelling need inventory.count.execute;
 * posting the one opening balance of the Store needs inventory.opening_balance.post.
 */
export class MerchantOpeningCountError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "AlreadyPosted"
      | "StockExists"
      | "LineInvalid"
      | "Invalid"
      | "Unavailable",
    readonly lineReference: string | null = null,
  ) {
    super(code);
    this.name = "MerchantOpeningCountError";
  }
}
const fail = (code: MerchantOpeningCountError["code"], line: string | null = null): never => {
  throw new MerchantOpeningCountError(code, line);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const actions = ["Create", "SaveLines", "Submit", "Reopen", "Cancel", "Post"] as const;
export interface OpeningCountCommandBody {
  readonly action: (typeof actions)[number];
  readonly operationReference: string;
  readonly countReference: string;
  readonly expectedVersion: number | null;
  readonly lines: unknown;
}
export function parseOpeningCountCommandBody(value: unknown): OpeningCountCommandBody {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !==
      "action,countReference,expectedVersion,lines,operationReference"
  )
    return fail("Invalid");
  const action = actions.find((item) => item === r.action);
  if (
    !action ||
    (action === "Create") !== (r.expectedVersion === null) ||
    (r.expectedVersion !== null &&
      (!Number.isSafeInteger(r.expectedVersion) || (r.expectedVersion as number) < 1)) ||
    (action === "SaveLines") !== (r.lines !== null)
  )
    return fail("Invalid");
  return {
    action,
    operationReference: ref(r.operationReference),
    countReference: ref(r.countReference),
    expectedVersion: r.expectedVersion as number | null,
    lines: r.lines,
  };
}

export function createMerchantOpeningCount(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  locale: string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, "inventory.count.read", sessionReference);
    if (!(await scope.allowed())) fail("PermissionDenied");
    return scope;
  }
  const ownerScope = (scope: Awaited<ReturnType<typeof scopeFor>>) => ({
    tenantReference: scope.selected.tenantReference,
    brandReference: scope.context.brand.brandReference,
    storeReference: scope.store.storeReference,
  });
  const may = async (scope: Awaited<ReturnType<typeof scopeFor>>, action: string) =>
    (await scope.authorizeAction(action))?.effect === "Allow";
  const mapError = (error: unknown): never => {
    if (error instanceof OpeningCountError)
      return fail(
        error.code === "OPENING_COUNT_NOT_FOUND"
          ? "NotFound"
          : error.code === "OPENING_COUNT_ALREADY_POSTED"
            ? "AlreadyPosted"
            : error.code === "OPENING_COUNT_STOCK_EXISTS"
              ? "StockExists"
              : error.code === "OPENING_COUNT_LINE_INVALID"
                ? "LineInvalid"
                : error.code === "OPENING_COUNT_INVALID"
                  ? "Invalid"
                  : "Conflict",
        error.lineReference,
      );
    throw error;
  };
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;

  /** Active, stock-tracked items of the Brand for the count picker, in code order. */
  async function countableItems(tx: Tx, scope: Awaited<ReturnType<typeof scopeFor>>) {
    const owner = ownerScope(scope);
    const store = createPostgresInventoryItemStore(
      { run: (work) => work(tx as unknown as InventoryItemTransaction) },
      { tenantReference: owner.tenantReference, brandReference: owner.brandReference },
    );
    const items: InventoryItemAggregate[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await store.list({
        search: null,
        lifecycle: "Active",
        afterInternalCode: after,
        limit: 200,
      });
      items.push(...result.items.filter((item) => item.trackingPolicy.stockTrackingEnabled));
      if (!result.hasMore) break;
      after = result.items.at(-1)?.internalCode ?? null;
    }
    return items;
  }

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    countReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const owner = ownerScope(scope);
        const otx = tx as unknown as OpeningCountTransaction;
        const permissions = {
          mayCount: await may(scope, "inventory.count.execute"),
          mayPost: await may(scope, "inventory.opening_balance.post"),
        };
        const { counts, postedCountReference } = await listOpeningCounts(otx, owner);
        let selected: OpeningCount | null = null;
        if (input.countReference !== null) {
          selected = await loadOpeningCount(otx, owner, input.countReference);
          if (selected === null) return fail("NotFound");
        }
        const items = await countableItems(tx, scope);
        const places = await createPostgresStockPlaceStore(
          { run: (work) => work(tx as unknown as InventoryItemTransaction) },
          owner,
        ).list();
        return {
          screenId: "INV-OPENING-COUNT" as const,
          sourceAsOf: options.persistence.now(),
          permissions,
          postedCountReference,
          counts: counts.map((count) => ({
            countReference: count.countReference,
            lifecycle: count.lifecycle,
            version: count.version,
            lineCount: count.lines.length,
            updatedAt: count.updatedAt,
            submittedBySelf: count.submittedBy === String(scope.actorReference),
          })),
          selected:
            selected === null
              ? null
              : {
                  countReference: selected.countReference,
                  lifecycle: selected.lifecycle,
                  version: selected.version,
                  lines: selected.lines,
                },
          items: items.map((item) => ({
            itemReference: item.itemReference,
            internalCode: item.internalCode,
            name: name(item.localizedNames, item.internalCode),
            unitCode: item.baseUnit.unitCode,
            ledgerPrecision: item.baseUnit.ledgerPrecision,
            lotTracking: item.trackingPolicy.lotTrackingMode,
          })),
          locations: places.locations
            .filter((location) => location.lifecycle === "Active")
            .map((location) => ({
              locationReference: location.locationReference,
              code: location.code,
              name: name(location.localizedNames, location.code),
            })),
        };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOpeningCountCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        if (
          !(await may(
            scope,
            body.action === "Post" ? "inventory.opening_balance.post" : "inventory.count.execute",
          ))
        )
          fail("PermissionDenied");
        const owner = ownerScope(scope);
        const otx = tx as unknown as OpeningCountTransaction;
        try {
          const change: OpeningCountChange =
            body.action === "Create"
              ? { action: "Create", countReference: body.countReference }
              : body.action === "SaveLines"
                ? {
                    action: "SaveLines",
                    expectedVersion: body.expectedVersion as number,
                    lines: parseOpeningCountLines(body.lines),
                  }
                : { action: body.action, expectedVersion: body.expectedVersion as number };
          const common = {
            operationReference: body.operationReference,
            countReference: body.countReference,
            change,
            actorReference: String(scope.actorReference),
            occurredAt: options.persistence.now(),
            auditReference: options.references.next(),
          };
          const result =
            body.action === "Post"
              ? await postOpeningCount(otx, owner, {
                  ...common,
                  nextReference: () => options.references.next(),
                })
              : await commitOpeningCountChange(otx, owner, common);
          return {
            status: result.status,
            countReference: result.count.countReference,
            lifecycle: result.count.lifecycle,
            version: result.count.version,
          };
        } catch (error) {
          return mapError(error);
        }
      }),
    );
  };
  return { query, command };
}
