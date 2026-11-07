import { KitchenTicketCreationError } from "../contracts/kitchen-ticket.js";
import { parseKitchenTicketCreationEffect } from "./kitchen-ticket-creation.js";
import type {
  KitchenTicketCreationEffect,
  KitchenTicketEffectValidationPorts,
} from "./ports/kitchen-ticket-ports.js";

const maximumDatabaseVersion = 9223372036854775807n;

function unavailable(): never {
  throw new KitchenTicketCreationError("KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE");
}

function storedVersion(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return unavailable();
  const version = BigInt(value);
  if (version > maximumDatabaseVersion) return unavailable();
  return version;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}

/**
 * Restricted owner persistence representation, never an Event or logging payload.
 * Validate before serialization so untrusted getters/toJSON and extra fields cannot
 * execute during encoding. The original effect remains independent of work progress.
 */
export function encodeKitchenTicketCreationRecord(
  value: unknown,
  ports: KitchenTicketEffectValidationPorts,
): string {
  const effect = parseKitchenTicketCreationEffect(value, ports);
  if (effect.ticket.sourceAggregateVersion > maximumDatabaseVersion) return unavailable();
  return JSON.stringify({ recordVersion: 1, effect }, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

/** Read JSONB as text; restore only explicitly versioned bigint paths. */
export function decodeKitchenTicketCreationRecord(
  value: unknown,
  ports: KitchenTicketEffectValidationPorts,
): KitchenTicketCreationEffect {
  try {
    if (typeof value !== "string") return unavailable();
    const record = object(JSON.parse(value));
    if (
      record.recordVersion !== 1 ||
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, "effect")
    )
      return unavailable();
    const effect = object(record.effect);
    const receipt = object(effect.receipt);
    const ticket = object(effect.ticket);
    const event = object(effect.event);
    return parseKitchenTicketCreationEffect(
      {
        ...effect,
        receipt: {
          ...receipt,
          sourceAggregateVersion: storedVersion(receipt.sourceAggregateVersion),
        },
        ticket: {
          ...ticket,
          sourceAggregateVersion: storedVersion(ticket.sourceAggregateVersion),
          aggregateVersion: storedVersion(ticket.aggregateVersion),
        },
        event: { ...event, aggregateVersion: storedVersion(event.aggregateVersion) },
      },
      ports,
    );
  } catch {
    return unavailable();
  }
}
