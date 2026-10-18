import { parseOrderExceptionSource, type OrderExceptionSource } from "../../order-exception.js";
export interface OrderExceptionTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
}
/** Append-only projected source history under shared projection-builder authority. */
export function createPostgresOrderExceptionSourceStore(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  authorize(tx: OrderExceptionTransaction, access: "Read" | "Write"): Promise<boolean>;
  validateSource(tx: OrderExceptionTransaction, source: OrderExceptionSource): Promise<boolean>;
}) {
  const scope = Object.freeze({ ...options.scope });
  const refs = [scope.tenantReference, scope.brandReference, scope.storeReference];
  const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (refs.some((value) => !ref.test(value))) throw Error("ORDER_EXCEPTION_SCOPE_INVALID");
  const fail = (): never => {
    throw Error("ORDER_EXCEPTION_STORE_UNAVAILABLE");
  };
  const encode = (value: OrderExceptionSource) =>
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  const bound = (value: unknown) => {
    const source = parseOrderExceptionSource(value);
    if (
      source.tenantReference !== scope.tenantReference ||
      source.brandReference !== scope.brandReference ||
      source.storeReference !== scope.storeReference
    )
      return fail();
    return source;
  };
  const decode = (row: Record<string, unknown>, sourceReference: string) => {
    const raw = row.record;
    if (typeof raw !== "string" || raw.length > 16384) return fail();
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.sourceVersion !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(parsed.sourceVersion)
    )
      return fail();
    const source = bound({ ...parsed, sourceVersion: BigInt(parsed.sourceVersion) });
    if (source.sourceReference !== sourceReference) return fail();
    return source;
  };
  const read = async (tx: OrderExceptionTransaction, sourceReference: string) => {
    const result = await tx.query(
      "SELECT record_json::text AS record FROM platform_projection.order_exception_source WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND source_id=$4 ORDER BY source_version DESC LIMIT 1",
      [...refs, sourceReference],
    );
    if (!result.rows.length) return null;
    return decode(result.rows[0] ?? fail(), sourceReference);
  };
  const page = (input: {
    readonly afterSourceReference: string | null;
    readonly limit: number;
  }) => {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.afterSourceReference !== null && !ref.test(input.afterSourceReference))
    )
      fail();
  };
  /** Decoded rows, strictly ordered after (or before) the cursor. */
  const ordered = (
    rows: readonly Record<string, unknown>[],
    cursor: string | null,
    direction: "Ascending" | "Descending",
  ) => {
    let previous = cursor;
    return rows.map((row) => {
      if (
        typeof row.source_id !== "string" ||
        !ref.test(row.source_id) ||
        (previous !== null &&
          (direction === "Ascending" ? row.source_id <= previous : row.source_id >= previous))
      )
        return fail();
      previous = row.source_id;
      return decode(row, row.source_id);
    });
  };
  const pageOf = (sources: readonly OrderExceptionSource[], limit: number) => {
    if (sources.length > limit + 1) return fail();
    const items = sources.slice(0, limit);
    return Object.freeze({
      items: Object.freeze(items),
      next: sources.length > limit ? (items[items.length - 1] ?? fail()).sourceReference : null,
    });
  };
  const run = async <T>(
    tx: OrderExceptionTransaction,
    access: "Read" | "Write",
    work: () => Promise<T>,
  ) => {
    try {
      if ((await options.authorize(tx, access)) !== true) return fail();
      await tx.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        refs,
      );
      const result = await work();
      if ((await options.authorize(tx, access)) !== true) return fail();
      return result;
    } catch {
      return fail();
    }
  };
  return {
    load: (tx: OrderExceptionTransaction, sourceReference: string) =>
      run(tx, "Read", async () => {
        if (!ref.test(sourceReference)) return fail();
        return read(tx, sourceReference);
      }),
    list: (
      tx: OrderExceptionTransaction,
      input: { readonly afterSourceReference: string | null; readonly limit: number },
    ) =>
      run(tx, "Read", async () => {
        if (
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 100 ||
          (input.afterSourceReference !== null && !ref.test(input.afterSourceReference))
        )
          return fail();
        const result = await tx.query(
          "SELECT DISTINCT ON (source_id) source_id,record_json::text AS record FROM platform_projection.order_exception_source WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND ($4::uuid IS NULL OR source_id>$4::uuid) ORDER BY source_id,source_version DESC LIMIT $5",
          [...refs, input.afterSourceReference, input.limit + 1],
        );
        if (result.rows.length > input.limit + 1) return fail();
        let previous = input.afterSourceReference;
        const sources = result.rows.map((row) => {
          if (
            typeof row.source_id !== "string" ||
            !ref.test(row.source_id) ||
            (previous !== null && row.source_id <= previous)
          )
            return fail();
          previous = row.source_id;
          return decode(row, row.source_id);
        });
        const items = sources.slice(0, input.limit);
        return Object.freeze({
          items: Object.freeze(items),
          nextAfterSourceReference:
            sources.length > input.limit
              ? (items[items.length - 1] ?? fail()).sourceReference
              : null,
        });
      }),
    /**
     * WP-2423: the cases still open, whatever the Store's lifetime count. Final is terminal (write
     * refuses Final -> Open), so a case is open while it has no Final version; both lookups use the
     * partial open/final indexes (2000_081), never every version the Store ever recorded.
     */
    listOpen: (
      tx: OrderExceptionTransaction,
      input: { readonly afterSourceReference: string | null; readonly limit: number },
    ) =>
      run(tx, "Read", async () => {
        page(input);
        const result = await tx.query(
          "SELECT DISTINCT ON (o.source_id) o.source_id,o.record_json::text AS record FROM platform_projection.order_exception_source o WHERE o.tenant_id=$1 AND o.brand_id=$2 AND o.store_id=$3 AND (o.record_json->>'sourceStatus')='Open' AND ($4::uuid IS NULL OR o.source_id>$4::uuid) AND NOT EXISTS (SELECT 1 FROM platform_projection.order_exception_source f WHERE f.tenant_id=o.tenant_id AND f.brand_id=o.brand_id AND f.store_id=o.store_id AND f.source_id=o.source_id AND (f.record_json->>'sourceStatus')='Final') ORDER BY o.source_id,o.source_version DESC LIMIT $5",
          [...refs, input.afterSourceReference, input.limit + 1],
        );
        const sources = ordered(result.rows, input.afterSourceReference, "Ascending");
        if (sources.some((source) => source.sourceStatus !== "Open")) return fail();
        return pageOf(sources, input.limit);
      }),
    /**
     * WP-2423: resolved history, most recently opened first (references are time-ordered), one
     * page at a time; each case is read at its latest version.
     */
    listResolved: (
      tx: OrderExceptionTransaction,
      input: { readonly beforeSourceReference: string | null; readonly limit: number },
    ) =>
      run(tx, "Read", async () => {
        page({ afterSourceReference: input.beforeSourceReference, limit: input.limit });
        const result = await tx.query(
          "SELECT f.source_id,(SELECT l.record_json::text FROM platform_projection.order_exception_source l WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.store_id=$3 AND l.source_id=f.source_id ORDER BY l.source_version DESC LIMIT 1) AS record FROM (SELECT DISTINCT source_id FROM platform_projection.order_exception_source WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND (record_json->>'sourceStatus')='Final' AND ($4::uuid IS NULL OR source_id<$4::uuid) ORDER BY source_id DESC LIMIT $5) f ORDER BY f.source_id DESC",
          [...refs, input.beforeSourceReference, input.limit + 1],
        );
        const sources = ordered(result.rows, input.beforeSourceReference, "Descending");
        if (sources.some((source) => source.sourceStatus !== "Final")) return fail();
        return pageOf(sources, input.limit);
      }),
    /**
     * WP-2423: every projected case's reference, kind and whether it is final, without records,
     * for a coverage check of the open cases against their owners (up to 1000 a page).
     */
    listReferences: (
      tx: OrderExceptionTransaction,
      input: { readonly afterSourceReference: string | null; readonly limit: number },
    ) =>
      run(tx, "Read", async () => {
        if (
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 1000 ||
          (input.afterSourceReference !== null && !ref.test(input.afterSourceReference))
        )
          return fail();
        const result = await tx.query(
          "SELECT DISTINCT ON (source_id) source_id,record_json->>'kind' AS kind,record_json->>'sourceStatus' AS status FROM platform_projection.order_exception_source WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND ($4::uuid IS NULL OR source_id>$4::uuid) ORDER BY source_id,source_version DESC LIMIT $5",
          [...refs, input.afterSourceReference, input.limit + 1],
        );
        if (result.rows.length > input.limit + 1) return fail();
        let previous = input.afterSourceReference;
        const references = result.rows.map((row) => {
          if (
            typeof row.source_id !== "string" ||
            !ref.test(row.source_id) ||
            (previous !== null && row.source_id <= previous) ||
            ![
              "DiningUnpaidBatch",
              "PaymentReconciliationDifference",
              "CaptureDeadlineExceeded",
              "PaidWithoutFulfillableOrder",
            ].includes(String(row.kind)) ||
            (row.status !== "Open" && row.status !== "Final")
          )
            return fail();
          previous = row.source_id;
          return Object.freeze({
            sourceReference: row.source_id,
            kind: row.kind as OrderExceptionSource["kind"],
            final: row.status === "Final",
          });
        });
        const items = references.slice(0, input.limit);
        return Object.freeze({
          items: Object.freeze(items),
          nextAfterSourceReference:
            references.length > input.limit
              ? (items[items.length - 1] ?? fail()).sourceReference
              : null,
        });
      }),
    write: (tx: OrderExceptionTransaction, value: OrderExceptionSource, checkpoint: string) =>
      run(tx, "Write", async () => {
        const source = bound(value);
        if (!ref.test(checkpoint) || source.sourceVersion > 9223372036854775807n) return fail();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "order-exception:" + refs.join(":") + ":" + source.sourceReference,
        ]);
        if ((await options.validateSource(tx, source)) !== true) return fail();
        const current = await read(tx, source.sourceReference);
        if (current && current.sourceVersion >= source.sourceVersion) {
          if (current.sourceVersion === source.sourceVersion && encode(current) !== encode(source))
            return fail();
          return current;
        }
        if (
          current &&
          ((current.sourceStatus === "Final" && source.sourceStatus !== "Final") ||
            Date.parse(source.updatedAt) < Date.parse(current.updatedAt))
        )
          return fail();
        await tx.query(
          "INSERT INTO platform_projection.order_exception_source (tenant_id,brand_id,store_id,source_id,source_version,checkpoint_id,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
          [
            ...refs,
            source.sourceReference,
            source.sourceVersion.toString(),
            checkpoint,
            encode(source),
          ],
        );
        return source;
      }),
  };
}
