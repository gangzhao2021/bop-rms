import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseSelectorHash } from "../contracts/browser-session.js";
import { createWorkforceInvitation } from "../contracts/workforce-identity-security.js";
import {
  buildWorkforceOnboardingOperation,
  parseWorkforceOnboardingOriginal,
  workforceOnboardingIntent,
  workforceOnboardingSubjectContext,
} from "../contracts/workforce-onboarding-operation.js";
import {
  createPostgresWorkforceOnboardingInvitationSource,
  type WorkforceOnboardingInvitationAccess,
  type WorkforceOnboardingInvitationAuthorization,
} from "../infrastructure/persistence/workforce-onboarding-invitation-source.js";
import { parseWorkforceOnboardingInvitationBinding } from "../contracts/workforce-onboarding-invitation.js";

const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const createdAt = "2026-10-06T12:00:00.000Z",
  at = "2026-10-06T12:00:01.000Z",
  until = "2026-10-06T12:00:06.000Z",
  expiresAt = "2026-10-07T12:00:00.000Z";
const codec = { canonicalize: canonicalizeRfc8785, hash: sha256Hex };
/** Controlled SQL and consumed-OIDC holder are composition unit evidence, not
 * actual invitation acceptance, Provider verification or native RLS evidence. */
function fixture(callback = false, observation = at) {
  const secret = "A".repeat(43),
    selectorHash = parseSelectorHash(sha256Hex(secret));
  const configuration = {
    environment: "controlled",
    issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
    clientId: "controlledclient",
  };
  const original = parseWorkforceOnboardingOriginal({
    profile: "WorkforceOnboardingOriginalV1",
    configuration,
    operationReference: id(1),
    operatorReference: id(2),
    actorReference: id(3),
    brandReference: id(4),
    membershipReference: id(5),
    storeAssignmentReferences: [],
    emailDigest: "b".repeat(64),
    approvedByReference: id(6),
    approvalEvidenceReference: id(7),
    relationshipEvidenceReference: id(8),
    approvedPlanDigest: `sha256:${"c".repeat(64)}`,
    reasonCode: "APPROVED_ONBOARDING",
  });
  const record = buildWorkforceOnboardingOperation(
    {
      profile: "WorkforceOnboardingOperationV1",
      original,
      intentDigest: workforceOnboardingIntent(original, codec),
      version: 3,
      state: "ProviderObserved",
      invitationReference: id(9),
      selectorHash,
      createdAt,
      expiresAt,
      dispatchStartedAt: createdAt,
      provider: {
        subjectHash: "d".repeat(64),
        encryptedSubject: {
          algorithm: "SYNTHETIC_AES_256_GCM",
          keyReference: "controlled-key",
          ciphertext: "B".repeat(64),
          encryptionContext: workforceOnboardingSubjectContext(original),
        },
        username: `bop_${original.actorReference}`,
        createdAt,
        status: "FORCE_CHANGE_PASSWORD",
        enabled: true,
      },
      phaseOperationReference: id(10),
      phaseRequestDigest: `sha256:${"e".repeat(64)}`,
      previousSourceDigest: `sha256:${"f".repeat(64)}`,
      auditReference: id(11),
      occurredAt: createdAt,
    },
    codec,
  );
  let invitation = createWorkforceInvitation({
    invitationReference: record.invitationReference,
    actorReference: original.actorReference,
    inviterActorReference: original.operatorReference,
    membershipReference: original.membershipReference,
    storeAssignmentReferences: [],
    emailDigest: original.emailDigest,
    selectorHash,
    status: "Pending",
    createdAt,
    expiresAt,
    consumedAt: null,
    providerEvidenceReference: null,
    version: 1,
  });
  let current = observation,
    writtenHere = false,
    autocommit = false,
    transactionId = 40,
    authorizationChange: Partial<WorkforceOnboardingInvitationAuthorization> = {},
    missing = false,
    malformedDigest = false;
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    queries: string[] = [];
  const transaction = {
    async query(sql: string, values: readonly unknown[]) {
      queries.push(sql);
      if (sql.includes("transaction_isolation"))
        return {
          rows: [
            {
              isolation: "read committed",
              transaction_id: String(autocommit ? transactionId++ : transactionId),
            },
          ],
        };
      expect(sql).toBe(
        "SELECT * FROM bop_identity.workforce_onboarding_invitation_read($1,$2,$3,$4)",
      );
      expect(values).toEqual([
        selectorHash,
        configuration.environment,
        configuration.issuer,
        configuration.clientId,
      ]);
      return {
        rows: missing
          ? []
          : [
              {
                snapshot_text: canonicalizeRfc8785(record),
                source_digest: malformedDigest ? `sha256:${"0".repeat(64)}` : record.sourceDigest,
                invitation_json: invitation,
                precise: true,
                invitation_written_here: writtenHere,
              },
            ],
      };
    },
  };
  const binding = {
    configuration,
    invitationReference: record.invitationReference,
    originalIntentDigest: record.intentDigest,
    selectorHash,
  };
  const access: WorkforceOnboardingInvitationAccess = callback
    ? {
        kind: "AuthorizationTransaction",
        authorizationTransactionReference: id(12),
        async hold(tx, request) {
          expect(tx).toBe(transaction);
          return {
            authorizationTransactionReference: request.authorizationTransactionReference,
            binding,
            consumedAt: observation,
            observedAt: request.observedAt,
            validUntil: request.validUntil,
            ...authorizationChange,
          };
        },
      }
    : { kind: "Secret", secret };
  const hasher = {
    hash: (value: string) => parseSelectorHash(sha256Hex(value)),
    equals: (left: string, right: string) => left === right,
  };
  const clock = { now: () => current };
  const source = createPostgresWorkforceOnboardingInvitationSource({
    transaction,
    configuration,
    access,
    hasher,
    clock,
    originalObservedAt: observation,
    originalValidUntil: new Date(Date.parse(observation) + 5000).toISOString(),
    async registerBeforeCommit(tx, guard, final) {
      expect(tx).toBe(transaction);
      guards.push(guard);
      finals.push(final);
    },
  });
  return {
    source,
    record,
    binding,
    transaction,
    hasher,
    clock,
    guards,
    finals,
    queries,
    move(value: string) {
      current = value;
    },
    authority(value: Partial<WorkforceOnboardingInvitationAuthorization>) {
      authorizationChange = value;
    },
    noRow() {
      missing = true;
    },
    badDigest() {
      malformedDigest = true;
    },
    autocommit() {
      autocommit = true;
    },
    accept(own = true) {
      invitation = createWorkforceInvitation({
        ...invitation,
        status: "Accepted",
        consumedAt: observation,
        providerEvidenceReference: id(13),
        version: 2,
      });
      writtenHere = own;
      return invitation;
    },
    revoke() {
      invitation = createWorkforceInvitation({ ...invitation, status: "Revoked", version: 2 });
    },
    async finalize() {
      for (const guard of guards) await guard();
      for (const final of finals) final();
    },
  };
}
describe("invitation-bound original source", () => {
  it("keeps the pure encrypted authorization binding closed and detached", () => {
    const f = fixture(),
      parsed = parseWorkforceOnboardingInvitationBinding(f.binding);
    expect(parsed).toEqual(f.binding);
    expect(Object.isFrozen(parsed.configuration)).toBe(true);
    expect(() =>
      parseWorkforceOnboardingInvitationBinding({ ...f.binding, secret: "A".repeat(43) }),
    ).toThrow();
    expect(() =>
      parseWorkforceOnboardingInvitationBinding({ ...f.binding, selectorHash: "bad" }),
    ).toThrow();
  });
  it("resolves a POST secret through the fixed owning reader without inviter identity or raw secret output", async () => {
    const f = fixture(),
      result = await f.source.hold();
    expect(result.binding).toEqual(f.binding);
    expect(result.record).toEqual(f.record);
    expect(result.invitation.status).toBe("Pending");
    expect(Object.isFrozen(result)).toBe(true);
    expect(canonicalizeRfc8785(result)).not.toContain("A".repeat(43));
    expect(f.queries.every((sql) => !sql.includes("INSERT") && !sql.includes("UPDATE"))).toBe(true);
    await f.finalize();
    f.move(expiresAt);
    f.source.assertFinalized();
  });
  it("pins actual consumed authorization reference, invitation binding and consumption time", async () => {
    const f = fixture(true);
    await f.source.hold();
    f.authority({ consumedAt: createdAt });
    await expect(f.finalize()).rejects.toThrow();
    f.authority({});
    await expect(f.source.hold()).rejects.toThrow();
  });
  it.each(["reference", "invitation", "intent", "configuration"])(
    "rejects a callback holder with another %s",
    async (change) => {
      const f = fixture(true);
      f.authority(
        change === "reference"
          ? { authorizationTransactionReference: id(99) }
          : {
              binding: {
                ...f.binding,
                ...(change === "invitation"
                  ? { invitationReference: id(99) }
                  : change === "intent"
                    ? { originalIntentDigest: `sha256:${"0".repeat(64)}` }
                    : { configuration: { ...f.binding.configuration, clientId: "otherclient" } }),
              },
            },
      );
      await expect(f.source.hold()).rejects.toThrow();
      await expect(f.finalize()).rejects.toThrow();
    },
  );
  it("allows only an explicit exact same-transaction consume handoff", async () => {
    const f = fixture(true);
    await f.source.hold();
    const accepted = f.accept();
    expect((await f.source.handoffAccepted(accepted)).invitation).toEqual(accepted);
    await f.finalize();
    f.source.assertFinalized();
  });
  it.each(["prior", "implicit", "secret"])(
    "refuses %s acceptance without the exact allowed handoff",
    async (mode) => {
      const f = fixture(mode !== "secret");
      if (mode === "prior") {
        f.accept(false);
        await expect(f.source.hold()).rejects.toThrow();
      } else {
        await f.source.hold();
        const accepted = f.accept();
        await expect(
          mode === "implicit" ? f.finalize() : f.source.handoffAccepted(accepted),
        ).rejects.toThrow();
      }
      expect(() => f.source.assertFinalized()).toThrow();
    },
  );
  it("rejects a forged consume result even when another actual row was changed here", async () => {
    const f = fixture(true);
    await f.source.hold();
    const actual = f.accept();
    const wrong = createWorkforceInvitation({ ...actual, providerEvidenceReference: id(99) });
    await expect(f.source.handoffAccepted(wrong)).rejects.toThrow();
    await expect(f.finalize()).rejects.toThrow();
  });
  it.each(["missing", "digest", "autocommit"])(
    "fails closed and poisons registered guards after %s",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") f.noRow();
      else if (mode === "digest") f.badDigest();
      else f.autocommit();
      await expect(f.source.hold()).rejects.toThrow();
      expect(f.guards).toHaveLength(1);
      await expect(f.finalize()).rejects.toThrow();
    },
  );
  it("holds the original deadline through the final synchronous seal and does not renew it", async () => {
    const f = fixture();
    await f.source.hold();
    await f.guards[0]?.();
    f.move(until);
    expect(() => f.finals[0]?.()).toThrow();
    f.move(at);
    expect(() => f.finals[0]?.()).toThrow();
  });
  it("shrinks the lease to the original 24h expiry and rejects current withdrawal", async () => {
    const f = fixture(false, "2026-10-07T11:59:59.000Z");
    expect((await f.source.hold()).validUntil).toBe(expiresAt);
    f.move(expiresAt);
    await expect(f.finalize()).rejects.toThrow();
    const g = fixture();
    await g.source.hold();
    g.revoke();
    await expect(g.finalize()).rejects.toThrow();
  });
  it("poisons invalid final clocks and captured query-port drift", async () => {
    const f = fixture();
    await f.source.hold();
    await f.guards[0]?.();
    f.move("bad");
    expect(() => f.finals[0]?.()).toThrow();
    f.move(at);
    expect(() => f.finals[0]?.()).toThrow();
    const g = fixture();
    await g.source.hold();
    Object.defineProperty(g.transaction, "query", { value: async () => ({ rows: [] }) });
    await expect(g.finalize()).rejects.toThrow();
  });
  it("rejects truthy nonboolean hasher equality", async () => {
    const f = fixture();
    Object.defineProperty(f.hasher, "equals", { value: () => "true" });
    await expect(f.source.hold()).rejects.toThrow();
  });
});
