import type {
  AuthorizationTransaction,
  BrowserSessionRecord,
  RawBrowserCredential,
} from "../../contracts/browser-session.js";
import type { WorkforceOnboardingInvitationBinding } from "../../contracts/workforce-onboarding-invitation.js";
import type {
  WorkforceOidcProviderPort,
  WorkforceTotpVerification,
} from "../../contracts/workforce-browser-session.js";
import type { CreateBrowserSessionCommand } from "./browser-session-store-port.js";

/** Fixed invitation entry composition. A consumed OIDC transaction is an
 * immutable authentication receipt, not business authorization. The concrete
 * owner must requalify the invitation, approval, relationship and roles and
 * commit invitation acceptance, binding, activation and Session together. */
export interface WorkforceOnboardingBrowserPort {
  resolveInvitation(input: {
    readonly secret: RawBrowserCredential;
    readonly observedAt: string;
    readonly validUntil: string;
  }): Promise<{
    readonly binding: WorkforceOnboardingInvitationBinding;
    readonly observedAt: string;
    readonly validUntil: string;
  }>;
  exchangeCode(input: {
    readonly request: Parameters<WorkforceOidcProviderPort["exchangeCode"]>[0];
    readonly authorization: AuthorizationTransaction;
    readonly binding: WorkforceOnboardingInvitationBinding;
  }): Promise<
    Awaited<ReturnType<WorkforceOidcProviderPort["exchangeCode"]>> & {
      readonly observedAt: string;
      readonly validUntil: string;
    }
  >;
  complete(input: {
    readonly command: CreateBrowserSessionCommand;
    readonly authorization: AuthorizationTransaction;
    readonly binding: WorkforceOnboardingInvitationBinding;
    readonly totp: WorkforceTotpVerification;
    readonly providerObservedAt: string;
    readonly providerValidUntil: string;
  }): Promise<BrowserSessionRecord>;
}
