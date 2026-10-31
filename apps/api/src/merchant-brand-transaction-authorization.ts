import { CatalogError } from "@rms/catalog";
import {
  deferMerchantTransactionStatement,
  merchantTransactionPhase,
  registerMerchantTransactionLastCheck,
} from "./merchant-category-transactions.js";

/**
 * WP-2423: Brand-scope authorization once per transaction, with one full re-check before commit.
 *
 * Catalog, Option, Product, Menu and Price commands and reads authorize every owner read they make
 * (each draft, review, release, binding and policy source asks "may the caller still do this").
 * Each ask used to re-resolve the caller in full — Session, Store selection, membership, store
 * assignment and the permission packet, for the Brand and again for the selected Store — so one
 * Option publication ran ~3.6k–4.9k IAM and ~4.1k–5.8k scope statements in one transaction and
 * ran out of its five-second command clock (503). Store-scope reads and commands moved to
 * `withMerchantTransactionAuthorization` for the same reason.
 *
 * The Brand-scope primitives (`createMerchantBrandScope`, `createMerchantCurrentBrandScope`,
 * `createMerchantProductCurrentAuthorization`) keep their contracts and route every full
 * resolution through this per-transaction memo:
 *
 * - While the transaction's work runs, the first ask resolves in full. A later ask in the same
 *   transaction for the same Session, Tenant, Brand, Store and Actor — the same actions or a
 *   subset of actions already resolved together — before the earliest boundary that resolution
 *   reported (Session expiry, policy validity, the five-second lease) reuses it without an IAM
 *   query. A new ask is resolved together with the actions already asked for in that scope. The
 *   reuse restores the row-level-security scope the full resolution leaves selected (deferred to
 *   the transaction's next statement), so the caller's next owner SQL runs exactly as before.
 * - The first remembered answer registers one before-commit check with the transaction host that
 *   runs after every other before-commit check (so after the transaction's last write). It
 *   resolves every remembered answer again in full — all remembered Brand actions of one scope
 *   together — and refuses the commit (`CATALOG_PERMISSION_DENIED`; the whole transaction rolls
 *   back) when any answer changed: a Session ended or a membership, store assignment or grant
 *   was withdrawn while the command ran. Locks the first resolution took stay held to the end.
 * - Asks made while the host runs its other before-commit checks never reuse the work's
 *   answers: an owner's own before-commit check is its late re-check (it refuses with its own
 *   domain error, e.g. a topology save withdrawn mid-command answers 403, not 503). The first
 *   such ask per key resolves in full and later asks of the check phase reuse that fresh answer.
 *   The final re-check, which runs after every other check, reuses nothing.
 *
 * A transaction of another runner joins by running its work inside
 * `withRememberedBrandAuthorization` (the re-check then runs when that work settles, before the
 * runner commits). Any other transaction (a driver transaction, a test double, a copied wrapper)
 * gets no memo: every ask resolves in full as before.
 */
type Epoch = "work" | "checks";
interface DecisionsResult {
  readonly decisions: readonly ComparableDecision[];
  readonly validUntil: string | null;
}
interface Remembered {
  readonly scope: string;
  readonly key: string;
  readonly epoch: Epoch;
  /** The actions resolved together (decisions entries only). */
  readonly actions: readonly string[] | null;
  /** Settled value and its boundary (null: none), or the in-flight resolution. */
  value?: unknown;
  until?: string | null;
  pending?: Promise<unknown> | undefined;
  readonly resolve: () => Promise<unknown>;
  /** Decisions entries: resolves any action set of this scope together (the union re-check). */
  readonly resolveActions?: (actions: readonly string[]) => Promise<DecisionsResult | null>;
  readonly validUntil: (value: unknown) => string | null;
  readonly same: (previous: unknown, fresh: unknown) => boolean;
  readonly restore: (() => Promise<unknown>) | undefined;
  /** Its freshness is re-checked by another remembered answer of the same scope. */
  readonly covered: boolean;
}
interface Memo {
  readonly entries: Remembered[];
  registered: boolean;
}
const memos = new WeakMap<object, Memo>();
const MAXIMUM_ACTIONS = 16;

/** A decision's answer as the re-check compares it: a changed effect, action or scope refuses. */
export interface ComparableDecision {
  readonly effect: string;
  readonly action: string;
  readonly scopeKind: string;
}
export const sameDecision = (
  previous: ComparableDecision | null | undefined,
  fresh: ComparableDecision | null | undefined,
): boolean =>
  previous === null || previous === undefined
    ? fresh === null || fresh === undefined
    : fresh !== null &&
      fresh !== undefined &&
      previous.effect === fresh.effect &&
      previous.action === fresh.action &&
      previous.scopeKind === fresh.scopeKind;

/** Transactions of other runners whose work runs inside `withRememberedBrandAuthorization`. */
const ownRuns = new WeakMap<object, { phase: Epoch | "closed" }>();

const epochOf = (tx: unknown): Epoch | undefined => {
  const phase = merchantTransactionPhase(tx);
  if (phase === "work" || phase === "checks") return phase;
  if (phase !== undefined || tx === null || typeof tx !== "object") return undefined;
  const own = ownRuns.get(tx)?.phase;
  return own === "work" || own === "checks" ? own : undefined;
};

/**
 * The row-level-security scope a full Brand (`storeReference` null) or Store permission read
 * leaves selected, restored before the transaction's next statement when an answer is reused.
 */
export function restoreBrandTransactionRowSecurity(
  tx: unknown,
  brandReference: string,
  storeReference: string | null,
): Promise<void> {
  const deferred =
    storeReference === null
      ? deferMerchantTransactionStatement(
          tx,
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [brandReference],
        )
      : deferMerchantTransactionStatement(
          tx,
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
  // A transaction of another runner (`withRememberedBrandAuthorization`) restores at once.
  if (!deferred && merchantTransactionPhase(tx) === undefined && epochOf(tx) !== undefined)
    return (tx as { query(sql: string, values: readonly unknown[]): Promise<unknown> })
      .query(
        storeReference === null
          ? "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)"
          : "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        storeReference === null ? [brandReference] : [brandReference, storeReference],
      )
      .then(() => undefined);
  return deferred
    ? Promise.resolve()
    : Promise.reject(new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"));
}

/** Whether asks on `tx` are remembered (a live host transaction in its work or check phase). */
export const rememberedBrandTransaction = (tx: unknown): boolean => epochOf(tx) !== undefined;

const settled = (entry: Remembered) => entry.pending === undefined && "value" in entry;
const live = (entry: Remembered, at: string) =>
  entry.pending !== undefined ||
  (settled(entry) && (entry.until === null || entry.until === undefined || at < entry.until));

async function settle(entry: Remembered): Promise<unknown> {
  if (entry.pending !== undefined) return entry.pending;
  if ("value" in entry) return entry.value;
  const pending = entry.resolve();
  entry.pending = pending;
  try {
    const value = await pending;
    entry.value = value;
    entry.until = entry.validUntil(value);
    return value;
  } finally {
    entry.pending = undefined;
  }
}

function memoFor(tx: object): Memo {
  let memo = memos.get(tx);
  if (!memo) {
    memo = { entries: [], registered: false };
    memos.set(tx, memo);
  }
  return memo;
}

const refuse = (): never => {
  throw new CatalogError("CATALOG_PERMISSION_DENIED");
};

/** Picks `requested` from decisions resolved together for `order`; null when one is missing. */
function pick<D extends ComparableDecision>(
  value: { readonly decisions: readonly D[]; readonly validUntil: string | null },
  order: readonly string[],
  requested: readonly string[],
) {
  if (order.length === requested.length && order.every((a, i) => a === requested[i]))
    return Object.freeze({ decisions: value.decisions, validUntil: value.validUntil });
  const decisions: D[] = [];
  for (const action of requested) {
    const decision = value.decisions[order.indexOf(action)];
    if (decision === undefined || decision.action !== action) return null;
    decisions.push(decision);
  }
  return Object.freeze({ decisions: Object.freeze(decisions), validUntil: value.validUntil });
}

/** Resolves one remembered answer again in full, after every other before-commit check. */
async function recheckValue(entry: Remembered): Promise<unknown> {
  try {
    return await entry.resolve();
  } catch {
    return refuse();
  }
}

/**
 * The single re-check, after every other before-commit check. Brand decisions of one scope are
 * resolved again together (at most 16 actions a resolution); every other remembered answer is
 * resolved again on its own. Nothing remembered is consulted: every answer is read afresh.
 */
async function recheckAll(memo: Memo): Promise<void> {
  const remembered = memo.entries.filter(
    (entry) => settled(entry) && !entry.covered && entry.epoch === "work",
  );
  const grouped = new Map<string, Remembered[]>();
  for (const entry of remembered) {
    if (entry.resolveActions && entry.actions !== null && entry.value !== null) {
      const group = grouped.get(entry.scope) ?? [];
      group.push(entry);
      grouped.set(entry.scope, group);
      continue;
    }
    if (!entry.same(entry.value, await recheckValue(entry))) refuse();
  }
  for (const entries of grouped.values()) {
    const resolveActions = entries[0]?.resolveActions;
    if (!resolveActions) return refuse();
    const union = [...new Set(entries.flatMap((entry) => entry.actions ?? []))];
    const fresh: { readonly order: readonly string[]; readonly value: DecisionsResult }[] = [];
    for (let start = 0; start < union.length; start += MAXIMUM_ACTIONS) {
      const order = Object.freeze(union.slice(start, start + MAXIMUM_ACTIONS));
      let value: DecisionsResult | null;
      try {
        value = await resolveActions(order);
      } catch {
        return refuse();
      }
      if (value === null) return refuse();
      fresh.push({ order, value });
    }
    for (const entry of entries) {
      const previous = entry.value as DecisionsResult,
        actions = entry.actions ?? [];
      const decisions = actions.map((action) => {
        const source = fresh.find((candidate) => candidate.order.includes(action));
        return source?.value.decisions[source.order.indexOf(action)];
      });
      if (
        decisions.length !== previous.decisions.length ||
        !previous.decisions.every((decision, index) => sameDecision(decision, decisions[index]))
      )
        refuse();
    }
  }
}

async function register(tx: object, memo: Memo): Promise<void> {
  if (memo.registered) return;
  memo.registered = true;
  // `withRememberedBrandAuthorization` re-checks after its work itself.
  if (merchantTransactionPhase(tx) === undefined && ownRuns.has(tx)) return;
  // After every other before-commit check: anything those checks wrote is re-read.
  registerMerchantTransactionLastCheck(tx, () => recheckAll(memo));
}

/**
 * The same once-per-transaction Brand authorization for a transaction of another runner (one
 * that has no before-commit checks): asks made on `tx` while `work` runs are remembered, and
 * once `work` settles every remembered answer is resolved again in full — still inside the
 * transaction, before its commit — and a changed answer refuses (`CATALOG_PERMISSION_DENIED`)
 * so the runner rolls back. `tx` must be the transaction object the Brand scope is given. On a
 * live merchant host transaction the host's own before-commit check is used instead.
 */
export async function withRememberedBrandAuthorization<T>(
  tx: object,
  work: () => Promise<T>,
): Promise<T> {
  if (merchantTransactionPhase(tx) !== undefined || ownRuns.has(tx)) return work();
  const run: { phase: Epoch | "closed" } = { phase: "work" };
  ownRuns.set(tx, run);
  try {
    const result = await work();
    run.phase = "checks";
    const memo = memos.get(tx);
    if (memo) await recheckAll(memo);
    return result;
  } finally {
    run.phase = "closed";
    ownRuns.delete(tx);
    memos.delete(tx);
  }
}

async function remember<T>(
  tx: unknown,
  input: {
    readonly scope: string;
    readonly key: string;
    readonly actions: readonly string[] | null;
    readonly now: () => string;
    readonly resolve: () => Promise<T>;
    readonly resolveActions?: (actions: readonly string[]) => Promise<DecisionsResult | null>;
    readonly validUntil: (value: T) => string | null;
    readonly same: (previous: T, fresh: T) => boolean;
    readonly restore?: () => Promise<unknown>;
    readonly covered?: boolean;
    readonly reuse?: (entry: Remembered) => boolean;
  },
): Promise<{ readonly value: T; readonly entry: Remembered | undefined }> {
  const epoch = epochOf(tx);
  if (epoch === undefined || tx === null || typeof tx !== "object")
    return { value: await input.resolve(), entry: undefined };
  const memo = memoFor(tx),
    at = input.now();
  // Asks made while the host runs its other before-commit checks reuse only answers resolved in
  // that phase: an owner's before-commit check is its own late re-check and must see the
  // current answer. The final re-check reads every work answer afresh after them.
  const reusable = memo.entries.find(
    (entry) =>
      entry.scope === input.scope &&
      entry.epoch === epoch &&
      (entry.key === input.key || (settled(entry) && (input.reuse?.(entry) ?? false))) &&
      live(entry, at),
  );
  if (reusable) {
    const value = (await settle(reusable)) as T;
    // The full resolution left this scope's row-level-security context selected; so does reuse.
    if (input.restore) await input.restore();
    return { value, entry: reusable };
  }
  // An expired answer is replaced by a fresh resolution, never extended. A work answer is never
  // replaced by a check-phase one: the final re-check must still resolve it again.
  for (let index = memo.entries.length - 1; index >= 0; index -= 1) {
    const stale = memo.entries[index];
    if (stale?.scope === input.scope && stale.key === input.key && stale.epoch === epoch)
      memo.entries.splice(index, 1);
  }
  const entry: Remembered = {
    scope: input.scope,
    key: input.key,
    epoch,
    actions: input.actions,
    resolve: input.resolve,
    ...(input.resolveActions ? { resolveActions: input.resolveActions } : {}),
    validUntil: input.validUntil as (value: unknown) => string | null,
    same: input.same as (previous: unknown, fresh: unknown) => boolean,
    restore: input.restore,
    covered: input.covered === true,
  };
  memo.entries.push(entry);
  try {
    const value = (await settle(entry)) as T;
    if (epoch === "work") await register(tx, memo);
    return { value, entry };
  } catch (error) {
    const index = memo.entries.indexOf(entry);
    if (index >= 0) memo.entries.splice(index, 1);
    throw error;
  }
}

/**
 * One answer per transaction for `key` within `scope` (Session, Tenant, Brand, Store and Actor),
 * re-resolved once before commit and compared with `same`. `covered`: another remembered answer
 * of the same scope re-checks the same facts, so this one is not resolved again before commit.
 */
export async function rememberBrandTransactionValue<T>(
  tx: unknown,
  input: {
    readonly scope: string;
    readonly key: string;
    readonly now: () => string;
    readonly resolve: () => Promise<T>;
    readonly validUntil?: (value: T) => string | null;
    readonly same: (previous: T, fresh: T) => boolean;
    readonly restore?: () => Promise<unknown>;
    readonly covered?: boolean;
  },
): Promise<T> {
  return (
    await remember(tx, {
      ...input,
      actions: null,
      validUntil: input.validUntil ?? (() => null),
    })
  ).value;
}

/**
 * Decisions for `actions` resolved together once per transaction: a later ask for the same
 * actions or a subset of actions resolved together reuses that resolution and picks its
 * decisions in order. `resolve(actions)` resolves any action set of the scope in full.
 */
export async function rememberBrandTransactionDecisions<R extends DecisionsResult>(
  tx: unknown,
  input: {
    readonly scope: string;
    readonly actions: readonly string[];
    readonly now: () => string;
    readonly resolve: (actions: readonly string[]) => Promise<R | null>;
    readonly restore?: () => Promise<unknown>;
  },
): Promise<{ readonly decisions: R["decisions"]; readonly validUntil: string | null } | null> {
  const requested = Object.freeze([...input.actions]);
  // A new ask resolves the actions this transaction already asked for in this scope with it, so
  // later asks for any of them reuse one resolution (and the re-check has one set to resolve).
  const epoch = epochOf(tx),
    memo = epoch !== undefined && tx !== null && typeof tx === "object" ? memos.get(tx) : undefined,
    at = memo ? input.now() : "",
    scoped = (memo?.entries ?? []).filter(
      (entry) =>
        entry.scope === input.scope &&
        entry.epoch === epoch &&
        entry.actions !== null &&
        settled(entry) &&
        entry.value !== null,
    ),
    covered = scoped.some(
      (entry) => live(entry, at) && requested.every((action) => entry.actions?.includes(action)),
    ),
    extra = covered
      ? []
      : [
          ...new Set(
            scoped
              .flatMap((entry) => entry.actions ?? [])
              .filter((action) => !requested.includes(action)),
          ),
        ],
    actions =
      extra.length > 0 && requested.length + extra.length <= MAXIMUM_ACTIONS
        ? Object.freeze([...requested, ...extra])
        : requested;
  const attempt = (asked: readonly string[]) =>
    remember<R | null>(tx, {
      scope: input.scope,
      key: "decisions:" + [...asked].sort().join(","),
      actions: asked,
      now: input.now,
      resolve: () => input.resolve(asked),
      resolveActions: input.resolve,
      validUntil: (result) => result?.validUntil ?? null,
      same: (previous, fresh) =>
        previous === null
          ? fresh === null
          : fresh !== null &&
            previous.decisions.length === fresh.decisions.length &&
            previous.decisions.every((decision, index) =>
              sameDecision(decision, fresh.decisions[index]),
            ),
      ...(input.restore ? { restore: input.restore } : {}),
      // A refused (null) answer is never reused for a different set of actions.
      reuse: (candidate) =>
        candidate.actions !== null &&
        candidate.value !== null &&
        candidate.value !== undefined &&
        asked.every((action) => candidate.actions?.includes(action)),
    });
  let { value, entry } = await attempt(actions);
  if (value === null && actions !== requested) {
    // An action of the wider set this scope cannot answer: forget it and ask on its own.
    const index = memo && entry ? memo.entries.indexOf(entry) : -1;
    if (memo && index >= 0) memo.entries.splice(index, 1);
    ({ value, entry } = await attempt(requested));
  }
  if (value === null) return null;
  return pick(value, entry?.actions ?? requested, requested) as {
    readonly decisions: R["decisions"];
    readonly validUntil: string | null;
  } | null;
}
