import { createIdentityActor, readClosedRecord } from "../../contracts/identity-actor.js";
import { parseCurrentWorkforceAccount } from "../../contracts/current-workforce-account.js";
import {
  parseWorkforceAccountBinding,
  parseWorkforceAccountBindingConfiguration,
  parseWorkforceAccountBindingInstant,
  parseWorkforceAccountBindingReference,
  parseWorkforceAccountBindingSubject,
  workforceAccountBindingFail,
  workforceAccountSubjectContext,
} from "../../contracts/workforce-account-binding.js";
import { parseSecurityVersion } from "../../contracts/workforce-identity-security.js";
import { createCognitoSubjectStatus } from "../cognito-subject-status.js";
import {
  workforceAccountBindingCodec,
  workforceAccountBindingSubjectHash,
} from "./workforce-account-binding-provisioner.js";
import type {
  CurrentWorkforceAccountSourceOptions,
  CurrentWorkforceAccountTransaction,
} from "./current-workforce-account-source.js";
import type { WorkforceAuthenticationSourceOptions } from "./workforce-authentication-source.js";

type FixedProfile =
  | { readonly kind: "InitialProvisioning"; readonly options: CurrentWorkforceAccountSourceOptions }
  | { readonly kind: "Authentication"; readonly options: WorkforceAuthenticationSourceOptions };
interface Selector {
  readonly actorReference: string | null;
  readonly subject: string | null;
}
const denied = (): never => workforceAccountBindingFail("WORKFORCE_ACCOUNT_BINDING_DENIED");
function one(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const descriptor =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")
      : undefined;
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    Object.getPrototypeOf(descriptor.value) !== Array.prototype ||
    descriptor.value.length !== 1 ||
    Reflect.ownKeys(descriptor.value).length !== 2
  )
    return denied();
  const row = Object.getOwnPropertyDescriptor(descriptor.value, "0");
  if (!row?.enumerable || !("value" in row)) return denied();
  return readClosedRecord(row.value, keys);
}

/** Private, fixed Identity entry points share owning facts and COMMIT guards.
 * Only the public factories choose a profile; neither accepts a caller purpose,
 * account kind or Provider verdict. Raw subjects never leave this kernel. */
export function createWorkforceAccountReadKernel(profile: FixedProfile) {
  const options = profile.options,
    initial = profile.kind === "InitialProvisioning" ? profile.options : null;
  readClosedRecord(options, [
    "transaction",
    "configuration",
    "hasher",
    "envelopes",
    "clock",
    "originalObservedAt",
    "originalValidUntil",
    "registerBeforeCommit",
    ...(initial ? ["actorReference", "authority"] : []),
  ]);
  const configuration = parseWorkforceAccountBindingConfiguration(options.configuration),
    originalConfiguration = options.configuration,
    configurationBytes = workforceAccountBindingCodec.canonicalize(configuration),
    initialActor = initial ? parseWorkforceAccountBindingReference(initial.actorReference) : null,
    purpose = initial ? "BRAND_INITIAL_PROVISIONING" : "WORKFORCE_AUTHENTICATION",
    tx = options.transaction,
    originalQuery = tx.query,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    decrypt = envelopes.decrypt,
    clock = options.clock,
    now = clock.now,
    authority = initial?.authority,
    holdAuthority = authority?.hold,
    register = options.registerBeforeCommit,
    observedAt = parseWorkforceAccountBindingInstant(options.originalObservedAt),
    originalDeadline = parseWorkforceAccountBindingInstant(options.originalValidUntil);
  if (
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [originalQuery, hash, equals, decrypt, now, register, ...(initial ? [holdAuthority] : [])].some(
      (port) => typeof port !== "function",
    )
  )
    return denied();
  const provider = createCognitoSubjectStatus({
    userPoolId: configuration.issuer.slice(configuration.issuer.lastIndexOf("/") + 1),
    clock,
  });
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false,
    latest = observedAt,
    deadline = originalDeadline,
    transactionId: string | undefined,
    pinned:
      | { readonly actorReference: string; readonly binding: string; readonly invitation: string }
      | undefined;
  const poison = (): never => {
    phase = "Poison";
    return denied();
  };
  const check = () => {
    const at = parseWorkforceAccountBindingInstant(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      options.transaction !== tx ||
      tx.query !== originalQuery ||
      options.configuration !== originalConfiguration ||
      workforceAccountBindingCodec.canonicalize(
        parseWorkforceAccountBindingConfiguration(options.configuration),
      ) !== configurationBytes ||
      options.hasher !== hasher ||
      hasher.hash !== hash ||
      hasher.equals !== equals ||
      options.envelopes !== envelopes ||
      envelopes.decrypt !== decrypt ||
      options.clock !== clock ||
      clock.now !== now ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== observedAt ||
      options.originalValidUntil !== originalDeadline ||
      (initial &&
        (initial.actorReference !== initialActor ||
          initial.authority !== authority ||
          authority?.hold !== holdAuthority)) ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await originalQuery.call(tx, sql, values);
    check();
    return result;
  };
  const currentAuthority = async () => {
    // Authentication has its own fixed identity lookup purpose. It does not
    // claim initial-provisioning read authority or manufacture an allowed port.
    if (!initial) return;
    if (!authority || !holdAuthority || !initialActor) return poison();
    const at = check(),
      held = readClosedRecord(
        await holdAuthority.call(authority, tx, {
          actorReference: initialActor,
          purposeCode: "BRAND_INITIAL_PROVISIONING",
          observedAt: at,
          validUntil: deadline,
        }),
        ["actorReference", "purposeCode", "observedAt", "validUntil"],
      );
    check();
    const until = parseWorkforceAccountBindingInstant(held.validUntil);
    if (
      held.actorReference !== initialActor ||
      held.purposeCode !== "BRAND_INITIAL_PROVISIONING" ||
      held.observedAt !== at ||
      until <= latest ||
      until > deadline
    )
      return poison();
    deadline = until;
  };
  const sameTransaction = async () => {
    const row = one(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,pg_current_xact_id()::text AS transaction_id",
        [],
      ),
      ["isolation", "transaction_id"],
    );
    if (
      row.isolation !== "read committed" ||
      typeof row.transaction_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(row.transaction_id) ||
      (transactionId !== undefined && transactionId !== row.transaction_id)
    )
      return poison();
    transactionId = row.transaction_id;
  };
  const scope = async (actorReference: string | null, subjectHash: string | null) => {
    await query(
      "SELECT set_config('bop.workforce_account_environment',$1,true),set_config('bop.workforce_account_issuer',$2,true),set_config('bop.workforce_account_actor_id',$3,true),set_config('bop.workforce_account_subject_hash',$4,true),set_config('bop.workforce_account_purpose',$5,true)",
      [
        configuration.environment,
        configuration.issuer,
        actorReference ?? "",
        subjectHash ?? "",
        purpose,
      ],
    );
  };
  const inspect = async (selector: Selector) => {
    await currentAuthority();
    await sameTransaction();
    const subjectHash =
      selector.subject === null
        ? null
        : workforceAccountBindingSubjectHash(hasher, configuration, selector.subject);
    check();
    await scope(selector.actorReference, subjectHash);
    const row = one(
      await query(
        "SELECT snapshot_text,source_digest,coherent FROM bop_identity.workforce_account_binding_read($1,$2,$3,$4)",
        [selector.actorReference, subjectHash, configuration.issuer, configuration.environment],
      ),
      ["snapshot_text", "source_digest", "coherent"],
    );
    if (
      row.coherent !== true ||
      typeof row.snapshot_text !== "string" ||
      row.snapshot_text.length > 16_384
    )
      return poison();
    const binding = parseWorkforceAccountBinding(
        JSON.parse(row.snapshot_text),
        workforceAccountBindingCodec,
      ),
      bytes = workforceAccountBindingCodec.canonicalize(binding);
    if (
      bytes !== row.snapshot_text ||
      binding.sourceDigest !== row.source_digest ||
      (selector.actorReference !== null && binding.actorReference !== selector.actorReference) ||
      (subjectHash !== null && equals.call(hasher, binding.subjectHash, subjectHash) !== true) ||
      binding.recordedAt > observedAt ||
      workforceAccountBindingCodec.canonicalize(binding.configuration) !== configurationBytes ||
      (pinned !== undefined &&
        (pinned.actorReference !== binding.actorReference || pinned.binding !== bytes))
    )
      return poison();
    const plaintext = await decrypt.call(
      envelopes,
      binding.encryptedSubject,
      workforceAccountSubjectContext(configuration, binding.actorReference),
    );
    check();
    if (typeof plaintext !== "string" || plaintext.length > 1024) return poison();
    const subject = parseWorkforceAccountBindingSubject(
        readClosedRecord(JSON.parse(plaintext), ["subject"]).subject,
      ),
      actualHash = workforceAccountBindingSubjectHash(hasher, configuration, subject);
    check();
    if (
      (selector.subject !== null && selector.subject !== subject) ||
      equals.call(hasher, binding.subjectHash, actualHash) !== true
    )
      return poison();
    // Subject lookup yields the genuine Actor. Never carry caller-selected
    // Actor authority into the original invitation read.
    await scope(binding.actorReference, null);
    const invitation = one(
      await query(
        "SELECT invitation_id,actor_id,membership_id,status,provider_evidence_id,version,created_at,expires_at,consumed_at,precise FROM bop_identity.workforce_account_invitation_read($1,$2)",
        [binding.actorReference, binding.invitationReference],
      ),
      [
        "invitation_id",
        "actor_id",
        "membership_id",
        "status",
        "provider_evidence_id",
        "version",
        "created_at",
        "expires_at",
        "consumed_at",
        "precise",
      ],
    );
    const original = Object.freeze({
      invitationReference: parseWorkforceAccountBindingReference(invitation.invitation_id),
      actorReference: parseWorkforceAccountBindingReference(invitation.actor_id),
      originalMembershipReference: parseWorkforceAccountBindingReference(invitation.membership_id),
      providerEvidenceReference: parseWorkforceAccountBindingReference(
        invitation.provider_evidence_id,
      ),
      version: parseSecurityVersion(invitation.version),
      createdAt: parseWorkforceAccountBindingInstant(invitation.created_at),
      expiresAt: parseWorkforceAccountBindingInstant(invitation.expires_at),
      consumedAt: parseWorkforceAccountBindingInstant(invitation.consumed_at),
    });
    if (
      invitation.status !== "Accepted" ||
      invitation.precise !== true ||
      original.actorReference !== binding.actorReference ||
      original.invitationReference !== binding.invitationReference ||
      original.originalMembershipReference !== binding.originalMembershipReference ||
      original.providerEvidenceReference !== binding.providerEvidenceReference ||
      original.createdAt > observedAt ||
      original.consumedAt > observedAt ||
      Date.parse(original.expiresAt) !== Date.parse(original.createdAt) + 86_400_000 ||
      original.consumedAt < original.createdAt ||
      original.consumedAt >= original.expiresAt
    )
      return poison();
    const invitationBytes = workforceAccountBindingCodec.canonicalize(original);
    if (pinned !== undefined && pinned.invitation !== invitationBytes) return poison();
    pinned = Object.freeze({
      actorReference: binding.actorReference,
      binding: bytes,
      invitation: invitationBytes,
    });
    const providerAt = check(),
      status = await provider.readCurrentProviderSubject({
        issuer: configuration.issuer,
        subject,
        observedAt: providerAt,
      });
    check();
    if (
      status.status !== "Enabled" ||
      status.issuer !== configuration.issuer ||
      status.subject !== subject ||
      status.observedAt !== providerAt
    )
      return poison();
    const providerUntil = parseWorkforceAccountBindingInstant(status.validUntil);
    if (providerUntil <= latest || Date.parse(providerUntil) > Date.parse(providerAt) + 5000)
      return poison();
    if (providerUntil < deadline) deadline = providerUntil;
    await currentAuthority();
    await sameTransaction();
    await scope(binding.actorReference, null);
    check();
    return binding.actorReference;
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || ++asyncCalls !== 1 || !pinned) return poison();
    busy = true;
    try {
      await inspect({ actorReference: pinned.actorReference, subject: null });
      check();
      asyncComplete = true;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const final = () => {
    try {
      if (busy || phase !== "Ready" || !asyncComplete || ++finalCalls !== 1) return poison();
      check();
      phase = "Final";
    } catch {
      return poison();
    }
  };
  const execute = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy || phase === "Final") return poison();
    busy = true;
    try {
      // A caught malformed authentication request must still prevent the host
      // from committing an earlier owning write.
      if (!registered) {
        registered = true;
        await register(tx, guard, final);
      }
      check();
      const result = await work();
      check();
      phase = "Ready";
      return result;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const authenticationTime = (auth: unknown, observation: unknown) => {
    const at = parseWorkforceAccountBindingInstant(observation),
      authenticatedAt = parseWorkforceAccountBindingInstant(auth);
    if (at < observedAt || at > check() || authenticatedAt > at) return poison();
    return authenticatedAt;
  };
  const actor = (actorReference: string, authenticatedAt: string) =>
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
  return Object.freeze({
    holdAccount: () =>
      execute(async () => {
        if (!initial || !initialActor) return poison();
        const actorReference = await inspect({ actorReference: initialActor, subject: null });
        return parseCurrentWorkforceAccount({
          profile: "CurrentWorkforceAccountV1",
          actorType: "User",
          actorReference,
          accountKind: "Workforce",
          status: "Active",
          observedAt,
          validUntil: deadline,
        });
      }),
    resolveVerifiedSubject: (value: unknown) =>
      execute(async () => {
        if (initial) return poison();
        const input = readClosedRecord(value, [
          "issuer",
          "clientId",
          "subject",
          "authenticatedAt",
          "observedAt",
        ]);
        if (
          input.issuer !== configuration.issuer ||
          typeof input.clientId !== "string" ||
          !configuration.clientIds.includes(input.clientId)
        )
          return poison();
        const authenticatedAt = authenticationTime(input.authenticatedAt, input.observedAt),
          subject = parseWorkforceAccountBindingSubject(input.subject),
          actorReference = await inspect({ actorReference: null, subject });
        return actor(actorReference, authenticatedAt);
      }),
    currentActor: (
      actualTx: CurrentWorkforceAccountTransaction,
      reference: string,
      auth: string,
      at: string,
    ) =>
      execute(async () => {
        if (initial || actualTx !== tx) return poison();
        const actorReference = parseWorkforceAccountBindingReference(reference),
          authenticatedAt = authenticationTime(auth, at);
        await inspect({ actorReference, subject: null });
        return actor(actorReference, authenticatedAt);
      }),
    assertFinalized() {
      if (phase !== "Final" || busy || asyncCalls !== 1 || finalCalls !== 1 || !asyncComplete)
        return poison();
    },
  });
}
