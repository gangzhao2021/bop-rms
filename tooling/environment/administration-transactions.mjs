const unavailable = () => new Error("ADMINISTRATION_TRANSACTION_UNAVAILABLE");

// The API host supplies authority and pre-COMMIT guards. This resource supplies
// only a finite, unscoped borrowed PostgreSQL transaction.
export function createAdministrationTransactions(database) {
  const acquire = database?.acquire;
  if (typeof acquire !== "function") throw unavailable();
  return Object.freeze({
    async run(work) {
      if (typeof work !== "function" || database.acquire !== acquire) throw unavailable();
      let connection;
      try {
        connection = await acquire.call(database);
      } catch {
        throw unavailable();
      }
      const query = connection?.query;
      const release = connection?.release;
      if (typeof query !== "function" || typeof release !== "function") {
        if (typeof release === "function") {
          try {
            await release.call(connection, true);
          } catch {
            /* Discard invalid acquired client. */
          }
        }
        throw unavailable();
      }
      let open = false;
      let failed = false;
      let committed = false;
      let result;
      let failure;
      let hasFailure = false;
      let callbackFailed = false;
      const pending = new Set();
      const check = () => {
        if (
          connection.query !== query ||
          connection.release !== release ||
          database.acquire !== acquire
        ) {
          failed = true;
          throw unavailable();
        }
      };
      const tx = Object.freeze({
        query(sql, values) {
          const operation = (async () => {
            if (!open || failed) throw unavailable();
            try {
              check();
              const value = await query.call(connection, sql, values);
              check();
              return value;
            } catch {
              failed = true;
              throw unavailable();
            }
          })();
          pending.add(operation);
          // Observe even a deliberately unawaited rejection, without hiding it
          // from its caller or allowing cleanup to release an in-flight client.
          void operation.then(
            () => pending.delete(operation),
            () => pending.delete(operation),
          );
          return operation;
        },
      });
      try {
        check();
        await query.call(connection, "BEGIN ISOLATION LEVEL READ COMMITTED");
        await query.call(connection, "SET LOCAL statement_timeout = '5s'");
        await query.call(connection, "SET LOCAL lock_timeout = '2s'");
        await query.call(connection, "SET LOCAL idle_in_transaction_session_timeout = '5s'");
        check();
        open = true;
        try {
          result = await work(tx);
        } catch (error) {
          callbackFailed = true;
          throw error;
        }
        open = false;
        if (failed || pending.size !== 0) throw unavailable();
        check();
        await query.call(connection, "COMMIT");
        committed = true;
      } catch (error) {
        // Callback errors retain their owning Domain identity. Driver errors
        // outside that callback are reduced below to the resource's fixed code.
        hasFailure = true;
        failure = callbackFailed ? error : unavailable();
      } finally {
        open = false;
        await Promise.allSettled([...pending]);
        if (!committed) {
          try {
            await query.call(connection, "ROLLBACK");
          } catch {
            failed = true;
          }
        }
        try {
          await release.call(connection, !committed || failed);
        } catch {
          if (!hasFailure) {
            hasFailure = true;
            failure = unavailable();
          }
        }
      }
      if (hasFailure) throw failure;
      if (!committed) throw unavailable();
      return result;
    },
  });
}
