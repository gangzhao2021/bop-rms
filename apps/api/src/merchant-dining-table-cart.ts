import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import { listStoreMenuSellableNames } from "@rms/catalog";
import { createPostgresDiningCheckoutHoldSource, parseDiningReference } from "@rms/dining";
import {
  CartError,
  readStaffDiningCart,
  removeStaffDiningCartLine,
  type StaffCartRemovalReason,
} from "@rms/ordering";
import { loadDiningGuestPhones } from "./dining-guest-phones.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 shared-table-checkout (c) (sim M36, triage M36/M138): on the table page staff see what
 * guests put in the table's shared cart and haven't sent yet (dish, how many, which phone, whether
 * that phone left), and take a dish out with a reason: the guest asked, the guest left, or the
 * kitchen can't make it. Each removal is the cart's next version, recorded with the staff member,
 * the reason and an Audit record. Not while a guest is paying for that cart: their payment covers
 * exactly those dishes.
 */
export type MerchantDiningTableCartCommand =
  | { readonly action: "Read"; readonly diningSessionReference: string }
  | {
      readonly action: "Remove";
      readonly diningSessionReference: string;
      readonly cartReference: string;
      readonly cartItemReference: string;
      readonly expectedCartVersion: number;
      readonly reason: StaffCartRemovalReason;
      readonly operationReference: string;
    };

export class MerchantDiningTableCartError extends Error {
  constructor(
    readonly code:
      | "DINING_TABLE_CART_INPUT_INVALID"
      | "DINING_TABLE_CART_DENIED"
      | "DINING_TABLE_CART_CHANGED"
      | "DINING_TABLE_CART_GUEST_PAYING"
      | "DINING_TABLE_CART_UNAVAILABLE",
  ) {
    super(code);
    this.name = "MerchantDiningTableCartError";
  }
}

const reasons: readonly StaffCartRemovalReason[] = ["GuestAsked", "GuestLeft", "CantMake"];

export function parseMerchantDiningTableCartCommand(
  value: unknown,
): MerchantDiningTableCartCommand {
  try {
    const action =
      value !== null && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "action")?.value
        : undefined;
    if (action === "Read") {
      const raw = readClosedRecord(value, ["action", "diningSessionReference"]);
      return Object.freeze({
        action,
        diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
      });
    }
    if (action === "Remove") {
      const raw = readClosedRecord(value, [
        "action",
        "diningSessionReference",
        "cartReference",
        "cartItemReference",
        "expectedCartVersion",
        "reason",
        "operationReference",
      ]);
      if (
        typeof raw.expectedCartVersion !== "number" ||
        !Number.isSafeInteger(raw.expectedCartVersion) ||
        raw.expectedCartVersion < 1 ||
        !reasons.includes(raw.reason as StaffCartRemovalReason)
      )
        throw new Error("invalid");
      return Object.freeze({
        action,
        diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
        cartReference: String(parseDiningReference(raw.cartReference)),
        cartItemReference: String(parseDiningReference(raw.cartItemReference)),
        expectedCartVersion: raw.expectedCartVersion,
        reason: raw.reason as StaffCartRemovalReason,
        operationReference: String(parseDiningReference(raw.operationReference)),
      });
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new MerchantDiningTableCartError("DINING_TABLE_CART_INPUT_INVALID");
}

export interface MerchantDiningTableCartLine {
  readonly cartItemReference: string;
  /**
   * WP-2423 M35: the dish and options chosen, so the staff round screen names, marks (sold out)
   * and estimates the line from the menu it holds. Never the guest's note.
   */
  readonly sellableReference: string;
  readonly optionSelections: readonly {
    readonly optionReference: string;
    readonly quantity: number;
  }[];
  /** The dish's published name by locale (empty when it is on no current menu). */
  readonly names: Readonly<Record<string, string>>;
  readonly quantity: number;
  /** Whether the guest chose options for it (the kitchen ticket shows them). */
  readonly withOptions: boolean;
  /** "Phone N" that added it; null when staff entered it. */
  readonly phoneNumber: number | null;
  /** The phone that added it has left the table or staff removed it. */
  readonly phoneLeft: boolean;
}
export interface MerchantDiningTableCartView {
  readonly cart: null | {
    readonly cartReference: string;
    readonly cartVersion: number;
    /** A guest is paying for exactly this cart now: nothing can be taken out until they finish. */
    readonly guestPaying: boolean;
    readonly lines: readonly MerchantDiningTableCartLine[];
  };
}

/** The Audit reason code for a staff removal reason. */
export function staffCartReasonCode(reason: StaffCartRemovalReason): string {
  return reason === "GuestAsked"
    ? "STAFF_CART_GUEST_ASKED"
    : reason === "GuestLeft"
      ? "STAFF_CART_GUEST_LEFT"
      : "STAFF_CART_CANT_MAKE";
}

export function createMerchantDiningTableCart(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
  nextReference(): string;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<MerchantDiningTableCartView> => {
    const authenticated = await options.authentication.authorize(input);
    const command = parseMerchantDiningTableCartCommand(input.command);
    const denied = (): never => {
      throw new MerchantDiningTableCartError("DINING_TABLE_CART_DENIED");
    };
    return options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              "dining.operate",
              authenticated.sessionReference,
            );
            if ((await current.allowed()) !== true) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const current = authority.scope;
          const actorReference = String(current.actorReference);
          const scope = {
            tenantReference: current.selected.tenantReference,
            brandReference: current.context.brand.brandReference,
            storeReference: current.store.storeReference,
          };
          const owner = {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          };
          const session = command.diningSessionReference;
          const observedAt = options.now();
          const cartTx = tx as never;
          // Any guest's checkout of this cart version: staff are never a participant, so every
          // guest's hold counts.
          const holds = createPostgresDiningCheckoutHoldSource(
            { run: (work) => work(tx as never) },
            scope,
          );
          const guestPaying = async (cartReference: string, cartVersion: number) =>
            (await holds.read({
              diningSessionReference: session,
              cartReference,
              cartVersion,
              participantReference: actorReference,
              observedAt,
            })) !== null;
          const unavailable = (error: unknown): never => {
            if (error instanceof MerchantDiningTableCartError) throw error;
            if (error instanceof CartError) {
              if (error.code === "CART_CHECKOUT_IN_PROGRESS")
                throw new MerchantDiningTableCartError("DINING_TABLE_CART_GUEST_PAYING");
              if (error.code === "CART_VERSION_CONFLICT" || error.code === "CART_ITEM_NOT_FOUND")
                throw new MerchantDiningTableCartError("DINING_TABLE_CART_CHANGED");
              if (error.code === "CART_PERMISSION_DENIED" || error.code === "CART_UNAVAILABLE")
                throw new MerchantDiningTableCartError("DINING_TABLE_CART_CHANGED");
              if (error.code === "CART_IDEMPOTENCY_CONFLICT")
                throw new MerchantDiningTableCartError("DINING_TABLE_CART_INPUT_INVALID");
            }
            throw new MerchantDiningTableCartError("DINING_TABLE_CART_UNAVAILABLE");
          };
          if (command.action === "Remove") {
            try {
              await removeStaffDiningCartLine(cartTx, owner, {
                operationReference: command.operationReference,
                diningSessionReference: session,
                cartReference: command.cartReference,
                cartItemReference: command.cartItemReference,
                expectedCartVersion: command.expectedCartVersion,
                reason: command.reason,
                actorReference,
                observedAt,
                hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
                // Asked by Ordering under the cart row lock, so a checkout that started just
                // before is seen (see removeStaffDiningCartLine).
                checkoutHeld: (cartVersion) => guestPaying(command.cartReference, cartVersion),
                audit: {
                  auditId: options.nextReference(),
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
                  actor: { type: "User", reference: actorReference },
                  actionCode: "ORDERING_CART_ITEM_REMOVE_BY_STAFF",
                  targetType: "OrderingCart",
                  targetId: command.cartReference,
                  reasonCode: staffCartReasonCode(command.reason),
                  correlationId: command.operationReference,
                  occurredAt: observedAt,
                  sourceChannel: "API",
                  dataClassification: "Internal",
                  retentionPolicyCode: options.retentionPolicyCode,
                  retentionPolicyVersion: options.retentionPolicyVersion,
                },
              });
            } catch (error) {
              unavailable(error);
            }
          }
          let cart: Awaited<ReturnType<typeof readStaffDiningCart>>;
          try {
            cart = await readStaffDiningCart(cartTx, owner, session, observedAt);
          } catch (error) {
            return unavailable(error);
          }
          if (cart === null) return Object.freeze({ cart: null });
          const phones = await loadDiningGuestPhones(tx as never, scope, session);
          const phoneOf = new Map(
            phones.map((phone) => [String(phone.participantReference), phone]),
          );
          const names = await listStoreMenuSellableNames(
            tx as never,
            owner,
            cart.lines.map((line) => line.sellableReference),
          );
          // The Catalog read moves the scope to the Brand; restore the Store for what follows.
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          const paying = await guestPaying(cart.cartReference, cart.cartVersion);
          return Object.freeze({
            cart: Object.freeze({
              cartReference: cart.cartReference,
              cartVersion: cart.cartVersion,
              guestPaying: paying,
              lines: Object.freeze(
                cart.lines.map((line) => {
                  const phone =
                    line.addedByParticipantReference === null
                      ? undefined
                      : phoneOf.get(line.addedByParticipantReference);
                  return Object.freeze({
                    cartItemReference: line.cartItemReference,
                    sellableReference: line.sellableReference,
                    optionSelections: line.optionSelections,
                    names: names.get(line.sellableReference) ?? Object.freeze({}),
                    quantity: line.quantity,
                    withOptions: line.optionCount > 0,
                    phoneNumber: phone?.phoneNumber ?? null,
                    phoneLeft: phone !== undefined && (phone.left || phone.removed),
                  });
                }),
              ),
            }),
          });
        },
      ),
    );
  };
}
