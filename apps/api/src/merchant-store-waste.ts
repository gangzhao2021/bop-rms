import { listStoreMembers, type MemberDirectoryTransaction } from "@bop/membership";
import {
  listStoreWaste,
  listWasteableStock,
  loadStoreWaste,
  parseStoreWasteLines,
  postStoreWaste,
  reviewStoreWaste,
  StoreWasteError,
  storeWasteAcceptReasons,
  storeWasteReasons,
  storeWasteReviewThresholdMinor,
  storeWasteVoidReasons,
  type LedgerTransaction,
} from "@rms/inventory";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { merchantStockCatalog } from "./merchant-stock-catalog.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-INV-WASTE: INV-WASTE for the selected Store. Recording waste needs
 * inventory.waste.record (front of house and kitchen); the waste history needs inventory.waste.read;
 * reviewing a record (accept, or void entries made in error) needs inventory.waste.approve and is
 * never done by the person who recorded it.
 */
export class MerchantStoreWasteError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "NotEnoughStock"
      | "AlreadyReviewed"
      | "NotIndependent"
      | "LineInvalid"
      | "Invalid",
    readonly lineReference: string | null = null,
  ) {
    super(code);
    this.name = "MerchantStoreWasteError";
  }
}
const fail = (code: MerchantStoreWasteError["code"], line: string | null = null): never => {
  throw new MerchantStoreWasteError(code, line);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");

export type StoreWasteCommandBody =
  | {
      readonly action: "Record";
      readonly operationReference: string;
      readonly wasteReference: string;
      readonly lines: unknown;
    }
  | {
      readonly action: "Review";
      readonly operationReference: string;
      readonly wasteReference: string;
      readonly decision: "Accepted" | "Voided";
      readonly reasonCode: string;
    };
export function parseStoreWasteCommandBody(value: unknown): StoreWasteCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (r.action === "Record" && keys === "action,lines,operationReference,wasteReference")
    return {
      action: "Record",
      operationReference: ref(r.operationReference),
      wasteReference: ref(r.wasteReference),
      lines: r.lines,
    };
  if (
    r.action === "Review" &&
    keys === "action,decision,operationReference,reasonCode,wasteReference" &&
    ((r.decision === "Accepted" &&
      (storeWasteAcceptReasons as readonly unknown[]).includes(r.reasonCode)) ||
      (r.decision === "Voided" &&
        (storeWasteVoidReasons as readonly unknown[]).includes(r.reasonCode)))
  )
    return {
      action: "Review",
      operationReference: ref(r.operationReference),
      wasteReference: ref(r.wasteReference),
      decision: r.decision,
      reasonCode: r.reasonCode as string,
    };
  return fail("Invalid");
}
const errors: Record<StoreWasteError["code"], MerchantStoreWasteError["code"]> = {
  STORE_WASTE_INVALID: "Invalid",
  STORE_WASTE_LINE_INVALID: "LineInvalid",
  STORE_WASTE_NOT_ENOUGH_STOCK: "NotEnoughStock",
  STORE_WASTE_NOT_FOUND: "NotFound",
  STORE_WASTE_ALREADY_REVIEWED: "AlreadyReviewed",
  STORE_WASTE_REVIEWER_NOT_INDEPENDENT: "NotIndependent",
  STORE_WASTE_IDEMPOTENCY_CONFLICT: "Conflict",
};

export function createMerchantStoreWaste(options: {
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
    const scope = await resolveScope(tx, sessionCookie, "merchant.access", sessionReference);
    if (!(await scope.allowed())) fail("PermissionDenied");
    const may = async (action: string) => (await scope.authorizeAction(action))?.effect === "Allow";
    const permissions = {
      mayRecord: await may("inventory.waste.record"),
      mayRead: await may("inventory.waste.read"),
      mayReview: await may("inventory.waste.approve"),
    };
    if (!permissions.mayRecord && !permissions.mayRead && !permissions.mayReview)
      fail("PermissionDenied");
    return {
      owner: {
        tenantReference: String(scope.selected.tenantReference),
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.store.storeReference),
      },
      actor: String(scope.actorReference),
      permissions,
    };
  }
  const ledger = (tx: Tx) => tx as unknown as LedgerTransaction;

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    wasteReference: string | null;
    before: string | null;
    needsReviewOnly: boolean;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const catalog = await merchantStockCatalog(tx, scope.owner, options.locale);
        const members = await listStoreMembers(
          tx as unknown as MemberDirectoryTransaction,
          scope.owner,
        );
        const labels = Object.fromEntries(
          members.map((member) => [
            member.actorReference,
            member.actorReference === scope.actor
              ? "You"
              : (member.displayName ?? "Staff " + member.actorReference.slice(-4)),
          ]),
        );
        const base = {
          sourceAsOf: options.persistence.now(),
          viewer: scope.actor,
          permissions: scope.permissions,
          reasons: storeWasteReasons,
          acceptReasons: storeWasteAcceptReasons,
          voidReasons: storeWasteVoidReasons,
          reviewThresholdMinor: storeWasteReviewThresholdMinor,
          items: catalog.items,
          locations: catalog.locations,
          stock: scope.permissions.mayRecord
            ? await listWasteableStock(ledger(tx), scope.owner)
            : [],
          people: labels,
        };
        if (input.wasteReference !== null) {
          const record = await loadStoreWaste(ledger(tx), scope.owner, input.wasteReference);
          // Recorders see their own records; the history needs read permission.
          if (
            record === null ||
            (!scope.permissions.mayRead &&
              !scope.permissions.mayReview &&
              record.recordedBy !== scope.actor)
          )
            return fail("NotFound");
          return {
            screenId: "INV-WASTE-DETAIL" as const,
            ...base,
            records: [record],
            hasMore: false,
          };
        }
        const page =
          scope.permissions.mayRead || scope.permissions.mayReview
            ? await listStoreWaste(ledger(tx), scope.owner, {
                before: input.before,
                limit: 30,
                needsReviewOnly: input.needsReviewOnly,
              })
            : { records: [], hasMore: false };
        return { screenId: "INV-WASTE-LIST" as const, ...base, ...page };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseStoreWasteCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        if (body.action === "Record" ? !scope.permissions.mayRecord : !scope.permissions.mayReview)
          fail("PermissionDenied");
        const at = options.persistence.now();
        try {
          if (body.action === "Record") {
            const result = await postStoreWaste(ledger(tx), scope.owner, {
              operationReference: body.operationReference,
              wasteReference: body.wasteReference,
              lines: parseStoreWasteLines(body.lines),
              actorReference: scope.actor,
              occurredAt: at,
              auditReference: options.references.next(),
              nextReference: () => options.references.next(),
            });
            return {
              status: result.status,
              wasteReference: result.record.wasteReference,
              needsReview: result.record.needsReview,
            };
          }
          const result = await reviewStoreWaste(ledger(tx), scope.owner, {
            operationReference: body.operationReference,
            wasteReference: body.wasteReference,
            decision: body.decision,
            reasonCode: body.reasonCode,
            actorReference: scope.actor,
            occurredAt: at,
            auditReference: options.references.next(),
            nextReference: () => options.references.next(),
          });
          return { status: result.status, wasteReference: result.record.wasteReference };
        } catch (error) {
          if (error instanceof StoreWasteError)
            return fail(errors[error.code], error.lineReference);
          throw error;
        }
      }),
    );
  };
  return { query, command };
}
