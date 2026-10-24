import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference } from "@rms/ordering";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import type { createMerchantDiningServeCommand } from "./merchant-dining-serve-command.js";
import type { createMerchantDiningOrderProgress } from "./merchant-dining-order-progress.js";

/** At most this many lines in one "Serve all ready items" request. */
export const DINING_SERVE_READY_MAX_LINES = 100;

export class DiningServeReadyError extends Error {
  constructor(readonly code: "Invalid" | "PermissionDenied" | "NotFound") {
    super("DINING_SERVE_READY_" + code.toUpperCase());
    this.name = "DiningServeReadyError";
  }
}
const invalid = (): never => {
  throw new DiningServeReadyError("Invalid");
};
const integer = (value: unknown, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid();
  return value;
};
const parseReference = (value: unknown) => {
  try {
    return parseOrderingReference(value);
  } catch {
    return invalid();
  }
};

/**
 * WP-2423: the operation reference of one line of a "Serve all ready items" request. Deterministic
 * in (batch, item), so a retried batch replays the same single-serve operations and never serves
 * a line twice. It keeps the batch reference's 48-bit timestamp and fills the rest from SHA-256,
 * with the UUIDv7 version and RFC 9562 variant bits set, so it is a valid serve operation reference.
 */
export function deriveDiningServeLineReference(
  batchOperationReference: string,
  orderItemReference: string,
) {
  const batch = parseReference(batchOperationReference),
    item = parseReference(orderItemReference);
  const digest = createHash("sha256")
    .update("DiningServeReadyLine:" + batch + ":" + item)
    .digest("hex");
  const variant = ((Number.parseInt(digest.charAt(3), 16) & 0x3) | 0x8).toString(16);
  const hex =
    batch.replaceAll("-", "").slice(0, 12) +
    "7" +
    digest.slice(0, 3) +
    variant +
    digest.slice(4, 7) +
    digest.slice(7, 19);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export type DiningServeReadyOutcome = "Served" | "AlreadyServed" | "Changed" | "Failed";

type Serve = ReturnType<typeof createMerchantDiningServeCommand>;
type Progress = ReturnType<typeof createMerchantDiningOrderProgress>;
interface Line {
  readonly orderItemReference: string;
  readonly quantity: number;
  readonly expectedItemServiceVersion: number;
}

function parseCommand(value: unknown) {
  let raw: Record<string, unknown>;
  try {
    raw = readClosedRecord(value, [
      "operationReference",
      "orderReference",
      "expectedOrderVersion",
      "expectedSessionVersion",
      "expectedTableAssignmentVersion",
      "lines",
    ]);
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(raw.lines) ||
    raw.lines.length < 1 ||
    raw.lines.length > DINING_SERVE_READY_MAX_LINES
  )
    return invalid();
  const seen = new Set<string>();
  const lines = raw.lines.map((entry: unknown): Line => {
    let line: Record<string, unknown>;
    try {
      line = readClosedRecord(entry, [
        "orderItemReference",
        "quantity",
        "expectedItemServiceVersion",
      ]);
    } catch {
      return invalid();
    }
    const orderItemReference = parseReference(line.orderItemReference);
    if (seen.has(orderItemReference)) return invalid();
    seen.add(orderItemReference);
    return Object.freeze({
      orderItemReference,
      quantity: integer(line.quantity, 1, 999),
      expectedItemServiceVersion: integer(line.expectedItemServiceVersion, 0, 2147483646),
    });
  });
  return Object.freeze({
    operationReference: parseReference(raw.operationReference),
    orderReference: parseReference(raw.orderReference),
    expectedOrderVersion: integer(raw.expectedOrderVersion, 1, 2147483646),
    expectedSessionVersion: integer(raw.expectedSessionVersion, 1, 2147483646),
    expectedTableAssignmentVersion: integer(raw.expectedTableAssignmentVersion, 1, 2147483646),
    lines: Object.freeze(lines),
  });
}

/**
 * WP-2423: "Serve all ready items" for a round or a table. Composition only: it runs the existing
 * single-serve command once per line, sequentially, each in its own transaction with that
 * command's full authorization, tenant/store scope, version checks, audit and idempotency. Each
 * line's operation reference is derived from the batch reference, so a retried batch never serves
 * twice. A line that cannot be served does not stop the others; one fresh read of the table's
 * serving facts afterwards says why (another device served it, it was cancelled or partly served,
 * or the table moved), so staff get a plain answer per line.
 */
export function createMerchantDiningServeReadyCommand(options: {
  serve: Serve;
  progress: Progress;
  retry?: typeof retryTransactionConflict;
}) {
  const retry = options.retry ?? retryTransactionConflict;
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const command = parseCommand(input.command);
    const read = () =>
      options.progress({
        sessionCookie: input.sessionCookie,
        csrf: input.csrf,
        query: { orderReference: command.orderReference },
      });
    // The serving view needs the same `dining.item.serve` permission as each serve: a caller who
    // may not serve is refused for the whole request before any line is attempted.
    let before: Awaited<ReturnType<Progress>>;
    try {
      before = await retry(read);
    } catch (error) {
      // A read that kept meeting a database conflict is "try again" (the route answers 503),
      // never a refusal; anything else refuses the whole request.
      if (
        error !== null &&
        typeof error === "object" &&
        Object.getOwnPropertyDescriptor(error, "code")?.value ===
          "TENANT_DATABASE_TRANSACTION_CONFLICT"
      )
        throw error;
      throw new DiningServeReadyError("PermissionDenied");
    }
    if (!before) throw new DiningServeReadyError("NotFound");
    const outcomes = new Map<string, DiningServeReadyOutcome>();
    for (const line of command.lines) {
      try {
        await retry(() =>
          options.serve({
            sessionCookie: input.sessionCookie,
            csrf: input.csrf,
            command: {
              operationReference: deriveDiningServeLineReference(
                command.operationReference,
                line.orderItemReference,
              ),
              orderReference: command.orderReference,
              orderItemReference: line.orderItemReference,
              quantity: line.quantity,
              expectedOrderVersion: command.expectedOrderVersion,
              expectedItemServiceVersion: line.expectedItemServiceVersion,
              expectedSessionVersion: command.expectedSessionVersion,
              expectedTableAssignmentVersion: command.expectedTableAssignmentVersion,
            },
          }),
        );
        // Created, or AlreadyCommitted by an earlier attempt of this same request.
        outcomes.set(line.orderItemReference, "Served");
      } catch {
        outcomes.set(line.orderItemReference, "Failed");
      }
    }
    if ([...outcomes.values()].includes("Failed")) {
      // Unreadable now: the lines stay "Failed" (still to serve; the same request may be retried).
      const after = await read().catch(() => null);
      if (after) {
        const tableChanged =
          after.sessionPhase !== "Active" ||
          after.closureStatus !== "Open" ||
          after.orderVersion !== command.expectedOrderVersion ||
          after.sessionVersion !== command.expectedSessionVersion ||
          after.tableAssignmentVersion !== command.expectedTableAssignmentVersion;
        const current = new Map(
          after.items.map((item) => [String(item.orderItemReference), item] as const),
        );
        for (const line of command.lines) {
          if (outcomes.get(line.orderItemReference) !== "Failed") continue;
          const item = current.get(line.orderItemReference);
          outcomes.set(
            line.orderItemReference,
            !item || item.phase === "Cancelled"
              ? "Changed"
              : item.remainingQuantity === 0
                ? "AlreadyServed"
                : tableChanged ||
                    item.phase !== "Ready" ||
                    item.itemServiceVersion !== line.expectedItemServiceVersion ||
                    item.remainingQuantity !== line.quantity
                  ? "Changed"
                  : "Failed",
          );
        }
      }
    }
    const lines = command.lines.map((line) =>
      Object.freeze({
        orderItemReference: line.orderItemReference,
        outcome: outcomes.get(line.orderItemReference) ?? ("Failed" as const),
      }),
    );
    const count = (outcome: DiningServeReadyOutcome) =>
      lines.filter((line) => line.outcome === outcome).length;
    return Object.freeze({
      operationReference: String(command.operationReference),
      served: count("Served"),
      alreadyServed: count("AlreadyServed"),
      changed: count("Changed"),
      failed: count("Failed"),
      lines: Object.freeze(lines),
    });
  };
}
