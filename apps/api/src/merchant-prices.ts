import { listBrandSkuChoices, listStoreMenuSellables } from "@rms/catalog";
import {
  assignStorePriceBook,
  createPostgresPriceBookRepository,
  currentStorePriceBook,
  listBrandPriceBooks,
  listStorePriceBookAssignments,
  parsePricingReference,
  PriceBookWorkflowError,
  StorePriceBookError,
  type CurrencyMetadataSnapshot,
  type PriceBookSnapshot,
  type PriceResolutionContext,
} from "@rms/pricing";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { createMerchantPriceBookCommands } from "./merchant-price-book-commands.js";
import { derivedReference } from "./merchant-products.js";
import { createPriceBookDraftAuthorSource } from "./price-book-draft-author-source.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

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
      | "Invalid",
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
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
/** Up to 99,999.99 per item. */
const amount = (value: unknown): string =>
  typeof value === "string" && /^(?:0|[1-9]\d{0,6})$/u.test(value) ? value : fail("Invalid");
const orderTypes = ["Pickup", "DineIn"] as const;
const quoteChannel = "CUSTOMER_WEB";

export interface PriceInput {
  readonly sellableReference: string;
  readonly amountMinor: string;
}
export type PriceCommandBody =
  | {
      readonly action: "CreateDraft";
      readonly operationReference: string;
      readonly stableCode: string;
      readonly copyFrom: string | null;
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
  if (r.action === "CreateDraft" && keys === "action,copyFrom,operationReference,stableCode") {
    const stable = typeof r.stableCode === "string" ? r.stableCode.trim().toUpperCase() : "";
    return {
      action: "CreateDraft",
      operationReference: ref(r.operationReference),
      stableCode: code.test(stable) ? stable : fail("Invalid"),
      copyFrom: r.copyFrom === null ? null : ref(r.copyFrom),
    };
  }
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
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: unknown, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx as Tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
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
      productName:
        sku.productLocalizedNames[options.locale] ??
        Object.values(sku.productLocalizedNames)[0] ??
        "",
      sizeName: sku.localizedNames[options.locale] ?? Object.values(sku.localizedNames)[0] ?? "",
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

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    priceBookReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const at = options.persistence.now();
        const assignment = await currentStorePriceBook(reads(tx), s.owner);
        const history = await listStorePriceBookAssignments(reads(tx), s.owner, 10);
        const menuSellables = await listStoreMenuSellables(reads(tx), s.owner);
        const base = {
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
          return {
            screenId: "PRICE-BOOK-EDITOR" as const,
            ...base,
            book: bookView(snapshot),
            draftAuthor: author?.actorReference ?? null,
            uncovered:
              snapshot.lifecycle === "Archived" ? [] : await uncovered(tx, s.owner, snapshot, at),
          };
        }
        return {
          screenId: "PRICE-BOOK-LIST" as const,
          ...base,
          books: await listBrandPriceBooks(reads(tx), s.owner),
        };
      }),
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

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parsePriceCommandBody(input.body);
    const current = await session(input);
    // Prepare the owner command (and refuse what the person may not do) in a read transaction.
    const prepared = await retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        if (
          ((body.action === "CreateDraft" ||
            body.action === "SaveDraft" ||
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
          const source = body.copyFrom === null ? null : await loadBook(tx, s.owner, body.copyFrom);
          if (body.copyFrom !== null && source === null) fail("NotFound");
          return {
            s,
            action: "CreateDraft" as const,
            transport: {
              operationReference: body.operationReference,
              priceBookReference: derivedReference(body.operationReference, "price-book"),
              expectedAggregateVersion: 0,
              stableCode: body.stableCode,
              entries: (source?.entries ?? [])
                .filter(
                  (e) => e.scopeKind === "Brand" && e.channelCode === null && e.orderType === null,
                )
                .map((e) => entry(e.sellableReference, e.amount.amountMinor.toString())),
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
    );
    if ("replayed" in prepared && prepared.replayed !== undefined)
      return { status: "AlreadyApplied", priceBookReference: prepared.replayed };
    if (prepared.transport !== null && "action" in prepared) {
      try {
        const result = await commandsFor(prepared.s.owner.storeReference).executeTransport({
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
          action: prepared.action,
          input: prepared.transport,
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
        throw error;
      }
    }
    if (body.action !== "AssignToStore") return fail("Invalid");
    // Assignment: the book must price everything the Store sells, then it replaces the current one.
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        if (!s.permissions.mayApprove) fail("PermissionDenied");
        const at = options.persistence.now();
        const snapshot = await loadBook(tx, s.owner, body.priceBookReference);
        if (snapshot === null) return fail("NotFound");
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
    );
  };
  return { query, command };
}
