import { BrowserSessionError, readClosedRecord } from "@bop/identity";
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

type View = Awaited<
  ReturnType<ReturnType<typeof createPostgresCurrentFullOptionSetDraftStore>["readCurrent"]>
>;
export interface MerchantOptionSetEditorQueryOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}
export type MerchantOptionSetCurrentEditorResult = Omit<View, "observedAt" | "validUntil"> &
  Readonly<{
    profile: "CatalogOptionSetCurrentEditorResultV1";
    tenantReference: string;
    brandReference: string;
    actorReference: string;
    storeReference: string;
  }>;
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
/** Current editable complete Draft only; source/reference publication readiness is not evaluated. */
export function createMerchantOptionSetEditorQuery(options: MerchantOptionSetEditorQueryOptions) {
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
  }): Promise<MerchantOptionSetCurrentEditorResult> => {
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
      completed: MerchantOptionSetCurrentEditorResult | undefined;
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
          ready = true;
          check();
          completed = Object.freeze({
            profile: "CatalogOptionSetCurrentEditorResultV1",
            tenantReference,
            brandReference: bound.brandReference,
            actorReference,
            storeReference: bound.storeReference,
            content: parsed.content,
            sourceDigest: parsed.sourceDigest,
            contentDigest: parsed.contentDigest,
            configurationDigest: parsed.configurationDigest,
            referenceEligibility: "NotEvaluated",
          });
          return completed;
        } catch {
          return reject();
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || sourceCalls !== 1 || !finalized || !completed || result !== completed)
      return reject();
    now();
    return result;
  };
}
