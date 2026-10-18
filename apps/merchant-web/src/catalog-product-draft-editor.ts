import {
  createProductDraftEditingSession,
  ProductDraftBaselineClientError,
  type ProductDraftEditingSession,
  type ProductDraftBaselineExpectedScope,
} from "./catalog-product-draft-baseline.js";
import {
  ProductDraftBaselineTransportClientError,
  type ProductDraftBaselineTransportClient,
} from "./catalog-product-draft-baseline-client.js";
import {
  ProductCommandClientError,
  type createProductCommandClient,
} from "./catalog-product-command-client.js";
import {
  productCommandRecord,
  parseCatalogReference,
  type ProductVersion,
} from "./catalog-product-command-values.js";
export type ProductDraftEditorErrorCode =
  | "Invalid"
  | "Denied"
  | "FeatureDisabled"
  | "Conflict"
  | "Unavailable"
  | "Stale"
  | "NotFound"
  | "OutcomeUnknown"
  | "Busy"
  | "PendingSave"
  | "UnsavedChanges"
  | "ScopeChanged";
export class ProductDraftEditorError extends Error {
  constructor(
    readonly code: ProductDraftEditorErrorCode,
    readonly attemptCode?: ProductCommandClientError["attemptCode"],
  ) {
    super("Product draft editing could not continue");
    this.name = "ProductDraftEditorError";
  }
}
export type ProductDraftEditorStatus =
  | "Unloaded"
  | "Loading"
  | "Ready"
  | "Saving"
  | "OutcomeUnknown"
  | "NeedsRefresh"
  | "ReadFailed"
  | "SaveFailed"
  | "ScopeChanged";
function scope(value: unknown): ProductDraftBaselineExpectedScope {
  try {
    const raw = productCommandRecord(value, [
      "brandReference",
      "storeReference",
      "productReference",
    ]);
    return Object.freeze({
      brandReference: parseCatalogReference(raw.brandReference),
      storeReference: parseCatalogReference(raw.storeReference),
      productReference: parseCatalogReference(raw.productReference),
    });
  } catch {
    throw new ProductDraftEditorError("ScopeChanged");
  }
}
// Only parsed immutable Draft values reach this comparison, never caller accessors.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** In-memory editing only. Current authority remains server-owned; no automatic IDs/retries. */
export function createProductDraftEditor(options: {
  readonly expectedScope: ProductDraftBaselineExpectedScope;
  readonly currentScope: () => unknown;
  /** Local auth-context generation; never a credential or permission. New login creates a new editor. */
  readonly currentContext: () => number;
  readonly baseline: Pick<ProductDraftBaselineTransportClient, "load">;
  readonly commands: Pick<ReturnType<typeof createProductCommandClient>, "prepareDraft">;
  readonly now: () => number;
}) {
  const selected = scope(options.expectedScope);
  if (
    typeof options.currentScope !== "function" ||
    typeof options.currentContext !== "function" ||
    typeof options.baseline?.load !== "function" ||
    typeof options.commands?.prepareDraft !== "function" ||
    typeof options.now !== "function"
  )
    throw new ProductDraftEditorError("Unavailable");
  const context = options.currentContext();
  if (!Number.isSafeInteger(context) || context < 0)
    throw new ProductDraftEditorError("Unavailable");
  const sameContext = () => {
    try {
      return options.currentContext() === context;
    } catch {
      return false;
    }
  };
  let status: ProductDraftEditorStatus = "Unloaded",
    session: ProductDraftEditingSession | null = null,
    draft: ProductVersion | null = null,
    dirty = false,
    busy = false,
    epoch = 0,
    floor = 0,
    applied = false;
  let pending: ReturnType<ReturnType<typeof createProductCommandClient>["prepareDraft"]> | null =
    null;
  let error: ProductDraftEditorError | null = null;
  const fail = (code: ProductDraftEditorErrorCode): never => {
    throw new ProductDraftEditorError(code);
  };
  const matches = () => {
    try {
      return sameContext() && equal(scope(options.currentScope()), selected);
    } catch {
      return false;
    }
  };
  const invalidate = () => {
    if (status !== "ScopeChanged") {
      epoch++;
      status = "ScopeChanged";
      session = null;
      draft = null;
      dirty = false;
      error = new ProductDraftEditorError("ScopeChanged");
    }
  };
  const current = () => {
    if (!matches()) {
      invalidate();
      return fail("ScopeChanged");
    }
  };
  const available = () => {
    current();
    if (busy) return fail("Busy");
  };
  const boundedRead = (value: unknown): ProductDraftEditorError => {
    if (
      value instanceof ProductDraftBaselineTransportClientError ||
      value instanceof ProductDraftBaselineClientError
    )
      return new ProductDraftEditorError(value.code);
    if (value instanceof ProductDraftEditorError) return value;
    return new ProductDraftEditorError("Unavailable");
  };
  async function read(signal: AbortSignal, refresh: boolean): Promise<void> {
    current();
    const generation = epoch;
    status = "Loading";
    session = null;
    draft = null;
    dirty = false;
    error = null;
    try {
      const raw = await options.baseline.load(selected, signal);
      current();
      if (generation !== epoch) return fail("ScopeChanged");
      const next = createProductDraftEditingSession(raw, selected, options.now());
      if (next.view.baseline.aggregateVersion < floor) return fail("Stale");
      session = next;
      draft = next.view.baseline.draft;
      status = "Ready";
      applied = false;
    } catch (value) {
      if (!matches() || generation !== epoch) {
        invalidate();
        return fail("ScopeChanged");
      }
      error = boundedRead(value);
      status = refresh ? "NeedsRefresh" : "ReadFailed";
      throw error;
    }
  }
  async function load(signal: AbortSignal, discard: boolean): Promise<void> {
    available();
    if (pending) return fail("PendingSave");
    if (dirty && !discard) return fail("UnsavedChanges");
    busy = true;
    try {
      await read(signal, applied);
    } finally {
      busy = false;
    }
  }
  async function execute(csrf: string, signal?: AbortSignal): Promise<void> {
    available();
    if (!pending) return fail("Invalid");
    const operation = pending,
      generation = epoch;
    busy = true;
    status = "Saving";
    error = null;
    try {
      let receipt;
      try {
        receipt = await operation.execute(csrf, signal);
      } catch (value) {
        const problem =
          value instanceof ProductCommandClientError
            ? new ProductDraftEditorError(value.code, value.attemptCode)
            : new ProductDraftEditorError("OutcomeUnknown");
        if (problem.code !== "OutcomeUnknown") pending = null;
        if (!matches() || generation !== epoch) {
          invalidate();
          return fail("ScopeChanged");
        }
        status = problem.code === "OutcomeUnknown" ? "OutcomeUnknown" : "SaveFailed";
        error = problem;
        throw problem;
      }
      pending = null;
      floor = Math.max(floor, receipt.aggregateVersion);
      applied = true;
      if (!matches() || generation !== epoch) {
        invalidate();
        return fail("ScopeChanged");
      }
      await read(signal ?? new AbortController().signal, true);
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    view() {
      if (!matches()) invalidate();
      const visible =
        status === "Ready" ||
        status === "Saving" ||
        (status === "OutcomeUnknown" &&
          error?.attemptCode !== "Denied" &&
          error?.attemptCode !== "FeatureDisabled") ||
        (status === "SaveFailed" && (error?.code === "Invalid" || error?.code === "Conflict"));
      return Object.freeze({
        status,
        dirty: sameContext() && dirty,
        pendingSave: sameContext() && pending !== null,
        appliedNeedsRefresh: sameContext() && applied,
        baseline: visible ? (session?.view.baseline ?? null) : null,
        draft: visible ? draft : null,
        error:
          error === null
            ? null
            : Object.freeze({
                code: error.code,
                ...(error.attemptCode === undefined ? {} : { attemptCode: error.attemptCode }),
              }),
      });
    },
    load: (signal: AbortSignal) => load(signal, false),
    /** Discard local unsaved edits only; never a server Draft deletion. */
    discardAndReload: (signal: AbortSignal) => load(signal, true),
    edit(value: unknown) {
      available();
      if (pending) return fail("PendingSave");
      if (
        !session ||
        !draft ||
        !(
          status === "Ready" ||
          (status === "SaveFailed" && (error?.code === "Invalid" || error?.code === "Conflict"))
        )
      )
        return fail("Unavailable");
      const next = session.parseDraft(value, selected);
      draft = next;
      dirty = !equal(next, session.view.baseline.draft);
      status = "Ready";
      error = null;
    },
    async save(operationReference: string, csrf: string, signal?: AbortSignal) {
      available();
      if (pending) return fail("PendingSave");
      if (status !== "Ready" || !session || !draft || !dirty) return fail("Invalid");
      pending = session.prepareSave(options.commands, { operationReference, draft }, selected);
      await execute(csrf, signal);
    },
    /** Recover only the captured operation in its original scope; never prepare a new intent. */
    retrySave: (csrf: string, signal?: AbortSignal) => execute(csrf, signal),
  });
}
export type ProductDraftEditor = ReturnType<typeof createProductDraftEditor>;
