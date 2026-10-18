import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingDigest,
  parsePublishingReference,
  type PublishingScope,
} from "@bop/publishing";
import type { MenuPublicationCommand } from "../../contracts/menu-publication.js";
import { CatalogError, parseCatalogInstant } from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

/** Explicit server-owned binding to Publishing history, never request-supplied evidence.
 * Retain the caller transaction through the Catalog commit so the owner read fence
 * prevents approval changes between the evidence read and publication.
 */
export function createPostgresMenuPublicationEvidenceSource(options: {
  tenantReference: string;
  brandReference: string;
  menuReference: string;
  menuVersionReference: string;
  lifecycleReference: string;
  snapshotDigest: string;
  authorize(
    transaction: ProductLifecycleTransaction,
    command: MenuPublicationCommand,
  ): Promise<boolean>;
}) {
  const tenant = parsePublishingReference(options.tenantReference);
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: parsePublishingReference(
      options.brandReference,
    ) as unknown as PublishingScope["brandReference"],
    storeReference: null,
  });
  const menu = parsePublishingReference(options.menuReference);
  const version = parsePublishingReference(options.menuVersionReference);
  const lifecycle = parsePublishingReference(options.lifecycleReference);
  const digest = parsePublishingDigest(options.snapshotDigest);
  return async (transaction: ProductLifecycleTransaction, command: MenuPublicationCommand) => {
    try {
      const authorize = async () => {
        if ((await options.authorize(transaction, command)) !== true)
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      };
      await authorize();
      const unavailable = (): never => {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      };
      if (
        String(command.menuReference) !== menu ||
        String(command.menuVersionReference) !== version ||
        command.snapshotDigest !== digest
      )
        return unavailable();
      const observedAt = parseCatalogInstant(command.requestedAt);
      const input = {
        familyReference: menu,
        lifecycleReference: lifecycle,
        configurationType: "MENU",
        purposeCode: "CUSTOMER_ORDERING",
        observedAt,
      };
      const owner = createPostgresPublishingMutationStore(
        { run: (work) => work(transaction) },
        tenant,
        scope,
      );
      if (command.action === "Archive") {
        await authorize();
        return { draft: null, validation: null, approval: null };
      }
      if (command.action === "SubmitReview") {
        const head = await owner.resolveCurrentLifecycleMutation(input);
        if (
          !head ||
          head.operation !== "SubmitReview" ||
          head.next.state !== "InReview" ||
          head.next.version !== 2 ||
          head.next.snapshotReference !== version ||
          head.next.snapshotDigest !== digest ||
          head.current?.state !== "Draft" ||
          head.current.version !== 1 ||
          head.current.lifecycleId !== lifecycle ||
          head.current.snapshotReference !== version ||
          head.current.snapshotDigest !== digest ||
          head.validationEvidence === null
        )
          return unavailable();
        const validation = head.validationEvidence;
        if (
          validation.evidenceReference !== head.next.validationEvidenceReference ||
          validation.snapshotReference !== version ||
          validation.snapshotDigest !== digest ||
          validation.scope.kind !== "Brand" ||
          validation.scope.brandReference !== scope.brandReference ||
          validation.scope.storeReference !== null ||
          String(validation.checkedAt) > observedAt ||
          String(validation.validUntil) <= observedAt
        )
          return unavailable();
        await authorize();
        return { draft: head.current, validation, approval: null };
      }
      if (command.action !== "Approve" && command.action !== "Publish") return unavailable();
      const candidate = await owner.resolvePublicationCandidate(input);
      if (
        candidate.lifecycle.snapshotReference !== version ||
        candidate.lifecycle.snapshotDigest !== digest ||
        candidate.lifecycle.version !== 3
      )
        return unavailable();
      await authorize();
      return {
        draft: null,
        validation: candidate.validationEvidence,
        approval: candidate.approvalEvidence,
      };
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    }
  };
}
