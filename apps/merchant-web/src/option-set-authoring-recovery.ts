import {
  createOptionSetAuthoringClient,
  OptionSetAuthoringClientError,
  parseOptionSetAuthoringCursor,
  type OptionSetAuthoringAction,
  type OptionSetAuthoringScope,
  type OptionSetAuthoringCursor,
  type OptionSetPreparedAuthoringRequest,
  type OptionSetAuthoringClient,
} from "./option-set-authoring-client.js";
import {
  createOptionSetAuthoringPendingJournal,
  type OptionSetAuthoringJournalScope,
  type OptionSetAuthoringPendingJournal,
} from "./option-set-authoring-pending-journal.js";
/** One mounted context. No new command can bypass actual context + committed
 * identity reservation. A reload has identity only and must explicitly Resolve. */
export function createOptionSetAuthoringRecovery(options: {
  readonly action: OptionSetAuthoringAction;
  readonly optionSetReference: string | null;
  readonly currentContext: () => number;
  readonly client?: OptionSetAuthoringClient;
  readonly journal?: (scope: OptionSetAuthoringJournalScope) => OptionSetAuthoringPendingJournal;
}) {
  const action = options.action,
    set = options.optionSetReference,
    currentContext = options.currentContext.bind(options),
    epoch = currentContext(),
    client = options.client ?? createOptionSetAuthoringClient(),
    context = client.context.bind(client),
    resolveOriginal = client.resolve.bind(client),
    readCurrent = client.readCurrent.bind(client),
    prepareCreate = client.prepareCreate.bind(client),
    prepareDraft = client.prepareDraft.bind(client),
    journalFor = options.journal?.bind(options) ?? createOptionSetAuthoringPendingJournal;
  if (
    (action !== "Create" && action !== "Edit") ||
    (action === "Create" && set !== null) ||
    (action === "Edit" && typeof set !== "string")
  )
    throw new OptionSetAuthoringClientError("Invalid");
  let checked = false,
    busy = false,
    cleanupFailed = false,
    selected: OptionSetAuthoringScope | null = null,
    journal: OptionSetAuthoringPendingJournal | null = null,
    cursor: OptionSetAuthoringCursor | null = null,
    prepared: OptionSetPreparedAuthoringRequest | null = null,
    contextUntil = 0,
    confirmedSet: string | null = null;
  const guard = (signal: AbortSignal) => {
    if (currentContext() !== epoch || signal.aborted)
      throw new OptionSetAuthoringClientError("ScopeChanged");
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  async function inspectActual(
    scope: { readonly brandReference: string; readonly storeReference: string },
    csrf: string,
    signal: AbortSignal,
  ) {
    guard(signal);
    checked = false;
    const actual = await context(action, scope, csrf, signal);
    guard(signal);
    if (selected && !same(selected, actual.scope))
      throw new OptionSetAuthoringClientError("ScopeChanged");
    contextUntil = Date.parse(actual.validUntil);
    selected = actual.scope;
    journal = journalFor({ ...actual.scope, action, optionSetReference: set });
    const loaded = await journal.load();
    guard(signal);
    if (loaded) {
      const parsed = parseOptionSetAuthoringCursor(loaded);
      if (
        !same(parsed.scope, selected) ||
        parsed.action !== action ||
        parsed.optionSetReference !== set
      )
        throw new OptionSetAuthoringClientError("ScopeChanged");
      cursor = parsed;
    } else if (cursor) throw new OptionSetAuthoringClientError("Unavailable");
    checked = true;
    return actual.scope;
  }
  async function clear(original: OptionSetAuthoringCursor, signal: AbortSignal) {
    guard(signal);
    if (!journal) throw new OptionSetAuthoringClientError("Unavailable");
    try {
      await journal.complete(original);
      guard(signal);
      cursor = null;
      cleanupFailed = false;
      prepared = null;
    } catch {
      cleanupFailed = true;
    }
  }
  async function execute(
    original: OptionSetPreparedAuthoringRequest,
    csrf: string,
    signal: AbortSignal,
  ) {
    if (!journal || !selected || !same(original.scope, selected))
      throw new OptionSetAuthoringClientError("ScopeChanged");
    if (cursor && !same(cursor, original.cursor))
      throw new OptionSetAuthoringClientError("Conflict");
    await journal.reserve(original.cursor);
    cursor = original.cursor;
    guard(signal);
    if (!Number.isFinite(contextUntil) || Date.now() >= contextUntil)
      throw new OptionSetAuthoringClientError("Stale");
    const receipt = await original.execute(csrf, signal);
    guard(signal);
    confirmedSet = receipt.content.sourceAggregate.optionSetReference;
    checked = false;
    const current = await readCurrent(
      {
        optionSetReference: receipt.content.sourceAggregate.optionSetReference,
        expectedAggregateVersion: null,
      },
      selected,
      csrf,
      signal,
    );
    guard(signal);
    await clear(original.cursor, signal);
    guard(signal);
    checked = true;
    return { receipt, current };
  }
  return Object.freeze({
    view() {
      return Object.freeze({
        checked,
        busy,
        pending: cursor !== null,
        cleanupFailed,
        scope: selected,
        confirmedSet,
        canRetry: prepared !== null,
      });
    },
    async inspect(
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy) throw new OptionSetAuthoringClientError("Unavailable");
      busy = true;
      try {
        return await inspectActual(scope, csrf, signal);
      } finally {
        busy = false;
      }
    },
    async write(
      value: unknown,
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      baseline?: unknown,
      signal = new AbortController().signal,
    ) {
      if (busy) throw new OptionSetAuthoringClientError("Unavailable");
      busy = true;
      try {
        if (action === "Create" && confirmedSet)
          throw new OptionSetAuthoringClientError("Conflict");
        await inspectActual(scope, csrf, signal);
        if (cursor) throw new OptionSetAuthoringClientError("Conflict");
        if (!selected) throw new OptionSetAuthoringClientError("Unavailable");
        prepared =
          action === "Create"
            ? prepareCreate(value, selected)
            : prepareDraft(value, selected, baseline);
        return await execute(prepared, csrf, signal);
      } finally {
        busy = false;
      }
    },
    async retry(
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy || !prepared || !cursor) throw new OptionSetAuthoringClientError("Unavailable");
      busy = true;
      try {
        const original = prepared;
        await inspectActual(scope, csrf, signal);
        guard(signal);
        return await execute(original, csrf, signal);
      } finally {
        busy = false;
      }
    },
    async resolve(
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy) throw new OptionSetAuthoringClientError("Unavailable");
      busy = true;
      try {
        await inspectActual(scope, csrf, signal);
        if (!cursor || !selected) throw new OptionSetAuthoringClientError("Unavailable");
        if (!Number.isFinite(contextUntil) || Date.now() >= contextUntil)
          throw new OptionSetAuthoringClientError("Stale");
        const original = cursor,
          result = await resolveOriginal(original, selected, csrf, signal);
        guard(signal);
        checked = false;
        if (result.content) confirmedSet = result.content.sourceAggregate.optionSetReference;
        const current = result.content
          ? await readCurrent(
              {
                optionSetReference: result.content.sourceAggregate.optionSetReference,
                expectedAggregateVersion: null,
              },
              selected,
              csrf,
              signal,
            )
          : null;
        guard(signal);
        await clear(original, signal);
        guard(signal);
        checked = true;
        return { result, current };
      } finally {
        busy = false;
      }
    },
  });
}
export type OptionSetAuthoringRecovery = ReturnType<typeof createOptionSetAuthoringRecovery>;
