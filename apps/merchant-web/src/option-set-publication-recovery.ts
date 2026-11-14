import {
  createOptionSetPublicationClient,
  OptionSetPublicationClientError,
  parseOptionSetPublicationCursor,
  type OptionSetPublicationClient,
  type OptionSetPublicationContext,
  type OptionSetPublicationCursor,
  type OptionSetPublicationScope,
  type OptionSetPublicationAction,
  type OptionSetPreparedPublication,
  type OptionSetPublicationReceipt,
} from "./option-set-publication-client.js";
import {
  createOptionSetPublicationPendingJournal,
  type OptionSetPublicationJournalScope,
  type OptionSetPublicationPendingJournal,
} from "./option-set-publication-pending-journal.js";
import { createOptionSetAuthoringPendingJournal } from "./option-set-authoring-pending-journal.js";
import type { OptionSetAuthoringScope } from "./option-set-authoring-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
export function createOptionSetPublicationRecovery(options: {
  readonly optionSetReference: string;
  readonly currentContext: () => number;
  readonly refreshCurrent: () => Promise<void>;
  readonly client?: OptionSetPublicationClient;
  readonly authoringPending?: (scope: OptionSetAuthoringScope, set: string) => Promise<boolean>;
  readonly journal?: (s: OptionSetPublicationJournalScope) => OptionSetPublicationPendingJournal;
}) {
  const set = options.optionSetReference,
    epoch = options.currentContext(),
    currentContext = options.currentContext.bind(options),
    refresh = options.refreshCurrent.bind(options),
    client = options.client ?? createOptionSetPublicationClient(),
    contextPort = client.context.bind(client),
    prepare = client.prepare.bind(client),
    resolvePort = client.resolve.bind(client),
    validatePort = client.validate.bind(client),
    journalFor = options.journal?.bind(options) ?? createOptionSetPublicationPendingJournal,
    authoringPort =
      options.authoringPending?.bind(options) ??
      (async (s: OptionSetAuthoringScope, target: string) =>
        (await createOptionSetAuthoringPendingJournal({
          ...s,
          action: "Edit",
          optionSetReference: target,
        }).load()) !== null);
  let checked = false,
    busy = false,
    cleanupFailed = false,
    authoringPending = false,
    scope: OptionSetAuthoringScope | null = null,
    journal: OptionSetPublicationPendingJournal | null = null,
    cursor: OptionSetPublicationCursor | null = null,
    prepared: OptionSetPreparedPublication | null = null,
    context: OptionSetPublicationContext | null = null,
    lastReceipt: OptionSetPublicationReceipt | null = null;
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b),
    guard = (signal: AbortSignal) => {
      if (signal.aborted || currentContext() !== epoch)
        throw new OptionSetPublicationClientError("ScopeChanged");
    };
  async function inspect(s: OptionSetPublicationScope, csrf: string, signal: AbortSignal) {
    guard(signal);
    checked = false;
    const actual = await contextPort(
      { optionSetReference: set, expectedAggregateVersion: null, action: "Inspect" },
      s,
      csrf,
      signal,
    );
    guard(signal);
    if (scope && !same(scope, actual.scope))
      throw new OptionSetPublicationClientError("ScopeChanged");
    scope = actual.scope;
    context = actual;
    journal = journalFor({ ...scope, optionSetReference: set });
    const stored = await journal.load();
    guard(signal);
    authoringPending = await authoringPort(scope, set);
    guard(signal);
    if (stored) {
      const original = parseOptionSetPublicationCursor(stored);
      if (!same(original.scope, scope) || original.command.optionSetReference !== set)
        throw new OptionSetPublicationClientError("ScopeChanged");
      cursor = original;
    } else if (cursor) throw new OptionSetPublicationClientError("Unavailable");
    checked = true;
    return actual;
  }
  async function terminal(
    original: OptionSetPublicationCursor,
    receipt: OptionSetPublicationReceipt,
    s: OptionSetPublicationScope,
    csrf: string,
    signal: AbortSignal,
  ) {
    guard(signal);
    lastReceipt = receipt;
    checked = false;
    await refresh();
    guard(signal);
    const actual = await contextPort(
      { optionSetReference: set, expectedAggregateVersion: null, action: "Inspect" },
      s,
      csrf,
      signal,
    );
    guard(signal);
    if (!scope || !same(actual.scope, scope))
      throw new OptionSetPublicationClientError("ScopeChanged");
    context = actual;
    if (!journal) throw new OptionSetPublicationClientError("Unavailable");
    try {
      await journal.complete(original);
      guard(signal);
      cursor = null;
      prepared = null;
      cleanupFailed = false;
      checked = true;
    } catch {
      cleanupFailed = true;
    }
    return { receipt, context: actual };
  }
  async function execute(
    p: OptionSetPreparedPublication,
    s: OptionSetPublicationScope,
    csrf: string,
    signal: AbortSignal,
  ) {
    if (!journal || !scope || !same(scope, p.cursor.scope))
      throw new OptionSetPublicationClientError("ScopeChanged");
    if (cursor && !same(cursor, p.cursor)) throw new OptionSetPublicationClientError("Conflict");
    await journal.reserve(p.cursor);
    cursor = p.cursor;
    guard(signal);
    const result = await p.execute(csrf, signal);
    guard(signal);
    return terminal(p.cursor, result, s, csrf, signal);
  }
  return Object.freeze({
    view() {
      return Object.freeze({
        checked,
        busy,
        authoringPending,
        pending: cursor !== null,
        cleanupFailed,
        canRetry: prepared !== null,
        context,
        lastReceipt,
        scope,
      });
    },
    async inspect(s: OptionSetPublicationScope, csrf: string, signal: AbortSignal) {
      if (busy) throw new OptionSetPublicationClientError("Conflict");
      busy = true;
      try {
        return await inspect(s, csrf, signal);
      } finally {
        busy = false;
      }
    },
    async validate(
      savedVersion: number,
      s: OptionSetPublicationScope,
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy || cursor || authoringPending || !checked)
        throw new OptionSetPublicationClientError("Conflict");
      busy = true;
      try {
        const c = await contextPort(
          { optionSetReference: set, expectedAggregateVersion: savedVersion, action: "Validate" },
          s,
          csrf,
          signal,
        );
        guard(signal);
        if (!scope || !same(c.scope, scope))
          throw new OptionSetPublicationClientError("ScopeChanged");
        const report = await validatePort(c, csrf, signal);
        guard(signal);
        context = c;
        return report;
      } finally {
        busy = false;
      }
    },
    async write(
      action: OptionSetPublicationAction,
      operationReference: string,
      savedVersion: number,
      s: OptionSetPublicationScope,
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy || cursor || authoringPending || !checked)
        throw new OptionSetPublicationClientError("Conflict");
      busy = true;
      try {
        await inspect(s, csrf, signal);
        if (cursor || authoringPending) throw new OptionSetPublicationClientError("Conflict");
        const c = await contextPort(
          { optionSetReference: set, expectedAggregateVersion: savedVersion, action },
          s,
          csrf,
          signal,
        );
        guard(signal);
        if (!scope || !same(c.scope, scope))
          throw new OptionSetPublicationClientError("ScopeChanged");
        prepared = prepare(c, action, operationReference);
        return await execute(prepared, s, csrf, signal);
      } finally {
        busy = false;
      }
    },
    async retry(s: OptionSetPublicationScope, csrf: string, signal: AbortSignal) {
      if (busy || !cursor || !prepared) throw new OptionSetPublicationClientError("Unavailable");
      busy = true;
      try {
        const original = prepared;
        await inspect(s, csrf, signal);
        guard(signal);
        return await execute(original, s, csrf, signal);
      } finally {
        busy = false;
      }
    },
    async resolve(s: OptionSetPublicationScope, csrf: string, signal: AbortSignal) {
      if (busy) throw new OptionSetPublicationClientError("Conflict");
      busy = true;
      try {
        await inspect(s, csrf, signal);
        if (!cursor || !scope) throw new OptionSetPublicationClientError("Unavailable");
        const original = cursor,
          result = await resolvePort(original, scope, csrf, signal);
        guard(signal);
        return await terminal(original, result, s, csrf, signal);
      } finally {
        busy = false;
      }
    },
  });
}
export type OptionSetPublicationRecovery = ReturnType<typeof createOptionSetPublicationRecovery>;
