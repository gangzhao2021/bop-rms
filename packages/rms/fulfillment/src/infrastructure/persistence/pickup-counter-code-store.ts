import type { ConsumerTransaction } from "@bop/eventing";
import { parsePickupProofReference, PickupProofError } from "../../contracts/pickup-proof.js";

/**
 * WP-2423 (DEC-PICKUP-COUNTER-CODE): owner rows for the six-digit pickup code and its rejected
 * checks. Only keyed hashes are stored; the code a guest reads and the code staff typed never are.
 * Caller owns the transaction, tenant context, authorization and the fulfillment fence.
 */
export const pickupCodeCheckLimit = 5;

export interface PickupCounterCodeRow {
  readonly capabilityReference: string;
  readonly fulfillmentReference: string;
  readonly generation: number;
  readonly derivationIndex: number;
  readonly pepperVersion: number;
  readonly selectorHash: string;
  readonly lookupHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function unavailable(): never {
  throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
}
function instant(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== "string" || !Number.isFinite(Date.parse(text))) return unavailable();
  return new Date(text).toISOString();
}
const hex = /^[0-9a-f]{64}$/u;

export async function readPickupCounterCode(
  tx: ConsumerTransaction,
  scope: { brandReference: string; storeReference: string },
  fulfillmentReference: string,
  capabilityReference: string,
): Promise<PickupCounterCodeRow | null> {
  const rows = (
    await tx.query<Record<string, unknown>>(
      "SELECT capability_id,fulfillment_id,generation,derivation_index,pepper_version,selector_hash," +
        "lookup_hash,issued_at,expires_at FROM rms_fulfillment.pickup_counter_code " +
        "WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 AND capability_id=$4",
      [
        parsePickupProofReference(scope.brandReference),
        parsePickupProofReference(scope.storeReference),
        parsePickupProofReference(fulfillmentReference),
        parsePickupProofReference(capabilityReference),
      ],
    )
  ).rows;
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.capability_id !== capabilityReference ||
    row.fulfillment_id !== fulfillmentReference ||
    !Number.isSafeInteger(row.generation) ||
    !Number.isSafeInteger(row.derivation_index) ||
    !Number.isSafeInteger(row.pepper_version) ||
    typeof row.selector_hash !== "string" ||
    !hex.test(row.selector_hash) ||
    typeof row.lookup_hash !== "string" ||
    !hex.test(row.lookup_hash)
  )
    return unavailable();
  return Object.freeze({
    capabilityReference,
    fulfillmentReference,
    generation: row.generation as number,
    derivationIndex: row.derivation_index as number,
    pepperVersion: row.pepper_version as number,
    selectorHash: row.selector_hash,
    lookupHash: row.lookup_hash,
    issuedAt: instant(row.issued_at),
    expiresAt: instant(row.expires_at),
  });
}

/** Inserts the code row; "Collision" when the code is still valid for another order at the Store. */
export async function insertPickupCounterCode(
  tx: ConsumerTransaction,
  scope: { brandReference: string; storeReference: string },
  row: PickupCounterCodeRow,
): Promise<"Inserted" | "Collision"> {
  if (!hex.test(row.selectorHash) || !hex.test(row.lookupHash)) return unavailable();
  await tx.query("SAVEPOINT pickup_counter_code_write", []);
  try {
    await tx.query(
      "INSERT INTO rms_fulfillment.pickup_counter_code (brand_id,store_id,fulfillment_id,capability_id," +
        "generation,derivation_index,pepper_version,selector_hash,lookup_hash,issued_at,expires_at," +
        "data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'RestrictedCredential')",
      [
        parsePickupProofReference(scope.brandReference),
        parsePickupProofReference(scope.storeReference),
        parsePickupProofReference(row.fulfillmentReference),
        parsePickupProofReference(row.capabilityReference),
        row.generation,
        row.derivationIndex,
        row.pepperVersion,
        row.selectorHash,
        row.lookupHash,
        row.issuedAt,
        row.expiresAt,
      ],
    );
    await tx.query("RELEASE SAVEPOINT pickup_counter_code_write", []);
    return "Inserted";
  } catch (error) {
    try {
      await tx.query("ROLLBACK TO SAVEPOINT pickup_counter_code_write", []);
      await tx.query("RELEASE SAVEPOINT pickup_counter_code_write", []);
    } catch {
      return unavailable();
    }
    const code = (error as { code?: unknown } | null)?.code;
    const message = (error as { message?: unknown } | null)?.message;
    if (code === "23505" && message === "PICKUP_COUNTER_CODE_COLLISION") return "Collision";
    return unavailable();
  }
}

/** Rejected checks recorded for one proof generation (the fifth locks code checks). */
export async function countPickupCodeCheckRejections(
  tx: ConsumerTransaction,
  scope: { brandReference: string; storeReference: string },
  fulfillmentReference: string,
  capabilityReference: string,
): Promise<number> {
  const rows = (
    await tx.query<{ count: unknown }>(
      "SELECT count(*)::integer AS count FROM rms_fulfillment.pickup_code_check_rejection " +
        "WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 AND capability_id=$4",
      [
        parsePickupProofReference(scope.brandReference),
        parsePickupProofReference(scope.storeReference),
        parsePickupProofReference(fulfillmentReference),
        parsePickupProofReference(capabilityReference),
      ],
    )
  ).rows;
  const count = rows[0]?.count;
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    (count as number) > pickupCodeCheckLimit
  )
    return unavailable();
  return count as number;
}

/** Appends one rejected check (who checked, how it was entered, when); never the code typed. */
export async function appendPickupCodeCheckRejection(
  tx: ConsumerTransaction,
  scope: { brandReference: string; storeReference: string },
  input: {
    readonly rejectionReference: string;
    readonly fulfillmentReference: string;
    readonly capabilityReference: string;
    readonly generation: number;
    readonly entryMethod: "Opaque" | "HumanCode";
    readonly actorReference: string;
    readonly rejectionNumber: number;
    readonly rejectedAt: string;
    readonly correlationReference: string;
  },
): Promise<void> {
  if (
    (input.entryMethod !== "Opaque" && input.entryMethod !== "HumanCode") ||
    !Number.isSafeInteger(input.rejectionNumber) ||
    input.rejectionNumber < 1 ||
    input.rejectionNumber > pickupCodeCheckLimit ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  )
    return unavailable();
  await tx.query(
    "INSERT INTO rms_fulfillment.pickup_code_check_rejection (pickup_code_check_rejection_id,brand_id," +
      "store_id,fulfillment_id,capability_id,generation,entry_method,checked_by_actor_id," +
      "rejection_number,rejected_at,correlation_id,data_classification) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'IndirectIdentifier')",
    [
      parsePickupProofReference(input.rejectionReference),
      parsePickupProofReference(scope.brandReference),
      parsePickupProofReference(scope.storeReference),
      parsePickupProofReference(input.fulfillmentReference),
      parsePickupProofReference(input.capabilityReference),
      input.generation,
      input.entryMethod,
      parsePickupProofReference(input.actorReference),
      input.rejectionNumber,
      instant(input.rejectedAt),
      parsePickupProofReference(input.correlationReference),
    ],
  );
}
