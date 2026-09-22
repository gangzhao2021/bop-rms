import process from "node:process";
/** Exception reads need one snapshot; current permission readers retain row locks. */
export function createInternalExceptionSnapshotTransactions(resources) {
  const binding = resources.publicProfile.binding;
  const fail = () => {
    throw Error("INTERNAL_EXCEPTION_SNAPSHOT_UNAVAILABLE");
  };
  const active = () =>
    process.env.NODE_ENV === "development" && resources.now() < binding.validUntil;
  if (
    binding.brandReference !== resources.scope.brandReference ||
    binding.storeReference !== resources.scope.storeReference
  )
    return fail();
  return Object.freeze({
    run: async (work) => {
      if (!active()) return fail();
      const client = await resources.database.acquire();
      let open = false,
        pending = 0,
        failed = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query(
          "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='5s'",
        );
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [binding.tenantReference, binding.brandReference, binding.storeReference],
        );
        open = true;
        const tx = Object.freeze({
          query: async (sql, values) => {
            if (
              !open ||
              !active() ||
              typeof sql !== "string" ||
              !/^\s*(SELECT\b|WITH RECURSIVE\b|SET LOCAL\b|LOCK TABLE [a-z_][a-z0-9_.]*(?:,[a-z_][a-z0-9_.]*)* IN (?:ROW )?SHARE MODE$)/iu.test(
                sql,
              ) ||
              sql.includes(";") ||
              (/^\s*WITH\b/iu.test(sql) &&
                /\b(INSERT|UPDATE|DELETE|MERGE|CALL|COPY|ALTER|DROP|CREATE|TRUNCATE)\b/iu.test(
                  sql,
                )) ||
              !Array.isArray(values)
            ) {
              failed = true;
              return fail();
            }
            pending++;
            try {
              return await client.query(sql, [...values]);
            } catch {
              failed = true;
              return fail();
            } finally {
              pending--;
            }
          },
        });
        const result = await work(tx);
        open = false;
        if (failed || pending !== 0 || !active()) return fail();
        await client.query("COMMIT");
        return result;
      } catch {
        open = false;
        await client.query("ROLLBACK").catch(() => undefined);
        return fail();
      } finally {
        open = false;
        client.release();
      }
    },
  });
}
