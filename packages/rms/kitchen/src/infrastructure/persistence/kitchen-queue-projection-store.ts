import type { ConsumerTransaction } from "@bop/eventing";
import type { KitchenQueueProjectionPorts } from "../../application/ports/kitchen-queue-projection-ports.js";
import {
  KitchenQueueProjectionError,
  reconcileKitchenQueueStoredProjectionBundle,
  type KitchenQueueStoredProjectionBundle,
} from "../../domain/kitchen-queue-projection.js";
import {
  parseKitchenTicketReference,
  parseKitchenTicketDigest,
} from "../../domain/kitchen-ticket.js";
import {
  generationColumns,
  rowColumns,
  generationSelect,
  rowSelect,
  generationValue,
  rowValue,
} from "./kitchen-queue-queries.js";

const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
function unavailable(): never {
  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
}

/** A change to one ticket, by the ticket version it produced or the ready result it recorded. */
export interface KitchenQueueTicketReflection {
  readonly transaction: ConsumerTransaction;
  readonly ticketReference: string;
  readonly ticketVersion: bigint | null;
  readonly readyResultReference: string | null;
}

/** Caller owns the transaction and tenant context; all generation changes use the
 * same Store advisory lock as the projection consumer. Rows/history are immutable.
 */
export function createPostgresKitchenQueueProjectionStore(options: {
  brandReference: string;
  storeReference: string;
  maxRows: number;
  sha256(value: string): string;
  authorize(tx: ConsumerTransaction, access: "Load" | "Replace"): Promise<boolean>;
  validateCurrentSource(
    tx: ConsumerTransaction,
    bundle: KitchenQueueStoredProjectionBundle,
  ): Promise<boolean>;
}): KitchenQueueProjectionPorts["projections"] & {
  reflectsTicket(input: KitchenQueueTicketReflection): Promise<boolean>;
} {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1 || options.maxRows > 100000)
    return unavailable();
  async function authorize(tx: ConsumerTransaction, access: "Load" | "Replace") {
    if ((await options.authorize(tx, access)) !== true)
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
  }
  function scope(input: { brandReference: string; storeReference: string }) {
    if (input.brandReference !== brand || input.storeReference !== store) return unavailable();
  }
  async function load(tx: ConsumerTransaction, predicate: string, value?: string) {
    const result = await tx.query(
      "SELECT " +
        generationSelect +
        " FROM rms_kitchen.kitchen_work_queue_projection_generation WHERE brand_id=$1 AND store_id=$2 AND " +
        predicate +
        " LIMIT 2",
      value === undefined ? [brand, store] : [brand, store, value],
    );
    if (!result.rows.length) return null;
    if (result.rows.length !== 1) return unavailable();
    const generation = generationValue(result.rows[0] ?? {});
    scope(generation);
    if (generation.workItemCount > options.maxRows) return unavailable();
    const rows = await tx.query(
      "SELECT " +
        rowSelect +
        " FROM rms_kitchen.kitchen_work_queue_projection WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3" +
        " ORDER BY work_item_created_at,kitchen_work_item_id LIMIT $4",
      [brand, store, generation.projectionGenerationReference, options.maxRows + 1],
    );
    return reconcileKitchenQueueStoredProjectionBundle(
      { generation, rows: rows.rows.map(rowValue) },
      options.sha256,
    );
  }
  async function guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof KitchenQueueProjectionError &&
        error.code === "KITCHEN_QUEUE_PERMISSION_DENIED"
      )
        throw error;
      return unavailable();
    }
  }
  return {
    /**
     * WP-2423 batch 52 (kitchen ready speed): whether the active Fresh generation was built from
     * a snapshot holding this ticket at the given version or later (a ready result: the ticket
     * version its ready publication recorded). One indexed read instead of a full rebuild
     * snapshot; anything unknown (ticket not on the board, no publication) answers false.
     */
    reflectsTicket: (input) =>
      guard(async () => {
        const ticket = parseKitchenTicketReference(input.ticketReference);
        const version = input.ticketVersion;
        const ready =
          input.readyResultReference === null
            ? null
            : parseKitchenTicketReference(input.readyResultReference);
        if (
          (version === null) === (ready === null) ||
          (version !== null &&
            (typeof version !== "bigint" || version < 1n || version > 9_223_372_036_854_775_807n))
        )
          return unavailable();
        await authorize(input.transaction, "Load");
        const result = await input.transaction.query(
          "SELECT 1 AS reflected FROM rms_kitchen.kitchen_work_queue_projection_generation g" +
            " JOIN rms_kitchen.kitchen_work_queue_projection p ON p.brand_id=g.brand_id AND p.store_id=g.store_id" +
            " AND p.projection_generation_id=g.projection_generation_id" +
            " WHERE g.brand_id=$1 AND g.store_id=$2 AND g.generation_status='Active' AND g.freshness_status='Fresh'" +
            " AND p.kitchen_ticket_id=$3 AND p.ticket_aggregate_version >= COALESCE($4::bigint," +
            " (SELECT r.ticket_version FROM rms_kitchen.kitchen_ready_publication r WHERE r.brand_id=$1" +
            " AND r.store_id=$2 AND r.kitchen_ticket_id=$3 AND r.ready_result_id=$5::uuid))" +
            " LIMIT 1",
          [brand, store, ticket, version === null ? null : version.toString(), ready],
        );
        return result.rows.length === 1;
      }),
    loadActive: (input) =>
      guard(async () => {
        scope(input);
        await authorize(input.transaction, "Load");
        const bundle = await load(input.transaction, "generation_status='Active'");
        await authorize(input.transaction, "Load");
        return bundle ? { status: "Found", ...bundle } : { status: "NotFound" };
      }),
    loadByRebuildReference: (input) =>
      guard(async () => {
        scope(input);
        await authorize(input.transaction, "Load");
        const ref = parseKitchenTicketReference(input.rebuildReference);
        const digest = parseKitchenTicketDigest(input.rebuildRequestDigest);
        const bundle = await load(input.transaction, "rebuild_reference=$3", ref);
        await authorize(input.transaction, "Load");
        if (!bundle) return { status: "NotFound" };
        if (bundle.generation.rebuildRequestDigest !== digest) return { status: "Conflict" };
        return { status: "Found", ...bundle };
      }),
    replaceActive: (input) =>
      guard(async () => {
        const tx = input.transaction;
        const candidate = reconcileKitchenQueueStoredProjectionBundle(input, options.sha256);
        const generation = candidate.generation;
        scope(generation);
        if (generation.generationStatus !== "Active" || candidate.rows.length > options.maxRows)
          return unavailable();
        const expected =
          input.expectedActiveGenerationReference === null
            ? null
            : parseKitchenTicketReference(input.expectedActiveGenerationReference);
        await authorize(tx, "Replace");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          brand + ":" + store + ":kitchen_work_queue_v1",
        ]);
        const current = await load(tx, "generation_status='Active'");
        if (
          current?.generation.projectionGenerationReference ===
          generation.projectionGenerationReference
        ) {
          if (json(current) !== json(candidate)) return { status: "Conflict" };
          await authorize(tx, "Replace");
          return { status: "Activated", ...current };
        }
        if ((current?.generation.projectionGenerationReference ?? null) !== expected)
          return { status: "Conflict" };
        if (
          current &&
          (generation.asOfUtc < current.generation.asOfUtc ||
            generation.projectedAt < current.generation.projectedAt)
        )
          return { status: "Conflict" };
        if (
          generation.rebuildReference !== null &&
          generation.expectedPriorGenerationReference !== expected
        )
          return { status: "Conflict" };
        if ((await options.validateCurrentSource(tx, candidate)) !== true) return unavailable();
        await tx.query("SAVEPOINT kitchen_queue_replace", []);
        try {
          const columns = Object.entries(generationColumns);
          const saved = { ...generation, generationStatus: "Building" };
          const inserted = await tx.query(
            "INSERT INTO rms_kitchen.kitchen_work_queue_projection_generation (" +
              columns.map(([, column]) => column).join(",") +
              ") VALUES (" +
              columns.map((_, i) => "$" + (i + 1)).join(",") +
              ")",
            columns.map(([key]) => saved[key as keyof typeof saved]),
          );
          if (inserted.rowCount !== 1) return unavailable();
          const fields = Object.entries(rowColumns);
          for (const row of candidate.rows) {
            const insertedRow = await tx.query(
              "INSERT INTO rms_kitchen.kitchen_work_queue_projection (" +
                fields.map(([, column]) => column).join(",") +
                ") VALUES (" +
                fields.map((_, i) => "$" + (i + 1)).join(",") +
                ")",
              fields.map(([key]) => {
                const value = row[key as keyof typeof row];
                return key === "localizedDisplayNames" || key === "selectedOptions"
                  ? json(value)
                  : typeof value === "bigint"
                    ? value.toString()
                    : value;
              }),
            );
            if (insertedRow.rowCount !== 1) return unavailable();
          }
          await authorize(tx, "Replace");
          if (current) {
            const retired = await tx.query(
              "UPDATE rms_kitchen.kitchen_work_queue_projection_generation SET generation_status='Retired'" +
                " WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3 AND generation_status='Active'",
              [brand, store, current.generation.projectionGenerationReference],
            );
            if (retired.rowCount !== 1) return unavailable();
          }
          const activated = await tx.query(
            "UPDATE rms_kitchen.kitchen_work_queue_projection_generation SET generation_status='Active'" +
              " WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3 AND generation_status='Building'",
            [brand, store, generation.projectionGenerationReference],
          );
          if (activated.rowCount !== 1) return unavailable();
          await tx.query("RELEASE SAVEPOINT kitchen_queue_replace", []);
          return { status: "Activated", ...candidate };
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT kitchen_queue_replace", []);
          await tx.query("RELEASE SAVEPOINT kitchen_queue_replace", []);
          if (error && typeof error === "object" && "code" in error && error.code === "23505")
            return { status: "Conflict" };
          throw error;
        }
      }),
  };
}
