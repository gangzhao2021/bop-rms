import { canonicalizeRfc8785, type AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBrandReference } from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  createPublishingLifecycleRecord,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingCode,
  parsePublishingVersion,
  parsePublishingInstant,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import {
  CatalogError,
  createPostgresMenuReviewContentStore,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  createMenuReviewPreparationSource,
  type MenuReviewPreparationInput,
} from "./menu-review-preparation-source.js";

export type MenuReviewCreationReferencePurpose =
  "Lifecycle" | "Validation" | "ReviewOperation" | "ContentAudit" | "DraftAudit" | "ReviewAudit";
export interface MenuReviewCreationInput {
  actorReference: string;
  menuReference: string;
  menuVersionReference: string;
  configurationDigest: string;
  registryVersionReference: string;
  operationReference: string;
  observedAt: string;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** Creates review submission evidence, not approval or the Catalog transition.
 * Caller retains tx through the related Catalog action. References must be stable
 * for the same operation on every retry and distinct across purposes/operations.
 */
export function createMenuReviewCreationSource(options: {
  tenantReference: string;
  brandReference: string;
  budget: MenuReviewPreparationInput["budget"];
  reference(purpose: MenuReviewCreationReferencePurpose, operationReference: string): string;
  authorize(
    tx: ProductLifecycleTransaction,
    input: {
      actorReference: string;
      menuReference: string;
      storeReference: string | null;
      owner: "Catalog" | "Recipe" | "Publishing";
    },
  ): Promise<boolean>;
}) {
  const tenant = parsePublishingReference(options.tenantReference);
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: parseBrandReference(options.brandReference),
    storeReference: null,
  });
  return Object.freeze({
    async create(tx: ProductLifecycleTransaction, input: MenuReviewCreationInput) {
      try {
        const raw = readClosedRecord(input, [
          "actorReference",
          "menuReference",
          "menuVersionReference",
          "configurationDigest",
          "registryVersionReference",
          "operationReference",
          "observedAt",
        ]);
        const actor = parsePublishingReference(raw.actorReference);
        const menu = parsePublishingReference(raw.menuReference);
        const version = parsePublishingReference(raw.menuVersionReference);
        const configurationDigest = parsePublishingDigest(raw.configurationDigest);
        const registry = parsePublishingReference(raw.registryVersionReference);
        const operation = parsePublishingReference(raw.operationReference);
        const at = parsePublishingInstant(raw.observedAt);
        const reference = (purpose: MenuReviewCreationReferencePurpose) =>
          parsePublishingReference(options.reference(purpose, operation));
        const lifecycle = reference("Lifecycle"),
          validation = reference("Validation"),
          reviewOperation = reference("ReviewOperation"),
          contentAudit = reference("ContentAudit"),
          draftAudit = reference("DraftAudit"),
          reviewAudit = reference("ReviewAudit");
        if (
          new Set([
            operation,
            lifecycle,
            validation,
            reviewOperation,
            contentAudit,
            draftAudit,
            reviewAudit,
          ]).size !== 7
        )
          return fail("CATALOG_INPUT_INVALID");
        const allowed = async () => {
          if (
            !(await options.authorize(tx, {
              actorReference: actor,
              menuReference: menu,
              storeReference: null,
              owner: "Publishing",
            }))
          )
            return fail("CATALOG_PERMISSION_DENIED");
        };
        await allowed();
        const publishing = createPostgresPublishingMutationStore(
          { run: (work) => work(tx) },
          tenant,
          scope,
        );
        const recovery = {
          operationReference: operation,
          familyReference: menu,
          lifecycleReference: lifecycle,
          configurationType: "MENU",
          purposeCode: "CUSTOMER_ORDERING",
          observedAt: at,
        };
        const original = await publishing.resolveOperation(recovery);
        const content = createPostgresMenuReviewContentStore({
          brandReference: options.brandReference,
          menuReference: menu,
          authorize: async () =>
            options.authorize(tx, {
              actorReference: actor,
              menuReference: menu,
              storeReference: null,
              owner: "Catalog",
            }),
        });
        if (original) {
          const submitted = await publishing.resolveOperation({
            ...recovery,
            operationReference: reviewOperation,
          });
          const record = await content.read(tx, version, original.next.snapshotDigest, at);
          if (
            !record ||
            !submitted ||
            original.operation !== "CreateDraft" ||
            submitted.operation !== "SubmitReview" ||
            !equal(submitted.current, original.next) ||
            original.audit.actor.type !== "User" ||
            original.audit.actor.reference !== actor ||
            submitted.audit.actor.type !== "User" ||
            submitted.audit.actor.reference !== actor ||
            record.createdByActorReference !== String(actor) ||
            record.lifecycleReference !== String(lifecycle) ||
            record.configurationDigest !== configurationDigest ||
            record.dependencyDigest === undefined ||
            submitted.validationEvidence?.evidenceReference !== validation ||
            submitted.validationEvidence.snapshotDigest !== record.snapshotDigest ||
            record.content.sections.some((section) =>
              section.sellables.some(
                (sellable) =>
                  sellable.allergenDisclosure.registryVersionReference !== String(registry),
              ),
            )
          )
            return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          await allowed();
          return Object.freeze({ status: "AlreadyCreated" as const, record });
        }
        const prepared = await createMenuReviewPreparationSource(options).prepare(tx, {
          actorReference: actor,
          menuReference: menu,
          lifecycleReference: lifecycle,
          validationEvidenceReference: validation,
          registryVersionReference: registry,
          observedAt: at,
          budget: options.budget,
        });
        if (
          prepared.record.content.menuVersionReference !== String(version) ||
          prepared.record.configurationDigest !== configurationDigest
        )
          return fail("CATALOG_VERSION_CONFLICT");
        const draft = createPublishingLifecycleRecord({
          lifecycleId: lifecycle,
          familyReference: menu,
          configurationType: parsePublishingCode("MENU"),
          purposeCode: parsePublishingCode("CUSTOMER_ORDERING"),
          snapshotReference: version,
          snapshotDigest: prepared.record.snapshotDigest,
          scope,
          version: parsePublishingVersion(1),
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: at,
          changedAt: at,
        });
        const inReview = createPublishingLifecycleRecord({
          ...draft,
          version: parsePublishingVersion(2),
          state: "InReview",
          validationEvidenceReference: validation,
        });
        const audit = (
          auditId: string,
          actionCode: string,
          targetType: string,
          targetId: string,
          dataClassification: "Internal" | "Confidential",
          retentionPolicyCode: string,
        ): AppendAuditRecordInput => ({
          auditId,
          brandId: options.brandReference,
          actor: { type: "User", reference: actor },
          actionCode,
          targetType,
          targetId,
          correlationId: operation,
          occurredAt: at,
          reasonCode: "AUTHORIZED_OPERATION",
          sourceChannel: "MERCHANT_WEB",
          dataClassification,
          retentionPolicyCode,
          retentionPolicyVersion: 1,
        });
        const base = {
          expectedVersion: parsePublishingVersion(1),
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          validationEvidence: null,
          approvalEvidence: null,
        };
        const mutations: readonly CommitPublishingMutationInput[] = [
          {
            ...base,
            operation: "CreateDraft",
            current: null,
            next: draft,
            idempotencyKey: operation,
            audit: audit(
              draftAudit,
              "PUBLISHING_DRAFT_CREATED",
              "PublishingLifecycle",
              lifecycle,
              "Confidential",
              "PUBLISHING_LIFECYCLE_AUDIT",
            ),
          },
          {
            ...base,
            operation: "SubmitReview",
            current: draft,
            next: inReview,
            idempotencyKey: reviewOperation,
            validationEvidence: prepared.validation,
            audit: audit(
              reviewAudit,
              "PUBLISHING_REVIEW_SUBMITTED",
              "PublishingLifecycle",
              lifecycle,
              "Confidential",
              "PUBLISHING_LIFECYCLE_AUDIT",
            ),
          },
        ];
        await allowed();
        await tx.query("SAVEPOINT api_menu_review_creation", []);
        try {
          await content.save(
            tx,
            prepared.record,
            audit(
              contentAudit,
              "CATALOG_MENU_SNAPSHOT_CREATED",
              "CatalogMenuVersion",
              version,
              "Internal",
              "CONFIGURATION_AUDIT",
            ),
          );
          for (const mutation of mutations) {
            await allowed();
            await publishing.commit(mutation);
          }
          await allowed();
          await tx.query("RELEASE SAVEPOINT api_menu_review_creation", []);
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT api_menu_review_creation", []);
          await tx.query("RELEASE SAVEPOINT api_menu_review_creation", []);
          throw error;
        }
        return Object.freeze({ status: "Created" as const, record: prepared.record });
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
