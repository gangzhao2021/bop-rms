import {
  ConfirmedOrderIntakeError,
  type ConfirmedOrderIntakeReceipt,
} from "../contracts/confirmed-order-intake.js";
import { KitchenTicketCreationError } from "../contracts/kitchen-ticket.js";
import { createKitchenTicketCreationService } from "./kitchen-ticket-creation.js";
import type { ConfirmedOrderConsumerPorts } from "./ports/confirmed-order-consumer-ports.js";
import type { KitchenTicketCreationPorts } from "./ports/kitchen-ticket-ports.js";

function translate(error: unknown): never {
  if (!(error instanceof KitchenTicketCreationError)) throw error;
  const code =
    error.code === "KITCHEN_TICKET_INPUT_INVALID"
      ? "KITCHEN_CONFIRMED_ORDER_INPUT_INVALID"
      : error.code === "KITCHEN_TICKET_PERMISSION_DENIED"
        ? "KITCHEN_CONFIRMED_ORDER_PERMISSION_DENIED"
        : error.code === "KITCHEN_TICKET_CONFLICT"
          ? "KITCHEN_CONFIRMED_ORDER_CONFLICT"
          : "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE";
  throw new ConfirmedOrderIntakeError(code);
}

export function createKitchenTicketIntakeAdapter(
  ports: KitchenTicketCreationPorts,
): ConfirmedOrderConsumerPorts["intakes"] {
  const service = createKitchenTicketCreationService(ports);
  return Object.freeze({
    async resolveByIdentity(input) {
      try {
        const resolution = await service.resolveExisting({
          brandReference: input.brandReference,
          storeReference: input.storeReference,
          sourceEventReference: input.sourceEventReference,
          confirmationReference: input.confirmationReference,
          orderBatchReference: input.orderBatchReference,
          transaction: input.transaction,
        });
        if (resolution.status === "NotFound") return Object.freeze({ status: "NotFound" as const });
        return Object.freeze({
          status: "Resolved" as const,
          receipt: resolution.effect.receipt,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async accept(input) {
      try {
        const result = await service.create({
          receipt: input.receipt as ConfirmedOrderIntakeReceipt,
          transaction: input.transaction,
        });
        return Object.freeze({
          status: result.status === "Created" ? ("Created" as const) : ("AlreadyAccepted" as const),
          receipt: result.receipt,
        });
      } catch (error) {
        return translate(error);
      }
    },
  });
}
