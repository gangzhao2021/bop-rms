import {
  parseProductCategoryLookupView,
  type ProductCategoryLookupView,
} from "./catalog-product-category-lookup-client.js";
import { selectProductCategoryClassification } from "./catalog-product-category-selection.js";
import {
  createProductCommandClient,
  ProductCommandClientError,
} from "./catalog-product-command-client.js";
import {
  copyProductCommandValue,
  parseProductVersion,
  type ProductVersion,
} from "./catalog-product-command-values.js";
import {
  createProductEditorClient,
  ProductEditorClientError,
  type ProductEditorView,
} from "./product-editor-client.js";
import {
  parseProductScopeJournalRequest,
  type ProductScopeJournalRequest,
} from "./product-scope-journal-client.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";

export type CompleteDraftErrorCode =
  | "Invalid"
  | "Denied"
  | "FeatureDisabled"
  | "Conflict"
  | "Unavailable"
  | "Stale"
  | "ScopeChanged"
  | "OutcomeUnknown"
  | "Busy"
  | "PendingSave";
export class CompleteDraftEditorError extends Error {
  constructor(readonly code: CompleteDraftErrorCode) {
    super("Complete Product editing could not continue");
    this.name = "CompleteDraftEditorError";
  }
}
const same = (a: unknown, b: unknown): boolean => {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};
/** Complete current editor read, never a manufactured legacy partial baseline.
 * This controller organizes client intent. Every source/permission decision remains server-owned.
 */
export function createCompleteProductDraftEditor(options: {
  request: ProductScopeJournalRequest;
  currentScope: () => unknown;
  currentContext: () => number;
  now: () => number;
  reads: Pick<ReturnType<typeof createProductEditorClient>, "load">;
  capabilities: Pick<ReturnType<typeof createStoreCapabilityClient>, "load">;
  commands: Pick<ReturnType<typeof createProductCommandClient>, "prepareDraft">;
}) {
  const selected = parseProductScopeJournalRequest(options.request);
  const { expectedAggregateVersion, ...selectedScope } = selected;
  let revision = expectedAggregateVersion;
  const context = options.currentContext();
  if (!Number.isSafeInteger(context) || context < 0) throw new CompleteDraftEditorError("Invalid");
  let status:
    | "Unloaded"
    | "Loading"
    | "Ready"
    | "Saving"
    | "OutcomeUnknown"
    | "NeedsRefresh"
    | "Failed"
    | "ScopeChanged" = "Unloaded";
  const currentStatus = () => status;
  let baseline: ProductEditorView | null = null,
    draft: ProductVersion | null = null;
  let categorySource: ProductCategoryLookupView | null = null;
  let pending: ReturnType<ReturnType<typeof createProductCommandClient>["prepareDraft"]> | null =
    null;
  let busy = false,
    dirty = false,
    deadline = 0,
    clockFloor = -Infinity,
    epoch = 0,
    hidden = false;
  let error: CompleteDraftEditorError | null = null;
  const fail = (code: CompleteDraftErrorCode): never => {
    throw new CompleteDraftEditorError(code);
  };
  const matches = () => {
    try {
      return (
        options.currentContext() === context &&
        same(copyProductCommandValue(options.currentScope()), selectedScope)
      );
    } catch {
      return false;
    }
  };
  const invalidate = () => {
    epoch++;
    status = "ScopeChanged";
    baseline = null;
    draft = null;
    categorySource = null;
    dirty = false;
    hidden = true;
    error = new CompleteDraftEditorError("ScopeChanged");
  };
  const current = () => {
    if (status === "ScopeChanged" || !matches()) {
      if (currentStatus() !== "ScopeChanged") invalidate();
      return fail("ScopeChanged");
    }
  };
  const clock = () => {
    const at = options.now();
    if (!Number.isFinite(at) || at < clockFloor) {
      hidden = true;
      return fail("Stale");
    }
    clockFloor = at;
    return at;
  };
  const fresh = () => {
    current();
    if (!baseline || clock() < Date.parse(baseline.observedAt) || clock() >= deadline) {
      hidden = true;
      return fail("Stale");
    }
  };
  const available = () => {
    current();
    if (busy) return fail("Busy");
  };
  const problem = (value: unknown): CompleteDraftEditorError => {
    if (value instanceof CompleteDraftEditorError) return value;
    if (
      value instanceof ProductCommandClientError ||
      value instanceof ProductEditorClientError ||
      value instanceof StoreCapabilityClientError
    )
      return new CompleteDraftEditorError(value.code);
    return new CompleteDraftEditorError("Unavailable");
  };
  async function capability(csrf: string, signal: AbortSignal, generation: number) {
    current();
    const gate = await options.capabilities.load(
      {
        scope: { brandReference: selected.brandReference, storeReference: selected.storeReference },
        capabilityKey: "catalog.cat_product_edit",
        csrf,
      },
      signal,
    );
    current();
    if (generation !== epoch || signal.aborted) return fail("Unavailable");
    if (
      gate.brandReference !== selected.brandReference ||
      gate.storeReference !== selected.storeReference ||
      gate.capabilityKey !== "catalog.cat_product_edit" ||
      gate.controlKey !== "catalog.product.edit"
    )
      return fail("ScopeChanged");
    const at = clock(),
      observedAt = Date.parse(gate.observedAt);
    if (!Number.isFinite(observedAt) || at < observedAt || at >= observedAt + 5000)
      return fail("Stale");
    if (
      gate.backendExecution !== "Allow" ||
      gate.frontendVisibility !== "Show" ||
      gate.reason !== "Enabled"
    )
      return fail("FeatureDisabled");
    return observedAt + 5000;
  }
  async function read(csrf: string, signal: AbortSignal, generation: number) {
    const gateDeadline = await capability(csrf, signal, generation);
    const next = await options.reads.load(
      { request: { ...selected, expectedAggregateVersion: revision }, csrf },
      signal,
    );
    current();
    if (generation !== epoch || signal.aborted) return fail("Unavailable");
    const at = clock(),
      end = Math.min(gateDeadline, Date.parse(next.validUntil));
    if (
      next.revision !== revision ||
      !Number.isFinite(end) ||
      at < Date.parse(next.observedAt) ||
      at >= end
    )
      return fail("Stale");
    if (next.draft.editorContent === undefined) return fail("Unavailable");
    // load() is the actual closed, scoped, digest-verified read client. No arbitrary DTO admission.
    if (
      dirty &&
      baseline &&
      (baseline.revision !== next.revision || !same(baseline.draft, next.draft))
    )
      return fail("Conflict");
    baseline = next;
    deadline = end;
    hidden = false;
    if (!dirty) {
      draft = next.draft;
      categorySource = null;
    }
  }
  async function refresh(csrf: string, signal: AbortSignal, discard: boolean) {
    available();
    if (pending) return fail("PendingSave");
    busy = true;
    status = "Loading";
    hidden = true;
    error = null;
    if (discard) {
      dirty = false;
      draft = null;
      baseline = null;
      categorySource = null;
    }
    try {
      await read(csrf, signal, epoch);
      status = "Ready";
    } catch (value) {
      error = problem(value);
      if (currentStatus() !== "ScopeChanged") status = "Failed";
      hidden = true;
      throw error;
    } finally {
      busy = false;
    }
  }
  async function execute(csrf: string, signal: AbortSignal, newIntent = false) {
    if (!pending) return fail("Invalid");
    const original = pending,
      generation = epoch;
    // Admission denial before execute is read-only; preserve any uncertain original operation.
    try {
      await capability(csrf, signal, generation);
      if (newIntent && categorySource && draft) selectedCategories(draft, categorySource);
    } catch (value) {
      if (newIntent) pending = null;
      hidden = true;
      error = problem(value);
      throw error;
    }
    status = "Saving";
    error = null;
    try {
      const receipt = await original.execute(csrf, signal);
      pending = null;
      current();
      if (generation !== epoch) return fail("ScopeChanged");
      revision = receipt.aggregateVersion;
      baseline = null;
      draft = null;
      dirty = false;
      categorySource = null;
      hidden = true;
      deadline = 0;
      status = "NeedsRefresh";
      return receipt;
    } catch (value) {
      const failure =
        value instanceof ProductCommandClientError
          ? value
          : new ProductCommandClientError("OutcomeUnknown");
      if (failure.code !== "OutcomeUnknown") pending = null;
      if (!matches() || currentStatus() === "ScopeChanged") {
        if (currentStatus() !== "ScopeChanged") invalidate();
        return fail("ScopeChanged");
      }
      error = new CompleteDraftEditorError(failure.code);
      status = failure.code === "OutcomeUnknown" ? "OutcomeUnknown" : "Failed";
      hidden =
        failure.code === "Denied" ||
        failure.code === "FeatureDisabled" ||
        failure.attemptCode === "Denied" ||
        failure.attemptCode === "FeatureDisabled";
      throw error;
    }
  }
  function selectedCategories(next: ProductVersion, source: unknown): ProductCategoryLookupView {
    if (next.categoryClassification === undefined) return fail("Invalid");
    const scope = {
      brandReference: selected.brandReference,
      storeReference: selected.storeReference,
      locale: next.defaultLocale,
    };
    let parsed: ProductCategoryLookupView;
    try {
      parsed = parseProductCategoryLookupView(
        copyProductCommandValue(source),
        "CAT-PRODUCT-EDIT",
        scope,
      );
    } catch {
      return fail("Invalid");
    }
    const at = clock(),
      observed = Date.parse(parsed.lookup.source.asOfUtc);
    if (at < observed || at >= observed + 5000) return fail("Stale");
    try {
      selectProductCategoryClassification(
        next.categoryClassification,
        parsed,
        "CAT-PRODUCT-EDIT",
        scope,
        at,
      );
    } catch {
      return fail("Invalid");
    }
    return parsed;
  }
  return Object.freeze({
    view() {
      try {
        current();
        if (baseline) fresh();
      } catch (value) {
        hidden = true;
        error = problem(value);
      }
      return Object.freeze({
        status,
        revision,
        dirty: matches() && dirty,
        pendingSave: matches() && pending !== null,
        draft: hidden ? null : draft,
        error: error?.code ?? null,
        validUntil: baseline && !hidden ? new Date(deadline).toISOString() : null,
      });
    },
    refresh: (csrf: string, signal: AbortSignal) => refresh(csrf, signal, false),
    discardAndReload: (csrf: string, signal: AbortSignal) => refresh(csrf, signal, true),
    edit(value: unknown, source?: unknown) {
      available();
      if (pending) return fail("PendingSave");
      fresh();
      if (status !== "Ready" || !baseline || !draft) return fail("Unavailable");
      const next = parseProductVersion(copyProductCommandValue(value));
      if (
        next.editorContent === undefined ||
        next.versionReference !== baseline.draft.versionReference ||
        next.baseVersionReference !== baseline.draft.baseVersionReference ||
        next.createdAt !== baseline.draft.createdAt ||
        next.updatedAt !== baseline.draft.updatedAt ||
        !same(
          next.skus.map((s) => [
            s.skuReference,
            s.productReference,
            s.brandReference,
            s.createdAt,
            s.createdByActorReference,
          ]),
          baseline.draft.skus.map((s) => [
            s.skuReference,
            s.productReference,
            s.brandReference,
            s.createdAt,
            s.createdByActorReference,
          ]),
        )
      )
        return fail("Invalid");
      const nextSource = same(next.categoryClassification, baseline.draft.categoryClassification)
        ? null
        : selectedCategories(next, source);
      draft = next;
      categorySource = nextSource;
      dirty = !same(next, baseline.draft);
      error = null;
    },
    async save(operationReference: string, csrf: string, signal: AbortSignal) {
      available();
      if (pending) return fail("PendingSave");
      fresh();
      if (status !== "Ready" || !dirty || !draft || !baseline) return fail("Invalid");
      busy = true;
      hidden = true;
      error = null;
      try {
        await read(csrf, signal, epoch);
        if (!draft || !baseline) return fail("Unavailable");
        if (!same(draft.categoryClassification, baseline.draft.categoryClassification))
          selectedCategories(draft, categorySource);
        pending = options.commands.prepareDraft(
          {
            productReference: selected.productReference,
            expectedAggregateVersion: revision,
            operationReference,
            draft,
          },
          { brandReference: selected.brandReference, storeReference: selected.storeReference },
        );
        return await execute(csrf, signal, true);
      } catch (value) {
        error = problem(value);
        if (
          currentStatus() !== "OutcomeUnknown" &&
          currentStatus() !== "NeedsRefresh" &&
          currentStatus() !== "ScopeChanged"
        ) {
          status = "Failed";
          hidden = true;
        }
        throw error;
      } finally {
        busy = false;
      }
    },
    async retry(csrf: string, signal: AbortSignal) {
      available();
      if (!pending) return fail("Invalid");
      busy = true;
      try {
        return await execute(csrf, signal);
      } finally {
        busy = false;
      }
    },
  });
}
export type CompleteProductDraftEditor = ReturnType<typeof createCompleteProductDraftEditor>;
