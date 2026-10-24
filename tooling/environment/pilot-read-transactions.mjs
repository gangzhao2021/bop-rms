export function createInternalReadTransactions(resources) {
  return {
    async run(work) {
      const connection = await resources.database.acquire();
      let failed = false;
      try {
        await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await connection.query("SET LOCAL lock_timeout = '2s'");
        await connection.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [resources.scope.brandReference, resources.scope.storeReference],
        );
        const result = await work({ query: (sql, values) => connection.query(sql, [...values]) });
        await connection.query("COMMIT");
        return result;
      } catch {
        failed = true;
        await connection.query("ROLLBACK").catch(() => undefined);
        throw new Error("INTERNAL_INVENTORY_READ_UNAVAILABLE");
      } finally {
        connection.release(failed);
      }
    },
  };
}
