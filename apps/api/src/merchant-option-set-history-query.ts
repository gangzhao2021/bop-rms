import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  createPostgresOptionSetHistoryStore,
  parseCatalogOptionSetHistoryResult,
  parseCatalogOptionSetHistoricalDraftResult,
  parseCatalogOptionSetHistoricalFrozenResult,
  copyCategoryPersistenceValue,
  compareCatalogOptionSetContent,
} from "@rms/catalog";
import {
  createPostgresOptionSetPublicationHistoryStore,
  parseOptionSetPublicationHistoryBefore,
  parsePublishingReference,
  parsePublishingInstant,
  parsePublishingVersion,
  parsePublishingCode,
  parsePublishingDigest,
  parseReleaseSequence,
  publishingLifecycleStates,
  optionSetPublicationHistoryFields,
} from "@bop/publishing";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  createMerchantOptionSetHistoryRuntimeAuthority,
  parseMerchantOptionSetHistoryPacket,
  merchantOptionSetCatalogHistoryReads,
  merchantOptionSetHistoryTarget,
} from "./merchant-option-set-history-runtime-authority.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export interface MerchantOptionSetHistoryQueryOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}
type List = ReturnType<typeof parseCatalogOptionSetHistoryResult>;
type Draft = ReturnType<typeof parseCatalogOptionSetHistoricalDraftResult>;
type Frozen = ReturnType<typeof parseCatalogOptionSetHistoricalFrozenResult>;
type Publishing = ReturnType<typeof parsePublishingView>;
type HistoricalSide =
  Readonly<{ kind: "Draft"; view: Draft }> | Readonly<{ kind: "Frozen"; view: Frozen }>;
type Compare = Readonly<{
  profile: "CatalogOptionSetHistoryComparisonV1";
  left: HistoricalSide;
  right: HistoricalSide;
  comparison: ReturnType<typeof compareCatalogOptionSetContent>;
  observedAt: string;
  validUntil: string;
}>;
interface Views {
  List: List;
  Draft: Draft;
  Frozen: Frozen;
  Publishing: Publishing;
  Compare: Compare;
}
export type MerchantOptionSetHistoryQueryResult = {
  [K in keyof Views]: Readonly<{
    profile: "CatalogOptionSetHistoryQueryResultV1";
    action: K;
    storeReference: string;
    actorReference: string;
    view: Views[K];
  }>;
}[keyof Views];
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};

function parsePublishingView(
  value: unknown,
  command: { optionSetReference: string; before: unknown; limit: number },
  scope: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
  },
) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
      "profile",
      "scope",
      "familyReference",
      "entries",
      "nextBefore",
      "observedAt",
      "validUntil",
    ]),
    anchor = readClosedRecord(r.scope, [
      "tenantReference",
      "brandReference",
      "selectedStoreReference",
      "actorReference",
    ]),
    observedAt = parsePublishingInstant(r.observedAt),
    validUntil = parsePublishingInstant(r.validUntil);
  if (
    r.profile !== "PublishingOptionSetHistoryV1" ||
    r.familyReference !== command.optionSetReference ||
    anchor.tenantReference !== scope.tenantReference ||
    anchor.brandReference !== scope.brandReference ||
    anchor.selectedStoreReference !== scope.storeReference ||
    anchor.actorReference !== scope.actorReference ||
    !Array.isArray(r.entries) ||
    r.entries.length > command.limit ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail();
  const state = (v: unknown) => publishingLifecycleStates.find((item) => item === v) ?? fail();
  const entries = r.entries.map((value) => {
    const e = readClosedRecord(value, optionSetPublicationHistoryFields),
      occurredAt = parsePublishingInstant(e.occurredAt),
      recordedAt = parsePublishingInstant(e.recordedAt);
    const operation = e.operation;
    if (
      operation !== "CreateDraft" &&
      operation !== "SubmitReview" &&
      operation !== "Approve" &&
      operation !== "Publish" &&
      operation !== "Archive" &&
      operation !== "Rollback"
    )
      return fail();
    const actorKind = e.actorKind;
    if (actorKind !== "User" && actorKind !== "Service" && actorKind !== "System") return fail();
    if (
      (actorKind === "System") !== (e.actorReference === null) ||
      occurredAt > observedAt ||
      recordedAt < occurredAt ||
      recordedAt > observedAt ||
      (e.releaseReference === null) !== (e.releaseSequence === null)
    )
      return fail();
    return Object.freeze({
      operationReference: parsePublishingReference(e.operationReference),
      lifecycleReference: parsePublishingReference(e.lifecycleReference),
      lifecycleVersion: parsePublishingVersion(e.lifecycleVersion),
      operation,
      actorKind,
      actorReference: e.actorReference === null ? null : parsePublishingReference(e.actorReference),
      occurredAt,
      recordedAt,
      reasonCode: parsePublishingCode(e.reasonCode),
      fromState: e.fromState === null ? null : state(e.fromState),
      toState: state(e.toState),
      snapshotReference: parsePublishingReference(e.snapshotReference),
      snapshotDigest: parsePublishingDigest(e.snapshotDigest),
      releaseReference:
        e.releaseReference === null ? null : parsePublishingReference(e.releaseReference),
      releaseSequence: e.releaseSequence === null ? null : parseReleaseSequence(e.releaseSequence),
      supersededReleaseReference:
        e.supersededReleaseReference === null
          ? null
          : parsePublishingReference(e.supersededReleaseReference),
      rollbackTargetReleaseReference:
        e.rollbackTargetReleaseReference === null
          ? null
          : parsePublishingReference(e.rollbackTargetReleaseReference),
    });
  });
  const before =
    command.before === null ? null : parseOptionSetPublicationHistoryBefore(command.before);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i],
      previous = i === 0 ? before : entries[i - 1];
    if (
      !entry ||
      (previous &&
        (entry.occurredAt > previous.occurredAt ||
          (entry.occurredAt === previous.occurredAt &&
            entry.operationReference >= previous.operationReference)))
    )
      return fail();
  }
  const nextBefore =
      r.nextBefore === null ? null : parseOptionSetPublicationHistoryBefore(r.nextBefore),
    last = entries.at(-1);
  if (
    nextBefore &&
    (entries.length !== command.limit ||
      !last ||
      nextBefore.occurredAt !== last.occurredAt ||
      nextBefore.operationReference !== last.operationReference)
  )
    return fail();
  return Object.freeze({
    profile: "PublishingOptionSetHistoryV1" as const,
    scope: Object.freeze({
      tenantReference: parsePublishingReference(anchor.tenantReference),
      brandReference: parsePublishingReference(anchor.brandReference),
      selectedStoreReference: parsePublishingReference(anchor.selectedStoreReference),
      actorReference: parsePublishingReference(anchor.actorReference),
    }),
    familyReference: parsePublishingReference(r.familyReference),
    entries: Object.freeze(entries),
    nextBefore,
    observedAt,
    validUntil,
  });
}
/** Current authenticated history observation. Historical Draft content never
 * grants publication, source eligibility or mutation permission. */
export function createMerchantOptionSetHistoryQuery(options: MerchantOptionSetHistoryQueryOptions) {
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
  }): Promise<MerchantOptionSetHistoryQueryResult> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let intent: ReturnType<typeof parseMerchantOptionSetHistoryPacket>;
    try {
      intent = parseMerchantOptionSetHistoryPacket(request.command);
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    let latest = parseCatalogInstant(clock()),
      failed = false;
    const startedAt = latest,
      originalDeadline = parseCatalogInstant(new Date(Date.parse(startedAt) + 5000).toISOString());
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
      finalized = false;
    let resultView: Views[keyof Views] | undefined;
    let completed: MerchantOptionSetHistoryQueryResult | undefined;
    let observe: (() => string) | undefined;
    let assertFailure: (() => void) | undefined;
    const ownerFinals: (() => string)[] = [];
    const reads = merchantOptionSetCatalogHistoryReads(intent),
      target = merchantOptionSetHistoryTarget(intent);
    const expectedSourceCalls = reads.length;
    const result = await host.transactions
      .run(async (tx) => {
        if (++calls !== 1) return reject();
        const query = tx.query;
        let ready = false,
          guardCalls = 0,
          guardComplete = false,
          finalCalls = 0;
        let assertSources: (() => void) | undefined;
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
            sessionReference = parseCatalogReference(session.sessionReference),
            current = createMerchantProductCurrentAuthorization({
              merchant,
              transaction: tx,
              scope,
              sessionCookie,
              sessionReference,
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
            }),
            holder = createMerchantOptionSetHistoryRuntimeAuthority({
              transaction: tx,
              tenantReference,
              brandReference: bound.brandReference,
              storeReference: bound.storeReference,
              actorReference,
              sessionReference,
              packet: intent,
              clock: { now },
              originalObservedAt: startedAt,
              originalValidUntil: originalDeadline,
              currentAuthorization: current,
              capability,
              registerBeforeCommit: host.registerBeforeCommit,
            });
          observe = holder.leaseDeadline;
          assertFailure = holder.assertCurrent;
          assertSources = () => {
            holder.assertCurrent();
            if (ready) {
              const until = parseCatalogInstant(holder.leaseDeadline());
              if (until < deadline) deadline = until;
              now();
            }
          };
          const store = createPostgresOptionSetHistoryStore({
            tenantReference,
            brandReference: bound.brandReference,
            actorReference,
            clock: { now },
            originalObservedAt: startedAt,
            originalValidUntil: originalDeadline,
            authority: holder.authority,
            registerBeforeCommit: host.registerBeforeCommit,
            transactions: {
              async run(work) {
                if (++sourceCalls > expectedSourceCalls) return reject();
                check();
                const value = await work(tx);
                check();
                return value;
              },
            },
          });
          ownerFinals.push(store.assertFinalized);
          const base = {
            profile: "CatalogOptionSetHistoryQueryResultV1" as const,
            storeReference: bound.storeReference,
            actorReference,
          };
          const validate = <T extends List | Draft | Frozen>(view: T): T => {
            if (
              view.tenantReference !== tenantReference ||
              view.brandReference !== bound.brandReference ||
              view.optionSetReference !== target ||
              view.observedAt < startedAt ||
              view.observedAt > now() ||
              view.validUntil > originalDeadline
            )
              return reject();
            const until = parseCatalogInstant(view.validUntil);
            if (until < deadline) deadline = until;
            return view;
          };
          if (intent.action === "List")
            completed = Object.freeze({
              ...base,
              action: "List" as const,
              view: validate(
                parseCatalogOptionSetHistoryResult(
                  await store.listHistory(intent.command),
                  intent.command,
                ),
              ),
            });
          else if (intent.action === "Draft")
            completed = Object.freeze({
              ...base,
              action: "Draft" as const,
              view: validate(
                parseCatalogOptionSetHistoricalDraftResult(
                  await store.readHistoricalDraft(intent.command),
                  intent.command,
                ),
              ),
            });
          else if (intent.action === "Frozen")
            completed = Object.freeze({
              ...base,
              action: "Frozen" as const,
              view: validate(
                parseCatalogOptionSetHistoricalFrozenResult(
                  await store.readHistoricalFrozen(intent.command),
                  intent.command,
                ),
              ),
            });
          else if (intent.action === "Compare") {
            const read = async (selector: typeof intent.command.left) =>
              selector.kind === "Draft"
                ? validate(
                    parseCatalogOptionSetHistoricalDraftResult(
                      await store.readHistoricalDraft(selector.command),
                      selector.command,
                    ),
                  )
                : validate(
                    parseCatalogOptionSetHistoricalFrozenResult(
                      await store.readHistoricalFrozen(selector.command),
                      selector.command,
                    ),
                  );
            const left = await read(intent.command.left),
              right = reads.length === 1 ? left : await read(intent.command.right);
            const leftContent =
              intent.command.left.kind === "Draft"
                ? parseCatalogOptionSetHistoricalDraftResult(left, intent.command.left.command)
                    .content
                : parseCatalogOptionSetHistoricalFrozenResult(left, intent.command.left.command)
                    .content.editorContent;
            const rightContent =
              intent.command.right.kind === "Draft"
                ? parseCatalogOptionSetHistoricalDraftResult(right, intent.command.right.command)
                    .content
                : parseCatalogOptionSetHistoricalFrozenResult(right, intent.command.right.command)
                    .content.editorContent;
            const leftSide =
              intent.command.left.kind === "Draft"
                ? Object.freeze({
                    kind: "Draft" as const,
                    view: parseCatalogOptionSetHistoricalDraftResult(
                      left,
                      intent.command.left.command,
                    ),
                  })
                : Object.freeze({
                    kind: "Frozen" as const,
                    view: parseCatalogOptionSetHistoricalFrozenResult(
                      left,
                      intent.command.left.command,
                    ),
                  });
            const rightSide =
              intent.command.right.kind === "Draft"
                ? Object.freeze({
                    kind: "Draft" as const,
                    view: parseCatalogOptionSetHistoricalDraftResult(
                      right,
                      intent.command.right.command,
                    ),
                  })
                : Object.freeze({
                    kind: "Frozen" as const,
                    view: parseCatalogOptionSetHistoricalFrozenResult(
                      right,
                      intent.command.right.command,
                    ),
                  });
            completed = Object.freeze({
              ...base,
              action: "Compare" as const,
              view: Object.freeze({
                profile: "CatalogOptionSetHistoryComparisonV1" as const,
                left: leftSide,
                right: rightSide,
                comparison: compareCatalogOptionSetContent({
                  left: leftContent,
                  right: rightContent,
                }),
                observedAt: now(),
                validUntil: deadline,
              }),
            });
          } else {
            const first = reads[0];
            if (!first) return reject();
            validate(
              parseCatalogOptionSetHistoryResult(
                await store.listHistory(first.command),
                first.command,
              ),
            );
            const publishing = createPostgresOptionSetPublicationHistoryStore({
              tenantReference,
              brandReference: bound.brandReference,
              selectedStoreReference: bound.storeReference,
              actorReference,
              clock: { now },
              originalValidUntil: originalDeadline,
              authority: holder.publishingAuthority,
              registerBeforeCommit: (actual, guard, final) => {
                if (actual !== tx) return reject();
                return host.registerBeforeCommit(tx, guard, final);
              },
            });
            const value = await publishing.list(tx, {
              familyReference: target,
              before: intent.command.before,
              limit: intent.command.limit,
            });
            ownerFinals.push(() => publishing.assertFinalized(tx));
            const view = parsePublishingView(value, intent.command, {
              tenantReference,
              brandReference: bound.brandReference,
              storeReference: bound.storeReference,
              actorReference,
            });
            if (
              parseCatalogInstant(view.observedAt) < startedAt ||
              parseCatalogInstant(view.observedAt) > now() ||
              parseCatalogInstant(view.validUntil) > originalDeadline
            )
              return reject();
            if (parseCatalogInstant(view.validUntil) < deadline)
              deadline = parseCatalogInstant(view.validUntil);
            completed = Object.freeze({ ...base, action: "Publishing" as const, view });
          }
          if (sourceCalls !== expectedSourceCalls || !completed) return reject();
          resultView = completed.view;
          ready = true;
          check();
          return completed;
        } catch (error) {
          failed = true;
          throw error;
        }
      })
      .catch((error: unknown) => {
        try {
          assertFailure?.();
        } catch (heldError) {
          if (
            heldError instanceof MerchantProductWriteFeatureDisabled ||
            (heldError instanceof CatalogError && heldError.code === "CATALOG_PERMISSION_DENIED")
          )
            throw heldError;
        }
        if (error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID") return fail();
        throw error;
      });
    if (
      calls !== 1 ||
      sourceCalls !== expectedSourceCalls ||
      !finalized ||
      !completed ||
      !resultView ||
      result !== completed ||
      !observe ||
      ownerFinals.length === 0
    )
      return reject();
    // Final asynchronous sources may shorten their held lease. Observe only the
    // completed original guard; never rerun a final assertion or issue a grant.
    for (const value of [...ownerFinals.map((final) => final()), observe()]) {
      const until = parseCatalogInstant(value);
      if (until < deadline) deadline = until;
    }
    now();
    if (completed.action === "List")
      return Object.freeze({
        ...completed,
        view: parseCatalogOptionSetHistoryResult(
          { ...completed.view, validUntil: deadline },
          intent.command,
        ),
      });
    if (completed.action === "Draft")
      return Object.freeze({
        ...completed,
        view: parseCatalogOptionSetHistoricalDraftResult(
          { ...completed.view, validUntil: deadline },
          intent.command,
        ),
      });
    if (completed.action === "Frozen")
      return Object.freeze({
        ...completed,
        view: parseCatalogOptionSetHistoricalFrozenResult(
          { ...completed.view, validUntil: deadline },
          intent.command,
        ),
      });
    if (completed.action === "Compare") {
      if (intent.action !== "Compare") return reject();
      const left =
        completed.view.left.kind === "Draft"
          ? Object.freeze({
              kind: "Draft" as const,
              view: parseCatalogOptionSetHistoricalDraftResult(
                { ...completed.view.left.view, validUntil: deadline },
                intent.command.left.command,
              ),
            })
          : Object.freeze({
              kind: "Frozen" as const,
              view: parseCatalogOptionSetHistoricalFrozenResult(
                { ...completed.view.left.view, validUntil: deadline },
                intent.command.left.command,
              ),
            });
      const right =
        completed.view.right.kind === "Draft"
          ? Object.freeze({
              kind: "Draft" as const,
              view: parseCatalogOptionSetHistoricalDraftResult(
                { ...completed.view.right.view, validUntil: deadline },
                intent.command.right.command,
              ),
            })
          : Object.freeze({
              kind: "Frozen" as const,
              view: parseCatalogOptionSetHistoricalFrozenResult(
                { ...completed.view.right.view, validUntil: deadline },
                intent.command.right.command,
              ),
            });
      return Object.freeze({
        ...completed,
        view: Object.freeze({ ...completed.view, left, right, validUntil: deadline }),
      });
    }
    if (intent.action !== "Publishing") return reject();
    return Object.freeze({
      ...completed,
      view: parsePublishingView({ ...completed.view, validUntil: deadline }, intent.command, {
        tenantReference: completed.view.scope.tenantReference,
        brandReference: completed.view.scope.brandReference,
        storeReference: completed.storeReference,
        actorReference: completed.actorReference,
      }),
    });
  };
}
