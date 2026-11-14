import {
  appendAuditRecordInTransaction,
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "@bop/audit";
import {
  BrowserSessionError,
  createCognitoWorkforceOnboardingAuthentication,
  createPostgresWorkforceOnboardingAuthorizationSource,
  createPostgresWorkforceOnboardingInvitationSource,
  createPostgresWorkforceInvitationStore,
  createPostgresWorkforceAccountBindingAcceptanceWriter,
  createPostgresWorkforceAuthenticationSource,
  createPostgresWorkforceBrowserSessionStore,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  parseCurrentWorkforceAccount,
  parseWorkforceOnboardingInvitationBinding,
  readClosedRecord,
  type AuthorizationTransaction,
  type WorkforceOnboardingBrowserPort,
  type WorkforceOnboardingInvitationEvidence,
  type CognitoWorkforceOnboardingAuthenticationOptions,
  type CognitoWorkforceOnboardingAuthenticationProof,
} from "@bop/identity";
import {
  createFileCurrentWorkforceRelationshipSource,
  createPostgresBrandAdministrationMembershipActivationSource,
  createPostgresApprovedWorkforceMembershipStore,
  type Membership,
} from "@bop/membership";
import {
  createFileWorkforceOnboardingPlanSource,
  deriveWorkforceOnboardingPlan,
  createFileWorkforceOnboardingApprovalSource,
  createPostgresApprovedWorkforcePolicyStore,
} from "@bop/permission";
import {
  createPostgresBrandAdministrationOrganizationSource,
  createBrandAdministrationContext,
} from "@bop/tenant";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export interface CognitoWorkforceOnboardingBrowserOptions {
  readonly transactions: PersistentMerchantBffOptions["transactions"];
  readonly configuration: CognitoWorkforceOnboardingAuthenticationOptions["configuration"];
  readonly clock: CognitoWorkforceOnboardingAuthenticationOptions["clock"];
  readonly hasher: CognitoWorkforceOnboardingAuthenticationOptions["hasher"];
  readonly envelopes: CognitoWorkforceOnboardingAuthenticationOptions["envelopes"];
  readonly nextReference: () => string;
  readonly environmentReference: string;
  readonly files: {
    readonly planPath: string;
    readonly approvalPath: string;
    readonly approvalTrustPath: string;
    readonly relationshipPath: string;
    readonly relationshipTrustPath: string;
  };
  readonly acceptanceRoleName: string;
  readonly allowedPostLoginPaths: readonly string[];
  readonly http?: typeof globalThis.fetch;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const bytes = canonicalizeRfc8785;
type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Tx = Parameters<Parameters<Host["transactions"]["run"]>[0]>[0];
interface Pending {
  readonly proof: CognitoWorkforceOnboardingAuthenticationProof;
  readonly invitation: WorkforceOnboardingInvitationEvidence;
  readonly request: Parameters<WorkforceOnboardingBrowserPort["exchangeCode"]>[0]["request"];
}

/** Fixed invitation-only composition. No caller verdicts, ordinary login
 * fallback, private cross-owner reads or durable plaintext credentials. */
export function createCognitoWorkforceOnboardingBrowser(
  options: CognitoWorkforceOnboardingBrowserOptions,
): WorkforceOnboardingBrowserPort {
  readClosedRecord(options, [
    "transactions",
    "configuration",
    "clock",
    "hasher",
    "envelopes",
    "nextReference",
    "environmentReference",
    "files",
    "acceptanceRoleName",
    "allowedPostLoginPaths",
    ...(Object.hasOwn(options, "http") ? ["http"] : []),
  ]);
  const transactions = options.transactions,
    run = transactions.run,
    configurationPort = options.configuration,
    configuration = Object.freeze({
      ...readClosedRecord(configurationPort, [
        "environment",
        "issuer",
        "clientId",
        "clientSecret",
        "managedLoginOrigin",
        "redirectUri",
        "logoutReturnUri",
      ]),
    }),
    scope = Object.freeze({
      environment: options.configuration.environment,
      issuer: options.configuration.issuer,
      clientId: options.configuration.clientId,
    }),
    clock = options.clock,
    now = clock.now,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    encrypt = envelopes.encrypt,
    decrypt = envelopes.decrypt,
    next = options.nextReference,
    http = options.http,
    filesPort = options.files,
    files = Object.freeze({
      ...readClosedRecord(filesPort, [
        "planPath",
        "approvalPath",
        "approvalTrustPath",
        "relationshipPath",
        "relationshipTrustPath",
      ]),
    }),
    environmentReference = parseOpaqueUuidV7(
      options.environmentReference,
      "ACTOR_REFERENCE_INVALID",
    ),
    role = options.acceptanceRoleName,
    pathsPort = options.allowedPostLoginPaths;
  readClosedRecord(clock, ["now"]);
  if (
    [run, now, hash, equals, encrypt, decrypt, next].some((p) => typeof p !== "function") ||
    typeof role !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(role) ||
    !Array.isArray(pathsPort) ||
    pathsPort.length < 1 ||
    pathsPort.length > 100 ||
    pathsPort.some((p) => typeof p !== "string")
  )
    return denied();
  const paths = Object.freeze([...pathsPort]),
    pathsPin = bytes(paths),
    host = createMerchantCategoryTransactions(transactions),
    authentication = createCognitoWorkforceOnboardingAuthentication({
      configuration: options.configuration,
      clock,
      hasher,
      envelopes,
      nextEvidenceReference: next,
      ...(http === undefined ? {} : { http }),
    }),
    pending = new WeakMap<AuthorizationTransaction, Pending>(),
    exchanging = new WeakSet<AuthorizationTransaction>();
  const observe = () => {
    if (
      options.transactions !== transactions ||
      transactions.run !== run ||
      options.configuration !== configurationPort ||
      bytes(readClosedRecord(configurationPort, Object.keys(configuration))) !==
        bytes(configuration) ||
      options.clock !== clock ||
      clock.now !== now ||
      options.hasher !== hasher ||
      hasher.hash !== hash ||
      hasher.equals !== equals ||
      options.envelopes !== envelopes ||
      envelopes.encrypt !== encrypt ||
      envelopes.decrypt !== decrypt ||
      options.nextReference !== next ||
      options.http !== http ||
      options.files !== filesPort ||
      bytes(readClosedRecord(filesPort, Object.keys(files))) !== bytes(files) ||
      options.environmentReference !== environmentReference ||
      options.acceptanceRoleName !== role ||
      options.allowedPostLoginPaths !== pathsPort ||
      bytes(pathsPort) !== pathsPin
    )
      return denied();
    return parseCanonicalInstant(now.call(clock));
  };
  const allocate = () => parseOpaqueUuidV7(next(), "ACTOR_REFERENCE_INVALID");
  const within = (origin: string, until: string) => {
    const start = parseCanonicalInstant(origin),
      end = parseCanonicalInstant(until),
      at = observe();
    if (end <= start || Date.parse(end) > Date.parse(start) + 5000 || at < start || at >= end)
      return denied();
    return at;
  };
  const transact = async <T>(
    origin: string,
    until: string,
    work: (
      tx: Tx,
      register: (actual: object, guard: () => Promise<void>, final: () => void) => Promise<void>,
      check: () => string,
      assertions: (() => void)[],
    ) => Promise<T>,
  ): Promise<T> => {
    let failed = false,
      completed = false,
      latest = within(origin, until);
    const check = () => {
      try {
        const at = within(origin, until);
        if (failed || at < latest) return denied();
        latest = at;
        return at;
      } catch {
        failed = true;
        return denied();
      }
    };
    const assertions: (() => void)[] = [];
    try {
      const result = await host.transactions.run(async (tx) => {
        const register = async (actual: object, guard: () => Promise<void>, final: () => void) => {
          if (actual !== tx) {
            failed = true;
            return denied();
          }
          await host.registerBeforeCommit(tx, guard, final);
        };
        await register(
          tx,
          async () => {
            check();
            if (!completed) return denied();
          },
          () => {
            check();
            if (!completed) return denied();
          },
        );
        const answer = await work(tx, register, check, assertions);
        check();
        completed = true;
        return answer;
      });
      for (const assertion of assertions) assertion();
      return result;
    } catch {
      failed = true;
      return denied();
    }
  };
  const holders = (
    tx: Tx,
    register: (actual: object, guard: () => Promise<void>, final: () => void) => Promise<void>,
    authorization: AuthorizationTransaction,
    binding: Parameters<WorkforceOnboardingBrowserPort["exchangeCode"]>[0]["binding"],
    origin: string,
    until: string,
  ) => {
    const auth = createPostgresWorkforceOnboardingAuthorizationSource({
      transaction: tx,
      configuration: scope,
      redirectUri: options.configuration.redirectUri,
      allowedPostLoginPaths: paths,
      envelopes,
      authorization,
      binding,
      clock,
      originalObservedAt: origin,
      originalValidUntil: until,
      registerBeforeCommit: register,
    });
    const invitation = createPostgresWorkforceOnboardingInvitationSource({
      transaction: tx,
      configuration: scope,
      access: {
        kind: "AuthorizationTransaction",
        authorizationTransactionReference: authorization.transactionReference,
        async hold(actual, requested) {
          if (
            actual !== tx ||
            requested.authorizationTransactionReference !== authorization.transactionReference
          )
            return denied();
          const current = await auth.hold();
          if (current.authorization.consumedAt === null) return denied();
          return {
            authorizationTransactionReference: current.authorization.transactionReference,
            binding: current.binding,
            consumedAt: current.authorization.consumedAt,
            observedAt: current.observedAt,
            validUntil: current.validUntil,
          };
        },
      },
      hasher,
      clock,
      originalObservedAt: origin,
      originalValidUntil: until,
      registerBeforeCommit: register,
    });
    return { auth, invitation };
  };
  return Object.freeze({
    async resolveInvitation(
      input: Parameters<WorkforceOnboardingBrowserPort["resolveInvitation"]>[0],
    ) {
      try {
        readClosedRecord(input, ["secret", "observedAt", "validUntil"]);
        return await transact(
          input.observedAt,
          input.validUntil,
          async (tx, register, check, assertions) => {
            const source = createPostgresWorkforceOnboardingInvitationSource({
              transaction: tx,
              configuration: scope,
              access: { kind: "Secret", secret: input.secret },
              hasher,
              clock,
              originalObservedAt: input.observedAt,
              originalValidUntil: input.validUntil,
              registerBeforeCommit: register,
            });
            const current = await source.hold();
            check();
            assertions.push(source.assertFinalized);
            return Object.freeze({
              binding: current.binding,
              observedAt: current.observedAt,
              validUntil: current.validUntil,
            });
          },
        );
      } catch {
        return denied();
      }
    },
    async exchangeCode(input: Parameters<WorkforceOnboardingBrowserPort["exchangeCode"]>[0]) {
      readClosedRecord(input, ["request", "authorization", "binding"]);
      if (pending.has(input.authorization) || exchanging.has(input.authorization)) return denied();
      exchanging.add(input.authorization);
      try {
        const binding = parseWorkforceOnboardingInvitationBinding(input.binding),
          origin = observe(),
          until = new Date(Date.parse(origin) + 5000).toISOString();
        let saved: Pending | undefined;
        const result = await transact(origin, until, async (tx, register, check, assertions) => {
          const { auth, invitation } = holders(
              tx,
              register,
              input.authorization,
              binding,
              origin,
              until,
            ),
            actual = await auth.hold();
          if (
            input.request.transactionReference !== actual.authorization.transactionReference ||
            input.request.nonce !== actual.nonce ||
            input.request.codeVerifier !== actual.codeVerifier
          )
            return denied();
          const current = await invitation.hold(),
            proof = await authentication.exchangeCode({
              request: input.request,
              invitation: current,
            });
          check();
          await register(
            tx,
            async () => {
              check();
              await proof.assertCurrent();
              check();
            },
            () => {
              check();
            },
          );
          assertions.push(auth.assertFinalized, invitation.assertFinalized);
          saved = { proof, invitation: current, request: Object.freeze({ ...input.request }) };
          return Object.freeze({
            actor: proof.actor,
            tokenBundle: proof.tokenBundle,
            totp: proof.totp,
            observedAt: proof.observedAt,
            validUntil: proof.validUntil,
          });
        });
        if (!saved) return denied();
        pending.set(input.authorization, saved);
        return result;
      } catch {
        return denied();
      } finally {
        exchanging.delete(input.authorization);
      }
    },
    async complete(input: Parameters<WorkforceOnboardingBrowserPort["complete"]>[0]) {
      try {
        readClosedRecord(input, [
          "command",
          "authorization",
          "binding",
          "totp",
          "providerObservedAt",
          "providerValidUntil",
        ]);
        const cached = pending.get(input.authorization);
        pending.delete(input.authorization);
        if (!cached) return denied();
        const { proof, invitation: originalInvitation } = cached,
          original = originalInvitation.record.original,
          binding = parseWorkforceOnboardingInvitationBinding(input.binding),
          origin = proof.observedAt,
          until = proof.validUntil;
        if (
          bytes(binding) !== bytes(originalInvitation.binding) ||
          bytes(input.totp) !== bytes(proof.totp) ||
          bytes(input.command.actor) !== bytes(proof.actor) ||
          input.providerObservedAt !== origin ||
          input.providerValidUntil !== until ||
          input.command.observedAt < origin ||
          input.command.observedAt >= until
        )
          return denied();
        within(origin, until);
        const planSource = createFileWorkforceOnboardingPlanSource({
            planPath: options.files.planPath,
          }),
          expected = {
            configuration: scope,
            environmentReference,
            operationReference: original.operationReference,
            brandReference: original.brandReference,
            actorReference: original.actorReference,
            membershipReference: original.membershipReference,
            operatorReference: original.operatorReference,
          },
          planPacket = await planSource.read(expected),
          derived = deriveWorkforceOnboardingPlan(planPacket.plan);
        if (
          bytes(derived.original) !== bytes(original) ||
          planPacket.planDigest !== original.approvedPlanDigest
        )
          return denied();
        const approval = createFileWorkforceOnboardingApprovalSource({
          approvalPath: options.files.approvalPath,
          trustPath: options.files.approvalTrustPath,
          clock: () => observe(),
        });
        return await approval.withApproval(derived.approvalExpected, async (lease) => {
          if (
            lease.approval.approvedByReference !== original.approvedByReference ||
            lease.approval.approvalEvidenceReference !== original.approvalEvidenceReference
          )
            return denied();
          const deadline = [until, lease.validUntil].sort()[0] ?? until;
          return transact(origin, deadline, async (tx, register, check, assertions) => {
            const assertAuthority = async () => {
              check();
              const packet = await planSource.read(expected);
              if (
                packet.planDigest !== derived.planDigest ||
                bytes(packet.plan) !== bytes(derived.plan)
              )
                return denied();
              // Recheck the original held authority at every owner boundary.
              // Remote proof refresh is reserved for admission and the last async
              // guard; recursive owner holds must not renew or multiply its lease.
              await lease.assertCurrent();
              check();
            };
            await register(tx, assertAuthority, () => {
              check();
            });
            await assertAuthority();
            await proof.assertCurrent();
            check();
            const tenant = createPostgresBrandAdministrationOrganizationSource(tx, {
              brandReference: original.brandReference,
              observedAt: origin,
            });
            let pendingMembership: Membership | undefined, brandPin: string | undefined;
            const relationship = createFileCurrentWorkforceRelationshipSource({
              transaction: tx,
              expected: {
                environmentReference,
                actorReference: original.actorReference,
                brandReference: original.brandReference,
                workforceRelationshipReference: derived.plan.workforceRelationshipReference,
                relationshipEvidenceReference: original.relationshipEvidenceReference,
              },
              qualificationPath: options.files.relationshipPath,
              trustPath: options.files.relationshipTrustPath,
              clock,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              authority: {
                async hold(actual, request) {
                  if (actual !== tx) return denied();
                  await assertAuthority();
                  return request;
                },
              },
              registerBeforeCommit: register,
            });
            const qualification = async () => {
              await assertAuthority();
              const brand = await tenant.getBrand(derived.approvedMembership.brandReference);
              if (brand === null) return denied();
              if (brandPin !== undefined && bytes(brand) !== brandPin) return denied();
              brandPin = bytes(brand);
              if (!pendingMembership) {
                const context = createBrandAdministrationContext(proof.actor, brand, origin),
                  members = createPostgresBrandAdministrationMembershipActivationSource(
                    tx,
                    context,
                  ),
                  candidates = await members.findMemberships(
                    context.actor.actorReference ?? denied(),
                    context.brand.brandReference,
                  ),
                  candidate = candidates[0];
                if (
                  candidates.length !== 1 ||
                  !candidate ||
                  candidate.membershipReference !== original.membershipReference ||
                  candidate.lifecycle !== "PendingActivation" ||
                  candidate.version !== 1
                )
                  return denied();
                pendingMembership = candidate;
              }
              const actualRelationship = await relationship.hold();
              check();
              if (!pendingMembership) return denied();
              return {
                brand,
                pendingMembership,
                relationship: actualRelationship,
                operator: proof.actor,
                approval: derived.approvedMembership,
                observedAt: origin,
                validUntil: [deadline, actualRelationship.validUntil].sort()[0] ?? deadline,
              };
            };
            const policy = createPostgresApprovedWorkforcePolicyStore({
              transaction: tx,
              clock,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              auditReference: originalInvitation.record.auditReference,
              authority: {
                async hold(actual, request) {
                  if (actual !== tx) return denied();
                  return { ...(await qualification()), requestDigest: request.requestDigest };
                },
              },
              appendAudit: appendAuditRecordInTransaction,
              registerBeforeCommit: register,
            });
            const policyRequest = {
              profile: "HoldApprovedWorkforcePolicyV1",
              approval: derived.approvedMembership,
              policy: derived.plan.policy,
            };
            await policy.holdApproved(policyRequest);
            check();
            const { auth, invitation } = holders(
                tx,
                register,
                input.authorization,
                binding,
                origin,
                deadline,
              ),
              currentAuth = await auth.hold();
            if (
              currentAuth.nonce !== proof.totp.nonce ||
              currentAuth.nonce !== cached.request.nonce ||
              currentAuth.codeVerifier !== cached.request.codeVerifier ||
              currentAuth.authorization.transactionReference !==
                proof.totp.authorizationTransactionReference
            )
              return denied();
            const current = await invitation.hold();
            if (bytes(current.record) !== bytes(originalInvitation.record)) return denied();
            const acceptanceOperation = allocate(),
              invitationBinding = {
                operatorReference: original.actorReference,
                actorReference: original.actorReference,
                membershipReference: original.membershipReference,
                purposeCode: "WORKFORCE_ONBOARDING" as const,
                action: "AcceptInvitation" as const,
                operationReference: acceptanceOperation,
                correlationReference: acceptanceOperation,
              };
            const invitationWriter = createPostgresWorkforceInvitationStore({
              transaction: tx,
              binding: invitationBinding,
              clock,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              authority: {
                async hold(actual, request) {
                  if (actual !== tx) return denied();
                  await assertAuthority();
                  return {
                    binding: invitationBinding,
                    requestDigest: request.requestDigest,
                    operator: proof.actor,
                    validUntil: deadline,
                  };
                },
              },
              async appendAudit(actual, descriptor) {
                if (actual !== tx) return denied();
                await tx.query(
                  "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
                  [descriptor.actorReference, descriptor.purposeCode],
                );
                await appendPlatformAuditRecordInTransaction(tx, {
                  auditReference: allocate(),
                  actorReference: descriptor.actorReference,
                  purposeCode: descriptor.purposeCode,
                  actionCode: "WORKFORCE_INVITATION_ACCEPTED",
                  targetType: "WorkforceInvitation",
                  targetReference: current.invitation.invitationReference,
                  operationReference: descriptor.idempotencyKey,
                  intentDigest: `sha256:${sha256Hex(bytes(descriptor))}`,
                  occurredAt: descriptor.occurredAt,
                  reasonCode: derived.plan.reasonCode,
                  retentionPolicyCode: "CONFIGURATION_AUDIT",
                  retentionPolicyVersion: 1,
                });
                // Complete this public Audit partition before the binding owner
                // changes purpose GUCs; deferred records must retain their own scope.
                await tx.query(
                  "SET CONSTRAINTS platform_audit.platform_actor_audit_record_complete IMMEDIATE",
                  [],
                );
                await tx.query(
                  "SET CONSTRAINTS platform_audit.platform_actor_audit_record_complete DEFERRED",
                  [],
                );
              },
              registerBeforeCommit: register,
            });
            const accepted = await invitationWriter.consumeInvitation({
              invitationReference: current.invitation.invitationReference,
              expectedVersion: 1,
              selectorHash: current.binding.selectorHash,
              emailDigest: original.emailDigest,
              actorReference: original.actorReference,
              membershipReference: original.membershipReference,
              providerEvidenceReference: proof.totp.evidenceReference,
              observedAt: origin,
            });
            const acceptedProviderEvidence = accepted.providerEvidenceReference,
              consumedAt = accepted.consumedAt;
            if (
              accepted.status !== "Accepted" ||
              accepted.version !== 2 ||
              acceptedProviderEvidence === null ||
              consumedAt === null
            )
              return denied();
            const handed = await invitation.handoffAccepted(accepted);
            check();
            const acceptedEvidence = Object.freeze({
              profile: "CurrentWorkforceInvitationEvidenceV1" as const,
              invitationReference: accepted.invitationReference,
              actorReference: accepted.actorReference,
              originalMembershipReference: accepted.membershipReference,
              providerEvidenceReference: acceptedProviderEvidence,
              status: "Accepted" as const,
              version: accepted.version,
              createdAt: accepted.createdAt,
              expiresAt: accepted.expiresAt,
              consumedAt,
              observedAt: parseCanonicalInstant(handed.observedAt),
              validUntil: parseCanonicalInstant(handed.validUntil),
            });
            const writer = createPostgresWorkforceAccountBindingAcceptanceWriter({
              transaction: tx,
              configuration: {
                environment: scope.environment,
                issuer: scope.issuer,
                clientIds: [scope.clientId],
              },
              operatorReference: original.actorReference,
              provisioningRoleName: role,
              clock,
              hasher,
              envelopes,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              authority: {
                async hold(actual) {
                  if (actual !== tx) return denied();
                  await assertAuthority();
                  return {
                    operator: proof.actor,
                    approvedByReference: original.approvedByReference,
                    approvalEvidenceReference: original.approvalEvidenceReference,
                    validUntil: deadline,
                    authorizationTransactionReference: input.authorization.transactionReference,
                    invitationReference: accepted.invitationReference,
                    originalOnboardingIntentDigest: originalInvitation.record.intentDigest,
                  };
                },
              },
              nextReference: allocate,
              appendAudit: appendPlatformAuditRecordInTransaction,
              registerBeforeCommit: register,
            });
            const actualBinding = await writer.accept({
              profile: "WorkforceAccountBindingAcceptanceV1",
              operationReference: allocate(),
              actorReference: original.actorReference,
              subject: proof.subject,
              invitationReference: accepted.invitationReference,
              originalMembershipReference: accepted.membershipReference,
              providerEvidenceReference: accepted.providerEvidenceReference,
              recordedByReference: original.actorReference,
              approvedByReference: original.approvedByReference,
              approvalEvidenceReference: original.approvalEvidenceReference,
              reasonCode: derived.plan.reasonCode,
            });
            const accountSource = createPostgresWorkforceAuthenticationSource({
              transaction: tx,
              configuration: {
                environment: scope.environment,
                issuer: scope.issuer,
                clientIds: [scope.clientId],
              },
              hasher,
              envelopes,
              clock,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              registerBeforeCommit: register,
            });
            const currentActor = async (
              actual: object,
              reference: string,
              authenticatedAt: string,
              observedAt: string,
            ) => {
              if (actual !== tx) return denied();
              return accountSource.currentActor(tx, reference, authenticatedAt, observedAt);
            };
            const memberWriter = createPostgresApprovedWorkforceMembershipStore({
              transaction: tx,
              clock,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              auditReference: allocate(),
              authority: {
                async hold(actual, request) {
                  if (actual !== tx || proof.actor.authenticatedAt === null) return denied();
                  const facts = await qualification(),
                    actor = await currentActor(
                      tx,
                      original.actorReference,
                      proof.actor.authenticatedAt,
                      check(),
                    ),
                    approvedPolicy = await policy.holdApproved(policyRequest);
                  const account = parseCurrentWorkforceAccount({
                    profile: "CurrentWorkforceAccountV1",
                    actorType: actor.actorType,
                    actorReference: actor.actorReference,
                    accountKind: actor.accountKind,
                    status: actor.status,
                    observedAt: origin,
                    validUntil: deadline,
                  });
                  return {
                    requestDigest: request.requestDigest,
                    approval: facts.approval,
                    brand: facts.brand,
                    operator: facts.operator,
                    relationship: facts.relationship,
                    observedAt: facts.observedAt,
                    validUntil: facts.validUntil,
                    activation: {
                      pendingMembership: facts.pendingMembership,
                      invitation: acceptedEvidence,
                      account,
                      binding: actualBinding,
                      policy: approvedPolicy,
                    },
                  };
                },
              },
              async appendAudit(actual, descriptor) {
                if (actual !== tx) return denied();
                await appendAuditRecordInTransaction(tx, {
                  auditId: descriptor.auditReference,
                  brandId: descriptor.brandReference,
                  actor: { type: "User", reference: descriptor.actorReference },
                  actionCode: descriptor.actionCode,
                  targetType: "Membership",
                  targetId: descriptor.membershipReference,
                  beforeSummary: { version: descriptor.beforeVersion },
                  afterSummary: {
                    version: descriptor.afterVersion,
                    requestDigest: descriptor.requestDigest,
                    originalOperationReference: descriptor.originalOperationReference,
                    planDigest: descriptor.planDigest,
                    approvalEvidenceReference: descriptor.approvalEvidenceReference,
                  },
                  reasonCode: derived.plan.reasonCode,
                  correlationId: descriptor.operationReference,
                  occurredAt: descriptor.occurredAt,
                  sourceChannel: "APPLICATION",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "CONFIGURATION_AUDIT",
                  retentionPolicyVersion: 1,
                });
              },
              registerBeforeCommit: register,
            });
            if (!pendingMembership) return denied();
            await memberWriter.activateApproved({
              profile: "ActivateApprovedMembershipV1",
              operationReference: allocate(),
              approval: derived.approvedMembership,
              expectedVersion: 1,
              pendingCreatedAt: pendingMembership.createdAt,
              invitationReference: accepted.invitationReference,
            });
            const sessionStore = createPostgresWorkforceBrowserSessionStore({
              transactions: {
                async run(work) {
                  return work(tx);
                },
              },
              environment: scope.environment,
              issuer: scope.issuer,
              clientId: scope.clientId,
              redirectUri: options.configuration.redirectUri,
              allowedPostLoginPaths: paths,
              now: () => check(),
              hasher,
              envelopes,
              currentActor,
            });
            const record = await sessionStore.createSession(input.command);
            check();
            // Register last so the genuine remote Provider reread follows all
            // owning asynchronous guards. Nothing asynchronous runs after seals.
            await register(
              tx,
              async () => {
                await assertAuthority();
                await proof.assertCurrent();
                check();
              },
              () => {
                check();
                lease.assertFinalized();
                proof.assertFinalized();
              },
            );
            assertions.push(
              policy.assertFinalized,
              relationship.assertFinalized,
              auth.assertFinalized,
              invitation.assertFinalized,
              invitationWriter.assertFinalized,
              writer.assertFinalized,
              accountSource.assertFinalized,
              memberWriter.assertFinalized,
            );
            return record;
          });
        });
      } catch {
        return denied();
      }
    },
  });
}
