import {
  createProductCommandClient,
  ProductCommandClientError,
} from "./catalog-product-command-client.js";
import {
  createProductAuthoringRecoveryClient,
  parseProductAuthoringCursor,
  ProductAuthoringRecoveryError,
  type ProductAuthoringAction,
  type ProductAuthoringCursor,
  type ProductAuthoringRecoveryScope,
} from "./product-authoring-recovery-client.js";
import {
  createProductAuthoringPendingJournal,
  type ProductAuthoringPendingJournal,
} from "./product-authoring-pending-journal.js";
/** One mounted authoring context. Journal absence is trusted only after a
 * successful actual-context read and exact scoped journal inspection. */
export function createProductAuthoringRecovery(options: {
  readonly action: ProductAuthoringAction;
  readonly productReference: string | null;
  readonly currentContext: () => number;
  readonly client?: ReturnType<typeof createProductAuthoringRecoveryClient>;
  readonly journal?: (scope: ProductAuthoringRecoveryScope) => ProductAuthoringPendingJournal;
  readonly commands?: ReturnType<typeof createProductCommandClient>;
}) {
  const action = options.action,
    productReference = options.productReference,
    currentContext = options.currentContext.bind(options),
    client = options.client ?? createProductAuthoringRecoveryClient(),
    loadContext = client.context.bind(client),
    resolveOriginal = client.resolve.bind(client),
    journalFor = options.journal?.bind(options) ?? createProductAuthoringPendingJournal,
    commands = options.commands ?? createProductCommandClient(),
    prepareCreate = commands.prepareCreate.bind(commands),
    prepareDraft = commands.prepareDraft.bind(commands),
    context = currentContext(),
    dispatched = new WeakSet<object>();
  if (
    (action !== "Create" && action !== "ReplaceDraft") ||
    (action === "Create" && productReference !== null) ||
    (action === "ReplaceDraft" && typeof productReference !== "string")
  )
    throw new ProductAuthoringRecoveryError("Invalid");
  let checked = false,
    cursor: ProductAuthoringCursor | null = null,
    journal: ProductAuthoringPendingJournal | null = null,
    selected: ProductAuthoringRecoveryScope | null = null,
    busy = false,
    cleanupFailed = false;
  const guard = (signal: AbortSignal) => {
    if (currentContext() !== context || signal.aborted)
      throw new ProductAuthoringRecoveryError("ScopeChanged");
  };
  const inspect = async (
    scope: { readonly brandReference: string; readonly storeReference: string },
    csrf: string,
    signal: AbortSignal,
  ) => {
    guard(signal);
    checked = false;
    const actual = await loadContext(action, scope, csrf, signal);
    guard(signal);
    const current = Object.freeze({
      tenantReference: actual.tenantReference,
      brandReference: actual.brandReference,
      storeReference: actual.storeReference,
      actorReference: actual.actorReference,
      action,
      productReference,
    });
    if (selected && JSON.stringify(selected) !== JSON.stringify(current))
      throw new ProductAuthoringRecoveryError("ScopeChanged");
    selected = current;
    journal = journalFor(current);
    cursor = await journal.load();
    guard(signal);
    checked = true;
  };
  async function execute<T>(
    command: { readonly operationReference: string; readonly expectedAggregateVersion?: number },
    scope: { readonly brandReference: string; readonly storeReference: string },
    original: { execute(csrf: string, signal?: AbortSignal): Promise<T> },
    csrf: string,
    signal?: AbortSignal,
  ): Promise<T> {
    if (busy) throw new ProductAuthoringRecoveryError("Unavailable");
    busy = true;
    const actualSignal = signal ?? new AbortController().signal;
    try {
      await inspect(scope, csrf, actualSignal);
      if (!selected || !journal) throw new ProductAuthoringRecoveryError("Unavailable");
      const next = parseProductAuthoringCursor(
        {
          profile: "CatalogProductAuthoringCursorV1",
          scope: selected,
          operationReference: command.operationReference,
          expectedAggregateVersion: action === "Create" ? null : command.expectedAggregateVersion,
        },
        selected,
      );
      if (cursor && JSON.stringify(cursor) !== JSON.stringify(next))
        throw new ProductCommandClientError(
          dispatched.has(original) ? "OutcomeUnknown" : "Conflict",
        );
      await journal.reserve(next);
      cursor = next;
      guard(actualSignal);
      dispatched.add(original);
      const receipt = await original.execute(csrf, actualSignal);
      // An acknowledged mutation stays acknowledged even if local CAS cleanup
      // fails. The retained marker can be authoritatively resolved next time.
      try {
        await journal.complete(next);
        cursor = null;
        cleanupFailed = false;
      } catch {
        cleanupFailed = true;
      }
      return receipt;
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    view() {
      return Object.freeze({ checked, pending: cursor !== null, busy, cleanupFailed });
    },
    inspect,
    async resolve(
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy) throw new ProductAuthoringRecoveryError("Unavailable");
      busy = true;
      try {
        await inspect(scope, csrf, signal);
        if (!cursor || !journal) throw new ProductAuthoringRecoveryError("Unavailable");
        const original = cursor,
          result = await resolveOriginal(original, csrf, signal);
        guard(signal);
        try {
          await journal.complete(original);
          cursor = null;
          cleanupFailed = false;
        } catch {
          cleanupFailed = true;
        }
        return result;
      } finally {
        busy = false;
      }
    },
    commands: Object.freeze({
      ...commands,
      prepareCreate(value: unknown, scopeValue: unknown) {
        if (action !== "Create") throw new ProductAuthoringRecoveryError("Invalid");
        const original = prepareCreate(value, scopeValue);
        return Object.freeze({
          ...original,
          execute: (csrf: string, signal?: AbortSignal) =>
            execute(original.command, original.scope, original, csrf, signal),
        });
      },
      prepareDraft(value: unknown, scopeValue: unknown) {
        if (action !== "ReplaceDraft") throw new ProductAuthoringRecoveryError("Invalid");
        const original = prepareDraft(value, scopeValue);
        return Object.freeze({
          ...original,
          execute: (csrf: string, signal?: AbortSignal) =>
            execute(original.command, original.scope, original, csrf, signal),
        });
      },
    }),
  });
}
