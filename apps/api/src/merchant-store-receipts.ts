import {
  createStoreReceipt,
  listStoreReceipts,
  loadStoreReceipt,
  parseStoreReceiptLines,
  postStoreReceipt,
  StoreReceiptError,
  storeReceiptDiscrepancyReasons,
  storeReceiptVoidReasons,
  voidStoreReceipt,
  type PostedStoreReceipt,
  type StoreReceiptTransaction,
} from "@rms/inventory";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { merchantStockCatalog } from "./merchant-stock-catalog.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-INV-DIRECT-RECEIPT: INV-GOODS-RECEIPT (Store direct mode) and the receipt list/detail
 * for the selected Store. Reading needs inventory.receipt.read, receiving inventory.receipt.post and
 * voiding inventory.receipt.correct.
 */
export class MerchantStoreReceiptError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "AlreadyVoided"
      | "StockUsed"
      | "LineInvalid"
      | "Invalid",
    readonly lineReference: string | null = null,
  ) {
    super(code);
    this.name = "MerchantStoreReceiptError";
  }
}
const fail = (code: MerchantStoreReceiptError["code"], line: string | null = null): never => {
  throw new MerchantStoreReceiptError(code, line);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
export type StoreReceiptCommandBody =
  | {
      readonly action: "Post";
      readonly operationReference: string;
      readonly receiptReference: string;
      readonly supplierName: unknown;
      readonly supplierDocument: unknown;
      readonly lines: unknown;
    }
  | {
      readonly action: "Void";
      readonly operationReference: string;
      readonly receiptReference: string;
      readonly reasonCode: string;
    };
export function parseStoreReceiptCommandBody(value: unknown): StoreReceiptCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (
    r.action === "Post" &&
    keys === "action,lines,operationReference,receiptReference,supplierDocument,supplierName"
  )
    return {
      action: "Post",
      operationReference: ref(r.operationReference),
      receiptReference: ref(r.receiptReference),
      supplierName: r.supplierName,
      supplierDocument: r.supplierDocument,
      lines: r.lines,
    };
  if (
    r.action === "Void" &&
    keys === "action,operationReference,reasonCode,receiptReference" &&
    (storeReceiptVoidReasons as readonly unknown[]).includes(r.reasonCode)
  )
    return {
      action: "Void",
      operationReference: ref(r.operationReference),
      receiptReference: ref(r.receiptReference),
      reasonCode: r.reasonCode as string,
    };
  return fail("Invalid");
}

export function createMerchantStoreReceipts(options: {
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
    const scope = await resolveScope(tx, sessionCookie, "inventory.receipt.read", sessionReference);
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
    if (error instanceof StoreReceiptError)
      return fail(
        error.code === "STORE_RECEIPT_NOT_FOUND"
          ? "NotFound"
          : error.code === "STORE_RECEIPT_ALREADY_VOIDED"
            ? "AlreadyVoided"
            : error.code === "STORE_RECEIPT_STOCK_USED"
              ? "StockUsed"
              : error.code === "STORE_RECEIPT_LINE_INVALID"
                ? "LineInvalid"
                : error.code === "STORE_RECEIPT_INVALID"
                  ? "Invalid"
                  : "Conflict",
        error.lineReference,
      );
    throw error;
  };
  const view = (receipt: PostedStoreReceipt) => ({
    receiptReference: receipt.receiptReference,
    supplierName: receipt.supplierName,
    supplierDocument: receipt.supplierDocument,
    receivedAt: receipt.receivedAt,
    lines: receipt.lines,
    voided: receipt.voided,
  });

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    receiptReference: string | null;
    before: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const owner = ownerScope(scope);
        const rtx = tx as unknown as StoreReceiptTransaction;
        const permissions = {
          mayReceive: await may(scope, "inventory.receipt.post"),
          mayVoid: await may(scope, "inventory.receipt.correct"),
        };
        const catalog = await merchantStockCatalog(tx, owner, options.locale);
        if (input.receiptReference !== null) {
          const receipt = await loadStoreReceipt(rtx, owner, input.receiptReference);
          if (receipt === null) return fail("NotFound");
          return {
            screenId: "INV-RECEIPT-DETAIL" as const,
            sourceAsOf: options.persistence.now(),
            permissions,
            discrepancyReasons: storeReceiptDiscrepancyReasons,
            voidReasons: storeReceiptVoidReasons,
            receipts: [view(receipt)],
            hasMore: false,
            ...catalog,
          };
        }
        const page = await listStoreReceipts(rtx, owner, { before: input.before, limit: 30 });
        return {
          screenId: "INV-RECEIPT-LIST" as const,
          sourceAsOf: options.persistence.now(),
          permissions,
          discrepancyReasons: storeReceiptDiscrepancyReasons,
          voidReasons: storeReceiptVoidReasons,
          receipts: page.receipts.map(view),
          hasMore: page.hasMore,
          ...catalog,
        };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseStoreReceiptCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        if (
          !(await may(
            scope,
            body.action === "Post" ? "inventory.receipt.post" : "inventory.receipt.correct",
          ))
        )
          fail("PermissionDenied");
        const owner = ownerScope(scope);
        const rtx = tx as unknown as StoreReceiptTransaction;
        const actor = String(scope.actorReference);
        try {
          if (body.action === "Post") {
            const receipt = createStoreReceipt({
              receiptReference: body.receiptReference,
              ...owner,
              supplierName: body.supplierName,
              supplierDocument: body.supplierDocument,
              lines: parseStoreReceiptLines(body.lines),
              receivedBy: actor,
              receivedAt: options.persistence.now(),
            });
            const result = await postStoreReceipt(rtx, owner, {
              operationReference: body.operationReference,
              receipt,
              auditReference: options.references.next(),
              nextReference: () => options.references.next(),
            });
            return { status: result.status, receiptReference: result.receipt.receiptReference };
          }
          const result = await voidStoreReceipt(rtx, owner, {
            operationReference: body.operationReference,
            receiptReference: body.receiptReference,
            reasonCode: body.reasonCode,
            actorReference: actor,
            occurredAt: options.persistence.now(),
            auditReference: options.references.next(),
            nextReference: () => options.references.next(),
          });
          return { status: result.status, receiptReference: result.receipt.receiptReference };
        } catch (error) {
          return mapError(error);
        }
      }),
    );
  };
  return { query, command };
}
