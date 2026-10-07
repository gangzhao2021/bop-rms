import { Buffer } from "node:buffer";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  BrowserSessionError,
  parseRawBrowserCredential,
  parseSelectorHash,
} from "../contracts/browser-session.js";
import {
  createIdentityActor,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "../contracts/identity-actor.js";
import { createWorkforceInvitation } from "../contracts/workforce-identity-security.js";
import {
  parseWorkforceOnboardingInvitationBinding,
  type WorkforceOnboardingInvitationEvidence,
} from "../contracts/workforce-onboarding-invitation.js";
import {
  parseWorkforceOnboardingConfiguration,
  parseWorkforceOnboardingOperation,
  workforceOnboardingSubjectContext,
} from "../contracts/workforce-onboarding-operation.js";
import { parseWorkforceAccountBindingSubject } from "../contracts/workforce-account-binding.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import type {
  WorkforceOidcProviderPort,
  WorkforceTotpVerification,
} from "../contracts/workforce-browser-session.js";
import {
  createCognitoProviderProtocol,
  type CognitoProviderConfiguration,
} from "./cognito-provider-protocol.js";
import { createCognitoSubjectStatus } from "./cognito-subject-status.js";
import { createCognitoWorkforceInvitation } from "./cognito-workforce-invitation.js";

export interface CognitoWorkforceOnboardingAuthenticationOptions {
  readonly configuration: CognitoProviderConfiguration & { readonly environment: string };
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly hasher: BrowserCredentialHasherPort;
  readonly clock: { now(): string };
  readonly nextEvidenceReference: () => string;
  readonly http?: typeof globalThis.fetch;
}
export interface CognitoWorkforceOnboardingAuthenticationProof {
  readonly actor: ReturnType<typeof createIdentityActor>;
  readonly tokenBundle: string;
  readonly totp: WorkforceTotpVerification;
  /** Transient server-only subject, never a browser response or durable plan. */
  readonly subject: string;
  readonly observedAt: string;
  readonly validUntil: string;
  assertCurrent(): Promise<void>;
  /** Final synchronous pre-COMMIT seal after an explicit asynchronous reread.
   * This checks the original clock/ports and must not run after COMMIT. */
  assertFinalized(): void;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const codec = Object.freeze({ canonicalize: canonicalizeRfc8785, hash: sha256Hex });
const configurationKeys = [
  "environment",
  "issuer",
  "clientId",
  "clientSecret",
  "managedLoginOrigin",
  "redirectUri",
  "logoutReturnUri",
];
function evidence(value: unknown): WorkforceOnboardingInvitationEvidence {
  const r = readClosedRecord(value, [
      "profile",
      "binding",
      "record",
      "invitation",
      "observedAt",
      "validUntil",
    ]),
    binding = parseWorkforceOnboardingInvitationBinding(r.binding),
    record = parseWorkforceOnboardingOperation(r.record, codec),
    invitation = createWorkforceInvitation(r.invitation),
    observedAt = parseCanonicalInstant(r.observedAt),
    validUntil = parseCanonicalInstant(r.validUntil);
  if (
    r.profile !== "WorkforceOnboardingInvitationEvidenceV1" ||
    record.state !== "ProviderObserved" ||
    record.provider === null ||
    invitation.status !== "Pending" ||
    invitation.version !== 1 ||
    invitation.consumedAt !== null ||
    invitation.providerEvidenceReference !== null ||
    record.createdAt > observedAt ||
    record.occurredAt > observedAt ||
    record.expiresAt <= observedAt ||
    validUntil <= observedAt ||
    Date.parse(validUntil) > Date.parse(observedAt) + 5000 ||
    validUntil > record.expiresAt ||
    binding.invitationReference !== record.invitationReference ||
    binding.originalIntentDigest !== record.intentDigest ||
    binding.selectorHash !== record.selectorHash ||
    canonicalizeRfc8785(binding.configuration) !==
      canonicalizeRfc8785(record.original.configuration) ||
    invitation.invitationReference !== record.invitationReference ||
    invitation.actorReference !== record.original.actorReference ||
    invitation.inviterActorReference !== record.original.operatorReference ||
    invitation.membershipReference !== record.original.membershipReference ||
    invitation.selectorHash !== record.selectorHash ||
    invitation.emailDigest !== record.original.emailDigest ||
    invitation.createdAt !== record.createdAt ||
    invitation.expiresAt !== record.expiresAt ||
    canonicalizeRfc8785(invitation.storeAssignmentReferences) !==
      canonicalizeRfc8785(record.original.storeAssignmentReferences)
  )
    return denied();
  return Object.freeze({
    profile: "WorkforceOnboardingInvitationEvidenceV1",
    binding,
    record,
    invitation,
    observedAt,
    validUntil,
  });
}
/** Invitation-only identity producer. The real signed protocol, exact original
 * Provider subject/email and current local account are mandatory; there is no
 * existing-binding resolver or guessed Actor fallback. */
export function createCognitoWorkforceOnboardingAuthentication(
  options: CognitoWorkforceOnboardingAuthenticationOptions,
) {
  try {
    readClosedRecord(options, [
      "configuration",
      "envelopes",
      "hasher",
      "clock",
      "nextEvidenceReference",
      ...(Object.hasOwn(options, "http") ? ["http"] : []),
    ]);
    const configurationPort = options.configuration,
      configuration = readClosedRecord(configurationPort, configurationKeys),
      scope = parseWorkforceOnboardingConfiguration({
        environment: configuration.environment,
        issuer: configuration.issuer,
        clientId: configuration.clientId,
      }),
      envelopes = options.envelopes,
      decrypt = envelopes.decrypt,
      encrypt = envelopes.encrypt,
      hasher = options.hasher,
      hash = hasher.hash,
      equals = hasher.equals,
      clock = options.clock,
      now = clock.now,
      next = options.nextEvidenceReference,
      http = options.http;
    readClosedRecord(clock, ["now"]);
    if ([decrypt, encrypt, hash, equals, now, next].some((p) => typeof p !== "function"))
      return denied();
    const protocol = createCognitoProviderProtocol({
      configuration: {
        issuer: scope.issuer,
        clientId: scope.clientId,
        clientSecret: options.configuration.clientSecret,
        managedLoginOrigin: options.configuration.managedLoginOrigin,
        redirectUri: options.configuration.redirectUri,
        logoutReturnUri: options.configuration.logoutReturnUri,
      },
      clock,
      accountKind: "Workforce",
      ...(http === undefined ? {} : { http }),
    });
    const pool = new URL(scope.issuer).pathname.slice(1);
    const observe = () => {
      if (
        options.configuration !== configurationPort ||
        canonicalizeRfc8785(readClosedRecord(configurationPort, configurationKeys)) !==
          canonicalizeRfc8785(configuration) ||
        options.envelopes !== envelopes ||
        envelopes.decrypt !== decrypt ||
        envelopes.encrypt !== encrypt ||
        options.hasher !== hasher ||
        hasher.hash !== hash ||
        hasher.equals !== equals ||
        options.clock !== clock ||
        clock.now !== now ||
        options.nextEvidenceReference !== next ||
        options.http !== http
      )
        return denied();
      return parseCanonicalInstant(now.call(clock));
    };
    return Object.freeze({
      async exchangeCode(input: {
        readonly request: Parameters<WorkforceOidcProviderPort["exchangeCode"]>[0];
        readonly invitation: WorkforceOnboardingInvitationEvidence;
      }): Promise<CognitoWorkforceOnboardingAuthenticationProof> {
        let failed = false,
          reading = false,
          checked = false,
          sealed = false;
        const poison = (): never => {
          failed = true;
          return denied();
        };
        try {
          const r = readClosedRecord(input, ["request", "invitation"]),
            invited = evidence(r.invitation),
            start = observe();
          if (
            canonicalizeRfc8785(invited.binding.configuration) !== canonicalizeRfc8785(scope) ||
            start < invited.observedAt ||
            start >= invited.validUntil
          )
            return poison();
          let latest = start;
          const deadline = invited.validUntil;
          const check = () => {
            try {
              const at = observe();
              if (failed || sealed || at < latest || at >= deadline) return poison();
              latest = at;
              return at;
            } catch {
              return poison();
            }
          };
          const request = readClosedRecord(r.request, [
            "issuer",
            "clientId",
            "redirectUri",
            "code",
            "nonce",
            "codeVerifier",
            "prompt",
            "requireTotp",
            "transactionReference",
          ]);
          if (
            request.issuer !== scope.issuer ||
            request.clientId !== scope.clientId ||
            request.redirectUri !== configuration.redirectUri
          )
            return poison();
          const verified = await protocol.exchangeVerifiedCode(input.request);
          check();
          const email = createCognitoWorkforceInvitation({ configuration: scope, hasher, clock });
          verified.assertIntendedEmail(
            invited.record.original.emailDigest,
            email.digestCorporateEmail,
          );
          check();
          const provider = invited.record.provider;
          if (provider === null) return poison();
          const subject = parseWorkforceAccountBindingSubject(
            await decrypt.call(
              envelopes,
              provider.encryptedSubject,
              workforceOnboardingSubjectContext(invited.record.original),
            ),
          );
          check();
          const subjectHash = parseSelectorHash(
            hash.call(
              hasher,
              parseRawBrowserCredential(
                Buffer.from(
                  sha256Hex(
                    canonicalizeRfc8785({
                      domain: "WORKFORCE_ONBOARDING_SUBJECT_V1",
                      configuration: scope,
                      subject,
                    }),
                  ),
                  "hex",
                ).toString("base64url"),
              ),
            ),
          );
          check();
          if (
            subject !== verified.subject ||
            equals.call(hasher, subjectHash, provider.subjectHash) !== true
          )
            return poison();
          check();
          const readStatus = async () => {
            check();
            verified.assertCurrent();
            const remaining = Date.parse(deadline) - Date.parse(latest),
              status = createCognitoSubjectStatus({
                userPoolId: pool,
                clock,
                requestTimeoutMs: Math.min(4000, remaining),
              });
            const current = readClosedRecord(
              await status.readCurrentProviderSubject({
                issuer: scope.issuer,
                subject,
                observedAt: invited.observedAt,
              }),
              ["issuer", "subject", "status", "observedAt", "validUntil"],
            );
            check();
            verified.assertCurrent();
            const observedAt = parseCanonicalInstant(current.observedAt),
              validUntil = parseCanonicalInstant(current.validUntil);
            if (
              current.issuer !== scope.issuer ||
              current.subject !== subject ||
              current.status !== "Enabled" ||
              observedAt !== invited.observedAt ||
              validUntil <= latest ||
              Date.parse(validUntil) > Date.parse(observedAt) + 5000
            )
              return poison();
          };
          await readStatus();
          const actor = createIdentityActor({
            actorType: "User",
            actorReference: invited.record.original.actorReference,
            accountKind: "Workforce",
            status: "Active",
            authenticationMethod: "Oidc",
            verificationLevel: "RecentMfa",
            authenticatedAt: verified.authenticatedAt,
            recentMfaAt: verified.authenticatedAt,
          });
          if (actor.actorReference === null) return poison();
          const evidenceReference = parseOpaqueUuidV7(next(), "ACTOR_REFERENCE_INVALID");
          check();
          verified.assertCurrent();
          return Object.freeze({
            actor,
            tokenBundle: verified.tokenBundle,
            subject,
            observedAt: invited.observedAt,
            validUntil: deadline,
            totp: Object.freeze({
              method: "Totp",
              timestampPrecision: "Second",
              evidenceReference,
              actorReference: actor.actorReference,
              issuer: scope.issuer,
              clientId: scope.clientId,
              authorizationTransactionReference: verified.authorizationTransactionReference,
              nonce: verified.nonce,
              authenticatedAt: verified.authenticatedAt,
              verifiedAt: verified.authenticatedAt,
            }),
            async assertCurrent() {
              if (reading || failed || sealed) return poison();
              reading = true;
              checked = false;
              try {
                await readStatus();
                check();
                checked = true;
              } catch {
                return poison();
              } finally {
                reading = false;
              }
            },
            assertFinalized() {
              try {
                if (reading || !checked || failed || sealed) return poison();
                check();
                verified.assertCurrent();
                sealed = true;
              } catch {
                return poison();
              }
            },
          });
        } catch {
          return poison();
        }
      },
    });
  } catch {
    return denied();
  }
}
