import {
  createSellingUnitRecoveryClient,
  parseSellingUnitCursor,
  type SellingUnitCursor,
  type SellingUnitRecoveryScope,
} from "./selling-unit-recovery-client.js";
import {
  createSellingUnitPendingJournal,
  type SellingUnitPendingJournal,
} from "./selling-unit-pending-journal.js";
import {
  ProductSellingUnitsError,
  type createProductSellingUnitsClient,
} from "./product-selling-units-client.js";
/** Create and Edit share one scoped registration slot. A reloaded slot can only
 * resolve its original identity; definitions and human confirmations stay in memory. */
export function createSellingUnitRecovery(options: {
  readonly currentContext: () => number;
  readonly client?: ReturnType<typeof createSellingUnitRecoveryClient>;
  readonly journal?: (scope: SellingUnitRecoveryScope) => SellingUnitPendingJournal;
}) {
  const client = options.client ?? createSellingUnitRecoveryClient(),
    journalFor = options.journal ?? createSellingUnitPendingJournal;
  let checked = false,
    cursor: SellingUnitCursor | null = null,
    journal: SellingUnitPendingJournal | null = null,
    selected: SellingUnitRecoveryScope | null = null,
    busy = false,
    cleanupFailed = false;
  const guard = (context: number, signal: AbortSignal) => {
    if (options.currentContext() !== context || signal.aborted)
      throw new ProductSellingUnitsError("Conflict");
  };
  const inspect = async (
    action: "Create" | "ReplaceDraft",
    scope: { readonly brandReference: string; readonly storeReference: string },
    csrf: string,
    signal: AbortSignal,
  ) => {
    const context = options.currentContext();
    checked = false;
    const actual = await client.context(action, scope, csrf, signal);
    guard(context, signal);
    const current = Object.freeze({
      tenantReference: actual.tenantReference,
      brandReference: actual.brandReference,
      storeReference: actual.storeReference,
      actorReference: actual.actorReference,
    });
    if (cursor && selected && JSON.stringify(current) !== JSON.stringify(selected))
      throw new ProductSellingUnitsError("Conflict");
    selected = current;
    journal = journalFor(current);
    const loaded = await journal.load();
    guard(context, signal);
    cursor = loaded;
    checked = true;
  };
  return Object.freeze({
    view: () => Object.freeze({ checked, pending: cursor !== null, cleanupFailed }),
    inspect,
    async execute(
      original: ReturnType<ReturnType<typeof createProductSellingUnitsClient>["prepare"]>,
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy) throw new ProductSellingUnitsError("Unavailable");
      busy = true;
      const context = options.currentContext();
      try {
        await inspect(original.command.action, original.scope, csrf, signal);
        guard(context, signal);
        if (!selected || !journal) throw new ProductSellingUnitsError("Unavailable");
        const next = parseSellingUnitCursor(
          {
            profile: "CatalogSellingUnitRegistrationCursorV1",
            scope: selected,
            action: original.command.action,
            operationReference: original.command.operationReference,
            expectedRegistryVersion: original.command.expectedRegistryVersion,
          },
          selected,
        );
        if (cursor && JSON.stringify(cursor) !== JSON.stringify(next))
          throw new ProductSellingUnitsError("Conflict");
        try {
          await journal.reserve(next);
        } catch {
          checked = false;
          throw new ProductSellingUnitsError("Conflict");
        }
        cursor = next;
        guard(context, signal);
        const receipt = await original.execute(csrf, signal);
        guard(context, signal);
        try {
          await journal.complete(next);
          guard(context, signal);
          cursor = null;
          cleanupFailed = false;
        } catch {
          cleanupFailed = true;
        }
        return receipt;
      } finally {
        busy = false;
      }
    },
    async resolve(
      action: "Create" | "ReplaceDraft",
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal: AbortSignal,
    ) {
      if (busy) throw new ProductSellingUnitsError("Unavailable");
      busy = true;
      const context = options.currentContext();
      try {
        await inspect(action, scope, csrf, signal);
        if (!cursor || !journal) throw new ProductSellingUnitsError("Unavailable");
        const original = cursor,
          resolution = await client.resolve(original, csrf, signal);
        guard(context, signal);
        try {
          await journal.complete(original);
          guard(context, signal);
          cursor = null;
          cleanupFailed = false;
        } catch {
          cleanupFailed = true;
        }
        return resolution;
      } finally {
        busy = false;
      }
    },
  });
}
