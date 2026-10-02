import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
} from "./catalog-product-command-values.js";
import {
  createProductPublicationCommandClient,
  ProductPublicationClientError,
  type ProductPublicationUserAction,
} from "./product-publication-command-client.js";
import {
  createProductPublicationManagementClient,
  ProductPublicationManagementClientError,
  type ProductPublicationManagementRequest,
  type ProductPublicationManagementView,
} from "./product-publication-management-client.js";
import { parseProductScopeJournalRequest } from "./product-scope-journal-client.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import {
  buildPublicationPendingRecord,
  parsePublicationPendingRecord,
  type PublicationPendingRecord,
} from "./product-publication-pending-record.js";
import type { PublicationPendingJournal } from "./product-publication-pending-journal.js";
export type PublicationControllerErrorCode =
  | "Invalid"
  | "Denied"
  | "FeatureDisabled"
  | "Conflict"
  | "Unavailable"
  | "Stale"
  | "ScopeChanged"
  | "OutcomeUnknown"
  | "Busy"
  | "PendingOperation";
export class PublicationControllerError extends Error {
  constructor(readonly code: PublicationControllerErrorCode) {
    super("Product publication could not continue");
    this.name = "PublicationControllerError";
  }
}
function same(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export interface ProductPublicationIntent {
  readonly operationReference: string;
  readonly versionReference: string;
  readonly action: ProductPublicationUserAction;
  readonly scopeSet: unknown;
  readonly effectivePeriod: unknown;
  readonly scheduleReference: string | null;
  readonly successorDraftVersionReference: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string;
}
/** Organizes explicit intent only. Every command still needs owning current admission. */
export function createProductPublicationController(options: {
  request: ProductPublicationManagementRequest;
  currentScope: () => unknown;
  currentContext: () => number;
  now: () => number;
  reads: Pick<ReturnType<typeof createProductPublicationManagementClient>, "load">;
  capabilities: Pick<ReturnType<typeof createStoreCapabilityClient>, "load">;
  commands: Pick<ReturnType<typeof createProductPublicationCommandClient>, "prepare" | "recover">;
  journal: PublicationPendingJournal;
}) {
  const raw = record(copyProductCommandValue(options.request), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
      "expectedAggregateVersion",
    ]),
    { tenantReference, ...query } = raw;
  const selected = Object.freeze({
      ...parseProductScopeJournalRequest(query),
      tenantReference: ref(tenantReference),
    }),
    { expectedAggregateVersion, ...scope } = selected;
  const context = options.currentContext();
  if (!Number.isSafeInteger(context) || context < 0)
    throw new PublicationControllerError("Invalid");
  let initialized = false;
  let pendingRecord: PublicationPendingRecord | null = null;
  let revision = expectedAggregateVersion,
    busy = false,
    hidden = true,
    clockFloor = -Infinity,
    deadline = 0;
  let status:
    | "Unloaded"
    | "Loading"
    | "Ready"
    | "Executing"
    | "OutcomeUnknown"
    | "NeedsRefresh"
    | "Failed"
    | "ScopeChanged" = "Unloaded";
  let source: ProductPublicationManagementView | null = null,
    error: PublicationControllerError | null = null;
  let pending: ReturnType<
    ReturnType<typeof createProductPublicationCommandClient>["prepare"]
  > | null = null;
  const currentStatus = () => status;
  const fail = (code: PublicationControllerErrorCode): never => {
    throw new PublicationControllerError(code);
  };
  const matches = () => {
    try {
      return (
        options.currentContext() === context &&
        same(copyProductCommandValue(options.currentScope()), scope)
      );
    } catch {
      return false;
    }
  };
  const current = () => {
    if (status === "ScopeChanged" || !matches()) {
      status = "ScopeChanged";
      hidden = true;
      source = null;
      error = new PublicationControllerError("ScopeChanged");
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
  const available = () => {
    current();
    if (busy) return fail("Busy");
  };
  const fresh = () => {
    current();
    const at = clock();
    if (!source || at < Date.parse(source.observedAt) || at >= deadline) {
      hidden = true;
      return fail("Stale");
    }
  };
  const problem = (v: unknown) =>
    v instanceof PublicationControllerError
      ? v
      : v instanceof ProductPublicationClientError ||
          v instanceof ProductPublicationManagementClientError ||
          v instanceof StoreCapabilityClientError
        ? new PublicationControllerError(v.code)
        : new PublicationControllerError("Unavailable");
  async function capability(csrf: string, signal: AbortSignal) {
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
    if (signal.aborted) return fail("Unavailable");
    if (
      gate.brandReference !== selected.brandReference ||
      gate.storeReference !== selected.storeReference ||
      gate.capabilityKey !== "catalog.cat_product_edit" ||
      gate.controlKey !== "catalog.product.edit"
    )
      return fail("ScopeChanged");
    const at = clock(),
      start = Date.parse(gate.observedAt);
    if (!Number.isFinite(start) || at < start || at >= start + 5000) return fail("Stale");
    if (
      gate.backendExecution !== "Allow" ||
      gate.frontendVisibility !== "Show" ||
      gate.reason !== "Enabled"
    )
      return fail("FeatureDisabled");
    return start + 5000;
  }
  async function read(csrf: string, signal: AbortSignal) {
    const end = await capability(csrf, signal);
    const next = await options.reads.load(
      { request: { ...selected, expectedAggregateVersion: revision }, csrf },
      signal,
    );
    current();
    if (signal.aborted) return fail("Unavailable");
    const at = clock(),
      until = Math.min(end, Date.parse(next.validUntil));
    if (
      next.revision !== revision ||
      next.tenantReference !== selected.tenantReference ||
      next.brandReference !== selected.brandReference ||
      next.storeReference !== selected.storeReference ||
      next.productReference !== selected.productReference
    )
      return fail("ScopeChanged");
    if (!Number.isFinite(until) || at < Date.parse(next.observedAt) || at >= until)
      return fail("Stale");
    return { next, until };
  }
  async function execute(csrf: string, signal: AbortSignal, originalRetry = false) {
    if (!pending) return fail("Invalid");
    const original = pending;
    try {
      await capability(csrf, signal);
      if (!originalRetry) fresh();
    } catch (v) {
      hidden = true;
      error = problem(v);
      throw error;
    }
    status = "Executing";
    error = null;
    try {
      const receipt = await original.execute(csrf, signal);
      current();
      if (!pendingRecord) return fail("OutcomeUnknown");
      await options.journal.complete(pendingRecord);
      current();
      pendingRecord = null;
      pending = null;
      revision = Math.max(revision, receipt.aggregateVersion);
      source = null;
      deadline = 0;
      hidden = true;
      status = "NeedsRefresh";
      return receipt;
    } catch (v) {
      const failure =
        v instanceof ProductPublicationClientError
          ? v
          : new ProductPublicationClientError("OutcomeUnknown");
      if (!matches() || currentStatus() === "ScopeChanged") {
        current();
        return fail("ScopeChanged");
      }
      // Durable reservation remains uncertain until its exact native receipt and local CAS cleanup.
      if (failure.code !== "OutcomeUnknown") return fail("OutcomeUnknown");
      error = new PublicationControllerError(failure.code);
      status = failure.code === "OutcomeUnknown" ? "OutcomeUnknown" : "Failed";
      hidden = true;
      throw error;
    }
  }
  return Object.freeze({
    view() {
      try {
        current();
        if (source) fresh();
      } catch (v) {
        hidden = true;
        error = problem(v);
      }
      return Object.freeze({
        status,
        revision,
        busy,
        pendingOperation: matches() && pending !== null,
        pendingAction: matches() ? (pending?.command.action ?? null) : null,
        source: hidden ? null : source,
        error: error?.code ?? null,
        validUntil: source && !hidden ? new Date(deadline).toISOString() : null,
      });
    },
    hide() {
      hidden = true;
    },
    async refresh(csrf: string, signal: AbortSignal) {
      available();
      if (pending) return fail("PendingOperation");
      busy = true;
      status = "Loading";
      hidden = true;
      error = null;
      try {
        if (!initialized) {
          await capability(csrf, signal);
          const stored = await options.journal.load();
          current();
          if (signal.aborted) return fail("Unavailable");
          if (stored !== null) {
            const restored = await parsePublicationPendingRecord(stored, scope);
            current();
            if (signal.aborted) return fail("Unavailable");
            pending = options.commands.recover(restored.command, {
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
            });
            pendingRecord = restored.record;
            status = "OutcomeUnknown";
            initialized = true;
            return;
          }
          initialized = true;
        }
        const { next, until } = await read(csrf, signal);
        source = next;
        deadline = until;
        hidden = false;
        status = "Ready";
      } catch (v) {
        error = problem(v);
        if (matches()) status = "Failed";
        throw error;
      } finally {
        busy = false;
      }
    },
    async act(value: ProductPublicationIntent, csrf: string, signal: AbortSignal) {
      available();
      if (pending) return fail("PendingOperation");
      if (!initialized) return fail("Unavailable");
      fresh();
      if (hidden) return fail("Stale");
      if (status !== "Ready" || !source) return fail("Unavailable");
      const prior = source;
      busy = true;
      hidden = true;
      error = null;
      try {
        const intent = record(copyProductCommandValue(value), [
          "operationReference",
          "versionReference",
          "action",
          "scopeSet",
          "effectivePeriod",
          "scheduleReference",
          "successorDraftVersionReference",
          "occurredAt",
          "reasonCode",
        ]);
        const { next, until } = await read(csrf, signal);
        if (
          !same(
            { revision: prior.revision, draft: prior.draft, versions: prior.versions },
            { revision: next.revision, draft: next.draft, versions: next.versions },
          )
        )
          return fail("Conflict");
        source = next;
        deadline = until;
        const versionReference = ref(intent.versionReference),
          row = source.versions.find((v) => v.versionReference === versionReference),
          validating = intent.action === "Validate";
        if (
          validating &&
          (versionReference !== source.draft.versionReference ||
            source.draft.contentStatus !== "Present")
        )
          return fail("Unavailable");
        if (!validating && !row) return fail("Unavailable");
        if (
          (intent.action === "ReschedulePublish" || intent.action === "CancelScheduledPublish") &&
          (!row || row.state !== "Scheduled" || row.scheduleReference !== intent.scheduleReference)
        )
          return fail("Conflict");
        const content = validating ? source.draft : row;
        if (!content) return fail("Unavailable");
        const prepared = options.commands.prepare(
          {
            ...intent,
            versionReference,
            productReference: selected.productReference,
            expectedProductAggregateVersion: revision,
            expectedPublicationVersion: row?.publicationVersion ?? 0,
            contentDigest: content.contentDigest,
            configurationDigest: content.configurationDigest,
            replacementVersionReference: null,
          },
          { brandReference: selected.brandReference, storeReference: selected.storeReference },
        );
        const originalRecord = await buildPublicationPendingRecord(prepared.command, scope);
        current();
        if (signal.aborted) return fail("Unavailable");
        try {
          await options.journal.reserve(originalRecord);
        } catch (value) {
          initialized = false;
          throw value;
        }
        // Reservation may commit even if the route is replaced while its promise resolves.
        // In that case the new exact context restores it, without sending from this context.
        current();
        pendingRecord = originalRecord;
        pending = options.commands.recover(prepared.command, {
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
        });
        if (signal.aborted) return fail("Unavailable");
        fresh();
        return await execute(csrf, signal);
      } catch (v) {
        error = problem(v);
        if (
          currentStatus() !== "OutcomeUnknown" &&
          currentStatus() !== "NeedsRefresh" &&
          currentStatus() !== "ScopeChanged"
        )
          status = "Failed";
        hidden = true;
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
        return await execute(csrf, signal, true);
      } finally {
        busy = false;
      }
    },
  });
}
export type ProductPublicationController = ReturnType<typeof createProductPublicationController>;
