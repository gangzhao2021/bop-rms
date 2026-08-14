import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { PricingDigest, PricingReference } from "../../domain/money-tax-contract.js";
import type {
  TaxConfigurationSnapshot,
  TaxResolutionContext,
} from "../../domain/tax-configuration.js";

export type TaxConfigAction = "CreateDraft" | "ReplaceDraft" | "Publish";

export interface TaxConfigEvent {
  readonly eventType: "TaxConfigDraftCreated" | "TaxConfigDraftReplaced" | "TaxConfigPublished";
  readonly configurationReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly aggregateVersion: number;
  readonly lifecycle: TaxConfigurationSnapshot["lifecycle"];
  readonly jurisdictionCode: string;
  readonly snapshotDigest: PricingDigest;
  readonly occurredAt: string;
}

export interface TaxConfigOperationRecord {
  readonly action: TaxConfigAction;
  readonly operationReference: PricingReference;
  readonly operationIntentHash: PricingDigest;
  readonly aggregate: TaxConfigurationSnapshot;
  readonly event: TaxConfigEvent;
}

export interface TaxConfigAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly approvalPermission: PermissionDecision | null;
  readonly draftAuthorActorReference: string | null;
  readonly audit: AppendAuditRecordInput;
}

export interface TaxConfigPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: TaxConfigAction;
      readonly operationReference: PricingReference;
      readonly configurationReference: PricingReference;
      readonly observedAt: string;
    }): Promise<TaxConfigAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: PricingDigest, right: PricingDigest): boolean;
  };
  readonly facts: {
    validate(snapshot: TaxConfigurationSnapshot): Promise<boolean>;
    validateApprovedFixtures(snapshot: TaxConfigurationSnapshot): Promise<boolean>;
    requiredCoverage(
      snapshot: TaxConfigurationSnapshot,
    ): Promise<
      readonly Pick<
        TaxResolutionContext,
        "taxClassificationReference" | "orderType" | "chargeType"
      >[]
    >;
  };
  readonly repository: {
    resolveOperation(reference: PricingReference): Promise<TaxConfigOperationRecord | null>;
    load(reference: PricingReference): Promise<TaxConfigurationSnapshot | null>;
    create(input: {
      readonly record: TaxConfigOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<TaxConfigOperationRecord>;
    commit(input: {
      readonly record: TaxConfigOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<TaxConfigOperationRecord>;
  };
}
