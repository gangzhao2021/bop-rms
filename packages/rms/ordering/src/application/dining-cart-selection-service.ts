import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import { CartError, parseOrderingReference } from "../domain/cart.js";
import {
  parseDiningCartSelectionReceipt,
  type DiningCartSelectionCommand,
  type DiningCartSelectionReceipt,
} from "../domain/dining-cart-selection.js";
import {
  createDiningCartAuthority,
  type DiningCartAuthorityPorts,
} from "./dining-cart-authority.js";

export interface DiningCartSelectionPorts extends DiningCartAuthorityPorts {
  readonly selection: { select(input: DiningCartSelectionCommand): Promise<unknown> };
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}

/** Current-authorized owner command; the result is an internal historical receipt, not a Cart DTO. */
export function createDiningCartSelectionService(ports: DiningCartSelectionPorts) {
  const authorization = createDiningCartAuthority(ports);
  return Object.freeze({
    async select(value: unknown): Promise<DiningCartSelectionReceipt> {
      let credential: string;
      let operationReference: string;
      try {
        const raw = readClosedRecord(value, ["sessionCredential", "operationReference"]);
        credential = parseGuestRawCredential(raw.sessionCredential);
        operationReference = parseOrderingReference(raw.operationReference);
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
      const { value: receipt, authority: current } = await authorization.run(
        credential,
        async (first) => {
          const command = Object.freeze({
            operationReference,
            brandReference: first.participation.brandReference,
            storeReference: first.participation.storeReference,
            diningSessionReference: first.participation.diningSessionReference,
            guestSessionReference: String(first.session.sessionReference),
            participantReference: first.participation.participantReference,
            observedAt: first.observedAt,
          });
          try {
            const result = parseDiningCartSelectionReceipt(await ports.selection.select(command));
            for (const key of [
              "operationReference",
              "brandReference",
              "storeReference",
              "diningSessionReference",
              "guestSessionReference",
              "participantReference",
            ] as const)
              if (result[key] !== command[key]) return unavailable();
            return result;
          } catch (error) {
            if (
              error instanceof CartError &&
              [
                "CART_IDEMPOTENCY_CONFLICT",
                "CART_EXPIRED",
                "CART_ABANDONED",
                "CART_LIFECYCLE_UNAVAILABLE",
              ].includes(error.code)
            )
              throw new CartError(error.code);
            return unavailable();
          }
        },
      );
      if (
        receipt.occurredAt > current.observedAt ||
        receipt.occurredAt < String(current.session.createdAt)
      )
        return unavailable();
      if (receipt.expiresAt <= current.observedAt) throw new CartError("CART_IDEMPOTENCY_CONFLICT");
      return receipt;
    },
  });
}
