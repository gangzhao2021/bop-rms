import type {
  PrivacyInstant,
  PrivacyReference,
  PrivacyRequest,
  PrivacyRight,
} from "../domain/privacy-request.js";
export interface PrivacyRequestQuery {
  readonly tenantReference: PrivacyReference;
  readonly brandReference: PrivacyReference;
  readonly actorReference: PrivacyReference;
  readonly purpose: "PrivacyRightsAdministration";
  readonly permission: "privacy.request.read";
  readonly requestReference: PrivacyReference | null;
  readonly verifiedContactReference: PrivacyReference | null;
  readonly right: PrivacyRight | "All";
  readonly status: PrivacyRequest["status"] | "All";
  readonly ownerReference: PrivacyReference | null;
  readonly due: "All" | "Due" | "Overdue";
}
export interface PrivacyRequestProjection {
  readonly projectionName: "privacy_request_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: PrivacyReference;
  readonly brandReference: PrivacyReference;
  readonly asOfUtc: PrivacyInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayIntake: boolean;
    readonly mayVerify: boolean;
    readonly mayFulfill: boolean;
    readonly mayViewVerification: boolean;
  };
  readonly rows: readonly (Omit<PrivacyRequest, "verificationReference"> & {
    readonly verificationReference: PrivacyReference | null;
  })[];
}
export interface PrivacyCommand {
  readonly tenantReference: PrivacyReference;
  readonly brandReference: PrivacyReference;
  readonly requestReference: PrivacyReference;
  readonly actorReference: PrivacyReference;
  readonly purpose: "PrivacyRightsAdministration";
  readonly permission: "privacy.request.manage";
  readonly operationReference: PrivacyReference;
  readonly expectedVersion: number;
  readonly occurredAt: PrivacyInstant;
  readonly action:
    "Transition" | "AddOwnerWork" | "CompleteOwnerWork" | "AttachHold" | "AttachExport";
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface PrivacyCommandRecord {
  readonly operationReference: PrivacyReference;
  readonly intentHash: string;
  readonly command: PrivacyCommand;
  readonly before: PrivacyRequest;
  readonly after: PrivacyRequest;
  readonly auditReference: PrivacyReference;
  readonly outcome: "Applied" | "AlreadyApplied";
}
