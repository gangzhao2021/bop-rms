import type { IdentityActor } from "../../contracts/identity-actor.js";
import type {
  CurrentWorkforceAccountSourceOptions,
  CurrentWorkforceAccountTransaction,
} from "./current-workforce-account-source.js";
import { createWorkforceAccountReadKernel } from "./workforce-account-read-kernel.js";

export type WorkforceAuthenticationSourceOptions = Omit<
  CurrentWorkforceAccountSourceOptions,
  "actorReference" | "authority"
>;
export interface WorkforceVerifiedSubject {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly authenticatedAt: string;
  readonly observedAt: string;
}
export interface WorkforceAuthenticationSource {
  /** Only the actual OIDC verifier supplies these signed claims. This method
   * maps an existing identity; it does not itself verify tokens or grant MFA. */
  resolveVerifiedSubject(input: WorkforceVerifiedSubject): Promise<IdentityActor>;
  /** Authentication time must come from the owning stored Session, never from
   * request input, Provider account creation or invitation consumption. */
  currentActor(
    actualTx: CurrentWorkforceAccountTransaction,
    actorReference: string,
    authenticatedAt: string,
    observedAt: string,
  ): Promise<IdentityActor>;
  assertFinalized(): void;
}
/** Fixed Workforce authentication entry point on the same immutable account
 * binding. No mutable directory, alternate purpose or Provider verdict port. */
export function createPostgresWorkforceAuthenticationSource(
  options: WorkforceAuthenticationSourceOptions,
): WorkforceAuthenticationSource {
  const reader = createWorkforceAccountReadKernel({ kind: "Authentication", options });
  return Object.freeze({
    resolveVerifiedSubject: reader.resolveVerifiedSubject,
    currentActor: reader.currentActor,
    assertFinalized: reader.assertFinalized,
  });
}
