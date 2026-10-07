import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  createPostgresOptionSetAuthoringResolutionStore,
  parseCatalogOptionSetAuthoringResolutionCommand,
  parseCatalogOptionSetAuthoringResolution,
  optionSetAuthoringResolutionFields,
  parseCatalogOptionSetEditorContent,
  type OptionSetEditorContent,
  type CatalogOptionSetAuthoringResolution,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export interface MerchantOptionSetAuthoringResolutionOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
}
export interface MerchantOptionSetAuthoringResolutionResult {
  readonly profile: "CatalogOptionSetAuthoringResolutionResultV1";
  readonly storeReference: string;
  readonly resolution: CatalogOptionSetAuthoringResolution;
  readonly content: OptionSetEditorContent | null;
}
/** Actual current Session/Brand/Store admission. No original content requalification
 * and no new execution. The Catalog owner resolves or permanently fences absence. */
export function createMerchantOptionSetAuthoringResolutionCommand(
  options: MerchantOptionSetAuthoringResolutionOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.auditReference !== "function"
  )
    return fail();
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    auditReference = options.auditReference.bind(options),
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
  }): Promise<MerchantOptionSetAuthoringResolutionResult> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(copyCategoryPersistenceValue(request.command), [
        "profile",
        "tenantReference",
        "action",
        "operationReference",
        "optionSetReference",
        "expectedAggregateVersion",
      ]);
      if (raw.profile !== "CatalogOptionSetAuthoringResolutionRequestV1")
        return fail("CATALOG_INPUT_INVALID");
      parseCatalogReference(raw.tenantReference);
      parseCatalogReference(raw.operationReference);
      if (raw.action === "Create") {
        if (raw.optionSetReference !== null || raw.expectedAggregateVersion !== null)
          return fail("CATALOG_INPUT_INVALID");
      } else if (raw.action === "Edit") {
        parseCatalogReference(raw.optionSetReference);
        if (
          !Number.isSafeInteger(raw.expectedAggregateVersion) ||
          (raw.expectedAggregateVersion as number) < 1 ||
          (raw.expectedAggregateVersion as number) > 2147483646
        )
          return fail("CATALOG_INPUT_INVALID");
      } else return fail("CATALOG_INPUT_INVALID");
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
      finalized = false,
      completed: MerchantOptionSetAuthoringResolutionResult | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query;
      let guardCalls = 0,
        finalCalls = 0,
        guardComplete = false;
      let ready = false,
        holdAgain: (() => Promise<void>) | undefined,
        assertCurrent: (() => void) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) return reject();
        assertCurrent?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || !holdAgain || ++guardCalls !== 1) return reject();
          await holdAgain();
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
        );
        if (scope.tenantReference !== raw.tenantReference) return fail("CATALOG_PERMISSION_DENIED");
        const command = parseCatalogOptionSetAuthoringResolutionCommand({
          profile: "CatalogOptionSetAuthoringResolutionCommandV1",
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          actorReference: scope.actorReference,
          action: raw.action,
          reasonCode: "AUTHORIZED_OPERATION",
          operationReference: raw.operationReference,
          optionSetReference: raw.optionSetReference,
          expectedAggregateVersion: raw.expectedAggregateVersion,
        });
        const capabilityKey =
            command.action === "Create"
              ? "catalog.cat_optionset_create"
              : "catalog.cat_optionset_edit",
          permissions = Object.freeze(["catalog.manage", "catalog.option_set.read"] as const),
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            capabilityKey,
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            storeReference: bound.storeReference,
            actorReference: command.actorReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey,
          });
        if (
          typeof current.leaseDeadline !== "function" ||
          typeof capability.leaseDeadline !== "function"
        )
          return reject();
        const assert = current.assertCurrent.bind(current),
          authorize = current.authorizeActions.bind(current),
          hold = capability.holdUntilCommit.bind(capability),
          currentLease = current.leaseDeadline.bind(current),
          capabilityLease = capability.leaseDeadline.bind(capability);
        const shorten = () => {
          const a = parseCatalogInstant(currentLease()),
            b = parseCatalogInstant(capabilityLease());
          if (a < deadline) deadline = a;
          if (b < deadline) deadline = b;
          now();
        };
        let holding = false,
          admitted = false;
        assertCurrent = () => {
          const at = parseCatalogInstant(assert());
          if (at !== latest) return reject();
          if (admitted) shorten();
        };
        holdAgain = async () => {
          if (holding) return reject();
          holding = true;
          try {
            check();
            if ((await hold()) !== undefined) return reject();
            check();
            if ((await authorize(permissions)) !== undefined) return reject();
            admitted = true;
            check();
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            holding = false;
          }
        };
        const store = createPostgresOptionSetAuthoringResolutionStore({
          tenantReference: command.tenantReference,
          brandReference: command.brandReference,
          actorReference: command.actorReference,
          clock: { now },
          originalValidUntil: originalDeadline,
          transactions: host.transactions,
          async registerBeforeCommit(actual, guard, finalAssert) {
            if (actual !== tx) return reject();
            await host.registerBeforeCommit(actual, guard, finalAssert);
            check();
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              try {
                readClosedRecord(input, [
                  "command",
                  "mode",
                  "permission",
                  "requiredPermissions",
                  "requiredFields",
                  "purposeCode",
                  "actorKind",
                  "requiredScope",
                  "observedAt",
                ]);
                const observedAt = parseCatalogInstant(input.observedAt);
                if (
                  actual !== tx ||
                  input.mode !== "Resolve" ||
                  canonicalizeRfc8785(input.command) !== canonicalizeRfc8785(command) ||
                  input.actorKind !== "User" ||
                  input.purposeCode !== "CATALOG_OPTION_SET_AUTHORING_OPERATION_RESOLUTION" ||
                  input.permission !== "catalog.manage" ||
                  input.requiredScope !== "FullBrandScope" ||
                  canonicalizeRfc8785(input.requiredPermissions) !==
                    canonicalizeRfc8785(permissions) ||
                  canonicalizeRfc8785(input.requiredFields) !==
                    canonicalizeRfc8785(optionSetAuthoringResolutionFields) ||
                  observedAt < startedAt ||
                  observedAt > now()
                )
                  return reject();
                if (!holdAgain) return reject();
                await holdAgain();
                return Object.freeze({ observedAt, validUntil: deadline });
              } catch (error) {
                failed = true;
                throw error;
              }
            },
          },
          audit: {
            create({ resolution }) {
              return {
                auditId: parseCatalogReference(auditReference(command.operationReference)),
                brandId: command.brandReference,
                actor: { type: "User", reference: command.actorReference },
                actionCode: "CATALOG_OPTION_SET_AUTHORING_ABANDONED",
                targetType: "CatalogOptionSetAuthoringOperation",
                targetId: command.operationReference,
                reasonCode: command.reasonCode,
                correlationId: command.operationReference,
                occurredAt: resolution.recordedAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              };
            },
          },
        });
        const resolved = await store.resolveInTransaction(tx, command),
          resolution = parseCatalogOptionSetAuthoringResolution(resolved.resolution);
        let content: OptionSetEditorContent | null = null;
        if (resolution.outcome === "Committed") {
          const rawContent = readClosedRecord(copyCategoryPersistenceValue(resolved.content), [
            "profile",
            "sourceAggregate",
            "optionDetails",
            "conditionalRules",
            "conflictRules",
            "scopeSet",
            "effectivePeriod",
          ]);
          const { sourceAggregate, ...additional } = rawContent;
          const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
            identity = resolution.identity;
          if (
            !identity ||
            parsed.content.sourceAggregate.brandReference !== command.brandReference ||
            parsed.content.sourceAggregate.optionSetReference !== identity.optionSetReference ||
            parsed.content.sourceAggregate.aggregateVersion !== identity.aggregateVersion ||
            parsed.content.sourceAggregate.draft.versionReference !== identity.versionReference ||
            parsed.content.sourceAggregate.updatedAt !== identity.originalOccurredAt ||
            parsed.sourceDigest !== identity.sourceDigest ||
            parsed.contentDigest !== identity.contentDigest ||
            parsed.configurationDigest !== identity.configurationDigest
          )
            return reject();
          content = parsed.content;
        } else if (resolved.content !== null) return reject();
        check();
        if (
          canonicalizeRfc8785(resolution.command) !== canonicalizeRfc8785(command) ||
          resolution.recordedAt > now()
        )
          return reject();
        ready = true;
        completed = Object.freeze({
          profile: "CatalogOptionSetAuthoringResolutionResultV1",
          storeReference: bound.storeReference,
          resolution,
          content,
        });
        return completed;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || !finalized || !completed || result !== completed) return reject();
    now();
    return result;
  };
}
