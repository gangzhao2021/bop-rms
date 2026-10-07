import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseRawBrowserCredential, parseSelectorHash } from "../../contracts/browser-session.js";
import {
  createWorkforceInvitation,
  type WorkforceInvitation,
} from "../../contracts/workforce-identity-security.js";
import {
  parseWorkforceOnboardingConfiguration,
  parseWorkforceOnboardingOperation,
  workforceOnboardingClosed,
  workforceOnboardingFail,
  workforceOnboardingInstant,
  workforceOnboardingReference,
  type WorkforceOnboardingConfiguration,
} from "../../contracts/workforce-onboarding-operation.js";
import {
  parseWorkforceOnboardingInvitationBinding as parseBinding,
  type WorkforceOnboardingInvitationBinding,
  type WorkforceOnboardingInvitationAuthorization,
  type WorkforceOnboardingInvitationEvidence,
} from "../../contracts/workforce-onboarding-invitation.js";
export type {
  WorkforceOnboardingInvitationBinding,
  WorkforceOnboardingInvitationAuthorization,
  WorkforceOnboardingInvitationEvidence,
} from "../../contracts/workforce-onboarding-invitation.js";
import type { BrowserCredentialHasherPort } from "../../application/ports/session-credential-ports.js";

export interface WorkforceOnboardingInvitationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export type WorkforceOnboardingInvitationAccess =
  | { readonly kind: "Secret"; readonly secret: string }
  | {
      readonly kind: "AuthorizationTransaction";
      readonly authorizationTransactionReference: string;
      readonly hold: (
        tx: WorkforceOnboardingInvitationTransaction,
        input: {
          readonly authorizationTransactionReference: string;
          readonly observedAt: string;
          readonly validUntil: string;
        },
      ) => Promise<WorkforceOnboardingInvitationAuthorization>;
    };
export interface WorkforceOnboardingInvitationSourceOptions {
  readonly transaction: WorkforceOnboardingInvitationTransaction;
  readonly configuration: WorkforceOnboardingConfiguration;
  readonly access: WorkforceOnboardingInvitationAccess;
  readonly hasher: BrowserCredentialHasherPort;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: WorkforceOnboardingInvitationTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface WorkforceOnboardingInvitationSource {
  hold(): Promise<WorkforceOnboardingInvitationEvidence>;
  /** Call only with the actual invitation owner's consume result in this same
   * borrowed transaction. SQL additionally proves that its row was written here. */
  handoffAccepted(value: WorkforceInvitation): Promise<WorkforceOnboardingInvitationEvidence>;
  assertFinalized(): void;
}
const codec = Object.freeze({ canonicalize: canonicalizeRfc8785, hash: sha256Hex });
const canon = canonicalizeRfc8785;
const denied = (): never => workforceOnboardingFail("WORKFORCE_ONBOARDING_DENIED");
function one(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const d =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")
      : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length !== 1 ||
    Reflect.ownKeys(d.value).length !== 2
  )
    return denied();
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row?.enumerable || !("value" in row)) return denied();
  return workforceOnboardingClosed(row.value, keys);
}
export function createPostgresWorkforceOnboardingInvitationSource(
  options: WorkforceOnboardingInvitationSourceOptions,
): WorkforceOnboardingInvitationSource {
  workforceOnboardingClosed(options, [
    "transaction",
    "configuration",
    "access",
    "hasher",
    "clock",
    "originalObservedAt",
    "originalValidUntil",
    "registerBeforeCommit",
  ]);
  if (options.access === null || typeof options.access !== "object") return denied();
  const kind = Object.getOwnPropertyDescriptor(options.access, "kind");
  if (!kind || !("value" in kind) || !kind.enumerable) return denied();
  const tx = options.transaction,
    queryPort = tx.query,
    configurationPort = options.configuration,
    configuration = parseWorkforceOnboardingConfiguration(configurationPort),
    accessPort = options.access,
    a = workforceOnboardingClosed(
      accessPort,
      kind.value === "Secret"
        ? ["kind", "secret"]
        : ["kind", "authorizationTransactionReference", "hold"],
    ),
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    clock = options.clock,
    now = clock.now,
    register = options.registerBeforeCommit,
    origin = workforceOnboardingInstant(options.originalObservedAt),
    originalEnd = workforceOnboardingInstant(options.originalValidUntil);
  if (a.kind !== "Secret" && a.kind !== "AuthorizationTransaction") return denied();
  const secret = a.kind === "Secret" ? parseRawBrowserCredential(a.secret) : null,
    reference =
      a.kind === "AuthorizationTransaction"
        ? workforceOnboardingReference(a.authorizationTransactionReference)
        : null,
    holdAuthorization = a.kind === "AuthorizationTransaction" ? a.hold : null;
  if (
    [queryPort, hash, equals, now, register].some((p) => typeof p !== "function") ||
    (reference !== null && typeof holdAuthorization !== "function") ||
    origin >= originalEnd ||
    Date.parse(originalEnd) > Date.parse(origin) + 5000
  )
    return denied();
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    guarded = false,
    latest = origin,
    deadline: string = originalEnd,
    txid: string | undefined,
    selector: string | undefined,
    pinnedAuthorization: string | undefined,
    pinnedRecord: string | undefined,
    pinnedInvitation: string | undefined,
    accepted: WorkforceInvitation | undefined,
    expectedBinding: WorkforceOnboardingInvitationBinding | undefined;
  const poison = (): never => {
    phase = "Poison";
    return denied();
  };
  const check = () => {
    try {
      const at = workforceOnboardingInstant(now.call(clock));
      const currentAccess = workforceOnboardingClosed(
        accessPort,
        secret !== null
          ? ["kind", "secret"]
          : ["kind", "authorizationTransactionReference", "hold"],
      );
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.transaction !== tx ||
        tx.query !== queryPort ||
        options.configuration !== configurationPort ||
        canon(parseWorkforceOnboardingConfiguration(configurationPort)) !== canon(configuration) ||
        options.access !== accessPort ||
        currentAccess.kind !== a.kind ||
        (secret !== null
          ? currentAccess.secret !== secret
          : currentAccess.authorizationTransactionReference !== reference ||
            currentAccess.hold !== holdAuthorization) ||
        options.hasher !== hasher ||
        hasher.hash !== hash ||
        hasher.equals !== equals ||
        options.clock !== clock ||
        clock.now !== now ||
        options.registerBeforeCommit !== register ||
        options.originalObservedAt !== origin ||
        options.originalValidUntil !== originalEnd ||
        at < latest ||
        at >= deadline
      )
        return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const sameTx = async () => {
    const r = one(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,pg_current_xact_id()::text AS transaction_id",
        [],
      ),
      ["isolation", "transaction_id"],
    );
    if (
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(r.transaction_id) ||
      (txid !== undefined && txid !== r.transaction_id)
    )
      return poison();
    txid = r.transaction_id;
  };
  const authorization = async () => {
    if (secret !== null) {
      if (selector === undefined) selector = parseSelectorHash(hash.call(hasher, secret));
      check();
      return;
    }
    if (typeof holdAuthorization !== "function" || reference === null) return poison();
    const at = check(),
      packet = await holdAuthorization.call(accessPort, tx, {
        authorizationTransactionReference: reference,
        observedAt: at,
        validUntil: deadline,
      });
    check();
    const r = workforceOnboardingClosed(packet, [
        "authorizationTransactionReference",
        "binding",
        "consumedAt",
        "observedAt",
        "validUntil",
      ]),
      binding = parseBinding(r.binding),
      consumedAt = workforceOnboardingInstant(r.consumedAt),
      observedAt = workforceOnboardingInstant(r.observedAt),
      until = workforceOnboardingInstant(r.validUntil);
    if (
      r.authorizationTransactionReference !== reference ||
      canon(binding.configuration) !== canon(configuration) ||
      consumedAt > origin ||
      observedAt < origin ||
      observedAt > latest ||
      until <= latest ||
      until > deadline ||
      until <= observedAt
    )
      return poison();
    const pin = canon({ authorizationTransactionReference: reference, binding, consumedAt });
    if (pinnedAuthorization !== undefined && pin !== pinnedAuthorization) return poison();
    pinnedAuthorization = pin;
    expectedBinding = binding;
    selector = binding.selectorHash;
    deadline = until;
    check();
  };
  const read = async (): Promise<WorkforceOnboardingInvitationEvidence> => {
    await authorization();
    await sameTx();
    await sameTx();
    if (selector === undefined) return poison();
    const r = one(
      await query("SELECT * FROM bop_identity.workforce_onboarding_invitation_read($1,$2,$3,$4)", [
        selector,
        configuration.environment,
        configuration.issuer,
        configuration.clientId,
      ]),
      ["snapshot_text", "source_digest", "invitation_json", "precise", "invitation_written_here"],
    );
    if (r.precise !== true || typeof r.snapshot_text !== "string" || r.snapshot_text.length > 32768)
      return poison();
    const record = parseWorkforceOnboardingOperation(JSON.parse(r.snapshot_text), codec),
      invitation = createWorkforceInvitation(r.invitation_json);
    if (
      r.source_digest !== record.sourceDigest ||
      canon(record) !== r.snapshot_text ||
      record.state !== "ProviderObserved" ||
      record.provider === null ||
      record.createdAt > origin ||
      record.occurredAt > latest ||
      record.expiresAt <= latest ||
      canon(record.original.configuration) !== canon(configuration) ||
      equals.call(hasher, parseSelectorHash(record.selectorHash), parseSelectorHash(selector)) !==
        true ||
      invitation.invitationReference !== record.invitationReference ||
      invitation.actorReference !== record.original.actorReference ||
      invitation.inviterActorReference !== record.original.operatorReference ||
      invitation.membershipReference !== record.original.membershipReference ||
      invitation.selectorHash !== record.selectorHash ||
      invitation.emailDigest !== record.original.emailDigest ||
      canon(invitation.storeAssignmentReferences) !==
        canon(record.original.storeAssignmentReferences) ||
      invitation.createdAt !== record.createdAt ||
      invitation.expiresAt !== record.expiresAt
    )
      return poison();
    check();
    const binding = parseBinding({
      configuration,
      invitationReference: record.invitationReference,
      originalIntentDigest: record.intentDigest,
      selectorHash: record.selectorHash,
    });
    if (
      (expectedBinding !== undefined && canon(binding) !== canon(expectedBinding)) ||
      (pinnedRecord !== undefined && canon(record) !== pinnedRecord)
    )
      return poison();
    if (accepted !== undefined) {
      if (r.invitation_written_here !== true || canon(invitation) !== canon(accepted))
        return poison();
    } else if (
      invitation.status !== "Pending" ||
      invitation.version !== 1 ||
      invitation.consumedAt !== null ||
      invitation.providerEvidenceReference !== null ||
      (pinnedInvitation !== undefined && canon(invitation) !== pinnedInvitation)
    )
      return poison();
    pinnedRecord = canon(record);
    pinnedInvitation ??= canon(invitation);
    expectedBinding ??= binding;
    deadline = record.expiresAt < deadline ? record.expiresAt : deadline;
    await authorization();
    await sameTx();
    check();
    return Object.freeze({
      profile: "WorkforceOnboardingInvitationEvidenceV1",
      binding,
      record,
      invitation,
      observedAt: origin,
      validUntil: deadline,
    });
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || guarded) return poison();
    busy = true;
    try {
      await read();
      check();
      guarded = true;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const final = () => {
    if (busy || phase !== "Ready" || !guarded) return poison();
    check();
    phase = "Final";
  };
  const protect = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy || guarded || phase === "Final" || phase === "Poison") return poison();
    busy = true;
    try {
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
  return Object.freeze({
    hold() {
      return protect(read);
    },
    handoffAccepted(value: WorkforceInvitation) {
      return protect(async () => {
        if (reference === null || pinnedInvitation === undefined || accepted !== undefined)
          return poison();
        const pending = createWorkforceInvitation(JSON.parse(pinnedInvitation)),
          actual = createWorkforceInvitation(value);
        if (
          actual.status !== "Accepted" ||
          actual.version !== 2 ||
          actual.providerEvidenceReference === null ||
          actual.consumedAt === null ||
          actual.consumedAt < origin ||
          actual.consumedAt > latest ||
          actual.consumedAt >= actual.expiresAt ||
          canon({
            ...actual,
            status: pending.status,
            version: pending.version,
            providerEvidenceReference: pending.providerEvidenceReference,
            consumedAt: pending.consumedAt,
          }) !== canon(pending)
        )
          return poison();
        accepted = actual;
        return read();
      });
    },
    assertFinalized() {
      if (phase !== "Final" || busy || !guarded) return denied();
    },
  });
}
