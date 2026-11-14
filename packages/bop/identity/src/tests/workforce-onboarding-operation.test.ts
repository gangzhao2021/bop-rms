import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseWorkforceOnboardingOriginal,
  workforceOnboardingIntent,
  buildWorkforceOnboardingOperation,
  parseWorkforceOnboardingOperation,
  assertWorkforceOnboardingTransition,
  workforceOnboardingSubjectContext,
} from "../contracts/workforce-onboarding-operation.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  end = "2026-10-07T12:00:00.000Z";
const codec = { canonicalize: canonicalizeRfc8785, hash: sha256Hex };
function original() {
  return parseWorkforceOnboardingOriginal({
    profile: "WorkforceOnboardingOriginalV1",
    configuration: {
      environment: "controlled",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
      clientId: "controlledclient",
    },
    operationReference: id(1),
    operatorReference: id(2),
    actorReference: id(3),
    brandReference: id(4),
    membershipReference: id(5),
    storeAssignmentReferences: [],
    emailDigest: "a".repeat(64),
    approvedByReference: id(6),
    approvalEvidenceReference: id(7),
    relationshipEvidenceReference: id(8),
    approvedPlanDigest: `sha256:${"b".repeat(64)}`,
    reasonCode: "APPROVED_ONBOARDING",
  });
}
function prepared() {
  const o = original();
  return buildWorkforceOnboardingOperation(
    {
      profile: "WorkforceOnboardingOperationV1",
      original: o,
      intentDigest: workforceOnboardingIntent(o, codec),
      version: 1,
      state: "Prepared",
      invitationReference: id(9),
      selectorHash: "c".repeat(64),
      createdAt: at,
      expiresAt: end,
      dispatchStartedAt: null,
      provider: null,
      phaseOperationReference: id(10),
      phaseRequestDigest: `sha256:${"d".repeat(64)}`,
      previousSourceDigest: null,
      auditReference: id(11),
      occurredAt: at,
    },
    codec,
  );
}
function phase(previous: ReturnType<typeof prepared>, changes: Record<string, unknown>) {
  const { sourceDigest, ...body } = previous;
  return buildWorkforceOnboardingOperation(
    {
      ...body,
      version: previous.version + 1,
      previousSourceDigest: sourceDigest,
      phaseOperationReference: id(20 + previous.version),
      auditReference: id(30 + previous.version),
      ...changes,
    },
    codec,
  );
}
describe("Workforce durable onboarding contracts", () => {
  it("detaches and hashes the approved scope without a selector or delivery claim", () => {
    const o = original(),
      p = prepared();
    expect(parseWorkforceOnboardingOperation(p, codec)).toEqual(p);
    expect(Object.isFrozen(o.configuration)).toBe(true);
    expect(Object.isFrozen(o.storeAssignmentReferences)).toBe(true);
    expect(canonicalizeRfc8785(p)).not.toContain("deliverySecret");
    expect(() => parseWorkforceOnboardingOriginal({ ...o, encryptedSelector: "secret" })).toThrow();
    expect(() => parseWorkforceOnboardingOperation({ ...p, selector: "secret" }, codec)).toThrow();
  });
  it.each([
    "brandReference",
    "membershipReference",
    "operatorReference",
    "actorReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "relationshipEvidenceReference",
  ])("includes %s in the immutable intent", (key) => {
    const o = original();
    expect(
      workforceOnboardingIntent(parseWorkforceOnboardingOriginal({ ...o, [key]: id(99) }), codec),
    ).not.toBe(workforceOnboardingIntent(o, codec));
  });
  it("includes the complete approved plan, email and configuration in intent", () => {
    const o = original();
    for (const change of [
      { approvedPlanDigest: `sha256:${"e".repeat(64)}` },
      { emailDigest: "f".repeat(64) },
      { configuration: { ...o.configuration, clientId: "otherclient" } },
    ])
      expect(
        workforceOnboardingIntent(parseWorkforceOnboardingOriginal({ ...o, ...change }), codec),
      ).not.toBe(workforceOnboardingIntent(o, codec));
  });
  it("does not run record or array accessors", () => {
    let calls = 0;
    const raw = { ...original() };
    Object.defineProperty(raw, "emailDigest", {
      enumerable: true,
      get: () => {
        calls++;
        return "a".repeat(64);
      },
    });
    expect(() => parseWorkforceOnboardingOriginal(raw)).toThrow();
    const array: string[] = [];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get: () => {
        calls++;
        return id(80);
      },
    });
    expect(() =>
      parseWorkforceOnboardingOriginal({ ...original(), storeAssignmentReferences: array }),
    ).toThrow();
    expect(calls).toBe(0);
  });
  it("rejects duplicate scope, own approval, sparse arrays and zero-year time", () => {
    const o = original();
    expect(() =>
      parseWorkforceOnboardingOriginal({ ...o, approvedByReference: o.operatorReference }),
    ).toThrow();
    expect(() =>
      parseWorkforceOnboardingOriginal({ ...o, storeAssignmentReferences: [id(50), id(50)] }),
    ).toThrow();
    expect(() =>
      parseWorkforceOnboardingOriginal({ ...o, storeAssignmentReferences: new Array(1) }),
    ).toThrow();
    const { sourceDigest, ...p } = prepared();
    void sourceDigest;
    expect(() =>
      buildWorkforceOnboardingOperation({ ...p, createdAt: "0000-01-01T00:00:00.000Z" }, codec),
    ).toThrow();
    expect(() =>
      buildWorkforceOnboardingOperation({ ...p, expiresAt: "2026-10-07T12:00:01.000Z" }, codec),
    ).toThrow();
  });
  it("records one claim and only inspection after Unknown; never restarts dispatch", () => {
    const p = prepared(),
      c = phase(p, { state: "DispatchClaimed", dispatchStartedAt: at });
    assertWorkforceOnboardingTransition(p, c, codec);
    const u = phase(c, { state: "ProviderUnknown" });
    assertWorkforceOnboardingTransition(c, u, codec);
    expect(() =>
      assertWorkforceOnboardingTransition(u, phase(u, { state: "DispatchClaimed" }), codec),
    ).toThrow();
    expect(() =>
      assertWorkforceOnboardingTransition(
        p,
        phase(p, { state: "ProviderUnknown", dispatchStartedAt: at }),
        codec,
      ),
    ).toThrow();
  });
  it("retains the original 24h deadline and prior hash, rejects a rewritten phase", () => {
    const p = prepared(),
      c = phase(p, { state: "DispatchClaimed", dispatchStartedAt: at });
    expect(() =>
      assertWorkforceOnboardingTransition(
        p,
        phase(p, {
          state: "DispatchClaimed",
          dispatchStartedAt: at,
          previousSourceDigest: `sha256:${"e".repeat(64)}`,
        }),
        codec,
      ),
    ).toThrow();
    expect(() =>
      parseWorkforceOnboardingOperation({ ...c, state: "ProviderUnknown" }, codec),
    ).toThrow();
    expect(() =>
      assertWorkforceOnboardingTransition(
        p,
        phase(p, {
          state: "DispatchClaimed",
          dispatchStartedAt: at,
          auditReference: p.auditReference,
        }),
        codec,
      ),
    ).toThrow();
    const e = phase(c, { state: "Expired", occurredAt: end });
    assertWorkforceOnboardingTransition(c, e, codec);
    expect(() =>
      assertWorkforceOnboardingTransition(
        e,
        phase(e, { state: "Expired", occurredAt: end }),
        codec,
      ),
    ).toThrow();
  });
  it("binds protected Provider bytes and preserves them at expiry without asserting acceptance", () => {
    const p = prepared(),
      c = phase(p, { state: "DispatchClaimed", dispatchStartedAt: at });
    const provider = {
      subjectHash: "a".repeat(64),
      encryptedSubject: {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-key",
        ciphertext: "A".repeat(64),
        encryptionContext: workforceOnboardingSubjectContext(p.original),
      },
      username: `bop_${p.original.actorReference}`,
      createdAt: at,
      status: "FORCE_CHANGE_PASSWORD",
      enabled: true,
    };
    const observed = phase(c, { state: "ProviderObserved", provider });
    assertWorkforceOnboardingTransition(c, observed, codec);
    const expired = phase(observed, { state: "Expired", occurredAt: end });
    assertWorkforceOnboardingTransition(observed, expired, codec);
    expect(expired.provider).toEqual(observed.provider);
    expect(() =>
      phase(c, {
        state: "ProviderObserved",
        provider: {
          ...provider,
          encryptedSubject: { ...provider.encryptedSubject, encryptionContext: "foreign" },
        },
      }),
    ).toThrow();
    expect(() =>
      assertWorkforceOnboardingTransition(
        observed,
        phase(observed, { state: "Expired", provider: null, occurredAt: end }),
        codec,
      ),
    ).toThrow();
  });
  it("bounds protected Provider key references by UTF-16 units", () => {
    const p = prepared(),
      c = phase(p, { state: "DispatchClaimed", dispatchStartedAt: at });
    const withKey = (keyReference: string) =>
      phase(c, {
        state: "ProviderObserved",
        provider: {
          subjectHash: "a".repeat(64),
          encryptedSubject: {
            algorithm: "SYNTHETIC_AES_256_GCM",
            keyReference,
            ciphertext: "A".repeat(64),
            encryptionContext: workforceOnboardingSubjectContext(p.original),
          },
          username: `bop_${p.original.actorReference}`,
          createdAt: at,
          status: "FORCE_CHANGE_PASSWORD",
          enabled: true,
        },
      });
    const accepted = withKey("😀".repeat(127) + "a");
    expect(accepted.provider?.encryptedSubject.keyReference.length).toBe(255);
    expect(() => withKey("😀".repeat(128))).toThrow();
  });
});
