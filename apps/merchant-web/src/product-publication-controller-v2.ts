import {
  createProductPublicationCommandClient as createLegacyPublicationCommandClient,
  type ProductPublicationUserAction,
} from "./product-publication-command-client.js";
import {
  parseAnyPublicationPendingRecord,
  type PublicationPendingJournalV2,
} from "./product-publication-pending-journal-v2.js";
import { type PublicationPendingRecord as LegacyPublicationPendingRecord } from "./product-publication-pending-record.js";
import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  createProductPublicationCommandClientV2,
  ProductPublicationClientError,
} from "./product-publication-command-client-v2.js";
import {
  createProductPublicationManagementClientV2,
  ProductPublicationManagementClientErrorV2,
  type ProductPublicationManagementRequest,
  type ProductPublicationManagementViewV2,
} from "./product-publication-management-client-v2.js";
import { parseProductScopeJournalRequest } from "./product-scope-journal-client.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import {
  buildPublicationPendingRecordV2,
  type PublicationPendingRecordV2,
} from "./product-publication-pending-record-v2.js";
import {
  createProductPublicationWarningAcknowledgementClient,
  type ProductPublicationWarningAcknowledgementResult,
} from "./product-publication-warning-acknowledgement-client.js";
import {
  buildProductPublicationWarningAcknowledgementPendingRecord,
  type ProductPublicationWarningAcknowledgementPendingRecord,
} from "./product-publication-warning-acknowledgement-pending-record.js";
import {
  parseProductPublicationValidationReportViewV2,
  ProductPublicationValidationReportClientError,
  type ProductPublicationValidationReportViewV2,
} from "./product-publication-validation-report-client-v2.js";
import type { createProductPublicationResolutionClient } from "./product-publication-resolution-client.js";
export interface ProductPublicationWarningAcknowledgementIntent {
  readonly operationReference: string;
  readonly report: ProductPublicationValidationReportViewV2;
  readonly reasonCode: string;
  readonly occurredAt: string;
  readonly confirmed: true;
}
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
export interface ProductPublicationIntentV2 {
  readonly operationReference: string;
  readonly versionReference: string;
  readonly action: ProductPublicationUserAction;
  readonly scopeSet: unknown;
  readonly replacementIntent: unknown;
  readonly effectivePeriod: unknown;
  readonly scheduleReference: string | null;
  readonly successorDraftVersionReference: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string;
}
/** Organizes explicit intent only. Every command still needs owning current admission. */
export function createProductPublicationControllerV2(options: {
  request: ProductPublicationManagementRequest;
  currentScope: () => unknown;
  currentContext: () => number;
  now: () => number;
  reads: Pick<ReturnType<typeof createProductPublicationManagementClientV2>, "load">;
  capabilities: Pick<ReturnType<typeof createStoreCapabilityClient>, "load">;
  commands: Pick<ReturnType<typeof createProductPublicationCommandClientV2>, "prepare" | "recover">;
  acknowledgements: Pick<
    ReturnType<typeof createProductPublicationWarningAcknowledgementClient>,
    "prepare" | "recover"
  >;
  journal: PublicationPendingJournalV2;
  legacyCommands: Pick<ReturnType<typeof createLegacyPublicationCommandClient>, "recover">;
  resolutions?: Pick<ReturnType<typeof createProductPublicationResolutionClient>, "resolve">;
}) {
  const configured = options;
  options = Object.freeze({
    ...configured,
    request: configured.request,
    currentScope: configured.currentScope.bind(configured),
    currentContext: configured.currentContext.bind(configured),
    now: configured.now.bind(configured),
    reads: Object.freeze({ load: configured.reads.load.bind(configured.reads) }),
    capabilities: Object.freeze({
      load: configured.capabilities.load.bind(configured.capabilities),
    }),
    commands: Object.freeze({
      prepare: configured.commands.prepare.bind(configured.commands),
      recover: configured.commands.recover.bind(configured.commands),
    }),
    acknowledgements: Object.freeze({
      prepare: configured.acknowledgements.prepare.bind(configured.acknowledgements),
      recover: configured.acknowledgements.recover.bind(configured.acknowledgements),
    }),
    legacyCommands: Object.freeze({
      recover: configured.legacyCommands.recover.bind(configured.legacyCommands),
    }),
    ...(configured.resolutions === undefined
      ? {}
      : {
          resolutions: Object.freeze({
            resolve: configured.resolutions.resolve.bind(configured.resolutions),
          }),
        }),
    journal: Object.freeze({
      load: configured.journal.load.bind(configured.journal),
      reserve: configured.journal.reserve.bind(configured.journal),
      complete: configured.journal.complete.bind(configured.journal),
    }),
  });
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
  let pendingRecord:
    | PublicationPendingRecordV2
    | LegacyPublicationPendingRecord
    | ProductPublicationWarningAcknowledgementPendingRecord
    | null = null;
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
  let source: ProductPublicationManagementViewV2 | null = null,
    error: PublicationControllerError | null = null;
  let pending:
    | Awaited<ReturnType<ReturnType<typeof createProductPublicationCommandClientV2>["prepare"]>>
    | Awaited<
        ReturnType<
          ReturnType<typeof createProductPublicationWarningAcknowledgementClient>["prepare"]
        >
      >
    | ReturnType<ReturnType<typeof createLegacyPublicationCommandClient>["recover"]>
    | null = null;
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
          v instanceof ProductPublicationManagementClientErrorV2 ||
          v instanceof StoreCapabilityClientError ||
          v instanceof ProductPublicationValidationReportClientError
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
        originalRecoveryChecked: initialized,
        revision,
        busy,
        pending:
          matches() && pending
            ? pending.command.action === "AcknowledgeProductPublicationWarnings"
              ? Object.freeze({
                  kind: "WarningAcknowledgementV1" as const,
                  action: pending.command.action,
                  operationReference: pending.command.operationReference,
                  versionReference: pending.command.versionReference,
                  reportOperationReference: pending.command.reportOperationReference,
                  warningCodes: pending.command.warningCodes,
                  reasonCode: pending.command.reasonCode,
                  occurredAt: pending.command.occurredAt,
                })
              : Object.freeze({
                  kind:
                    "profile" in pending.command
                      ? ("PublicationV2" as const)
                      : ("PublicationV1" as const),
                  action: pending.command.action,
                  operationReference: pending.command.operationReference,
                })
            : null,
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
            const restored = await parseAnyPublicationPendingRecord(stored, scope);
            current();
            if (signal.aborted) return fail("Unavailable");
            pending =
              restored.command.action === "AcknowledgeProductPublicationWarnings"
                ? await options.acknowledgements.recover(restored.command, {
                    brandReference: selected.brandReference,
                    storeReference: selected.storeReference,
                  })
                : "profile" in restored.command
                  ? await options.commands.recover(restored.command, {
                      brandReference: selected.brandReference,
                      storeReference: selected.storeReference,
                    })
                  : options.legacyCommands.recover(restored.command, {
                      brandReference: selected.brandReference,
                      storeReference: selected.storeReference,
                    });
            current();
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
    async act(value: ProductPublicationIntentV2, csrf: string, signal: AbortSignal) {
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
          "replacementIntent",
          "effectivePeriod",
          "scheduleReference",
          "successorDraftVersionReference",
          "occurredAt",
          "reasonCode",
        ]);
        const { next, until } = await read(csrf, signal);
        if (
          !same(
            {
              revision: prior.revision,
              draft: prior.draft,
              versions: prior.versions,
              sourceRevision: prior.sourceRevision,
              replacementTargets: prior.replacementTargets,
            },
            {
              revision: next.revision,
              draft: next.draft,
              versions: next.versions,
              sourceRevision: next.sourceRevision,
              replacementTargets: next.replacementTargets,
            },
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
        if (validating && row?.state !== undefined && row.state !== "Draft")
          return fail("Conflict");
        if (
          intent.action === "SubmitReview" &&
          (row?.state !== "Draft" || !["Pass", "ApprovalPending"].includes(row.validationDecision))
        )
          return fail("Conflict");
        if (
          intent.action === "Approve" &&
          (row?.state !== "InReview" ||
            row.approvalPolicy !== "Required" ||
            !["ApprovalPending", "Pass"].includes(row.validationDecision))
        )
          return fail("Conflict");
        if (intent.action === "Reject" && row?.state !== "InReview") return fail("Conflict");
        if (
          (intent.action === "Publish" || intent.action === "SchedulePublish") &&
          (!row ||
            row.validationDecision !== "Pass" ||
            !(
              row.state === "Approved" ||
              (row.state === "InReview" && row.approvalPolicy === "NotRequired")
            ))
        )
          return fail("Conflict");
        if (intent.action === "ReschedulePublish" && row?.approvalPolicy === "Required")
          return fail("Conflict");
        if (
          !validating &&
          intent.action !== "ReschedulePublish" &&
          !same(intent.effectivePeriod, row?.effectivePeriod)
        )
          return fail("Conflict");
        const content = validating ? source.draft : row;
        if (!content) return fail("Unavailable");
        if (row && row.profile === null) return fail("Unavailable");
        if (validating) {
          if (
            !same(intent.replacementIntent, source.noReplacementIntent) &&
            !source.replacementTargets.some(
              (t) =>
                same(t.replacementIntent, intent.replacementIntent) &&
                same([t.selector], intent.scopeSet),
            )
          )
            return fail("Conflict");
        } else if (
          !row ||
          !same(intent.replacementIntent, row.replacementIntent) ||
          !same(intent.scopeSet, row.scopeSet)
        )
          return fail("Conflict");
        const replacementIntent = validating ? intent.replacementIntent : row?.replacementIntent;
        if (
          !replacementIntent ||
          typeof replacementIntent !== "object" ||
          !("digest" in replacementIntent)
        )
          return fail("Invalid");
        const prepared = await options.commands.prepare(
          {
            ...intent,
            profile: "CatalogProductPublicationCommandV2",
            replacementIntent,
            replacementIntentDigest: replacementIntent.digest,
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
        const originalRecord = await buildPublicationPendingRecordV2(prepared.command, scope);
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
        pending = await options.commands.recover(prepared.command, {
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
        });
        if (signal.aborted) return fail("Unavailable");
        fresh();
        const result = await execute(csrf, signal);
        if (
          "profile" in result &&
          result.profile === "CatalogProductPublicationWarningAcknowledgementResultV1"
        )
          return fail("OutcomeUnknown");
        return result;
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
    async acknowledge(
      value: ProductPublicationWarningAcknowledgementIntent,
      csrf: string,
      signal: AbortSignal,
    ): Promise<ProductPublicationWarningAcknowledgementResult> {
      available();
      if (pending) return fail("PendingOperation");
      if (!initialized) return fail("Unavailable");
      busy = true;
      hidden = true;
      error = null;
      try {
        // The report can be an already-delivered historical snapshot. Only its
        // structural admission is evaluated at its original read time; the
        // separate owning management/capability read below is current admission.
        const intent = record(value, [
          "operationReference",
          "report",
          "reasonCode",
          "occurredAt",
          "confirmed",
        ]);
        if (intent.confirmed !== true) return fail("Invalid");
        const raw = record(intent.report, [
            "profile",
            "tenantReference",
            "brandReference",
            "storeReference",
            "productReference",
            "versionReference",
            "aggregateVersion",
            "publicationVersion",
            "selectedPublicationOperationReference",
            "selectedPublicationDigest",
            "currentDraft",
            "status",
            "applicability",
            "report",
            "observedAt",
            "validUntil",
            "eligibility",
            "digest",
          ]),
          originalRead = instant(raw.observedAt),
          request = {
            ...scope,
            versionReference: ref(raw.versionReference),
            expectedAggregateVersion: raw.aggregateVersion as number,
            expectedPublicationVersion: raw.publicationVersion as number,
          },
          delivered = await parseProductPublicationValidationReportViewV2(raw, request, () =>
            Date.parse(originalRead),
          ),
          report = delivered.report;
        current();
        if (signal.aborted) return fail("Unavailable");
        if (
          Date.parse(originalRead) > clock() ||
          delivered.status !== "Recorded" ||
          delivered.applicability !== "CurrentDraftContent" ||
          !report ||
          report.details.coverage !== "Complete" ||
          report.warningBindingDigest === null ||
          report.validation.checks.some((check) => check.outcome === "HardError")
        )
          return fail("Invalid");
        const warningCodes = report.validation.checks
          .filter((check) => check.outcome === "Warning")
          .map((check) => check.code)
          .sort();
        if (warningCodes.length === 0) return fail("Invalid");
        // No stale() prerequisite: reading a report is not a five-second human
        // deadline. New permission and management evidence must still be fresh.
        const { next, until } = await read(csrf, signal),
          row = next.versions.find(
            (entry) => entry.versionReference === delivered.versionReference,
          ),
          binding = report.binding;
        if (
          next.draft.versionReference !== delivered.versionReference ||
          next.draft.contentStatus !== "Present" ||
          !row ||
          row.profile !== "CatalogProductPublicationVersionV2" ||
          next.draft.contentDigest !== binding.contentDigest ||
          next.draft.configurationDigest !== binding.configurationDigest ||
          row.contentDigest !== binding.contentDigest ||
          row.configurationDigest !== binding.configurationDigest ||
          row.scopeDigest !== binding.scopeDigest ||
          row.periodDigest !== binding.periodDigest ||
          row.replacementIntentDigest !== binding.replacementIntentDigest ||
          Object.getOwnPropertyDescriptor(row.original, "policyReference")?.value !==
            binding.policyReference ||
          Object.getOwnPropertyDescriptor(row.original, "policyVersion")?.value !==
            binding.policyVersion
        )
          return fail("Conflict");
        source = next;
        deadline = until;
        const prepared = await options.acknowledgements.prepare(
          {
            profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
            action: "AcknowledgeProductPublicationWarnings",
            operationReference: intent.operationReference,
            productReference: selected.productReference,
            versionReference: delivered.versionReference,
            expectedProductAggregateVersion: revision,
            reportOperationReference: report.operationReference,
            reportDigest: report.digest,
            warningBindingDigest: report.warningBindingDigest,
            warningCodes,
            reasonCode: intent.reasonCode,
            occurredAt: intent.occurredAt,
          },
          { brandReference: selected.brandReference, storeReference: selected.storeReference },
        );
        if (Date.parse(prepared.command.occurredAt) > clock()) return fail("Invalid");
        const originalRecord = await buildProductPublicationWarningAcknowledgementPendingRecord(
          prepared.command,
          scope,
        );
        current();
        if (signal.aborted) return fail("Unavailable");
        try {
          await options.journal.reserve(originalRecord);
        } catch (cause) {
          initialized = false;
          throw cause;
        }
        current();
        pendingRecord = originalRecord;
        pending = await options.acknowledgements.recover(prepared.command, {
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
        });
        if (signal.aborted) return fail("Unavailable");
        fresh();
        const result = await execute(csrf, signal);
        if (
          !("profile" in result) ||
          result.profile !== "CatalogProductPublicationWarningAcknowledgementResultV1"
        )
          return fail("OutcomeUnknown");
        return result;
      } catch (cause) {
        error = problem(cause);
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
    async resolveOriginal(csrf: string, signal: AbortSignal) {
      available();
      if (!pending || !pendingRecord) return fail("Invalid");
      if (!options.resolutions) return fail("Unavailable");
      const original = pending,
        originalRecord = pendingRecord;
      busy = true;
      hidden = true;
      error = null;
      try {
        // Recovery needs current access, but never today's expected Product root
        // or a renewed publication/source qualification lease.
        await capability(csrf, signal);
        const resolution = await options.resolutions.resolve(
          {
            originalKind:
              original.command.action === "AcknowledgeProductPublicationWarnings"
                ? "WarningAcknowledgementV1"
                : "profile" in original.command
                  ? "PublicationV2"
                  : "PublicationV1",
            originalCommand: original.command,
            scope,
            csrf,
          },
          signal,
        );
        current();
        if (signal.aborted) return fail("OutcomeUnknown");
        await options.journal.complete(originalRecord);
        current();
        pendingRecord = null;
        pending = null;
        revision = resolution.currentAggregateVersion;
        source = null;
        deadline = 0;
        status = "NeedsRefresh";
        return resolution;
      } catch {
        if (!matches() || currentStatus() === "ScopeChanged") return fail("ScopeChanged");
        error = new PublicationControllerError("OutcomeUnknown");
        status = "OutcomeUnknown";
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
export type ProductPublicationControllerV2 = ReturnType<
  typeof createProductPublicationControllerV2
>;
