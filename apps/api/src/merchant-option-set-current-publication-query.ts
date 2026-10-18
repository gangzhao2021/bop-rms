import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import { createPostgresPublishingMutationStore, createPublishingScope } from "@bop/publishing";
import { createCurrentPublishedOptionSetGraphSource } from "./current-published-option-set-graph.js";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresCurrentFullOptionSetDraftStore,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { createMerchantOptionSetAuthoringRuntimeAuthority } from "./merchant-option-set-authoring-runtime-authority.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type GraphSource = Parameters<
  ReturnType<typeof createCurrentPublishedOptionSetGraphSource>["withCurrentGraph"]
>[1] extends (source: infer S) => Promise<unknown>
  ? S
  : never;
type PublicationStatus = Awaited<
  ReturnType<
    ReturnType<
      typeof createPostgresPublishingMutationStore
    >["resolveCurrentOptionSetPublicationStatus"]
  >
>;
export type MerchantOptionSetCurrentPublishedContent = Pick<
  GraphSource,
  | "sourceRecords"
  | "graphDigest"
  | "rules"
  | "observedAt"
  | "validUntil"
  | "sourceAuthority"
  | "referenceEligibility"
  | "eligibility"
  | "publishValidation"
> &
  Readonly<{
    profile: "CatalogOptionSetCurrentPublishedContentV1";
    content: GraphSource["graph"]["contents"][number];
    sourceDigest: string;
    contentDigest: string;
    configurationDigest: string;
  }>;
export interface MerchantOptionSetCurrentPublicationQueryOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}
export interface MerchantOptionSetCurrentPublicationResult {
  readonly profile: "CatalogOptionSetCurrentPublicationResultV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly storeReference: string;
  readonly optionSetReference: string;
  readonly currentAggregateVersion: number;
  readonly publicationState: PublicationStatus["outcome"];
  readonly currentLifecycleReference: string | null;
  readonly lastReleaseReference: string | null;
  readonly release: Readonly<{
    publicationReference: string;
    releaseSequence: number;
    releasedAt: string;
    lifecycleReference: string;
    lifecycleVersion: number;
    snapshotReference: string;
    snapshotDigest: string;
    approvalDisposition: "Approved" | "PolicyWaived";
  }> | null;
  readonly published: MerchantOptionSetCurrentPublishedContent | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
const sameStatus = (value: PublicationStatus) => {
  const copy = copyCategoryPersistenceValue(value) as Record<string, unknown>;
  const { observedAt, ...rest } = copy;
  void observedAt;
  if (copy.outcome === "Published") {
    const { observedAt: at, ...proof } = copy.proof as Record<string, unknown>;
    void at;
    return canonicalizeRfc8785({ ...rest, proof });
  }
  return canonicalizeRfc8785(rest);
};
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
/** Ordinary current publication read, independently authorized from historical browsing. */
export function createMerchantOptionSetCurrentPublicationQuery(
  options: MerchantOptionSetCurrentPublicationQueryOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function"
  )
    return fail();
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    merchant = Object.freeze({
      ...options.merchant,
      now: clock,
      transactions: { run },
      ...(options.merchant.validateAssociation
        ? { validateAssociation: options.merchant.validateAssociation.bind(options.merchant) }
        : {}),
      ...(options.merchant.currentActor
        ? { currentActor: options.merchant.currentActor.bind(options.merchant) }
        : {}),
    }),
    resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({ run });
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
    readonly expectedScope: unknown;
  }): Promise<MerchantOptionSetCurrentPublicationResult> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let command: Readonly<{ optionSetReference: string; expectedAggregateVersion: number | null }>;
    try {
      const raw = readClosedRecord(copyCategoryPersistenceValue(request.command), [
        "optionSetReference",
        "expectedAggregateVersion",
      ]);
      if (
        raw.expectedAggregateVersion !== null &&
        (!Number.isSafeInteger(raw.expectedAggregateVersion) ||
          (raw.expectedAggregateVersion as number) < 1 ||
          (raw.expectedAggregateVersion as number) > 2147483647)
      )
        return fail("CATALOG_INPUT_INVALID");
      command = Object.freeze({
        optionSetReference: parseCatalogReference(raw.optionSetReference),
        expectedAggregateVersion: raw.expectedAggregateVersion as number | null,
      });
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    let latest = parseCatalogInstant(clock()),
      failed = false;
    const startedAt = latest,
      originalDeadline = new Date(Date.parse(latest) + 5000).toISOString();
    let deadline = originalDeadline;
    const reject = (): never => {
      failed = true;
      return fail();
    };
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= deadline) return reject();
        latest = at;
        return at;
      } catch {
        return reject();
      }
    };
    const session = await authenticate({ sessionCookie, csrf }).catch((error: unknown) =>
      fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      ),
    );
    now();
    let calls = 0,
      sourceCalls = 0,
      finalized = false,
      completed: MerchantOptionSetCurrentPublicationResult | undefined;
    let graphFinal: (() => string) | undefined;
    let finalLease: (() => string) | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query;
      let ready = false,
        guardCalls = 0,
        guardComplete = false,
        finalCalls = 0,
        assertSources: (() => void) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) return reject();
        assertSources?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || ++guardCalls !== 1) return reject();
          check();
          guardComplete = true;
        },
        () => {
          if (!ready || !guardComplete || guardCalls !== 1 || ++finalCalls !== 1) return reject();
          check();
          finalized = true;
        },
      );
      try {
        const scope = await resolve(tx, sessionCookie, session.sessionReference);
        check();
        const bound = bindMerchantProductCommandScope(
            {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.selectedStoreReference,
            },
            expected,
          ),
          tenantReference = parseCatalogReference(scope.tenantReference),
          actorReference = parseCatalogReference(scope.actorReference),
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            capabilityKey: "catalog.cat_optionset_detail",
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference,
            brandReference: bound.brandReference,
            storeReference: bound.storeReference,
            actorReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey: "catalog.cat_optionset_detail",
          });
        if (
          typeof current.leaseDeadline !== "function" ||
          typeof capability.leaseDeadline !== "function"
        )
          return reject();
        const assert = current.assertCurrent.bind(current),
          currentLease = current.leaseDeadline.bind(current),
          capabilityLease = capability.leaseDeadline.bind(capability);
        assertSources = () => {
          parseCatalogInstant(assert());
          if (ready) {
            const a = parseCatalogInstant(currentLease()),
              b = parseCatalogInstant(capabilityLease());
            if (a < deadline) deadline = a;
            if (b < deadline) deadline = b;
            now();
          }
        };
        const holder = createMerchantOptionSetAuthoringRuntimeAuthority({
            transaction: tx,
            tenantReference,
            brandReference: bound.brandReference,
            storeReference: bound.storeReference,
            actorReference,
            sessionReference: session.sessionReference,
            packet: { action: "Read", command },
            clock: { now },
            originalValidUntil: originalDeadline,
            currentAuthorization: current,
            capability,
            registerBeforeCommit: host.registerBeforeCommit,
          }),
          store = createPostgresCurrentFullOptionSetDraftStore({
            tenantReference,
            brandReference: bound.brandReference,
            actorReference,
            clock: { now },
            authority: holder.reading,
            transactions: {
              async run(work) {
                if (++sourceCalls !== 1) return reject();
                check();
                const value = await work(tx);
                check();
                return value;
              },
            },
          });
        const value = await store.readCurrent(command);
        check();
        holder.assertCurrent();
        try {
          const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
              "content",
              "sourceDigest",
              "contentDigest",
              "configurationDigest",
              "observedAt",
              "validUntil",
              "referenceEligibility",
            ]),
            body = readClosedRecord(raw.content, [
              "profile",
              "sourceAggregate",
              "optionDetails",
              "conditionalRules",
              "conflictRules",
              "scopeSet",
              "effectivePeriod",
            ]),
            { sourceAggregate, ...additional } = body,
            parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
            root = parsed.content.sourceAggregate,
            observedAt = parseCatalogInstant(raw.observedAt),
            validUntil = parseCatalogInstant(raw.validUntil);
          if (
            sourceCalls !== 1 ||
            root.brandReference !== bound.brandReference ||
            root.optionSetReference !== command.optionSetReference ||
            root.lifecycle !== "Draft" ||
            (command.expectedAggregateVersion !== null &&
              root.aggregateVersion !== command.expectedAggregateVersion) ||
            raw.sourceDigest !== parsed.sourceDigest ||
            raw.contentDigest !== parsed.contentDigest ||
            raw.configurationDigest !== parsed.configurationDigest ||
            raw.referenceEligibility !== "NotEvaluated" ||
            observedAt < startedAt ||
            observedAt > now() ||
            validUntil <= observedAt ||
            validUntil > originalDeadline ||
            root.updatedAt > observedAt ||
            root.draft.updatedAt > observedAt ||
            root.createdAt > observedAt
          )
            return reject();
          if (validUntil < deadline) deadline = validUntil;
          const owner = createPostgresPublishingMutationStore(
            {
              async run(work) {
                check();
                const remaining = Math.max(1, Date.parse(deadline) - Date.parse(now()));
                await tx.query(
                  "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
                  [String(remaining)],
                );
                check();
                const result = await work(tx);
                check();
                return result;
              },
            },
            tenantReference,
            createPublishingScope({
              kind: "Brand",
              brandReference: bound.brandReference,
              storeReference: null,
            }),
          );
          const readStatus = owner.resolveCurrentOptionSetPublicationStatus.bind(owner);
          const status = await readStatus({
            familyReference: command.optionSetReference,
            observedAt: now(),
          });
          check();
          let published: GraphSource | null = null;
          if (status.outcome === "Published") {
            const graph = createCurrentPublishedOptionSetGraphSource({
              transaction: tx,
              tenantReference,
              brandReference: bound.brandReference,
              storeReference: bound.storeReference,
              actorReference,
              sessionReference: session.sessionReference,
              clock: { now },
              originalValidUntil: originalDeadline,
              currentAuthorization: current,
              capability,
              registerBeforeCommit: host.registerBeforeCommit,
              events: { generateReference: () => reject() },
            });
            graphFinal = graph.assertFinalized;
            published = await graph.withCurrentGraph(
              {
                optionSetReference: command.optionSetReference,
                versionReference: status.proof.release.snapshotReference,
              },
              async (value) => value,
            );
            check();
            const rootRecord = published.sourceRecords.find(
              (r) => r.optionSetReference === command.optionSetReference,
            );
            if (
              !rootRecord ||
              rootRecord.publicationReference !== status.proof.release.releaseId ||
              rootRecord.versionReference !== status.proof.release.snapshotReference ||
              rootRecord.approvalDisposition !== status.proof.approvalDisposition ||
              published.graph.brandReference !== bound.brandReference ||
              published.graph.rootOptionSetReference !== command.optionSetReference
            )
              return reject();
            if (published.validUntil < deadline) deadline = published.validUntil;
          }
          finalLease = () => {
            // The reading holder intentionally seals itself at its own final guard.
            // Observe the captured current authority lease without reopening it.
            parseCatalogInstant(assert());
            const a = parseCatalogInstant(currentLease()),
              b = parseCatalogInstant(capabilityLease());
            if (a < deadline) deadline = a;
            if (b < deadline) deadline = b;
            now();
            return deadline;
          };
          let statusChecked = false,
            statusFinal = false;
          if (
            (await host.registerBeforeCommit(
              tx,
              async () => {
                if (!ready || statusChecked) return reject();
                holder.assertCurrent();
                check();
                const currentStatus = await readStatus({
                  familyReference: command.optionSetReference,
                  observedAt: now(),
                });
                if (sameStatus(currentStatus) !== sameStatus(status)) return reject();
                check();
                statusChecked = true;
              },
              () => {
                if (!ready || !statusChecked || statusFinal) return reject();
                finalLease?.();
                statusFinal = true;
              },
            )) !== undefined
          )
            return reject();
          ready = true;
          check();
          completed = Object.freeze({
            profile: "CatalogOptionSetCurrentPublicationResultV1",
            tenantReference,
            brandReference: bound.brandReference,
            actorReference,
            storeReference: bound.storeReference,
            optionSetReference: command.optionSetReference,
            currentAggregateVersion: root.aggregateVersion,
            publicationState: status.outcome,
            currentLifecycleReference:
              status.outcome === "Published"
                ? status.proof.lifecycle.lifecycleId
                : status.outcome === "NotCurrentlyPublished"
                  ? status.lifecycle.lifecycleId
                  : (status.latestRecordedLifecycle?.lifecycleId ?? null),
            lastReleaseReference:
              status.outcome === "Published"
                ? status.proof.release.releaseId
                : status.lastReleaseReference,
            release:
              status.outcome === "Published"
                ? Object.freeze({
                    publicationReference: String(status.proof.release.releaseId),
                    releaseSequence: status.proof.release.sequence,
                    releasedAt: status.proof.release.createdAt,
                    lifecycleReference: String(status.proof.lifecycle.lifecycleId),
                    lifecycleVersion: status.proof.lifecycle.version,
                    snapshotReference: String(status.proof.release.snapshotReference),
                    snapshotDigest: String(status.proof.release.snapshotDigest),
                    approvalDisposition: status.proof.approvalDisposition,
                  })
                : null,
            published: published
              ? (() => {
                  const rootContent = published.graph.contents.find(
                    (content) =>
                      content.sourceAggregate.optionSetReference === command.optionSetReference,
                  );
                  if (
                    !rootContent ||
                    status.outcome !== "Published" ||
                    rootContent.sourceAggregate.draft.versionReference !==
                      parseCatalogReference(status.proof.release.snapshotReference)
                  )
                    return reject();
                  const { sourceAggregate, ...additional } = rootContent;
                  const parsedRoot = parseCatalogOptionSetEditorContent(
                    sourceAggregate,
                    additional,
                  );
                  return Object.freeze({
                    profile: "CatalogOptionSetCurrentPublishedContentV1" as const,
                    content: parsedRoot.content,
                    sourceDigest: parsedRoot.sourceDigest,
                    contentDigest: parsedRoot.contentDigest,
                    configurationDigest: parsedRoot.configurationDigest,
                    sourceRecords: published.sourceRecords,
                    graphDigest: published.graphDigest,
                    rules: published.rules,
                    observedAt: published.observedAt,
                    validUntil: published.validUntil,
                    sourceAuthority: published.sourceAuthority,
                    referenceEligibility: published.referenceEligibility,
                    eligibility: published.eligibility,
                    publishValidation: published.publishValidation,
                  });
                })()
              : null,
            observedAt,
            validUntil: deadline,
          });
          return completed;
        } catch (error) {
          if (error instanceof CatalogError && error.code !== "CATALOG_INPUT_INVALID") throw error;
          return reject();
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || sourceCalls !== 1 || !finalized || !completed || result !== completed)
      return reject();
    if (!finalLease) return reject();
    const finalDeadline = finalLease();
    if (graphFinal) {
      const graphDeadline = parseCatalogInstant(graphFinal());
      if (graphDeadline < deadline) deadline = graphDeadline;
    }
    if (finalDeadline < deadline) deadline = finalDeadline;
    now();
    return Object.freeze({
      ...result,
      published: result.published
        ? Object.freeze({ ...result.published, validUntil: deadline })
        : null,
      validUntil: deadline,
    });
  };
}
