import { parseSelectorHash } from "./browser-session.js";
import type { WorkforceInvitation } from "./workforce-identity-security.js";
import {
  parseWorkforceOnboardingConfiguration,
  workforceOnboardingClosed,
  workforceOnboardingDigest,
  workforceOnboardingReference,
  type WorkforceOnboardingConfiguration,
  type WorkforceOnboardingOperation,
} from "./workforce-onboarding-operation.js";

/** This capability-bearing binding is persisted only inside the owning
 * encrypted OIDC payload. It must never be a browser response or URL. */
export interface WorkforceOnboardingInvitationBinding {
  readonly configuration: WorkforceOnboardingConfiguration;
  readonly invitationReference: string;
  readonly originalIntentDigest: string;
  readonly selectorHash: string;
}
export function parseWorkforceOnboardingInvitationBinding(
  value: unknown,
): WorkforceOnboardingInvitationBinding {
  const r = workforceOnboardingClosed(value, [
    "configuration",
    "invitationReference",
    "originalIntentDigest",
    "selectorHash",
  ]);
  return Object.freeze({
    configuration: parseWorkforceOnboardingConfiguration(r.configuration),
    invitationReference: workforceOnboardingReference(r.invitationReference),
    originalIntentDigest: workforceOnboardingDigest(r.originalIntentDigest),
    selectorHash: parseSelectorHash(r.selectorHash),
  });
}
export interface WorkforceOnboardingInvitationAuthorization {
  readonly authorizationTransactionReference: string;
  readonly binding: WorkforceOnboardingInvitationBinding;
  readonly consumedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
/** Server-only historical original facts, not proof of current Provider state,
 * MFA, Membership or roles and not a browser DTO. */
export interface WorkforceOnboardingInvitationEvidence {
  readonly profile: "WorkforceOnboardingInvitationEvidenceV1";
  readonly binding: WorkforceOnboardingInvitationBinding;
  readonly record: WorkforceOnboardingOperation;
  readonly invitation: WorkforceInvitation;
  readonly observedAt: string;
  readonly validUntil: string;
}
