import { sha256Hex } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import { listBrandStoreReferences } from "@bop/tenant";
import {
  assignStorePriceBook,
  createPostgresPriceBookRepository,
  createPriceBookOperationRecord,
  currentStorePriceBook,
  findStorePriceChange,
  listStorePriceChanges,
  parsePricingReference,
  recordStorePriceChange,
  type CurrencyMetadataSnapshot,
  type PriceBookSnapshot,
  type StorePriceChangeRecord,
} from "@rms/pricing";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import {
  bindMerchantPriceBookTransport,
  parseMerchantPriceBookTransport,
} from "./merchant-price-book-transport.js";
import { localBoundary } from "./merchant-prices.js";
import { derivedReference } from "./merchant-products.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31 rule 1, a
 * revision of Owner trade-off 7 the Owner may overrule): at a Brand with several Stores, the
 * Store's manager, an area manager or the owner changes this Store's price for an item directly,
 * here only, after confirming the old and the new price; who changed it is recorded. The Store's
 * price is a Store-scope entry in the Store's own Published price book, so the guest menu, quotes,
 * receipts and their evidence read it as they read any price (Store scope outranks Brand scope).
 * When the Brand Owner lists a Brand price change, every Store charges it and keeps its own Store
 * prices (`carryBrandPriceBook`). A Brand with one Store has one price: the Brand price, changed on
 * the one-page menu as before.
 */
export class MerchantStorePriceError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Invalid"
      /** Someone changed this price since it was shown: refresh, then confirm again. */
      | "Changed"
      /** The Store charges no price book yet. */
      | "NoPriceBook"
      /** One Store: its price is the Brand price (the one-page menu). */
      | "NotMultiStore"
      /** The Brand book does not price everything a Store sells. */
      | "NotCovered",
  ) {
    super(code);
    this.name = "MerchantStorePriceError";
  }
}
const fail = (code: MerchantStorePriceError["code"]): never => {
  throw new MerchantStorePriceError(code);
};
export const storePricePermission = "pricing.store_price.manage";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
/** Up to 99,999.99 per item, in cents. */
const amount = (value: unknown): string =>
  typeof value === "string" && /^(?:0|[1-9]\d{0,6})$/u.test(value) ? value : fail("Invalid");

export interface ChangeStorePriceBody {
  readonly action: "ChangeStorePrice";
  readonly operationReference: string;
  readonly sellableReference: string;
  /** The price the Store charged when the person looked (the "old" they confirmed). */
  readonly expectedAmountMinor: string;
  /** The Store's new price; null returns the item to the Brand price. */
  readonly amountMinor: string | null;
}
export function parseStorePriceCommandBody(value: unknown): ChangeStorePriceBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  if (
    r.action !== "ChangeStorePrice" ||
    Object.keys(r).sort().join(",") !==
      "action,amountMinor,expectedAmountMinor,operationReference,sellableReference"
  )
    return fail("Invalid");
  return {
    action: "ChangeStorePrice",
    operationReference: ref(r.operationReference),
    sellableReference: ref(r.sellableReference),
    expectedAmountMinor: amount(r.expectedAmountMinor),
    amountMinor: r.amountMinor === null ? null : amount(r.amountMinor),
  };
}

type Entry = PriceBookSnapshot["entries"][number];
/** An item's own price at the Store (all channels and order types), or undefined. */
const isStorePrice = (entry: Entry, store: string, sellable?: string) =>
  entry.scopeKind === "Store" &&
  String(entry.scopeReference) === store &&
  entry.channelCode === null &&
  entry.orderType === null &&
  (sellable === undefined || String(entry.sellableReference) === sellable);
/** A price book entry as the price book transport carries it. */
interface TransportEntry {
  readonly sellableReference: string;
  readonly scopeKind: Entry["scopeKind"];
  readonly scopeReference: string | null;
  readonly channelCode: string | null;
  readonly orderType: Entry["orderType"];
  readonly amountMinor: string;
  readonly effectivePeriod: Entry["effectivePeriod"];
  readonly reasonCode: string;
}
const transportEntry = (entry: Entry): TransportEntry => ({
  sellableReference: String(entry.sellableReference),
  scopeKind: entry.scopeKind,
  scopeReference: entry.scopeReference === null ? null : String(entry.scopeReference),
  channelCode: entry.channelCode === null ? null : String(entry.channelCode),
  orderType: entry.orderType,
  amountMinor: entry.amount.amountMinor.toString(),
  effectivePeriod: entry.effectivePeriod,
  reasonCode: String(entry.reasonCode),
});
/** What each item costs at the Store: its own price, else the Brand price (cents). */
export function storePrices(snapshot: PriceBookSnapshot | null, store: string) {
  const brand = new Map<string, string>();
  const own = new Map<string, string>();
  for (const entry of snapshot?.entries ?? []) {
    if (entry.scopeKind === "Brand" && entry.channelCode === null && entry.orderType === null)
      brand.set(String(entry.sellableReference), entry.amount.amountMinor.toString());
    if (isStorePrice(entry, store))
      own.set(String(entry.sellableReference), entry.amount.amountMinor.toString());
  }
  return { brand, own, charged: (sku: string) => own.get(sku) ?? brand.get(sku) ?? null };
}

type Tx = Parameters<Parameters<PersistentMerchantBffOptions["transactions"]["run"]>[0]>[0];
interface Owner {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}

/**
 * Writes a Store's own Published book (entries as given), assigns it to the Store from `at` and
 * records it. Every identity is derived from the operation, so a retry finds its record.
 */
async function writeStoreBook(
  tx: Tx,
  owner: Owner,
  currencyMetadata: CurrencyMetadataSnapshot,
  input: {
    readonly operationReference: string;
    readonly changeKind: "StorePrice" | "BrandListing";
    readonly sellableReference: string | null;
    readonly previousAmountMinor: string | null;
    readonly amountMinor: string | null;
    readonly source: { readonly priceBookReference: string; readonly versionReference: string };
    readonly entries: readonly TransportEntry[];
    readonly actorReference: string;
    readonly at: string;
  },
): Promise<StorePriceChangeRecord> {
  const step = (purpose: string) => derivedReference(input.operationReference, purpose);
  const book = step("store-price-book");
  const stableCode =
    "STORE-" + input.at.slice(0, 10).replaceAll("-", "") + "-" + book.slice(-8).toUpperCase();
  const hash = (value: string) => "sha256:" + sha256Hex(value);
  const intentHash = hash(
    JSON.stringify([
      owner.storeReference,
      input.changeKind,
      input.sellableReference,
      input.amountMinor,
      input.source.versionReference,
    ]),
  );
  const bind = (action: "CreateDraft" | "Publish", operationReference: string) =>
    bindMerchantPriceBookTransport(
      action,
      parseMerchantPriceBookTransport(action, {
        operationReference,
        priceBookReference: book,
        expectedAggregateVersion: action === "CreateDraft" ? 0 : 1,
        stableCode,
        entries: input.entries,
      }),
      { brandReference: owner.brandReference, currencyMetadata, requestedAt: input.at },
    ).candidate;
  const brandScope = () =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      owner.brandReference,
    ]);
  const repository = createPostgresPriceBookRepository({
    brandReference: owner.brandReference,
    currencyMetadata,
    transactions: { run: (work) => work(tx as never) },
    // The caller authorized this Store price change; the database checks what it may change.
    authorize: async () => {
      await brandScope();
      return true;
    },
    appendEvent: async (_tx, record) => {
      await appendEventInTransaction(tx as unknown as ConsumerTransaction, {
        eventId: record.operationReference,
        eventType: record.event.eventType,
        schemaVersion: 1,
        occurredAt: record.event.occurredAt,
        producerModule: "@rms/pricing",
        tenantId: owner.brandReference,
        aggregateType: "PriceBook",
        aggregateId: record.aggregate.priceBookReference,
        aggregateVersion: BigInt(record.aggregate.aggregateVersion),
        correlationId: record.operationReference,
        actor: { type: "Actor", actorId: input.actorReference },
        payload: { ...record.event },
        redactionClassification: "indirect_identifier",
        replayMetadata: {},
      });
    },
  });
  const audit = (action: "CREATEDRAFT" | "PUBLISH", operationReference: string) =>
    ({
      auditId: step("audit-" + action),
      brandId: owner.brandReference,
      actor: { type: "User", reference: input.actorReference },
      actionCode: "PRICING_PRICE_BOOK_" + action,
      targetType: "PricingPriceBook",
      targetId: book,
      correlationId: operationReference,
      occurredAt: input.at,
      reasonCode: "AUTHORIZED_OPERATION",
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
      afterSummary: { storePriceBook: owner.storeReference, changeKind: input.changeKind },
    }) as never;
  await brandScope();
  const create = step("store-price-create");
  const draft = bind("CreateDraft", create);
  await repository.create({
    record: createPriceBookOperationRecord("CreateDraft", create, intentHash, draft),
    audit: audit("CREATEDRAFT", create),
  });
  const publish = step("store-price-publish");
  const published = bind("Publish", publish);
  await repository.commit({
    record: createPriceBookOperationRecord("Publish", publish, intentHash, published),
    expectedAggregateVersion: 1,
    audit: audit("PUBLISH", publish),
  });
  const assigned = await assignStorePriceBook(tx as never, owner, {
    operationReference: step("store-price-assign"),
    priceBookReference: book,
    actorReference: input.actorReference,
    at: input.at,
    auditReference: step("audit-assign"),
    assignmentReference: step("store-price-assignment"),
  });
  return recordStorePriceChange(tx as never, owner, {
    operationReference: input.operationReference,
    changeKind: input.changeKind,
    sellableReference: input.sellableReference,
    previousAmountMinor: input.previousAmountMinor,
    amountMinor: input.amountMinor,
    currencyCode: currencyMetadata.currencyCode,
    priceBookReference: book,
    versionReference: String(published.versionReference),
    assignmentReference: assigned.assignment.assignmentReference,
    intentHash,
    actorReference: input.actorReference,
    changedAt: input.at,
    sourcePriceBookReference: input.source.priceBookReference,
    sourceVersionReference: input.source.versionReference,
    auditReference: step("audit-store-price"),
  });
}

const loadBook = async (
  tx: Tx,
  owner: Owner,
  currencyMetadata: CurrencyMetadataSnapshot,
  priceBookReference: string,
) => {
  const snapshot = await createPostgresPriceBookRepository({
    brandReference: owner.brandReference,
    currencyMetadata,
    transactions: { run: (work) => work(tx as never) },
    authorize: async (_tx, input) => !input.write,
    appendEvent: async () => {
      throw new Error("STORE_PRICE_READ_ONLY");
    },
  }).load(parsePricingReference(priceBookReference));
  return snapshot;
};
/** The Store's current book and what it charges. */
const storeBook = async (tx: Tx, owner: Owner, currencyMetadata: CurrencyMetadataSnapshot) => {
  const assignment = await currentStorePriceBook(tx as never, owner);
  if (assignment === null) return null;
  const snapshot = await loadBook(tx, owner, currencyMetadata, assignment.priceBookReference);
  if (snapshot === null || String(snapshot.versionReference) !== assignment.versionReference)
    return null;
  return { assignment, snapshot };
};

/**
 * A Published Brand book goes live at every Store of the Brand: a Store with prices of its own
 * gets the Brand book with those prices carried over (BrandListing), any other the Brand book
 * itself. The caller authorized the Brand assignment; `covers` checks each Store's menu.
 */
export async function carryBrandPriceBook(
  tx: Tx,
  input: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly priceBookReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly currencyMetadata: CurrencyMetadataSnapshot;
    /** Store items the book (with that Store's own prices) leaves unpriced. */
    readonly uncovered: (owner: Owner, snapshot: PriceBookSnapshot) => Promise<readonly string[]>;
  },
): Promise<readonly { readonly storeReference: string; readonly status: string }[]> {
  const stores = await listBrandStoreReferences(tx as never, input);
  const results: { storeReference: string; status: string }[] = [];
  for (const storeReference of stores) {
    const owner = { ...input, storeReference };
    const step = (purpose: string) =>
      derivedReference(input.operationReference, purpose + ":" + storeReference);
    if ((await findStorePriceChange(tx as never, owner, step("carry"))) !== null) {
      results.push({ storeReference, status: "AlreadyApplied" });
      continue;
    }
    const brand = await loadBook(tx, owner, input.currencyMetadata, input.priceBookReference);
    if (brand === null || brand.lifecycle !== "Published") return fail("NotFound");
    const current = await storeBook(tx, owner, input.currencyMetadata);
    if (
      current !== null &&
      String(current.snapshot.versionReference) === String(brand.versionReference)
    ) {
      results.push({ storeReference, status: "Unchanged" });
      continue;
    }
    const own = (current?.snapshot.entries ?? []).filter((entry) =>
      isStorePrice(entry, storeReference),
    );
    const entries = [...brand.entries.filter((entry) => entry.scopeKind === "Brand"), ...own];
    const missing = await input.uncovered(owner, { ...brand, entries });
    if (missing.length > 0) return fail("NotCovered");
    if (own.length === 0) {
      const assigned = await assignStorePriceBook(tx as never, owner, {
        operationReference: step("assign"),
        priceBookReference: input.priceBookReference,
        actorReference: input.actorReference,
        at: input.at,
        auditReference: step("audit"),
        assignmentReference: step("assignment"),
      });
      results.push({ storeReference, status: assigned.status });
      continue;
    }
    await writeStoreBook(tx, owner, input.currencyMetadata, {
      operationReference: step("carry"),
      changeKind: "BrandListing",
      sellableReference: null,
      previousAmountMinor: null,
      amountMinor: null,
      source: {
        priceBookReference: input.priceBookReference,
        versionReference: String(brand.versionReference),
      },
      entries: entries.map(transportEntry),
      actorReference: input.actorReference,
      at: input.at,
    });
    results.push({ storeReference, status: "Applied" });
  }
  return results;
}

export function createMerchantStorePrices(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  currencyMetadata: CurrencyMetadataSnapshot;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const allowed = async (action: string) =>
      (await scope.authorizeStoreAction(action))?.effect === "Allow" ||
      (await scope.authorizeAction(action))?.effect === "Allow";
    const mayChange = await allowed(storePricePermission);
    if (!mayChange && !(await allowed("pricing.price_book.read"))) fail("PermissionDenied");
    const owner = {
      tenantReference: String(scope.tenantReference),
      brandReference: String(scope.context.brand.brandReference),
      storeReference: String(scope.selectedStoreReference),
    };
    const stores = await listBrandStoreReferences(tx as never, owner);
    return {
      owner,
      actor: String(scope.actorReference),
      timeZone: scope.selectedStoreTimeZone,
      multiStore: stores.length > 1 && stores.includes(owner.storeReference),
      mayChange,
    };
  }

  const query = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const book = await storeBook(tx, s.owner, options.currencyMetadata);
          const prices = storePrices(book?.snapshot ?? null, s.owner.storeReference);
          const changes = await listStorePriceChanges(tx as never, s.owner, 20);
          return {
            sourceAsOf: options.persistence.now(),
            multiStore: s.multiStore,
            permissions: { mayChange: s.mayChange && s.multiStore },
            currencyCode: options.currencyMetadata.currencyCode,
            prices: [...new Set([...prices.brand.keys(), ...prices.own.keys()])].map((sku) => ({
              sellableReference: sku,
              brandPriceMinor: prices.brand.get(sku) ?? null,
              storePriceMinor: prices.own.get(sku) ?? null,
            })),
            changes: changes
              .filter((change) => change.changeKind === "StorePrice")
              .map((change) => ({
                sellableReference: change.sellableReference,
                previousAmountMinor: change.previousAmountMinor,
                amountMinor: change.amountMinor,
                changedBy: change.actorReference,
                changedAt: change.changedAt,
              })),
          };
        }),
      ),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseStorePriceCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          if (!s.mayChange) return fail("PermissionDenied");
          if (!s.multiStore) return fail("NotMultiStore");
          // One change of this Store's prices at a time (the assignment's own hold).
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "StorePriceBook:" + s.owner.brandReference + ":" + s.owner.storeReference,
          ]);
          const prior = await findStorePriceChange(tx as never, s.owner, body.operationReference);
          if (prior !== null) {
            // The same operation is the same change by the same person.
            if (
              prior.changeKind !== "StorePrice" ||
              prior.sellableReference !== body.sellableReference ||
              prior.actorReference !== s.actor
            )
              return fail("Invalid");
            return { status: "AlreadyApplied" as const, change: prior };
          }
          const book = await storeBook(tx, s.owner, options.currencyMetadata);
          if (book === null) return fail("NoPriceBook");
          const prices = storePrices(book.snapshot, s.owner.storeReference);
          const sku = body.sellableReference;
          const brandPrice = prices.brand.get(sku);
          if (brandPrice === undefined) return fail("NotFound");
          const charged = prices.charged(sku);
          // Someone changed it since it was shown: the old price confirmed is not the old price.
          if (charged !== body.expectedAmountMinor) return fail("Changed");
          // The Brand price itself is no price of the Store's own.
          const own = body.amountMinor === brandPrice ? null : body.amountMinor;
          if (own === (prices.own.get(sku) ?? null))
            return { status: "Unchanged" as const, amountMinor: charged };
          const at = options.persistence.now();
          const keep = book.snapshot.entries.filter(
            (entry) => !isStorePrice(entry, s.owner.storeReference, sku),
          );
          const entries: TransportEntry[] = keep.map(transportEntry);
          if (own !== null)
            entries.push({
              sellableReference: sku,
              scopeKind: "Store",
              scopeReference: s.owner.storeReference,
              channelCode: null,
              orderType: null,
              amountMinor: own,
              effectivePeriod: {
                timeZone: s.timeZone,
                effectiveFrom: localBoundary(at, s.timeZone),
                effectiveUntil: null,
              } as unknown as Entry["effectivePeriod"],
              reasonCode: "STORE_PRICE",
            });
          const change = await writeStoreBook(tx, s.owner, options.currencyMetadata, {
            operationReference: body.operationReference,
            changeKind: "StorePrice",
            sellableReference: sku,
            previousAmountMinor: charged,
            amountMinor: own,
            source: {
              priceBookReference: book.assignment.priceBookReference,
              versionReference: book.assignment.versionReference,
            },
            entries,
            actorReference: s.actor,
            at,
          });
          return { status: "Applied" as const, change };
        }),
      ),
    );
  };
  return { query, command };
}
