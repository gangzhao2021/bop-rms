import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
} from "../domain/cart.js";
import {
  createDiningCartAuthority,
  type DiningCartAuthorityPorts,
} from "./dining-cart-authority.js";

export interface DiningCartReadPorts extends DiningCartAuthorityPorts {
  readonly carts: {
    current(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly diningSessionReference: string;
      readonly observedAt: OrderingInstant;
    }): Promise<CartAggregate | null>;
  };
}
export interface DiningCartViewer {
  readonly guestSessionReference: string;
  readonly guestSessionVersion: number;
  readonly participantReference: string;
  readonly participantVersion: number;
  readonly diningSessionVersion: number;
  readonly tableReference: string;
  readonly tableAssignmentVersion: number;
  readonly publicTableReference: string;
  readonly qrReference: string;
  readonly qrRevocationVersion: number;
}
export interface DiningCartReadResult {
  /** Restricted current authority; omitted entirely from public display. */
  readonly viewer: DiningCartViewer;
  readonly context: { readonly publicStoreReference: string; readonly locale: string };
  readonly cart: CartAggregate;
  readonly effectiveStatus: "Active" | "Abandoned" | "Expired";
  readonly observedAt: OrderingInstant;
}

function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}

/** Restricted internal snapshot only. Shared reads do not transfer creator or item ownership. */
export function createDiningCartReadService(ports: DiningCartReadPorts) {
  const authorization = createDiningCartAuthority(ports);
  return Object.freeze({
    async read(value: unknown): Promise<DiningCartReadResult | null> {
      let credential: string;
      let requestedReference: string | null;
      try {
        const raw = readClosedRecord(
          value,
          Object.hasOwn(value as object, "cartReference")
            ? ["sessionCredential", "cartReference"]
            : ["sessionCredential"],
        );
        credential = parseGuestRawCredential(raw.sessionCredential);
        requestedReference = Object.hasOwn(raw, "cartReference")
          ? parseOrderingReference(raw.cartReference)
          : null;
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
      const { value: cart, authority: last } = await authorization.run(
        credential,
        async (first) => {
          try {
            const source = await ports.carts.current(
              Object.freeze({
                brandReference: first.participation.brandReference,
                storeReference: first.participation.storeReference,
                diningSessionReference: first.participation.diningSessionReference,
                observedAt: first.observedAt,
              }),
            );
            return source === null ? null : parseCartAggregate(source);
          } catch {
            return unavailable();
          }
        },
      );
      const brand = String(last.session.brandReference);
      const store = String(last.session.storeReference);
      if (cart === null) return null;
      if (
        cart.brandReference !== brand ||
        cart.storeReference !== store ||
        cart.orderType !== "DineIn" ||
        cart.diningSessionReference !== last.participation.diningSessionReference ||
        !["Qr", "Web"].includes(cart.sourceChannel) ||
        cart.updatedAt > last.observedAt ||
        cart.lifecycle === null
      )
        return unavailable();
      if (requestedReference !== null && cart.cartReference !== requestedReference) return null;
      const lifecycle = cart.lifecycle;
      const effectiveStatus =
        lifecycle.status === "Active" &&
        (last.observedAt >= lifecycle.idleExpiresAt ||
          last.observedAt >= lifecycle.absoluteExpiresAt)
          ? "Expired"
          : lifecycle.status;
      return Object.freeze({
        viewer: Object.freeze({
          guestSessionReference: String(last.session.sessionReference),
          guestSessionVersion: last.session.version,
          participantReference: last.participation.participantReference,
          participantVersion: last.participation.participantVersion,
          diningSessionVersion: last.participation.diningSessionVersion,
          tableReference: last.participation.tableReference,
          tableAssignmentVersion: last.participation.tableAssignmentVersion,
          publicTableReference: String(last.session.publicTableReference),
          qrReference: String(last.session.qrReference),
          qrRevocationVersion: last.session.qrRevocationVersion,
        }),
        context: Object.freeze({
          publicStoreReference: String(last.session.publicStoreReference),
          locale: String(last.session.locale),
        }),
        cart,
        effectiveStatus,
        observedAt: last.observedAt,
      });
    },
  });
}
