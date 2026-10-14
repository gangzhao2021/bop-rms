/**
 * WP-2423: one merchant read = one transaction whose caller (Session, selected Store, Actor and
 * permission) is resolved in full once at the start and once more before the reply.
 *
 * Owner reads inside the transaction take `authority.guard`, a check that costs
 * no query: it only confirms the owner read runs inside this authorized run, on its transaction
 * and (when asked) for its scope. Re-resolving the scope inside every owner read instead (a
 * Session, selection, membership, store-assignment and permission-policy read of ~30 queries)
 * made the reads store tablets poll cost hundreds to thousands of queries a request.
 *
 * The final full re-check is not optional: the result of `work` is only returned after it passes,
 * so a Session that expired or was revoked, or a permission withdrawn, during the read still
 * refuses the reply. The guard stops answering true as soon as `work` settles.
 */
export interface MerchantTransactionAuthority<Scope> {
  /** The scope resolved in full at the start of this run. */
  readonly scope: Scope;
  /**
   * Owner-read guard: true only while this run's work is in progress, when `transaction` (if
   * given) is this run's transaction (or one bound to it) and `expected` (if given) is this
   * run's scope.
   */
  guard(transaction?: unknown, expected?: Scope): Promise<boolean>;
  /** Accepts `transaction` (for example a row-checking wrapper of this run's transaction). */
  bind(transaction: unknown): void;
  /**
   * A further permission an owner-read adapter resolved in full during the run (for example a
   * Task source's own permission): it is re-checked in full with the scope before the reply.
   */
  recheckBeforeReply(check: () => Promise<boolean>): void;
}

export async function withMerchantTransactionAuthorization<Scope, T>(
  options: {
    /** The transaction (connection) this run uses; owner reads must present it or a bound one. */
    readonly transaction: unknown;
    /** The full scope resolution at the start; it throws (or calls `denied`) to refuse. */
    resolve(): Promise<Scope>;
    /** The full re-resolution before the reply, against the scope resolved at the start. */
    recheck(scope: Scope): Promise<boolean>;
    /** Compares two scopes for `guard(_, expected)`; defaults to identity. */
    sameScope?(a: Scope, b: Scope): boolean;
    /** The read's own refusal when the final re-check fails. */
    denied(): never;
  },
  work: (authority: MerchantTransactionAuthority<Scope>) => Promise<T>,
): Promise<T> {
  const scope = await options.resolve();
  const transactions = new Set<unknown>([options.transaction]);
  const rechecks: (() => Promise<boolean>)[] = [];
  const sameScope = options.sameScope ?? ((a: Scope, b: Scope) => a === b);
  let active = true;
  const guard = async (transaction?: unknown, expected?: Scope) =>
    active &&
    (transaction === undefined || transactions.has(transaction)) &&
    (expected === undefined || sameScope(expected, scope));
  const authority: MerchantTransactionAuthority<Scope> = Object.freeze({
    scope,
    guard,
    bind: (transaction: unknown) => {
      if (!active) return options.denied();
      transactions.add(transaction);
    },
    recheckBeforeReply: (check: () => Promise<boolean>) => {
      if (!active) return options.denied();
      rechecks.push(check);
    },
  });
  let result: T;
  try {
    result = await work(authority);
  } finally {
    active = false;
    transactions.clear();
  }
  // Sequential: one query at a time on the transaction.
  if ((await options.recheck(scope)) !== true) return options.denied();
  for (const check of rechecks) if ((await check()) !== true) return options.denied();
  return result;
}
