import { AsyncLocalStorage } from "node:async_hooks";

export interface MediaImageWorkerTransaction {
  readonly query: <Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ) => Promise<{
    readonly rows: readonly Row[];
    readonly rowCount?: number | null;
  }>;
}
export interface MediaImageWorkerConnection extends MediaImageWorkerTransaction {
  release(discard: boolean): void | Promise<void>;
}
export interface MediaImageWorkerTransactionsOptions {
  acquire(): Promise<MediaImageWorkerConnection>;
  readonly tenantReference: string;
  readonly scope: {
    readonly kind: "Brand" | "Store";
    readonly brandReference: string;
    readonly storeReference: string | null;
  };
}
export class MediaImageWorkerTransactionError extends Error {
  constructor(readonly code: "MEDIA_WORKER_TRANSACTION_UNAVAILABLE" | "COMMIT_OUTCOME_UNKNOWN") {
    super(code === "COMMIT_OUTCOME_UNKNOWN" ? "MEDIA_WORKER_COMMIT_OUTCOME_UNKNOWN" : code);
    this.name = "MediaImageWorkerTransactionError";
  }
}
interface Guard {
  readonly asyncGuard: () => Promise<void>;
  readonly finalAssert: () => void;
}
interface State {
  phase: "starting" | "work" | "guards" | "final" | "commit" | "closed";
  failed: boolean;
  readonly pending: Set<Promise<unknown>>;
  readonly guards: Guard[];
  token: object | null;
}
const connections = new WeakMap<object, State>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const unavailable = (): never => {
  throw new MediaImageWorkerTransactionError("MEDIA_WORKER_TRANSACTION_UNAVAILABLE");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return unavailable();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
    result[key] = descriptor.value;
  }
  return result;
}
function method(value: object, key: string): (...args: never[]) => unknown {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor)
      return "value" in descriptor && typeof descriptor.value === "function"
        ? (descriptor.value as (...args: never[]) => unknown)
        : unavailable();
    current = Object.getPrototypeOf(current) as object | null;
  }
  return unavailable();
}
function rows<Row>(value: unknown) {
  if (!value || typeof value !== "object") return unavailable();
  const r = Object.getOwnPropertyDescriptor(value, "rows"),
    count = Object.getOwnPropertyDescriptor(value, "rowCount");
  if (
    !r ||
    !("value" in r) ||
    !Array.isArray(r.value) ||
    (count &&
      (!("value" in count) ||
        (count.value !== undefined &&
          count.value !== null &&
          (!Number.isSafeInteger(count.value) || count.value < 0))))
  )
    return unavailable();
  return {
    rows: r.value as readonly Row[],
    ...(count?.value === undefined ? {} : { rowCount: count.value as number | null }),
  };
}

/** Pool lifecycle only. The owning Media/Permission holders supply all business
 * checks and authenticated System admission; this host cannot grant either. */
export function createMediaImageWorkerTransactions(options: MediaImageWorkerTransactionsOptions) {
  const config = closed(options, ["acquire", "tenantReference", "scope"]),
    scope = closed(config.scope, ["kind", "brandReference", "storeReference"]);
  if (
    typeof config.acquire !== "function" ||
    typeof config.tenantReference !== "string" ||
    !uuid.test(config.tenantReference) ||
    typeof scope.brandReference !== "string" ||
    !uuid.test(scope.brandReference) ||
    !(
      (scope.kind === "Brand" && scope.storeReference === null) ||
      (scope.kind === "Store" &&
        typeof scope.storeReference === "string" &&
        uuid.test(scope.storeReference))
    )
  )
    return unavailable();
  const acquire = (config.acquire as MediaImageWorkerTransactionsOptions["acquire"]).bind(options),
    contextValues = Object.freeze([
      config.tenantReference,
      scope.brandReference,
      scope.storeReference ?? "",
    ]),
    contexts = new AsyncLocalStorage<State>(),
    executions = new AsyncLocalStorage<object>(),
    active = new WeakMap<MediaImageWorkerTransaction, State>();
  const transactions = Object.freeze({
    async run<T>(work: (tx: MediaImageWorkerTransaction) => Promise<T>): Promise<T> {
      const parent = contexts.getStore();
      if (parent) {
        if (parent.phase !== "closed") parent.failed = true;
        return unavailable();
      }
      if (typeof work !== "function") return unavailable();
      let connection: MediaImageWorkerConnection;
      try {
        connection = await acquire();
      } catch {
        return unavailable();
      }
      if (!connection || typeof connection !== "object") return unavailable();
      const existing = connections.get(connection);
      if (existing) {
        existing.failed = true;
        return unavailable();
      }
      const state: State = {
        phase: "starting",
        failed: false,
        pending: new Set(),
        guards: [],
        token: null,
      };
      connections.set(connection, state);
      let began = false,
        commitAttempted = false,
        discard = false;
      let query: MediaImageWorkerConnection["query"] | undefined,
        release: MediaImageWorkerConnection["release"] | undefined;
      let tx: MediaImageWorkerTransaction | undefined;
      try {
        release = (method(connection, "release") as MediaImageWorkerConnection["release"]).bind(
          connection,
        );
        const originalQuery = method(connection, "query"),
          rawQuery = (originalQuery as MediaImageWorkerConnection["query"]).bind(connection);
        query = rawQuery;
        const check = () => {
          let currentQuery: ReturnType<typeof method>;
          try {
            currentQuery = method(connection, "query");
          } catch {
            discard = true;
            state.failed = true;
            return unavailable();
          }
          if (currentQuery !== originalQuery) discard = true;
          if (state.failed || currentQuery !== originalQuery) {
            state.failed = true;
            return unavailable();
          }
        };
        tx = Object.freeze({
          query<Row>(sql: string, values: readonly unknown[]) {
            if (
              (state.phase !== "work" && state.phase !== "guards") ||
              executions.getStore() !== state.token
            ) {
              state.failed = true;
              return Promise.reject(
                new MediaImageWorkerTransactionError("MEDIA_WORKER_TRANSACTION_UNAVAILABLE"),
              );
            }
            try {
              check();
            } catch {
              return Promise.reject(
                new MediaImageWorkerTransactionError("MEDIA_WORKER_TRANSACTION_UNAVAILABLE"),
              );
            }
            const original = query;
            if (!original)
              return Promise.reject(
                new MediaImageWorkerTransactionError("MEDIA_WORKER_TRANSACTION_UNAVAILABLE"),
              );
            const pending = (async () => {
              try {
                const result = await original<Row>(sql, values);
                check();
                return rows<Row>(result);
              } catch {
                state.failed = true;
                return unavailable();
              }
            })();
            state.pending.add(pending);
            // Register both outcomes immediately, including unawaited caller SQL.
            void pending.then(
              () => state.pending.delete(pending),
              () => state.pending.delete(pending),
            );
            return pending;
          },
        });
        active.set(tx, state);
        await rawQuery("BEGIN ISOLATION LEVEL READ COMMITTED", []);
        began = true;
        check();
        await rawQuery(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          contextValues,
        );
        check();
        const actual = tx;
        return await contexts.run(state, async () => {
          state.phase = "work";
          const workToken = {};
          state.token = workToken;
          const value = await executions.run(workToken, () => work(actual));
          check();
          if (state.pending.size !== 0 || state.guards.length === 0) return unavailable();
          state.phase = "guards";
          for (const guard of state.guards) {
            const guardToken = {};
            state.token = guardToken;
            const returned: unknown = await executions.run(guardToken, guard.asyncGuard);
            check();
            if (returned !== undefined || state.pending.size !== 0) return unavailable();
          }
          state.phase = "final";
          state.token = null;
          for (const guard of state.guards) {
            const returned: unknown = guard.finalAssert();
            if (returned !== undefined) {
              if (returned instanceof Promise) void returned.catch(() => undefined);
              return unavailable();
            }
            check();
            if (state.pending.size !== 0) return unavailable();
          }
          // There is no await or intervening query between the final assertions
          // and invoking COMMIT on the captured actual connection.
          state.phase = "commit";
          commitAttempted = true;
          await rawQuery("COMMIT", []);
          return value;
        });
      } catch {
        state.failed = true;
        if (commitAttempted) {
          discard = true;
          throw new MediaImageWorkerTransactionError("COMMIT_OUTCOME_UNKNOWN");
        }
        state.phase = "closed";
        // Already dispatched SQL must finish before rollback/release. Escaped
        // calls are closed now, so they cannot enqueue more work behind it.
        await Promise.allSettled([...state.pending]);
        if (began && query) {
          try {
            await query("ROLLBACK", []);
          } catch {
            discard = true;
          }
        } else discard = true;
        return unavailable();
      } finally {
        state.phase = "closed";
        if (tx) active.delete(tx);
        // Cleanup cannot erase an acknowledged commit or reveal raw pool errors.
        try {
          await release?.(discard);
        } catch {
          /* Pool cleanup owns disposal. */
        }
        connections.delete(connection);
      }
    },
  });
  return Object.freeze({
    transactions,
    async registerBeforeCommit(
      tx: MediaImageWorkerTransaction,
      asyncGuard: () => Promise<void>,
      finalAssert: () => void,
    ): Promise<void> {
      const state = active.get(tx),
        current = contexts.getStore();
      if (
        !state ||
        state !== current ||
        state.phase !== "work" ||
        executions.getStore() !== state.token ||
        typeof asyncGuard !== "function" ||
        typeof finalAssert !== "function" ||
        state.guards.length >= 64 ||
        state.guards.some((g) => g.asyncGuard === asyncGuard)
      ) {
        if (state) state.failed = true;
        if (current && current.phase !== "closed") current.failed = true;
        return unavailable();
      }
      state.guards.push(Object.freeze({ asyncGuard, finalAssert }));
    },
  });
}
