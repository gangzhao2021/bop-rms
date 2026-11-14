import { appendAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import {
  createBrandInitialProvisioningOperatorSource,
  createPostgresCurrentWorkforceInvitationSource,
  createPostgresCurrentWorkforceAccountSource,
  parseWorkforceAccountBindingConfiguration,
  parseCurrentWorkforceAccount,
  type IdentityActor,
} from "@bop/identity";
import {
  createFileCurrentWorkforceRelationshipSource,
  createPostgresInitialBrandMembershipStore,
  hashInitialBrandMembershipRequest,
  type InitialBrandMembershipQualifiedMember,
} from "@bop/membership";
import {
  assertBrandInitialProvisioningOriginal,
  createFileBrandProvisioningApprovalSource,
  createPostgresBrandInitialPolicyStore,
  deriveBrandInitialProvisioningRequests,
  hashBrandInitialPolicyRequest,
  hashBrandInitialProvisioningPlan,
  parseBrandInitialProvisioningPlan,
  parseBrandInitialProvisioningOperator,
  parseBrandInitialProvisioningMembers,
  type BrandInitialProvisioningPlan,
} from "@bop/permission";
import {
  createPostgresBrandInitialCreationStore,
  parseBrandAdministrationReference,
  parseCanonicalInstant,
  type BrandLifecycleTransaction,
  type BrandAdministrationOperation,
} from "@bop/tenant";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Register = (
  tx: BrandLifecycleTransaction,
  guard: () => Promise<void>,
  final: () => void,
) => Promise<void>;
interface ParticipantsRequest {
  readonly plan: BrandInitialProvisioningPlan;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly registerBeforeCommit: Register;
}
export interface BrandInitialProvisioningOptions {
  readonly transactions: PersistentMerchantBffOptions["transactions"];
  readonly clock: { now(): string };
  readonly approvalFiles: { readonly approvalPath: string; readonly trustPath: string };
  readonly participants: {
    /** Real current Identity/Session/TOTP holder. Sources retain their own locks
     * and register host guards; an Actor reference or signed plan is not login. */
    holdOperator(
      tx: BrandLifecycleTransaction,
      input: ParticipantsRequest,
    ): Promise<{ readonly actor: IdentityActor; readonly validUntil: string }>;
    /** Current owning Identity and relationship/invitation evidence holders.
     * There is no fallback actor, relationship, invitation or passed verdict. */
    holdMembers(
      tx: BrandLifecycleTransaction,
      input: ParticipantsRequest,
    ): Promise<{
      readonly members: readonly InitialBrandMembershipQualifiedMember[];
      readonly validUntil: string;
    }>;
  };
}
export interface BrandInitialProvisioningResult {
  readonly profile: "BrandInitialProvisioningResultV1";
  readonly status: "Applied" | "AlreadyApplied";
  readonly operation: BrandAdministrationOperation;
}
const unavailable = (): never => {
  throw new Error("BRAND_INITIAL_PROVISIONING_UNAVAILABLE");
};

type OperatorSourceOptions = Parameters<typeof createBrandInitialProvisioningOperatorSource>[0];
export interface AuthenticatedBrandInitialProvisioningOptions extends Omit<
  BrandInitialProvisioningOptions,
  "participants"
> {
  readonly operator: Pick<
    OperatorSourceOptions,
    "configuration" | "hasher" | "envelopes" | "cookie"
  >;
  readonly workforce: {
    readonly configuration: Parameters<
      typeof createPostgresCurrentWorkforceAccountSource
    >[0]["configuration"];
    readonly hasher: Parameters<typeof createPostgresCurrentWorkforceAccountSource>[0]["hasher"];
    readonly envelopes: Parameters<
      typeof createPostgresCurrentWorkforceAccountSource
    >[0]["envelopes"];
    readonly relationships: {
      readonly trustPath: string;
      readonly qualifications: readonly {
        readonly actorReference: string;
        readonly qualificationPath: string;
      }[];
    };
  };
}

/** Fixed production source composition. Actual operator, persistent Workforce account, invitation and signed
 * relationship owners are instantiated from trusted deployment configuration. */
export function createAuthenticatedBrandInitialProvisioning(
  options: AuthenticatedBrandInitialProvisioningOptions,
) {
  const operator = options.operator,
    configuration = operator.configuration,
    hasher = operator.hasher,
    envelopes = operator.envelopes,
    cookie = operator.cookie,
    clock = options.clock,
    transactions = options.transactions,
    approvalFiles = options.approvalFiles,
    workforce = options.workforce,
    accountConfiguration = workforce.configuration,
    parsedAccountConfiguration = parseWorkforceAccountBindingConfiguration(accountConfiguration),
    accountConfigurationBytes = canonicalizeRfc8785(parsedAccountConfiguration),
    accountHasher = workforce.hasher,
    accountHash = accountHasher.hash,
    accountEquals = accountHasher.equals,
    accountEnvelopes = workforce.envelopes,
    accountDecrypt = accountEnvelopes.decrypt,
    relationships = workforce.relationships,
    relationshipTrust = relationships.trustPath,
    qualificationFiles = relationships.qualifications,
    capturedFiles = qualificationFiles.map((file) =>
      Object.freeze({
        source: file,
        actorReference: file.actorReference,
        qualificationPath: file.qualificationPath,
      }),
    );
  if (
    [accountHash, accountEquals, accountDecrypt].some((port) => typeof port !== "function") ||
    capturedFiles.length < 1 ||
    capturedFiles.length > 20 ||
    new Set(capturedFiles.map((file) => file.actorReference)).size !== capturedFiles.length ||
    new Set(capturedFiles.map((file) => file.qualificationPath)).size !== capturedFiles.length
  )
    return unavailable();
  type Operator = ReturnType<typeof createBrandInitialProvisioningOperatorSource>;
  type Account = ReturnType<typeof createPostgresCurrentWorkforceAccountSource>;
  type Invitation = ReturnType<typeof createPostgresCurrentWorkforceInvitationSource>;
  type Relationship = ReturnType<typeof createFileCurrentWorkforceRelationshipSource>;
  const holders = new WeakMap<
    BrandLifecycleTransaction,
    {
      plan: BrandInitialProvisioningPlan;
      register: Register;
      operator: Operator;
      accounts: Map<string, Account>;
      originalObservedAt: string;
      originalValidUntil: string;
      invitations: Map<string, Invitation>;
      relationships: Map<string, Relationship>;
    }
  >();
  const current = (tx: BrandLifecycleTransaction, input: ParticipantsRequest) => {
    if (
      options.operator !== operator ||
      operator.configuration !== configuration ||
      operator.hasher !== hasher ||
      operator.envelopes !== envelopes ||
      operator.cookie !== cookie ||
      options.clock !== clock ||
      options.transactions !== transactions ||
      options.approvalFiles !== approvalFiles ||
      options.workforce !== workforce ||
      workforce.configuration !== accountConfiguration ||
      canonicalizeRfc8785(parseWorkforceAccountBindingConfiguration(workforce.configuration)) !==
        accountConfigurationBytes ||
      workforce.hasher !== accountHasher ||
      accountHasher.hash !== accountHash ||
      accountHasher.equals !== accountEquals ||
      workforce.envelopes !== accountEnvelopes ||
      accountEnvelopes.decrypt !== accountDecrypt ||
      workforce.relationships !== relationships ||
      relationships.trustPath !== relationshipTrust ||
      relationships.qualifications !== qualificationFiles ||
      qualificationFiles.length !== capturedFiles.length ||
      capturedFiles.some(
        (file, index) =>
          qualificationFiles[index] !== file.source ||
          file.source.actorReference !== file.actorReference ||
          file.source.qualificationPath !== file.qualificationPath,
      )
    )
      return unavailable();
    let holder = holders.get(tx);
    if (!holder) {
      const source = createBrandInitialProvisioningOperatorSource({
        configuration,
        hasher,
        envelopes,
        cookie,
        transaction: tx,
        clock,
        actorReference: input.plan.operatorReference,
        originalObservedAt: input.observedAt,
        originalValidUntil: input.validUntil,
        registerBeforeCommit: async (actual, guard, final) => {
          if (actual !== tx) return unavailable();
          await input.registerBeforeCommit(tx, guard, final);
        },
      });
      holder = {
        plan: input.plan,
        register: input.registerBeforeCommit,
        operator: source,
        accounts: new Map(),
        originalObservedAt: input.observedAt,
        originalValidUntil: input.validUntil,
        invitations: new Map(),
        relationships: new Map(),
      };
      holders.set(tx, holder);
    }
    if (holder.plan !== input.plan || holder.register !== input.registerBeforeCommit)
      return unavailable();
    return holder;
  };
  return createBrandInitialProvisioning({
    transactions,
    clock,
    approvalFiles,
    participants: {
      async holdOperator(tx, input) {
        return current(tx, input).operator.hold();
      },
      async holdMembers(tx, input) {
        const holder = current(tx, input);
        let validUntil = String(parseCanonicalInstant(input.validUntil));
        const members: InitialBrandMembershipQualifiedMember[] = [];
        for (const recipient of input.plan.recipients) {
          let accountHolder = holder.accounts.get(recipient.actorReference);
          if (!accountHolder) {
            accountHolder = createPostgresCurrentWorkforceAccountSource({
              transaction: tx,
              configuration: parsedAccountConfiguration,
              actorReference: recipient.actorReference,
              hasher: accountHasher,
              envelopes: accountEnvelopes,
              clock,
              originalObservedAt: holder.originalObservedAt,
              originalValidUntil: holder.originalValidUntil,
              authority: {
                async hold(actualTx, request) {
                  if (
                    actualTx !== tx ||
                    request.actorReference !== recipient.actorReference ||
                    request.purposeCode !== "BRAND_INITIAL_PROVISIONING"
                  )
                    return unavailable();
                  current(tx, input);
                  const actualOperator = await holder.operator.hold();
                  current(tx, input);
                  return Object.freeze({
                    ...request,
                    validUntil:
                      actualOperator.validUntil < request.validUntil
                        ? actualOperator.validUntil
                        : request.validUntil,
                  });
                },
              },
              registerBeforeCommit: async (actualTx, guard, final) => {
                if (actualTx !== tx) return unavailable();
                await input.registerBeforeCommit(tx, guard, final);
              },
            });
            holder.accounts.set(recipient.actorReference, accountHolder);
          }
          const account = parseCurrentWorkforceAccount(await accountHolder.hold());
          current(tx, input);
          if (account.actorReference !== recipient.actorReference) return unavailable();
          let invitation = holder.invitations.get(recipient.invitationEvidenceReference);
          if (!invitation) {
            invitation = createPostgresCurrentWorkforceInvitationSource({
              transaction: tx,
              binding: {
                actorReference: recipient.actorReference,
                invitationReference: recipient.invitationEvidenceReference,
                purposeCode: "BRAND_INITIAL_PROVISIONING",
              },
              clock,
              originalObservedAt: holder.originalObservedAt,
              originalValidUntil: holder.originalValidUntil,
              authority: {
                async hold(actualTx, request) {
                  if (actualTx !== tx) return unavailable();
                  current(tx, input);
                  const operator = await holder.operator.hold();
                  return Object.freeze({
                    ...request.binding,
                    observedAt: request.observedAt,
                    validUntil:
                      operator.validUntil < request.validUntil
                        ? operator.validUntil
                        : request.validUntil,
                  });
                },
              },
              registerBeforeCommit: async (actualTx, guard, final) => {
                if (actualTx !== tx) return unavailable();
                await input.registerBeforeCommit(tx, guard, final);
              },
            });
            holder.invitations.set(recipient.invitationEvidenceReference, invitation);
          }
          const evidence = await invitation.hold();
          let relationship = holder.relationships.get(recipient.actorReference);
          if (!relationship) {
            const configured = capturedFiles.find(
              (file) => file.actorReference === recipient.actorReference,
            );
            if (!configured) return unavailable();
            relationship = createFileCurrentWorkforceRelationshipSource({
              transaction: tx,
              expected: {
                environmentReference: input.plan.environmentReference,
                actorReference: recipient.actorReference,
                brandReference: input.plan.brand.brandReference,
                workforceRelationshipReference: recipient.workforceRelationshipReference,
                relationshipEvidenceReference: recipient.relationshipEvidenceReference,
              },
              qualificationPath: configured.qualificationPath,
              trustPath: relationshipTrust,
              clock,
              originalObservedAt: holder.originalObservedAt,
              originalValidUntil: holder.originalValidUntil,
              authority: {
                async hold(actualTx, request) {
                  if (actualTx !== tx) return unavailable();
                  current(tx, input);
                  const operator = await holder.operator.hold();
                  return Object.freeze({
                    expected: request.expected,
                    observedAt: request.observedAt,
                    validUntil:
                      operator.validUntil < request.validUntil
                        ? operator.validUntil
                        : request.validUntil,
                  });
                },
              },
              registerBeforeCommit: async (actualTx, guard, final) => {
                if (actualTx !== tx) return unavailable();
                await input.registerBeforeCommit(tx, guard, final);
              },
            });
            holder.relationships.set(recipient.actorReference, relationship);
          }
          const qualified = await relationship.hold();
          current(tx, input);
          for (const until of [evidence.validUntil, qualified.validUntil, account.validUntil])
            if (until < validUntil) validUntil = until;
          members.push(
            Object.freeze({
              membershipReference: recipient.membershipReference,
              account,
              workforceRelationshipReference: qualified.workforceRelationshipReference,
              relationshipEvidenceReference: qualified.relationshipEvidenceReference,
              relationshipEffectiveFrom: qualified.relationshipEffectiveFrom,
              relationshipEffectiveUntil: qualified.relationshipEffectiveUntil,
              invitationEvidenceReference: evidence.invitationReference,
              invitationQualified: true as const,
            }),
          );
        }
        return Object.freeze({ members: Object.freeze(members), validUntil });
      },
    },
  });
}

/** Controlled composition, not a reusable browser bootstrap endpoint. Public
 * owners validate the signed plan, identities and business facts; this function
 * wires their actual writers and Audit into one existing transaction host.
 * Deployment paths and participating identity sources are trusted configuration.
 */
export function createBrandInitialProvisioning(options: BrandInitialProvisioningOptions) {
  const transactions = options.transactions,
    run = transactions?.run,
    clock = options.clock,
    now = clock?.now,
    files = options.approvalFiles,
    approvalPath = files?.approvalPath,
    trustPath = files?.trustPath,
    participants = options.participants,
    holdOperator = participants?.holdOperator,
    holdMembers = participants?.holdMembers;
  if ([run, now, holdOperator, holdMembers].some((port) => typeof port !== "function"))
    return unavailable();
  const executeTransaction = run.bind(transactions);
  let active: (() => never) | undefined;
  return Object.freeze({
    async execute(input: unknown): Promise<BrandInitialProvisioningResult> {
      if (active) return active();
      let failed = false,
        closed = false,
        latest: string | undefined,
        deadline: string | undefined,
        rootSealed = false,
        runCount = 0;
      const poison = (): never => {
        failed = true;
        return unavailable();
      };
      active = poison;
      const check = () => {
        try {
          if (
            failed ||
            closed ||
            options.transactions !== transactions ||
            transactions.run !== run ||
            options.clock !== clock ||
            clock.now !== now ||
            options.approvalFiles !== files ||
            files.approvalPath !== approvalPath ||
            files.trustPath !== trustPath ||
            options.participants !== participants ||
            participants.holdOperator !== holdOperator ||
            participants.holdMembers !== holdMembers
          )
            return poison();
          const at = String(parseCanonicalInstant(now.call(clock)));
          if ((latest !== undefined && at < latest) || (deadline !== undefined && at >= deadline))
            return poison();
          latest = at;
          return at;
        } catch {
          return poison();
        }
      };
      const retain = (until: string) => {
        const parsed = String(parseCanonicalInstant(until));
        if (deadline === undefined || parsed < deadline) deadline = parsed;
        check();
      };
      try {
        const plan = parseBrandInitialProvisioningPlan(input),
          planDigest = hashBrandInitialProvisioningPlan(plan);
        const approvalSource = createFileBrandProvisioningApprovalSource({
          approvalPath,
          trustPath,
          clock: check,
        });
        const result = await approvalSource.withApproval(
          {
            environmentReference: plan.environmentReference,
            operationReference: plan.operationReference,
            brandReference: plan.brand.brandReference,
            planDigest,
            operatorReference: plan.operatorReference,
          },
          async (approval) => {
            if (
              approval.approval.approvedByReference !== plan.approvedByReference ||
              approval.approval.approvalEvidenceReference !== plan.approvalEvidenceReference
            )
              return poison();
            retain(approval.validUntil);
            const host = createMerchantCategoryTransactions({
              run: (work) => {
                if (++runCount !== 1) return poison();
                check();
                return executeTransaction(work);
              },
            });
            let membershipFinal: (() => unknown) | undefined,
              policyFinal: (() => unknown) | undefined;
            const outcome = await host.transactions.run(async (hostTx) => {
              const query = hostTx.query;
              const tx: BrandLifecycleTransaction = Object.freeze({
                async query<Row = Record<string, unknown>>(
                  sql: string,
                  values: readonly unknown[],
                ) {
                  check();
                  if (hostTx.query !== query) return poison();
                  const answer = await query.call(hostTx, sql, values);
                  check();
                  return { rows: answer.rows as readonly Row[], rowCount: answer.rowCount ?? null };
                },
              });
              const registerBeforeCommit: Register = async (actual, guard, final) => {
                check();
                if (actual !== tx) return poison();
                await host.registerBeforeCommit(hostTx, guard, final);
                check();
              };
              let operatorIdentity: string | undefined, memberIdentity: string | undefined;
              const participantInput = (): ParticipantsRequest =>
                Object.freeze({
                  plan,
                  observedAt: check(),
                  validUntil: deadline ?? poison(),
                  registerBeforeCommit,
                });
              const currentOperator = async () => {
                check();
                await approval.assertCurrent();
                const raw = await holdOperator.call(participants, tx, participantInput());
                const actual = parseBrandInitialProvisioningOperator(raw, plan, check());
                const identity = canonicalizeRfc8785(actual.actor);
                if (operatorIdentity !== undefined && operatorIdentity !== identity)
                  return poison();
                operatorIdentity = identity;
                retain(actual.validUntil);
                return actual.actor;
              };
              // Registered before any owner mutation. Even a caught leaf failure
              // must leave an uncommittable host rather than a partial Brand.
              await registerBeforeCommit(
                tx,
                async () => {
                  await currentOperator();
                  if (failed) return poison();
                },
                () => {
                  check();
                  if (rootSealed) return poison();
                  approval.assertFinalized();
                  rootSealed = true;
                },
              );
              await currentOperator();
              const tenant = createPostgresBrandInitialCreationStore({
                brandReference: plan.brand.brandReference,
                binding: {
                  operationReference: plan.operationReference,
                  intentDigest: planDigest,
                  actorReference: plan.operatorReference,
                  auditReference: plan.brandAuditReference,
                },
                transactions: { run: (work) => work(tx) },
                async authorize(actual) {
                  if (actual !== tx) return poison();
                  await currentOperator();
                  return true;
                },
                async appendAudit(actual, committed) {
                  if (actual !== tx) return poison();
                  await appendAuditRecordInTransaction(tx, {
                    auditId: plan.brandAuditReference,
                    brandId: plan.brand.brandReference,
                    actor: { type: "User", reference: plan.operatorReference },
                    actionCode: "BRAND_CREATED",
                    targetType: "Brand",
                    targetId: plan.brand.brandReference,
                    afterSummary: {
                      operationReference: plan.operationReference,
                      planDigest,
                      approvalEvidenceReference: plan.approvalEvidenceReference,
                      approvedByReference: plan.approvedByReference,
                      lifecycle: "Draft",
                      version: 1,
                    },
                    reasonCode: "APPROVED_BRAND_INITIALIZATION",
                    correlationId: plan.operationReference,
                    occurredAt: committed.audit.occurredAt,
                    sourceChannel: "DEPLOYMENT",
                    dataClassification: "Restricted",
                    retentionPolicyCode: "BRAND_ADMINISTRATION_AUDIT",
                    retentionPolicyVersion: 1,
                  });
                },
              });
              const original = await tenant.resolveOperation(
                parseBrandAdministrationReference(plan.operationReference),
              );
              if (original) {
                assertBrandInitialProvisioningOriginal(plan, original);
                return Object.freeze({
                  profile: "BrandInitialProvisioningResultV1" as const,
                  status: "AlreadyApplied" as const,
                  operation: original,
                });
              }
              // Derive runtime timestamps only after original arbitration. An
              // original receipt never needs today's target grants or periods.
              const derived = deriveBrandInitialProvisioningRequests(plan, approval.observedAt);
              const operation = await tenant.commit({
                operation: derived.brandOperation,
                expectedBrandVersion: 0,
                audit: {
                  actorReference: parseBrandAdministrationReference(plan.operatorReference),
                  purposeCode: "BRAND_INITIAL_PROVISIONING",
                  auditReference: parseBrandAdministrationReference(plan.brandAuditReference),
                  occurredAt: derived.brand.createdAt,
                },
              });
              assertBrandInitialProvisioningOriginal(plan, operation);
              const currentMembers = async () => {
                const operator = await currentOperator();
                const raw = await holdMembers.call(participants, tx, participantInput());
                const actual = parseBrandInitialProvisioningMembers(
                  plan,
                  approval.observedAt,
                  check(),
                  operator,
                  raw,
                );
                const identity = canonicalizeRfc8785(
                  actual.members.map((member) => ({
                    ...member,
                    account: {
                      profile: member.account.profile,
                      actorType: member.account.actorType,
                      actorReference: member.account.actorReference,
                      accountKind: member.account.accountKind,
                      status: member.account.status,
                    },
                  })),
                );
                if (memberIdentity !== undefined && memberIdentity !== identity) return poison();
                memberIdentity = identity;
                retain(actual.validUntil);
                return actual;
              };
              const membership = createPostgresInitialBrandMembershipStore({
                transaction: tx,
                clock: { now: check },
                originalObservedAt: approval.observedAt,
                originalValidUntil: deadline ?? poison(),
                auditReference: plan.membershipAuditReference,
                registerBeforeCommit: async (actual, guard, final) => {
                  if (actual !== tx) return poison();
                  await registerBeforeCommit(tx, guard, final);
                },
                authority: {
                  async hold(actual, request) {
                    if (
                      actual !== tx ||
                      request.requestDigest !==
                        hashInitialBrandMembershipRequest(derived.membershipRequest) ||
                      hashInitialBrandMembershipRequest(request.request) !== request.requestDigest
                    )
                      return poison();
                    return currentMembers();
                  },
                },
                async appendAudit(actual, audit) {
                  if (actual !== tx) return poison();
                  await appendAuditRecordInTransaction(tx, {
                    auditId: audit.auditReference,
                    brandId: audit.brandReference,
                    actor: { type: "User", reference: audit.actorReference },
                    actionCode: audit.actionCode,
                    targetType: "Brand",
                    targetId: audit.brandReference,
                    afterSummary: {
                      operationReference: audit.operationReference,
                      planDigest: audit.planDigest,
                      requestDigest: audit.requestDigest,
                      approvalEvidenceReference: audit.approvalEvidenceReference,
                      membershipReferences: [...audit.membershipReferences],
                    },
                    reasonCode: "APPROVED_BRAND_INITIALIZATION",
                    correlationId: audit.operationReference,
                    occurredAt: audit.occurredAt,
                    sourceChannel: "DEPLOYMENT",
                    dataClassification: "Restricted",
                    retentionPolicyCode: "MEMBERSHIP_AUDIT",
                    retentionPolicyVersion: 1,
                  });
                },
              });
              const memberships = await membership.initialize(derived.membershipRequest);
              membershipFinal = () => membership.assertFinalized();
              const policy = createPostgresBrandInitialPolicyStore({
                transaction: tx,
                clock: { now: check },
                originalObservedAt: approval.observedAt,
                originalValidUntil: deadline ?? poison(),
                registerBeforeCommit: async (actual, guard, final) => {
                  if (actual !== tx) return poison();
                  await registerBeforeCommit(tx, guard, final);
                },
                appendAudit: appendAuditRecordInTransaction,
                authority: {
                  async hold(actual, request) {
                    if (
                      actual !== tx ||
                      request.requestDigest !==
                        hashBrandInitialPolicyRequest(derived.policyRequest) ||
                      hashBrandInitialPolicyRequest(request.request) !== request.requestDigest
                    )
                      return poison();
                    const held = await currentMembers();
                    return Object.freeze({
                      operationReference: plan.operationReference,
                      brand: derived.brand,
                      planDigest,
                      requestDigest: request.requestDigest,
                      approvalEvidenceReference: plan.approvalEvidenceReference,
                      operator: held.operator,
                      approvedByReference: plan.approvedByReference,
                      recipients: Object.freeze(
                        held.members.map((member, index) => ({
                          account: member.account,
                          membership: memberships.memberships[index] ?? poison(),
                        })),
                      ),
                      validUntil: deadline ?? poison(),
                    });
                  },
                },
              });
              await policy.initialize(derived.policyRequest);
              policyFinal = () => policy.assertFinalized();
              return Object.freeze({
                profile: "BrandInitialProvisioningResultV1" as const,
                status: "Applied" as const,
                operation,
              });
            });
            // These assertions inspect finalized state only. No failed clock/read
            // after COMMIT may turn a committed creation into a reported rollback.
            if (!rootSealed || failed || runCount !== 1) return poison();
            membershipFinal?.();
            policyFinal?.();
            return outcome;
          },
        );
        return result;
      } catch {
        return poison();
      } finally {
        closed = true;
        active = undefined;
      }
    },
  });
}
