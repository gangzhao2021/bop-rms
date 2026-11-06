import { listBrandStoreReferences } from "@bop/tenant";
import { listBrandSkuChoices, listStoreMenuSellables } from "@rms/catalog";
import {
  assignStorePriceBook,
  createPostgresPriceBookRepository,
  currentStorePriceBook,
  listBrandPriceBooks,
  listPriceBookDraftPurposes,
  listStorePriceBookAssignments,
  recordPriceBookDraftPurpose,
  parsePricingReference,
  PriceBookWorkflowError,
  StorePriceBookError,
  type CurrencyMetadataSnapshot,
  type PriceBookSnapshot,
  type PriceResolutionContext,
} from "@rms/pricing";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import {
  createMerchantPriceBookCommands,
  type PriceBookAfterCommand,
} from "./merchant-price-book-commands.js";
import { derivedReference } from "./merchant-products.js";
import { createPriceBookDraftAuthorSource } from "./price-book-draft-author-source.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import {
  brandPriceDigest,
  carryBrandPriceBook,
  MerchantStorePriceError,
  storeBook,
  storePrices,
} from "./merchant-store-prices.js";
import {
  brandOwnerAuthority,
  merchantBrandApprovalHolders,
  merchantBrandSoleOperatorGate,
  MerchantSingleStoreListingError,
  MerchantSoleOperatorGateError,
} from "./merchant-sole-operator.js";
import { staffContentName } from "./staff-content-locale.js";
import { onlyRefusal } from "./merchant-failure.js";

/**
 * WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: PRICE-BOOK-LIST / PRICE-BOOK-EDITOR. Brand price books are drafted
 * (pricing.price_book.update), published only by someone other than the draft's author who holds
 * pricing.price_book.approve, and a Published book is then assigned to the selected Store (also
 * pricing.price_book.approve), ending its current assignment. A Store's book must price every item on
 * its current menus for pickup and dine-in. Published books are never changed: a price change is a
 * new book. Prices are per size (SKU) for the whole Brand, in cents.
 */
export class MerchantPriceError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "CodeTaken"
      | "ApprovalRequired"
      | "NotCovered"
      | "NotPublished"
      | "AlreadyAssigned"
      | "Lifecycle"
      | "Invalid"
      /** WP-2423 Q19: the author asked to publish alone, but sole operator is not in effect. */
      | "SoleOperatorNotInEffect"
      /** WP-2423 item 8 ⑥: publishing without review needs a Brand with exactly one store. */
      | "NotSingleStore"
      /** WP-2423 Q19: publishing alone needs a second-factor check in the last 15 minutes. */
      | "NeedsReverification"
      /**
       * WP-2423 M71: the menu page already has its own price draft open (one per Brand: "List it"
       * lists it). Prices changed on a dish go into it.
       */
      | "DraftOpen"
      /**
       * WP-2423 M71: the prices in effect have changed since this draft was started (another
       * change went live): publishing it would undo that change. "Apply my changes to the current
       * prices" (Rebase) starts it again from them.
       */
      | "PricesMoved",
    readonly sellableReferences: readonly string[] = [],
  ) {
    super(code);
    this.name = "MerchantPriceError";
  }
}
const fail = (code: MerchantPriceError["code"], sellables: readonly string[] = []): never => {
  throw new MerchantPriceError(code, sellables);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const version = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");
/** Up to 99,999.99 per item. */
const amount = (value: unknown): string =>
  typeof value === "string" && /^(?:0|[1-9]\d{0,6})$/u.test(value) ? value : fail("Invalid");
const orderTypes = ["Pickup", "DineIn"] as const;
const quoteChannel = "CUSTOMER_WEB";

export interface PriceInput {
  readonly sellableReference: string;
  readonly amountMinor: string;
}
/**
 * WP-2423 M71: why a draft is started — the menu page's own price draft, listed with the menu
 * (MenuListing), or a price change on the Prices page, published there (PriceChange).
 */
export type PriceDraftPurpose = "MenuListing" | "PriceChange";
export type PriceCommandBody =
  | {
      readonly action: "CreateDraft";
      readonly operationReference: string;
      readonly copyFrom: string | null;
      readonly purpose: PriceDraftPurpose;
    }
  | {
      /**
       * WP-2423 M71: a draft whose prices in effect moved since it was started is started again
       * from the prices in effect now, with the same changes (the draft's own changes against what
       * it was started from), and the old draft is discarded.
       */
      readonly action: "Rebase";
      readonly operationReference: string;
      readonly priceBookReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly priceBookReference: string;
      readonly expectedAggregateVersion: number;
      readonly prices: readonly PriceInput[];
    }
  | {
      readonly action: "Publish" | "Discard";
      readonly operationReference: string;
      readonly priceBookReference: string;
      readonly expectedAggregateVersion: number;
      /** WP-2423 Q19: the author publishes alone as sole operator (explicitly confirmed). */
      /** WP-2423 item 8 ⑥: SingleStoreListing — the author publishes at a single store. */
      readonly approvalMode?: "SoleOperator" | "SingleStoreListing";
    }
  | {
      readonly action: "AssignToStore";
      readonly operationReference: string;
      readonly priceBookReference: string;
    };
export function parsePriceCommandBody(value: unknown): PriceCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  // WP-2423 M124/M150: the server names the draft (staff never type a code); a client that still
  // sends one is refused.
  if (
    r.action === "CreateDraft" &&
    keys === "action,copyFrom,operationReference,purpose" &&
    (r.purpose === "MenuListing" || r.purpose === "PriceChange")
  )
    return {
      action: "CreateDraft",
      operationReference: ref(r.operationReference),
      copyFrom: r.copyFrom === null ? null : ref(r.copyFrom),
      purpose: r.purpose,
    };
  if (
    r.action === "Rebase" &&
    keys === "action,expectedAggregateVersion,operationReference,priceBookReference"
  )
    return {
      action: "Rebase",
      operationReference: ref(r.operationReference),
      priceBookReference: ref(r.priceBookReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
    };
  if (
    r.action === "SaveDraft" &&
    keys === "action,expectedAggregateVersion,operationReference,priceBookReference,prices"
  ) {
    if (!Array.isArray(r.prices) || r.prices.length > 2000) return fail("Invalid");
    const prices = r.prices.map((candidate: unknown) => {
      const p = candidate as Record<string, unknown> | null;
      if (
        p === null ||
        typeof p !== "object" ||
        Object.keys(p).sort().join(",") !== "amountMinor,sellableReference"
      )
        return fail("Invalid");
      return { sellableReference: ref(p.sellableReference), amountMinor: amount(p.amountMinor) };
    });
    if (new Set(prices.map((p) => p.sellableReference)).size !== prices.length)
      return fail("Invalid");
    return {
      action: "SaveDraft",
      operationReference: ref(r.operationReference),
      priceBookReference: ref(r.priceBookReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
      prices,
    };
  }
  if (
    (r.action === "Publish" || r.action === "Discard") &&
    keys === "action,expectedAggregateVersion,operationReference,priceBookReference"
  )
    return {
      action: r.action,
      operationReference: ref(r.operationReference),
      priceBookReference: ref(r.priceBookReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
    };
  if (
    r.action === "Publish" &&
    keys === "action,approvalMode,expectedAggregateVersion,operationReference,priceBookReference" &&
    (r.approvalMode === "SoleOperator" || r.approvalMode === "SingleStoreListing")
  )
    return {
      action: "Publish",
      operationReference: ref(r.operationReference),
      priceBookReference: ref(r.priceBookReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
      approvalMode: r.approvalMode,
    };
  if (r.action === "AssignToStore" && keys === "action,operationReference,priceBookReference")
    return {
      action: "AssignToStore",
      operationReference: ref(r.operationReference),
      priceBookReference: ref(r.priceBookReference),
    };
  return fail("Invalid");
}

/** The instant as a local boundary of the Store's time zone (exact offset at that instant). */
export function localBoundary(instant: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const localDateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${instant.slice(20, 23)}`;
  return {
    instant,
    localDateTime,
    utcOffsetMinutes: (Date.parse(localDateTime + "Z") - Date.parse(instant)) / 60000,
  };
}

/** WP-2423 M150: the instant's calendar date at the Store (YYYYMMDD), never UTC's. */
export function storeLocalDate(instant: string, timeZone: string): string {
  return localBoundary(instant, timeZone).localDateTime.slice(0, 10).replaceAll("-", "");
}

/**
 * WP-2423 M124/M150: the server names a draft — the menu page's MENU-…, the Prices page's
 * PRICES-… — by the Store's date and its operation (a retry names it the same).
 */
export function priceDraftCode(
  purpose: PriceDraftPurpose,
  operationReference: string,
  at: string,
  timeZone: string,
): string {
  return (
    (purpose === "MenuListing" ? "MENU-" : "PRICES-") +
    storeLocalDate(at, timeZone) +
    "-" +
    derivedReference(operationReference, "code").replaceAll("-", "").slice(-6).toUpperCase()
  );
}

const workflowErrors: Partial<Record<PriceBookWorkflowError["code"], MerchantPriceError["code"]>> =
  {
    PRICE_BOOK_INPUT_INVALID: "Invalid",
    PRICE_BOOK_PERMISSION_DENIED: "PermissionDenied",
    PRICE_BOOK_APPROVAL_REQUIRED: "ApprovalRequired",
    PRICE_BOOK_VERSION_CONFLICT: "Conflict",
    PRICE_BOOK_IDEMPOTENCY_CONFLICT: "Conflict",
    PRICE_BOOK_CODE_CONFLICT: "CodeTaken",
    PRICE_BOOK_LIFECYCLE_CONFLICT: "Lifecycle",
    PRICE_BOOK_COVERAGE_INVALID: "NotCovered",
  };
const assignmentErrors: Record<StorePriceBookError["code"], MerchantPriceError["code"]> = {
  STORE_PRICE_BOOK_NOT_FOUND: "NotFound",
  STORE_PRICE_BOOK_NOT_PUBLISHED: "NotPublished",
  STORE_PRICE_BOOK_ALREADY_ASSIGNED: "AlreadyAssigned",
  STORE_PRICE_BOOK_IDEMPOTENCY_CONFLICT: "Conflict",
};

export function createMerchantPrices(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  currencyMetadata: CurrencyMetadataSnapshot;
  /** Locale used for names (the Brand's menu locale). */
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  type ReadTx = Parameters<typeof listBrandPriceBooks>[0];
  const reads = (tx: unknown) => tx as ReadTx;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(onlyRefusal(() => fail("PermissionDenied")));
  async function scopeFor(tx: unknown, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx as Tx, sessionCookie, sessionReference).catch(
      onlyRefusal(() => fail("PermissionDenied")),
    );
    const may = async (action: string) => (await scope.authorizeAction(action))?.effect === "Allow";
    const permissions = {
      mayRead: await may("pricing.price_book.read"),
      mayEdit: await may("pricing.price-book.manage"),
      mayApprove: await may("pricing.price-book.approve"),
    };
    if (!permissions.mayRead) fail("PermissionDenied");
    return {
      owner: {
        tenantReference: String(scope.tenantReference),
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.selectedStoreReference),
      },
      timeZone: scope.selectedStoreTimeZone,
      actor: String(scope.actorReference),
      permissions,
      mayApproveNow: async () => await may("pricing.price-book.approve"),
    };
  }
  type Owner = Awaited<ReturnType<typeof scopeFor>>["owner"];
  const repository = (tx: unknown, owner: Owner) =>
    createPostgresPriceBookRepository({
      brandReference: owner.brandReference,
      currencyMetadata: options.currencyMetadata,
      transactions: { run: (work) => work(tx as never) },
      // Reads only; the caller admitted pricing.price_book.read.
      authorize: async (_tx, input) => !input.write,
      appendEvent: async () => {
        throw new Error("PRICE_READ_ONLY");
      },
    });
  const loadBook = async (tx: unknown, owner: Owner, book: string) => {
    const snapshot = await repository(tx, owner).load(parsePricingReference(book));
    await reads(tx).query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
      [owner.brandReference],
    );
    return snapshot;
  };
  /** Sizes the Brand sells, with product and size names. */
  const sellables = async (tx: unknown, owner: Owner) =>
    (await listBrandSkuChoices(reads(tx), { brandReference: owner.brandReference })).map((sku) => ({
      sellableReference: sku.skuReference,
      skuCode: sku.skuCode,
      productReference: sku.productReference,
      productName: staffContentName(sku.productLocalizedNames, options.locale),
      sizeName: staffContentName(sku.localizedNames, options.locale),
      active: sku.active,
    }));
  const bookView = (snapshot: PriceBookSnapshot) => ({
    priceBookReference: snapshot.priceBookReference,
    versionReference: snapshot.versionReference,
    stableCode: snapshot.stableCode,
    lifecycle: snapshot.lifecycle,
    aggregateVersion: snapshot.aggregateVersion,
    createdAt: snapshot.createdAt,
    prices: snapshot.entries
      .filter(
        (entry) =>
          entry.scopeKind === "Brand" && entry.channelCode === null && entry.orderType === null,
      )
      .map((entry) => ({
        sellableReference: entry.sellableReference,
        amountMinor: entry.amount.amountMinor.toString(),
      })),
    otherEntries: snapshot.entries.filter(
      (entry) =>
        !(entry.scopeKind === "Brand" && entry.channelCode === null && entry.orderType === null),
    ).length,
  });
  /** Store items this book does not price for pickup or dine-in (sellable references). */
  const uncovered = async (
    tx: unknown,
    owner: Owner,
    snapshot: PriceBookSnapshot,
    at: string,
  ): Promise<readonly string[]> => {
    const menu = await listStoreMenuSellables(reads(tx), owner);
    const missing = new Set<string>();
    for (const sellable of menu)
      for (const orderType of orderTypes)
        if (
          !snapshot.entries.some(
            (entry) =>
              entry.sellableReference === sellable &&
              (entry.scopeKind === "Brand" ||
                (entry.scopeKind === "Store" && entry.scopeReference === owner.storeReference)) &&
              (entry.channelCode === null || entry.channelCode === quoteChannel) &&
              (entry.orderType === null || entry.orderType === orderType) &&
              entry.effectivePeriod.effectiveFrom.instant <= at &&
              (entry.effectivePeriod.effectiveUntil === null ||
                entry.effectivePeriod.effectiveUntil.instant > at),
          )
        )
          missing.add(sellable);
    return [...missing];
  };

  /**
   * WP-2423 M71: the Brand prices in effect at each Store of the Brand (a Store with no book yet
   * has none), as digests.
   */
  const liveDigests = async (tx: unknown, owner: Owner) => {
    const stores = await listBrandStoreReferences(reads(tx), owner);
    const found: { storeReference: string; digest: string; priceBookReference: string }[] = [];
    for (const storeReference of stores.includes(owner.storeReference)
      ? stores
      : [owner.storeReference, ...stores]) {
      const book = await storeBook(
        tx as never,
        { ...owner, storeReference },
        options.currencyMetadata,
      );
      if (book !== null)
        found.push({
          storeReference,
          digest: brandPriceDigest(book.snapshot),
          priceBookReference: book.assignment.priceBookReference,
        });
    }
    await reads(tx).query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
      [owner.brandReference],
    );
    return found;
  };
  /**
   * WP-2423 M71: has another change gone live since this draft was started? At some Store the
   * Brand prices in effect are neither what the draft started from nor the draft's own (a replay
   * of its own listing). A draft with no record of its start (made before it was recorded, or not
   * by these pages) is not judged.
   */
  const movedSinceStart = async (tx: unknown, owner: Owner, snapshot: PriceBookSnapshot) => {
    const purpose = (await listPriceBookDraftPurposes(reads(tx), owner)).find(
      (p) => p.priceBookReference === String(snapshot.priceBookReference),
    );
    if (purpose === undefined || purpose.sourceBrandDigest === null) return false;
    const own = brandPriceDigest(snapshot);
    return (await liveDigests(tx, owner)).some(
      (live) => live.digest !== purpose.sourceBrandDigest && live.digest !== own,
    );
  };
  /** Each draft's purpose, who started it and whether prices moved since (list and editor). */
  const draftFacts = async (tx: unknown, owner: Owner, snapshot: PriceBookSnapshot | null) => {
    if (snapshot === null || snapshot.lifecycle !== "Draft")
      return { purpose: null, movedSinceStart: false };
    const purpose = (await listPriceBookDraftPurposes(reads(tx), owner)).find(
      (p) => p.priceBookReference === String(snapshot.priceBookReference),
    );
    return {
      purpose: purpose?.purpose ?? null,
      movedSinceStart: await movedSinceStart(tx, owner, snapshot),
    };
  };

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    priceBookReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const at = options.persistence.now();
          const assignment = await currentStorePriceBook(reads(tx), s.owner);
          const history = await listStorePriceBookAssignments(reads(tx), s.owner, 10);
          const menuSellables = await listStoreMenuSellables(reads(tx), s.owner);
          // WP-2423 M70: whether this Brand has several Stores and whether this person lists a
          // Brand price for all of them (one Store: price approval; several: Brand Owner too).
          const stores = await listBrandStoreReferences(reads(tx), s.owner);
          const multiStore = stores.length > 1 && stores.includes(s.owner.storeReference);
          const mayListForAllStores =
            s.permissions.mayApprove &&
            (!multiStore ||
              (
                await merchantBrandApprovalHolders(tx as never, {
                  brandReference: s.owner.brandReference,
                  permissionCode: brandOwnerAuthority,
                  observedAt: at,
                })
              ).includes(s.actor));
          await reads(tx).query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [s.owner.brandReference],
          );
          const base = {
            allStores: { multiStore, storeCount: stores.length, mayList: mayListForAllStores },
            sourceAsOf: at,
            viewer: s.actor,
            permissions: s.permissions,
            currencyCode: options.currencyMetadata.currencyCode,
            storeAssignment: assignment,
            assignmentHistory: history,
            sellables: await sellables(tx, s.owner),
            menuSellables,
          };
          if (input.priceBookReference !== null) {
            const snapshot = await loadBook(tx, s.owner, input.priceBookReference);
            if (snapshot === null) return fail("NotFound");
            const author =
              snapshot.lifecycle === "Draft"
                ? await createPriceBookDraftAuthorSource({
                    brandReference: s.owner.brandReference,
                    repository: () => repository(tx, s.owner),
                  }).load(tx as never, snapshot.priceBookReference)
                : null;
            // WP-2423 Q19: the author who may approve sees whether they may publish alone and why.
            const gate =
              author !== null &&
              String(author.actorReference) === s.actor &&
              s.permissions.mayApprove
                ? await merchantBrandSoleOperatorGate(tx as never, {
                    tenantReference: s.owner.tenantReference,
                    brandReference: s.owner.brandReference,
                    storeReference: s.owner.storeReference,
                    actorReference: s.actor,
                    permissionCode: "pricing.price-book.approve",
                    observedAt: at,
                    allowed: s.mayApproveNow,
                  })
                : null;
            await reads(tx).query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
              [s.owner.brandReference],
            );
            return {
              screenId: "PRICE-BOOK-EDITOR" as const,
              ...base,
              book: bookView(snapshot),
              ...(await draftFacts(tx, s.owner, snapshot)),
              draftAuthor: author?.actorReference ?? null,
              soleOperator:
                gate === null
                  ? null
                  : {
                      status: gate.status,
                      otherApprovers: gate.otherApprovers,
                      verifiedUntil: gate.verifiedUntil,
                    },
              uncovered:
                snapshot.lifecycle === "Archived" ? [] : await uncovered(tx, s.owner, snapshot, at),
            };
          }
          const listed = await listBrandPriceBooks(reads(tx), s.owner);
          const purposes = new Map(
            (await listPriceBookDraftPurposes(reads(tx), s.owner)).map((p) => [
              p.priceBookReference,
              p,
            ]),
          );
          // WP-2423 M71: why each draft was started, by whom, and whether prices moved since.
          const books = [];
          for (const book of listed) {
            const purpose = purposes.get(book.priceBookReference);
            const snapshot =
              book.lifecycle === "Draft" && purpose !== undefined
                ? await loadBook(tx, s.owner, book.priceBookReference)
                : null;
            books.push({
              ...book,
              purpose: purpose?.purpose ?? null,
              startedBy: purpose?.actorReference ?? null,
              movedSinceStart:
                snapshot === null ? false : await movedSinceStart(tx, s.owner, snapshot),
            });
          }
          // WP-2423 Q19: whether someone who may approve may publish their own book alone, so
          // the page says who publishes (another person, or the sole operator after verifying).
          const gate = s.permissions.mayApprove
            ? await merchantBrandSoleOperatorGate(tx as never, {
                tenantReference: s.owner.tenantReference,
                brandReference: s.owner.brandReference,
                storeReference: s.owner.storeReference,
                actorReference: s.actor,
                permissionCode: "pricing.price-book.approve",
                observedAt: at,
                allowed: s.mayApproveNow,
              })
            : null;
          return {
            screenId: "PRICE-BOOK-LIST" as const,
            ...base,
            books,
            soleOperator:
              gate === null
                ? null
                : {
                    status: gate.status,
                    otherApprovers: gate.otherApprovers,
                    verifiedUntil: gate.verifiedUntil,
                  },
          };
        }),
      ),
    );
  };

  const commandsFor = (storeReference: string) =>
    createMerchantPriceBookCommands({
      merchant: options.persistence,
      authentication: options.authentication,
      currencyMetadata: options.currencyMetadata,
      auditReference: (operation) => derivedReference(operation, "audit"),
      validateFacts: async (tx, snapshot) => {
        const known = new Map(
          (await listBrandSkuChoices(reads(tx), { brandReference: snapshot.brandReference })).map(
            (sku) => [sku.skuReference, sku],
          ),
        );
        return snapshot.entries.every(
          (entry) =>
            known.has(entry.sellableReference) &&
            entry.scopeKind === "Brand" &&
            entry.channelCode === null &&
            entry.orderType === null &&
            entry.amount.currencyCode === options.currencyMetadata.currencyCode,
        );
      },
      // Publication: every priced size resolves for pickup and dine-in at this Store now.
      coverageContexts: async (_tx, snapshot) => {
        const at = options.persistence.now();
        return [...new Set(snapshot.entries.map((entry) => entry.sellableReference))].flatMap(
          (sellableReference) =>
            orderTypes.map(
              (orderType) =>
                ({
                  brandReference: snapshot.brandReference,
                  storeReference,
                  storeGroupReference: null,
                  regionReference: null,
                  sellableReference,
                  channelCode: quoteChannel,
                  orderType,
                  currencyCode: options.currencyMetadata.currencyCode,
                  evaluatedAt: at,
                }) as unknown as PriceResolutionContext,
            ),
        );
      },
      ...(options.resolveScope === undefined ? {} : { resolveScope: options.resolveScope }),
    });

  /**
   * WP-2423 M71: why the draft was started and the Brand prices in effect then, in its CreateDraft
   * transaction. The menu page has one draft of its own at a time.
   */
  const recordPurpose =
    (
      owner: Owner,
      after: { readonly purpose: PriceDraftPurpose; readonly replacing: string | null },
    ): PriceBookAfterCommand =>
    async (transaction, applied) => {
      const here = { ...owner, storeReference: applied.storeReference };
      if (after.purpose === "MenuListing") {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "MenuListingDraft:" + applied.brandReference,
        ]);
        const open = new Set(
          (await listBrandPriceBooks(reads(transaction), here))
            .filter((book) => book.lifecycle === "Draft")
            .map((book) => book.priceBookReference),
        );
        if (
          (await listPriceBookDraftPurposes(reads(transaction), here)).some(
            (p) =>
              p.purpose === "MenuListing" &&
              open.has(p.priceBookReference) &&
              p.priceBookReference !== applied.priceBookReference &&
              p.priceBookReference !== after.replacing,
          )
        )
          fail("DraftOpen");
      }
      const live = await storeBook(transaction as never, here, options.currencyMetadata);
      await recordPriceBookDraftPurpose(reads(transaction), {
        brandReference: applied.brandReference,
        priceBookReference: applied.priceBookReference,
        purpose: after.purpose,
        sourcePriceBookReference: live?.assignment.priceBookReference ?? null,
        sourceBrandDigest: brandPriceDigest(live?.snapshot ?? null),
        operationReference: applied.operationReference,
        actorReference: applied.actorReference,
        recordedAt: applied.observedAt,
      });
    };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parsePriceCommandBody(input.body);
    const current = await session(input);
    // Prepare the owner command (and refuse what the person may not do) in a read transaction.
    const prepared = await retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          if (
            ((body.action === "CreateDraft" ||
              body.action === "SaveDraft" ||
              body.action === "Rebase" ||
              body.action === "Discard") &&
              !s.permissions.mayEdit) ||
            ((body.action === "Publish" || body.action === "AssignToStore") &&
              !s.permissions.mayApprove)
          )
            fail("PermissionDenied");
          if (body.action === "AssignToStore") return { s, transport: null };
          // A retried operation returns its recorded result.
          const prior = (
            await reads(tx).query(
              "SELECT price_book_id::text book FROM rms_pricing.price_book_operation_record WHERE brand_id=$1 AND operation_id=$2",
              [s.owner.brandReference, body.operationReference],
            )
          ).rows[0];
          if (prior !== undefined) return { s, transport: null, replayed: String(prior.book) };
          const at = options.persistence.now();
          const from = localBoundary(at, s.timeZone);
          const period = { timeZone: s.timeZone, effectiveFrom: from, effectiveUntil: null };
          const entry = (
            sellableReference: string,
            amountMinor: string,
            effectivePeriod = period,
          ) => ({
            sellableReference,
            scopeKind: "Brand",
            scopeReference: null,
            channelCode: null,
            orderType: null,
            amountMinor,
            effectivePeriod,
            reasonCode: "BASE_PRICE",
          });
          if (body.action === "CreateDraft") {
            const source =
              body.copyFrom === null ? null : await loadBook(tx, s.owner, body.copyFrom);
            if (body.copyFrom !== null && source === null) fail("NotFound");
            return {
              s,
              action: "CreateDraft" as const,
              after: { purpose: body.purpose, replacing: null },
              transport: {
                operationReference: body.operationReference,
                priceBookReference: derivedReference(body.operationReference, "price-book"),
                expectedAggregateVersion: 0,
                stableCode: priceDraftCode(body.purpose, body.operationReference, at, s.timeZone),
                entries: (source?.entries ?? [])
                  .filter(
                    (e) =>
                      e.scopeKind === "Brand" && e.channelCode === null && e.orderType === null,
                  )
                  .map((e) => entry(e.sellableReference, e.amount.amountMinor.toString())),
              },
            };
          }
          if (body.action === "Rebase") {
            // WP-2423 M71: this draft's own changes (against what it was started from), on top of
            // the prices in effect now, as a new draft for the same purpose; the old one goes.
            const create = derivedReference(body.operationReference, "rebase-create");
            const made = derivedReference(create, "price-book");
            const old = await loadBook(tx, s.owner, body.priceBookReference);
            if (old === null) return fail("NotFound");
            if (old.lifecycle !== "Draft") {
              if ((await loadBook(tx, s.owner, made)) !== null)
                return { s, transport: null, replayed: made };
              return fail("Lifecycle");
            }
            if (old.aggregateVersion !== body.expectedAggregateVersion) fail("Conflict");
            const purpose =
              (await listPriceBookDraftPurposes(reads(tx), s.owner)).find(
                (p) => p.priceBookReference === body.priceBookReference,
              ) ?? fail("Invalid");
            const started =
              purpose.sourcePriceBookReference === null
                ? null
                : await loadBook(tx, s.owner, purpose.sourcePriceBookReference);
            if (
              purpose.sourceBrandDigest === null ||
              brandPriceDigest(started) !== purpose.sourceBrandDigest
            )
              fail("Invalid");
            const from = storePrices(started, "").brand;
            const prices = storePrices(
              (await storeBook(tx as never, s.owner, options.currencyMetadata))?.snapshot ?? null,
              "",
            ).brand;
            for (const [sku, amountMinor] of storePrices(old, "").brand)
              if (from.get(sku) !== amountMinor) prices.set(sku, amountMinor);
            await reads(tx).query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
              [s.owner.brandReference],
            );
            return {
              s,
              action: "CreateDraft" as const,
              after: { purpose: purpose.purpose, replacing: body.priceBookReference },
              transport: {
                operationReference: create,
                priceBookReference: made,
                expectedAggregateVersion: 0,
                stableCode: priceDraftCode(purpose.purpose, create, at, s.timeZone),
                entries: [...prices].map(([sku, amountMinor]) => entry(sku, amountMinor)),
              },
              discard: {
                operationReference: derivedReference(body.operationReference, "rebase-discard"),
                priceBookReference: old.priceBookReference,
                expectedAggregateVersion: old.aggregateVersion,
                stableCode: old.stableCode,
                entries: old.entries.map((e) => ({
                  sellableReference: e.sellableReference,
                  scopeKind: e.scopeKind,
                  scopeReference: e.scopeReference,
                  channelCode: e.channelCode,
                  orderType: e.orderType,
                  amountMinor: e.amount.amountMinor.toString(),
                  effectivePeriod: e.effectivePeriod,
                  reasonCode: e.reasonCode,
                })),
              },
            };
          }
          const book = await loadBook(tx, s.owner, body.priceBookReference);
          if (book === null) return fail("NotFound");
          if (book.aggregateVersion !== body.expectedAggregateVersion) fail("Conflict");
          if (book.lifecycle !== "Draft") fail("Lifecycle");
          const keep = book.entries.map((e) => ({
            sellableReference: e.sellableReference,
            scopeKind: e.scopeKind,
            scopeReference: e.scopeReference,
            channelCode: e.channelCode,
            orderType: e.orderType,
            amountMinor: e.amount.amountMinor.toString(),
            effectivePeriod: e.effectivePeriod,
            reasonCode: e.reasonCode,
          }));
          if (body.action === "SaveDraft") {
            // Unchanged prices keep their entry; changed and new prices start now.
            const entries = body.prices.map((price) => {
              const existing = keep.find(
                (e) =>
                  e.sellableReference === price.sellableReference &&
                  e.scopeKind === "Brand" &&
                  e.channelCode === null &&
                  e.orderType === null,
              );
              return existing !== undefined && existing.amountMinor === price.amountMinor
                ? existing
                : entry(price.sellableReference, price.amountMinor);
            });
            return {
              s,
              action: "ReplaceDraft" as const,
              transport: {
                operationReference: body.operationReference,
                priceBookReference: book.priceBookReference,
                expectedAggregateVersion: book.aggregateVersion,
                stableCode: book.stableCode,
                entries,
              },
            };
          }
          if (body.action === "Publish" && book.entries.length === 0) fail("NotCovered");
          // WP-2423 M71: never published over a change that went live after it was started.
          if (body.action === "Publish" && (await movedSinceStart(tx, s.owner, book)))
            fail("PricesMoved");
          return {
            s,
            action: body.action === "Publish" ? ("Publish" as const) : ("Archive" as const),
            transport: {
              operationReference: body.operationReference,
              priceBookReference: book.priceBookReference,
              expectedAggregateVersion: book.aggregateVersion,
              stableCode: book.stableCode,
              entries: keep,
            },
          };
        }),
      ),
    );
    if ("replayed" in prepared && prepared.replayed !== undefined)
      return { status: "AlreadyApplied", priceBookReference: prepared.replayed };
    if (prepared.transport !== null && "action" in prepared) {
      try {
        const commands = commandsFor(prepared.s.owner.storeReference);
        const after = "after" in prepared ? prepared.after : undefined;
        const result = await commands.executeTransport(
          {
            sessionCookie: input.sessionCookie,
            csrf: input.csrf,
            action: prepared.action,
            input: prepared.transport,
            ...(body.action === "Publish" && body.approvalMode !== undefined
              ? { approvalMode: body.approvalMode }
              : {}),
          },
          after === undefined ? undefined : recordPurpose(prepared.s.owner, after),
        );
        if ("discard" in prepared && prepared.discard !== undefined)
          await commands.executeTransport({
            sessionCookie: input.sessionCookie,
            csrf: input.csrf,
            action: "Archive",
            input: prepared.discard,
          });
        return {
          status: result.status,
          priceBookReference: result.aggregate.priceBookReference,
          aggregateVersion: result.aggregate.aggregateVersion,
          lifecycle: result.aggregate.lifecycle,
        };
      } catch (error) {
        if (error instanceof PriceBookWorkflowError)
          return fail(workflowErrors[error.code] ?? "Invalid");
        if (error instanceof MerchantSingleStoreListingError)
          return fail(error.code === "NotSingleStore" ? "NotSingleStore" : "PermissionDenied");
        if (error instanceof MerchantSoleOperatorGateError)
          return fail(
            error.code === "NotInEffect" ? "SoleOperatorNotInEffect" : "NeedsReverification",
          );
        throw error;
      }
    }
    if (body.action !== "AssignToStore") return fail("Invalid");
    // Assignment: the book must price everything the Store sells, then it replaces the current one.
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          if (!s.permissions.mayApprove) fail("PermissionDenied");
          const at = options.persistence.now();
          // WP-2423 M71: one Brand price assignment at a time, and never one over a change that
          // went live after this book was started.
          await reads(tx).query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "BrandPriceAssign:" + s.owner.brandReference,
          ]);
          const snapshot = await loadBook(tx, s.owner, body.priceBookReference);
          if (snapshot === null) return fail("NotFound");
          if (await movedSinceStart(tx, s.owner, snapshot)) fail("PricesMoved");
          // DEC-BRAND-MULTI-STORE segment 9 (coordinator 2026-10-31 rule 1): at a Brand with
          // several Stores, a Brand price book goes live at every Store, each keeping its own
          // Store prices.
          const stores = await listBrandStoreReferences(reads(tx), s.owner);
          if (stores.length > 1 && stores.includes(s.owner.storeReference)) {
            if (snapshot.lifecycle !== "Published") fail("NotPublished");
            try {
              const results = await carryBrandPriceBook(tx as never, {
                tenantReference: s.owner.tenantReference,
                brandReference: s.owner.brandReference,
                priceBookReference: body.priceBookReference,
                operationReference: body.operationReference,
                actorReference: s.actor,
                at,
                timeZone: s.timeZone,
                currencyMetadata: options.currencyMetadata,
                uncovered: (owner, book) => uncovered(tx, owner, book, at),
              });
              const here = await currentStorePriceBook(reads(tx), s.owner);
              return {
                status: results.some((r) => r.status === "Applied") ? "Applied" : "AlreadyApplied",
                assignment: here,
                stores: results,
              };
            } catch (error) {
              if (error instanceof MerchantStorePriceError)
                return fail(error.code === "NotCovered" ? "NotCovered" : "NotFound");
              if (error instanceof StorePriceBookError) return fail(assignmentErrors[error.code]);
              throw error;
            }
          }
          const missing = await uncovered(tx, s.owner, snapshot, at);
          if (missing.length > 0) fail("NotCovered", missing);
          try {
            const result = await assignStorePriceBook(reads(tx), s.owner, {
              operationReference: body.operationReference,
              priceBookReference: body.priceBookReference,
              actorReference: s.actor,
              at,
              auditReference: derivedReference(body.operationReference, "audit"),
              assignmentReference: derivedReference(body.operationReference, "assignment"),
            });
            return { status: result.status, assignment: result.assignment };
          } catch (error) {
            if (error instanceof StorePriceBookError) return fail(assignmentErrors[error.code]);
            throw error;
          }
        }),
      ),
    );
  };
  return { query, command };
}
