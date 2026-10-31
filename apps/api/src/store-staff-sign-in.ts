import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  acceptStoreStaffInvitation,
  BrowserSessionError,
  createIdentityActor,
  createPostgresWorkforceReauthenticationStepUpStore,
  findStoreStaffAccount,
  hasStoreStaffAccount,
  parseCanonicalInstant,
  storeStaffActorFromProviderUsername,
  storeStaffSubjectHash,
  type BrowserCredentialHasherPort,
  type CognitoStoreVerifiedSubject,
  type IdentityActor,
  type StoreStaffPool,
  type StoreStaffTransaction,
} from "@bop/identity";
import { activateInvitedStoreMember, type MemberDirectoryTransaction } from "@bop/membership";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: who a verified Cognito sign-in is. An account already bound in
 * this pool names its person. Otherwise the signed username names an invited person, and the
 * first sign-in is accepted only when Cognito still holds that invitation's account (same
 * invitation intent and email, enabled, password set) for exactly this subject: the account is
 * bound, the authenticator recorded as set up and the waiting Membership activated, together.
 * A sign-in grants nothing by itself; Store access still needs an approved role.
 */
export interface StoreStaffInvitationInspector {
  inspect(input: {
    readonly actorReference: string;
    readonly creationIntentDigest: string;
    readonly emailDigest: string;
    readonly creationStartedAt: string;
    readonly expectedSubject: null;
    readonly expectedCreatedAt: null;
  }): Promise<{
    readonly status: string;
    readonly provider: {
      readonly subject: string;
      readonly status: string;
      readonly enabled: boolean;
    } | null;
  }>;
}
interface Transactions {
  run<T>(work: (tx: StoreStaffTransaction) => Promise<T>): Promise<T>;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
/** Cognito's account creation time may run slightly behind this server's clock. */
const providerClockToleranceMilliseconds = 5 * 60 * 1000;

export function createStoreStaffSignIn(options: {
  readonly transactions: Transactions;
  readonly pool: StoreStaffPool;
  readonly hasher: BrowserCredentialHasherPort;
  readonly now: () => string;
  readonly nextReference: () => string;
  readonly inspector: StoreStaffInvitationInspector;
}) {
  const pool = options.pool;
  const actor = (actorReference: string, authenticatedAt: string): IdentityActor =>
    createIdentityActor({
      actorType: "User",
      actorReference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt,
      recentMfaAt: null,
    });
  const subjectHash = (subject: string) =>
    storeStaffSubjectHash(options.hasher, {
      environment: pool.environment,
      issuer: pool.issuer,
      subject,
    });
  const samePool = (verified: CognitoStoreVerifiedSubject) =>
    verified.issuer === pool.issuer && verified.clientId === pool.clientId;

  /** The person behind a verified sign-in, accepting their invitation on the first one. */
  async function resolveSubject(verified: CognitoStoreVerifiedSubject): Promise<IdentityActor> {
    try {
      if (!samePool(verified)) return denied();
      const hash = subjectHash(verified.subject);
      const authenticatedAt = parseCanonicalInstant(verified.authenticatedAt);
      const actorReference = await options.transactions.run(async (tx) => {
        const bound = await findStoreStaffAccount(tx, { pool, subjectHash: hash });
        if (bound !== null) return bound;
        const invited = storeStaffActorFromProviderUsername(verified.username);
        if (invited === null) return denied();
        const at = parseCanonicalInstant(options.now());
        const accepted = await acceptStoreStaffInvitation(tx, {
          pool,
          actorReference: invited,
          subjectHash: hash,
          authenticatedAt,
          at,
          auditReference: options.nextReference(),
          mfaEvidenceReference: options.nextReference(),
          confirm: async (invitation) => {
            const seen = await options.inspector.inspect({
              actorReference: invited,
              creationIntentDigest: invitation.intentDigest,
              emailDigest: invitation.emailDigest,
              creationStartedAt: new Date(
                Date.parse(invitation.createdAt) - providerClockToleranceMilliseconds,
              ).toISOString(),
              expectedSubject: null,
              expectedCreatedAt: null,
            });
            return (
              seen.status === "Found" &&
              seen.provider !== null &&
              seen.provider.subject === verified.subject &&
              seen.provider.enabled === true &&
              seen.provider.status === "CONFIRMED"
            );
          },
        });
        await activateInvitedStoreMember(
          tx as unknown as MemberDirectoryTransaction,
          {
            brandReference: accepted.brandReference,
            storeReference: accepted.storeReference,
            actorReference: invited,
            membershipReference: accepted.membershipReference,
            invitationReference: accepted.invitationReference,
            at,
            auditReference: options.nextReference(),
          },
          (transaction, record) =>
            appendAuditRecordInTransaction(
              transaction as Parameters<typeof appendAuditRecordInTransaction>[0],
              record as unknown as Parameters<typeof appendAuditRecordInTransaction>[1],
            ),
        );
        return invited;
      });
      return actor(actorReference, authenticatedAt);
    } catch {
      return denied();
    }
  }

  /** A bound account only (a step-up never accepts an invitation). */
  async function boundActor(verified: CognitoStoreVerifiedSubject): Promise<string> {
    try {
      if (!samePool(verified)) return denied();
      const hash = subjectHash(verified.subject);
      const found = await options.transactions.run((tx) =>
        findStoreStaffAccount(tx, { pool, subjectHash: hash }),
      );
      return found ?? denied();
    } catch {
      return denied();
    }
  }

  /** The stored session's person still has their Cognito account bound in this pool. */
  async function currentActor(
    tx: unknown,
    actorReference: string,
    authenticatedAt: string,
    observedAt: string,
  ): Promise<IdentityActor> {
    const at = parseCanonicalInstant(observedAt),
      authenticated = parseCanonicalInstant(authenticatedAt);
    if (authenticated > at) return denied();
    const bound = await hasStoreStaffAccount(tx as StoreStaffTransaction, {
      pool,
      actorReference,
    });
    if (!bound) return denied();
    return actor(actorReference, authenticated);
  }

  /**
   * A full Cognito sign-in already proved the authenticator: recorded for the new session as a
   * verified step-up, so a refund or approval right after signing in needs no second prompt.
   */
  async function recordSignInVerification(
    tx: unknown,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly sessionReference: string;
      readonly authenticatedAt: string;
    },
  ): Promise<boolean> {
    const record = createPostgresWorkforceReauthenticationStepUpStore({
      authorize: async (_tx, query) =>
        query.actorReference === input.actorReference &&
        query.sessionReference === input.sessionReference &&
        query.brandReference === input.brandReference &&
        query.storeReference === input.storeReference,
      retentionPolicyCode: "SECURITY_AUDIT",
      retentionPolicyVersion: 1,
    });
    // Best effort: a sign-in this step-up cannot record (two sign-ins in the same second, or an
    // authentication past the freshness window) still signs in; staff verify when an action asks.
    const store = tx as StoreStaffTransaction;
    await store.query("SAVEPOINT store_staff_sign_in_step_up", []);
    try {
      await record(store, {
        ...input,
        stepUpReference: options.nextReference(),
        auditReference: options.nextReference(),
        purposeCode: "IDENTITY_SIGN_IN",
      });
      await store.query("RELEASE SAVEPOINT store_staff_sign_in_step_up", []);
      return true;
    } catch {
      await store.query("ROLLBACK TO SAVEPOINT store_staff_sign_in_step_up", []);
      await store.query("RELEASE SAVEPOINT store_staff_sign_in_step_up", []);
      return false;
    }
  }

  return Object.freeze({ resolveSubject, boundActor, currentActor, recordSignInVerification });
}
