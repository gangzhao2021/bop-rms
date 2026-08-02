import type { EffectivePeriod } from "@bop/effective-period";
import type {
  PublishingApprovalEvidence,
  PublishingLifecycleRecord,
  PublishingReleaseRecord,
  PublishingValidationEvidence,
} from "@bop/publishing";

import type { CatalogHash, CatalogInstant, CatalogReference } from "./product.js";

export type MenuPublicationAction = "SubmitReview" | "Approve" | "Publish" | "Archive";

export interface MenuPublicationRecord {
  readonly lifecycle: PublishingLifecycleRecord;
  readonly effectivePeriod: EffectivePeriod | null;
  readonly release: PublishingReleaseRecord | null;
}

export interface MenuPublicationCommand {
  readonly action: MenuPublicationAction;
  readonly operationReference: CatalogReference;
  readonly menuReference: CatalogReference;
  readonly menuVersionReference: CatalogReference;
  readonly expectedVersion: number;
  readonly snapshotDigest: CatalogHash;
  readonly requestedAt: CatalogInstant;
  readonly effectivePeriod: EffectivePeriod | null;
}

export interface MenuPublicationEvidence {
  readonly validation: PublishingValidationEvidence | null;
  readonly approval: PublishingApprovalEvidence | null;
}
