import { createMerchantOptionSetAuthoringRuntimeAuthority } from "./merchant-option-set-authoring-runtime-authority.js";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  createPostgresOptionSetAuthoringResolutionStore,
  parseCatalogOptionSetAuthoringResolutionCommand,
  parseCatalogOptionSetAuthoringIdentity,
  parseFullOptionSetCreateCommand,
  parseFullOptionSetEditCommand,
  createPostgresFullOptionSetDraftStore,
  optionSetAuthoringResolutionFields,
  parseCatalogOptionSetEditorContent,
  type OptionSetEditorContent,
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
export interface MerchantOptionSetAuthoringCommandOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly references: {
    generate(kind: "OptionSet" | "OptionSetVersion" | "Option" | "Audit" | "Event"): string;
  };
}
export interface MerchantOptionSetAuthoringCommandResult {
  readonly profile: "CatalogOptionSetAuthoringCommandResultV1";
  readonly action: "Create" | "Edit";
  readonly status: "Applied" | "Replayed";
  readonly operationReference: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly referenceEligibility: "NotEvaluated";
  readonly storeReference: string;
  readonly content: OptionSetEditorContent;
}
/** Actual ordinary writing composition. The Catalog owner arbitrates original
 * operation identity before server clock/allocation and commits all facts atomically. */
export function createMerchantOptionSetAuthoringCommand(
  options: MerchantOptionSetAuthoringCommandOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.references?.generate !== "function"
  )
    return fail();
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    generate = options.references.generate.bind(options.references),
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
  const execute = async (
    action: "Create" | "Edit",
    request: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
      readonly command: unknown;
      readonly expectedScope: unknown;
    },
  ): Promise<MerchantOptionSetAuthoringCommandResult> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(
        copyCategoryPersistenceValue(request.command),
        action === "Create"
          ? ["internalCode", "draft", "additionalContent", "operationReference"]
          : [
              "optionSetReference",
              "expectedAggregateVersion",
              "draft",
              "additionalContent",
              "archiveOptionReferences",
              "operationReference",
            ],
      );
      parseCatalogReference(raw.operationReference);
      // Owning parsers validate every field before admission using a temporary
      // shape only. The real authoritative occurrence is chosen under the lock.
      const preview = {
        ...raw,
        occurredAt: parseCatalogInstant(clock()),
        reasonCode: "AUTHORIZED_OPERATION",
      };
      if (action === "Create") parseFullOptionSetCreateCommand(preview);
      else parseFullOptionSetEditCommand(preview);
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
      completed: MerchantOptionSetAuthoringCommandResult | undefined;
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
        const command = parseCatalogOptionSetAuthoringResolutionCommand({
          profile: "CatalogOptionSetAuthoringResolutionCommandV1",
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          actorReference: scope.actorReference,
          action,
          reasonCode: "AUTHORIZED_OPERATION",
          operationReference: raw.operationReference,
          optionSetReference: action === "Create" ? null : raw.optionSetReference,
          expectedAggregateVersion: action === "Create" ? null : raw.expectedAggregateVersion,
        });
        const capabilityKey =
            command.action === "Create"
              ? "catalog.cat_optionset_create"
              : "catalog.cat_optionset_edit",
          permissions = Object.freeze([
            "catalog.manage",
            command.action === "Create" ? "catalog.option_set.create" : "catalog.option_set.update",
          ] as const),
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
                  input.mode !== "Write" ||
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
                auditId: parseCatalogReference(generate("Audit")),
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
        let originalCalls = 0;
        const written = await store.withOriginalOperation(tx, command, async (original) => {
          if (++originalCalls !== 1) return reject();
          check();
          if (original.outcome === "Abandoned") return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          const originalIdentity =
            original.outcome === "Committed"
              ? parseCatalogOptionSetAuthoringIdentity(original.identity)
              : null;
          if (
            originalIdentity &&
            canonicalizeRfc8785(originalIdentity.command) !== canonicalizeRfc8785(command)
          )
            return reject();
          const occurredAt = originalIdentity ? originalIdentity.originalOccurredAt : now();
          const full =
            action === "Create"
              ? parseFullOptionSetCreateCommand({
                  ...raw,
                  occurredAt,
                  reasonCode: "AUTHORIZED_OPERATION",
                })
              : parseFullOptionSetEditCommand({
                  ...raw,
                  occurredAt,
                  reasonCode: "AUTHORIZED_OPERATION",
                });
          const authority = createMerchantOptionSetAuthoringRuntimeAuthority({
            transaction: tx,
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            storeReference: bound.storeReference,
            actorReference: command.actorReference,
            sessionReference: session.sessionReference,
            packet: { action, command: full },
            clock: { now },
            originalValidUntil: originalDeadline,
            currentAuthorization: current,
            capability,
            registerBeforeCommit: host.registerBeforeCommit,
          });
          let ownerCalls = 0;
          const owner = createPostgresFullOptionSetDraftStore({
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            actorReference: command.actorReference,
            clock: { now },
            transactions: {
              async run(work) {
                if (++ownerCalls !== 1) return reject();
                check();
                const result = await work(tx);
                check();
                return result;
              },
            },
            authority: { holdUntilTransactionCompletes: async () => reject() },
            creation: {
              authority: authority.creation,
              references: { generate: (kind) => parseCatalogReference(generate(kind)) },
            },
            editing: {
              authority: authority.editing,
              references: { generateOption: () => parseCatalogReference(generate("Option")) },
              registerBeforeCommit: host.registerBeforeCommit,
            },
            audit: {
              create(input) {
                return {
                  auditId: parseCatalogReference(generate("Audit")),
                  brandId: command.brandReference,
                  actor: { type: "User", reference: command.actorReference },
                  actionCode:
                    action === "Create"
                      ? "CATALOG_OPTION_SET_CREATE"
                      : "CATALOG_OPTION_SET_REPLACEDRAFT",
                  targetType: "CatalogOptionSet",
                  targetId: input.result.sourceAggregate.optionSetReference,
                  reasonCode: input.reasonCode,
                  correlationId: input.operationReference,
                  occurredAt: input.occurredAt,
                  sourceChannel: "API",
                  dataClassification: "Internal",
                  retentionPolicyCode: "OPERATIONAL",
                  retentionPolicyVersion: 1,
                };
              },
            },
            events: { generateReference: () => parseCatalogReference(generate("Event")) },
          });
          const result = action === "Create" ? await owner.create(full) : await owner.edit(full);
          check();
          if (
            ownerCalls !== 1 ||
            result.operationReference !== command.operationReference ||
            result.referenceEligibility !== "NotEvaluated" ||
            result.status !== (original.outcome === "Committed" ? "Replayed" : "Applied")
          )
            return reject();
          const packet = readClosedRecord(copyCategoryPersistenceValue(result.content), [
              "profile",
              "sourceAggregate",
              "optionDetails",
              "conditionalRules",
              "conflictRules",
              "scopeSet",
              "effectivePeriod",
            ]),
            { sourceAggregate, ...details } = packet,
            parsed = parseCatalogOptionSetEditorContent(sourceAggregate, details),
            root = parsed.content.sourceAggregate;
          if (
            root.brandReference !== command.brandReference ||
            root.aggregateVersion !==
              (action === "Create" ? 1 : (command.expectedAggregateVersion ?? 0) + 1) ||
            root.updatedAt !== occurredAt ||
            parsed.contentDigest !== result.contentDigest ||
            parsed.configurationDigest !== result.configurationDigest ||
            (action === "Edit" && root.optionSetReference !== command.optionSetReference) ||
            (action === "Create" &&
              (root.createdByActorReference !== command.actorReference ||
                root.createdAt !== occurredAt)) ||
            (original.outcome === "Committed" &&
              canonicalizeRfc8785(parsed.content) !== canonicalizeRfc8785(original.content))
          )
            return reject();
          return { ...result, content: parsed.content };
        });
        check();
        if (originalCalls !== 1) return reject();
        ready = true;
        completed = Object.freeze({
          profile: "CatalogOptionSetAuthoringCommandResultV1",
          storeReference: bound.storeReference,
          action,
          status: written.status,
          operationReference: written.operationReference,
          content: written.content,
          contentDigest: written.contentDigest,
          configurationDigest: written.configurationDigest,
          referenceEligibility: "NotEvaluated",
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
  return Object.freeze({
    create: (request: Parameters<typeof execute>[1]) => execute("Create", request),
    edit: (request: Parameters<typeof execute>[1]) => execute("Edit", request),
  });
}
