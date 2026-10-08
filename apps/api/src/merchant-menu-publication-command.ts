import { createMenuReviewApprovalSource } from "./menu-review-approval-source.js";
import {
  createMenuReviewDependencyBindingSource,
  MenuReviewDependencyChangedError,
} from "./menu-review-preparation-source.js";
import { readClosedRecord } from "@bop/identity";
import { createMenuReviewCreationSource } from "./menu-review-creation-source.js";
import { sha256Hex } from "@bop/audit";
import {
  CatalogError,
  createMenuPublicationService,
  createPostgresMenuDraftSource,
  createPostgresMenuPublicationEvidenceSource,
  createPostgresMenuPublicationRepository,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
  validateMenuEffectivePeriod,
  type MenuPublicationCommand,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const fail = (code: ConstructorParameters<typeof CatalogError>[0]): never => {
  throw new CatalogError(code);
};
function decodeReview(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "action")?.value !== "CreateReview"
  )
    return null;
  try {
    const raw = readClosedRecord(value, [
      "action",
      "operationReference",
      "menuReference",
      "menuVersionReference",
      "configurationDigest",
      "registryVersionReference",
      "expectedVersion",
    ]);
    if (
      raw.expectedVersion !== 1 ||
      typeof raw.configurationDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(raw.configurationDigest)
    )
      return fail("CATALOG_INPUT_INVALID");
    return {
      operationReference: parseCatalogReference(raw.operationReference),
      menuReference: parseCatalogReference(raw.menuReference),
      menuVersionReference: parseCatalogReference(raw.menuVersionReference),
      configurationDigest: raw.configurationDigest,
      registryVersionReference: parseCatalogReference(raw.registryVersionReference),
    };
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}
function decode(value: unknown): Omit<MenuPublicationCommand, "requestedAt"> {
  try {
    const raw = readClosedRecord(value, [
      "action",
      "operationReference",
      "menuReference",
      "menuVersionReference",
      "expectedVersion",
      "snapshotDigest",
      "effectivePeriod",
    ]);
    if (
      !["SubmitReview", "Approve", "Publish", "Archive"].includes(raw.action as string) ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      (raw.expectedVersion as number) < 1 ||
      typeof raw.snapshotDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(raw.snapshotDigest)
    )
      return fail("CATALOG_INPUT_INVALID");
    if (raw.action !== "Publish" && raw.effectivePeriod !== null)
      return fail("CATALOG_INPUT_INVALID");
    // Validate closed nested transport records before the domain checks zoned boundaries.
    if (raw.effectivePeriod !== null) {
      const period = readClosedRecord(raw.effectivePeriod, [
        "timeZone",
        "effectiveFrom",
        "effectiveUntil",
      ]);
      readClosedRecord(period.effectiveFrom, ["instant", "localDateTime", "utcOffsetMinutes"]);
      if (period.effectiveUntil !== null)
        readClosedRecord(period.effectiveUntil, ["instant", "localDateTime", "utcOffsetMinutes"]);
    }
    return {
      action: raw.action as MenuPublicationCommand["action"],
      operationReference: parseCatalogReference(raw.operationReference),
      menuReference: parseCatalogReference(raw.menuReference),
      menuVersionReference: parseCatalogReference(raw.menuVersionReference),
      expectedVersion: raw.expectedVersion as number,
      snapshotDigest: raw.snapshotDigest as MenuPublicationCommand["snapshotDigest"],
      effectivePeriod:
        raw.action === "Publish"
          ? validateMenuEffectivePeriod(
              raw.effectivePeriod as MenuPublicationCommand["effectivePeriod"],
            )
          : null,
    };
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}

/** Current permission is required even on exact replay. The runtime binding maps
 * a reviewed snapshot to its Menu configuration; neither is supplied as approval
 * by the HTTP client. Publishing history is read through its public owner.
 */
export function createMerchantMenuPublicationCommand(options: {
  reviewApproval?: Pick<
    Parameters<typeof createMenuReviewApprovalSource>[0],
    "reference" | "validUntil"
  >;
  reviewCreation?: Pick<
    Parameters<typeof createMenuReviewCreationSource>[0],
    "budget" | "reference"
  >;
  merchant: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  binding(
    transaction: ProductLifecycleTransaction,
    input: {
      tenantReference: string;
      brandReference: string;
      menuReference: string;
      menuVersionReference: string;
    },
  ): Promise<{
    lifecycleReference: string;
    snapshotDigest: string;
    configurationDigest: string;
  } | null>;
  reference(
    purpose: "Audit" | "Lifecycle" | "Release" | "Event" | "Timing",
    operationReference: string,
  ): string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.merchant);
  return async (request: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    const review = decodeReview(request.command);
    const publication = review === null ? decode(request.command) : null;
    return options.merchant.transactions.run(async (identityTransaction) => {
      const transaction: ProductLifecycleTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await identityTransaction.query(sql, values);
          if (!result || typeof result !== "object") return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
          )
            return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };
      const scope = await resolveScope(
        transaction,
        request.sessionCookie,
        session.sessionReference,
      );
      const requestedAction = publication?.action ?? "SubmitReview";
      const action =
        "catalog.menu." +
        (requestedAction === "SubmitReview" ? "submit" : requestedAction.toLowerCase());
      const permission = async () => {
        const decision = await scope.authorizeAction(action);
        return decision?.effect === "Allow" &&
          decision.scopeKind === "Brand" &&
          decision.action === action
          ? decision
          : null;
      };
      const publishingApprovalAllowed = async () => {
        const decision = await scope.authorizeAction("publishing.review.approve");
        return (
          decision?.effect === "Allow" &&
          decision.scopeKind === "Brand" &&
          decision.action === "publishing.review.approve"
        );
      };
      if (
        !(await permission()) ||
        (requestedAction === "Approve" &&
          options.reviewApproval &&
          !(await publishingApprovalAllowed()))
      )
        return fail("CATALOG_PERMISSION_DENIED");
      const brand = parseCatalogReference(scope.context.brand.brandReference);
      const created =
        review === null
          ? null
          : await (async () => {
              if (!options.reviewCreation) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
              return createMenuReviewCreationSource({
                ...options.reviewCreation,
                tenantReference: scope.tenantReference,
                brandReference: brand,
                authorize: async (_tx, input) => {
                  if (
                    input.actorReference !== scope.actorReference ||
                    input.menuReference !== review.menuReference ||
                    !(await permission())
                  )
                    return false;
                  if (input.owner !== "Publishing") return true;
                  for (const required of ["publishing.draft.create", "publishing.review.submit"]) {
                    const decision = await scope.authorizeAction(required);
                    if (
                      decision?.effect !== "Allow" ||
                      decision.scopeKind !== "Brand" ||
                      decision.action !== required
                    )
                      return false;
                  }
                  return true;
                },
              }).create(transaction, {
                ...review,
                actorReference: scope.actorReference,
                observedAt: options.merchant.now(),
              });
            })();
      const decoded: Omit<MenuPublicationCommand, "requestedAt"> =
        publication ??
        (() => {
          if (!review || !created) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          return {
            action: "SubmitReview" as const,
            operationReference: review.operationReference,
            menuReference: review.menuReference,
            menuVersionReference: review.menuVersionReference,
            expectedVersion: 1,
            snapshotDigest: created.record.snapshotDigest,
            effectivePeriod: null,
          };
        })();

      const transactions = {
        run: <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) => work(transaction),
      };
      const loadEvidence = async (
        tx: ProductLifecycleTransaction,
        command: MenuPublicationCommand,
      ) => {
        if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
        if (command.action === "Archive") return { draft: null, validation: null, approval: null };
        const binding =
          created?.record ??
          (await options.binding(tx, {
            tenantReference: scope.tenantReference,
            brandReference: brand,
            menuReference: command.menuReference,
            menuVersionReference: command.menuVersionReference,
          }));
        if (!binding || binding.snapshotDigest !== command.snapshotDigest)
          return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
        const current = await createPostgresMenuDraftSource({
          brandReference: brand,
          transactions,
          authorize: async (_tx, menu) =>
            menu === command.menuReference && (await permission()) !== null,
        }).load(command.menuReference, command.requestedAt);
        if (
          !current ||
          current.aggregate.draft.versionReference !== command.menuVersionReference ||
          current.configurationDigest !== binding.configurationDigest
        )
          return fail("CATALOG_VERSION_CONFLICT");
        const reviewed = await createMenuReviewDependencyBindingSource({
          brandReference: brand,
          budget: { maximumConfigurations: 10000, maximumSearchSteps: 1000000 },
          authorize: async (_tx, input) =>
            input.actorReference === scope.actorReference &&
            input.menuReference === command.menuReference &&
            (await permission()) !== null,
        })
          .resolve(tx, {
            actorReference: scope.actorReference,
            menuReference: command.menuReference,
            menuVersionReference: command.menuVersionReference,
            snapshotDigest: command.snapshotDigest,
            observedAt: command.requestedAt,
            // Only a temporary current validation; no new evidence is persisted here.
            validationEvidenceReference: binding.lifecycleReference,
          })
          .catch(async (error) => {
            if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
            if (error instanceof MenuReviewDependencyChangedError)
              return fail("CATALOG_VERSION_CONFLICT");
            return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          });
        if (
          reviewed.lifecycleReference !== binding.lifecycleReference ||
          reviewed.configurationDigest !== binding.configurationDigest
        )
          return fail("CATALOG_VERSION_CONFLICT");
        if (command.action === "Approve" && options.reviewApproval) {
          await createMenuReviewApprovalSource({
            ...options.reviewApproval,
            tenantReference: scope.tenantReference,
            brandReference: brand,
            authorize: async () => {
              if (!(await permission())) return false;
              return publishingApprovalAllowed();
            },
          }).approve(tx, {
            actorReference: scope.actorReference,
            menuReference: command.menuReference,
            menuVersionReference: command.menuVersionReference,
            lifecycleReference: binding.lifecycleReference,
            snapshotDigest: command.snapshotDigest,
            operationReference: command.operationReference,
            expectedVersion: command.expectedVersion,
            observedAt: command.requestedAt,
          });
        }
        const currentEvidence = await createPostgresMenuPublicationEvidenceSource({
          tenantReference: scope.tenantReference,
          brandReference: brand,
          menuReference: command.menuReference,
          menuVersionReference: command.menuVersionReference,
          lifecycleReference: binding.lifecycleReference,
          snapshotDigest: binding.snapshotDigest,
          authorize: async () => (await permission()) !== null,
        })(tx, command);
        return currentEvidence;
      };
      const evidenceCache = new Map<string, ReturnType<typeof loadEvidence>>();
      const evidence = async (tx: ProductLifecycleTransaction, command: MenuPublicationCommand) => {
        if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
        const key = JSON.stringify(command);
        let pending = evidenceCache.get(key);
        if (!pending) {
          pending = loadEvidence(tx, command);
          evidenceCache.set(key, pending);
        }
        return pending;
      };
      const repository = createPostgresMenuPublicationRepository({
        brandReference: brand,
        menuReference: decoded.menuReference,
        transactions,
        authorize: async (_tx, operation) =>
          (!operation || operation.command.action === decoded.action) &&
          (await permission()) !== null,
        evidence,
        timingReference: (operation) => options.reference("Timing", operation),
      });
      // The persisted command owns its original clock. Retrying later must not
      // turn an identical operation into a new publication or intent conflict.
      const prior = await repository.resolveOperation(decoded.operationReference);
      const command: MenuPublicationCommand = {
        ...decoded,
        requestedAt:
          prior?.command.requestedAt ??
          created?.record.createdAt ??
          parseCatalogInstant(options.merchant.now()),
      };
      const service = createMenuPublicationService({
        repository,
        facts: { loadDraftSnapshot: async () => (await evidence(transaction, command)).draft },
        evidence: {
          validation: async (input) => (await evidence(transaction, input)).validation,
          approval: async (input) => (await evidence(transaction, input)).approval,
        },
        references: {
          generate: (purpose) => options.reference(purpose, command.operationReference),
          hashIntent: (value) => parseCatalogHash(sha256Hex(value)),
          equals: (left, right) => left === right,
        },
        authorization: {
          authorize: async (input) => {
            const decision = await permission();
            if (!decision) return null;
            return {
              tenantContext: scope.context,
              permission: decision,
              audit: {
                auditId: parseCatalogReference(
                  options.reference("Audit", input.operationReference),
                ),
                brandId: brand,
                actor: { type: "User", reference: scope.actorReference },
                actionCode: "CATALOG_MENU_" + input.action.toUpperCase(),
                targetType: "CatalogMenuVersion",
                targetId: input.menuVersionReference,
                correlationId: input.operationReference,
                occurredAt: input.requestedAt,
                reasonCode: "AUTHORIZED_OPERATION",
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              },
            };
          },
        },
      });
      const result = await service.execute(command);
      if (
        !(await permission()) ||
        (requestedAction === "Approve" &&
          options.reviewApproval &&
          !(await publishingApprovalAllowed()))
      )
        return fail("CATALOG_PERMISSION_DENIED");
      return {
        status: result.status,
        menuReference: command.menuReference,
        menuVersionReference: command.menuVersionReference,
        lifecycleVersion: result.record.lifecycle.version,
        state: result.record.lifecycle.state,
        snapshotDigest: command.snapshotDigest,
        releaseReference: result.record.release?.releaseId ?? null,
      };
    });
  };
}
