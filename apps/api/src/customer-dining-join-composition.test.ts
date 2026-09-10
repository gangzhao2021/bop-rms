import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGuestSessionRecord,
  createGuestSessionCredentialProvider,
  parseCanonicalInstant,
  type GuestSessionRecord,
} from "@bop/identity";
import {
  parseDiningSession,
  parseQrTableContextEvidence,
  type DiningJoinState,
  type DiningJoinRecord,
} from "@rms/dining";
import {
  createCustomerDiningJoinComposition,
  type CustomerDiningJoinCompositionOptions,
} from "./customer-dining-join-composition.js";
const id = (n: number) => `01902304-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n: number) =>
  parseCanonicalInstant(new Date(Date.parse("2026-09-09T12:00:00.000Z") + n * 1000).toISOString());
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = { code: "GUEST_SESSION_UNAVAILABLE" };
function fixture(offset = 0) {
  let seconds = 0;
  const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
  const sessionCredential = credentials.generateCredential("Session"),
    csrfCredential = credentials.generateCredential("Csrf");
  const prior = createGuestSessionRecord({
    session: {
      sessionReference: id(offset + 1),
      status: "Active",
      version: 1,
      brandReference: id(2),
      storeReference: id(3),
      publicStoreReference: id(4),
      publicTableReference: id(offset + 40),
      channel: "DineIn",
      locale: "en-CA",
      qrReference: id(offset + 5),
      qrRevocationVersion: 1,
      diningState: "ContextOnly",
      diningSessionReference: null,
      diningParticipantReference: null,
      createdAt: at(-60),
      lastSeenAt: at(-60),
      idleExpiresAt: at(14340),
      absoluteExpiresAt: at(86340),
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    },
    sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
    csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
    operationReference: id(offset + 6),
    operationIntentHash: credentials.hashOperationIntent("synthetic entry"),
  });
  const records = new Map<string, GuestSessionRecord>([[prior.sessionSelectorHash, prior]]);
  const joinCredential = Buffer.alloc(16, offset + 1).toString("base64url");
  let state: DiningJoinState = {
    session: parseDiningSession({
      diningSessionReference: id(offset + 20),
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(offset + 50),
      tableAssignmentVersion: 7,
      phase: "Active",
      version: 1,
      startedByActorReference: id(60),
      startedAt: at(-60),
      hostParticipantReference: null,
    }),
    capability: {
      capabilityReference: id(offset + 30),
      purpose: "DiningJoin",
      kind: "Invitation",
      storeReference: id(3),
      tableReference: id(offset + 50),
      diningSessionReference: id(offset + 20),
      selectorHash: hash(joinCredential),
      pepperVersion: 1,
      assignmentVersion: 7,
      generation: 1,
      status: "Active",
      version: 1,
      issuedAt: at(-60),
      expiresAt: at(600),
      consumedAt: null,
      revokedAt: null,
    } as unknown as DiningJoinState["capability"],
  };
  const history = new Map<string, DiningJoinRecord>();
  const store: CustomerDiningJoinCompositionOptions["dining"]["store"] = {
    resolveJoinState: vi.fn(async (key) => (key === state.capability.selectorHash ? state : null)),
    resolveJoinOperation: vi.fn(async (key) => history.get(key) ?? null),
    join: vi.fn(async (input) => {
      state = { session: input.record.session, capability: input.record.capability };
      history.set(input.record.operationReference, input.record);
      return input.record;
    }),
  };
  const context = parseQrTableContextEvidence({
    publicStoreReference: id(4),
    publicTableReference: id(offset + 40),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(offset + 50),
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableLifecycle: "Active",
    assignmentState: "Active",
    channel: "DineIn",
    qrState: "Enabled",
    revocationVersion: 1,
    contextEvidenceReference: id(offset + 80),
    validUntil: at(600),
  });
  const options: CustomerDiningJoinCompositionOptions = {
    scope: { brandReference: id(2), storeReference: id(3) },
    now: () => at(seconds),
    session: {
      credentials,
      binding: { validate: vi.fn(async () => "Current" as const) },
      store: {
        create: async ({ record }) => record,
        resolve: vi.fn(async (key) => records.get(key) ?? null),
        touchInteractive: async () => null,
        revoke: async () => null,
        resolveOperation: async () => null,
        rotate: async () => {
          throw new Error("unexpected rotation");
        },
      },
    },
    dining: {
      store,
      pepperVersion: 1,
      credentials: {
        generateReference: (purpose) => id(offset + (purpose === "Participant" ? 21 : 22)),
        hashJoinCredential: (_kind, value) => hash(value) as never,
        hashOperationIntent: (value) => hash(value) as never,
        equals: (a, b) => a === b,
      },
    },
    contexts: { resolve: vi.fn(async () => context) },
  };
  const request = { abuse: { admit: vi.fn(async () => "Admitted" as const) } };
  const input = {
    sessionCredential,
    csrfCredential,
    joinCredential,
    operationReference: id(offset + 10),
  };
  return {
    options,
    records,
    prior,
    context,
    store,
    history,
    input,
    request,
    tick: (value: number) => {
      seconds = value;
    },
    composition: createCustomerDiningJoinComposition(options),
  };
}
describe("current-authorized Dining Join composition", () => {
  it("joins and recovers only a narrow receipt, preserving public/internal Table distinction", async () => {
    const f = fixture();
    const result = await f.composition.join(f.input, f.request);
    expect(result).toEqual({
      status: "Joined",
      operationReference: f.input.operationReference,
      admissionReference: id(22),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.request.abuse.admit).toHaveBeenCalledExactlyOnceWith({
      guestSessionReference: id(1),
      kind: "Invitation",
      observedAt: at(0),
    });
    expect(f.store.join).toHaveBeenCalledWith(
      expect.objectContaining({
        guestSessionReference: id(1),
        expectedSessionVersion: 1,
        expectedCapabilityVersion: 1,
      }),
    );
    expect(f.history.get(id(10))?.admission.tableReference).toBe(id(50));
    expect(f.prior.session.publicTableReference).toBe(id(40));
    f.tick(10);
    expect(await f.composition.join(f.input, f.request)).toEqual(result);
    expect(f.store.join).toHaveBeenCalledTimes(1);
    expect(f.records.get(f.prior.sessionSelectorHash)?.session.status).toBe("Active");
    for (const secret of [
      f.input.sessionCredential,
      f.input.csrfCredential,
      f.input.joinCredential,
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(vi.mocked(f.options.contexts.resolve).mock.calls)).not.toContain(
        secret,
      );
    }
  });
  it.each([null, [], {}, { extra: true }])(
    "bounds malformed input before effects",
    async (value) => {
      const f = fixture();
      await expect(f.composition.join(value, f.request)).rejects.toMatchObject(unavailable);
      expect(f.options.session.store.resolve).not.toHaveBeenCalled();
      expect(f.store.resolveJoinState).not.toHaveBeenCalled();
    },
  );
  it("rejects caller abuse and identity scope fields", async () => {
    const f = fixture();
    await expect(
      f.composition.join(
        { ...f.input, abuse: "Admitted", guestSessionReference: id(1) },
        f.request,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(f.request.abuse.admit).not.toHaveBeenCalled();
  });
  it("never evaluates credential accessors", async () => {
    const f = fixture();
    const getter = vi.fn(() => f.input.joinCredential);
    await expect(
      f.composition.join(
        Object.defineProperty({ ...f.input }, "joinCredential", { get: getter }),
        f.request,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["session", "csrf", "policy", "scope", "bound", "pickup"] as const)(
    "denies invalid %s before owner state reads",
    async (mode) => {
      const f = fixture();
      let input: Record<keyof typeof f.input, string> = { ...f.input };
      if (mode === "session") input = { ...input, sessionCredential: "Z".repeat(43) };
      if (mode === "csrf") input = { ...input, csrfCredential: "Z".repeat(43) };
      if (mode === "policy")
        vi.mocked(f.options.session.binding.validate).mockResolvedValue("Unavailable");
      if (mode === "scope")
        f.records.set(
          f.prior.sessionSelectorHash,
          createGuestSessionRecord({
            ...f.prior,
            session: { ...f.prior.session, storeReference: id(99) },
          }),
        );
      if (mode === "bound")
        f.records.set(
          f.prior.sessionSelectorHash,
          createGuestSessionRecord({
            ...f.prior,
            session: {
              ...f.prior.session,
              diningState: "DiningBound",
              diningSessionReference: id(20),
              diningParticipantReference: id(21),
              rotatedFromGuestSessionReference: id(90),
            },
          }),
        );
      if (mode === "pickup")
        f.records.set(
          f.prior.sessionSelectorHash,
          createGuestSessionRecord({
            ...f.prior,
            session: { ...f.prior.session, channel: "Pickup", publicTableReference: null },
          }),
        );
      await expect(f.composition.join(input, f.request)).rejects.toMatchObject(unavailable);
      expect(f.store.resolveJoinState).not.toHaveBeenCalled();
      expect(f.request.abuse.admit).not.toHaveBeenCalled();
    },
  );
  it.each([
    "qrState",
    "revocationVersion",
    "publicTableReference",
    "tableLifecycle",
    "validUntil",
  ] as const)("requires current context %s", async (field) => {
    const f = fixture();
    const changed = {
      ...f.context,
      [field]:
        field === "qrState"
          ? "Revoked"
          : field === "revocationVersion"
            ? 2
            : field === "publicTableReference"
              ? id(99)
              : field === "validUntil"
                ? at(0)
                : "Inactive",
    };
    vi.mocked(f.options.contexts.resolve).mockResolvedValue(changed as never);
    await expect(f.composition.join(f.input, f.request)).rejects.toMatchObject(unavailable);
    expect(f.store.resolveJoinState).not.toHaveBeenCalled();
    expect(f.request.abuse.admit).not.toHaveBeenCalled();
  });
  it("refreshes owner command time after initial context resolution", async () => {
    const f = fixture();
    vi.mocked(f.options.contexts.resolve).mockImplementationOnce(async () => {
      f.tick(601);
      return f.context;
    });
    await expect(f.composition.join(f.input, f.request)).rejects.toMatchObject(unavailable);
    expect(f.request.abuse.admit).toHaveBeenCalledExactlyOnceWith({
      guestSessionReference: id(1),
      kind: "Invitation",
      observedAt: at(601),
    });
    expect(f.store.resolveJoinState).not.toHaveBeenCalled();
    expect(f.store.join).not.toHaveBeenCalled();
  });
  it("requires an invocation-specific abuse port and never defaults admission", async () => {
    const f = fixture();
    await expect(f.composition.join(f.input, undefined as never)).rejects.toMatchObject(
      unavailable,
    );
    expect(f.store.resolveJoinState).not.toHaveBeenCalled();
    const admit = vi.fn(async () => "Cooldown" as const);
    await expect(f.composition.join(f.input, { abuse: { admit } })).rejects.toMatchObject(
      unavailable,
    );
    expect(admit).toHaveBeenCalledOnce();
    expect(f.store.resolveJoinState).not.toHaveBeenCalled();
  });
  it("captures input and request abuse method before asynchronous authorization", async () => {
    const f = fixture();
    const original = { ...f.input };
    const input = { ...original };
    const request = { abuse: { admit: f.request.abuse.admit } },
      substitute = vi.fn(async () => "Admitted" as const);
    const resolve = vi.mocked(f.options.session.store.resolve).getMockImplementation();
    if (!resolve) throw new Error("missing mock");
    vi.spyOn(f.options.session.store, "resolve").mockImplementationOnce(async (key) => {
      input.joinCredential = "wrong";
      request.abuse.admit = substitute;
      return resolve(key);
    });
    expect(await f.composition.join(input, request)).toMatchObject({ status: "Joined" });
    expect(f.request.abuse.admit).toHaveBeenCalledOnce();
    expect(substitute).not.toHaveBeenCalled();
  });
  it("reauthorizes after abuse before reading owner state", async () => {
    const f = fixture();
    f.request.abuse.admit.mockImplementationOnce(async () => {
      f.records.clear();
      return "Admitted";
    });
    await expect(f.composition.join(f.input, f.request)).rejects.toMatchObject(unavailable);
    expect(f.store.resolveJoinState).not.toHaveBeenCalled();
  });
  it("bounds a post-commit context failure and recovers the original operation", async () => {
    const f = fixture();
    const write = vi.mocked(f.store.join).getMockImplementation();
    if (!write) throw new Error("missing mock");
    vi.spyOn(f.store, "join").mockImplementationOnce(async (input) => {
      const result = await write(input);
      vi.mocked(f.options.contexts.resolve).mockResolvedValue(null);
      return result;
    });
    await expect(f.composition.join(f.input, f.request)).rejects.toMatchObject(unavailable);
    expect(f.history.size).toBe(1);
    vi.mocked(f.options.contexts.resolve).mockResolvedValue(f.context);
    expect(await f.composition.join(f.input, f.request)).toMatchObject({
      admissionReference: id(22),
    });
    expect(f.store.join).toHaveBeenCalledTimes(1);
  });
  it("keeps concurrent identity and request abuse contexts separate", async () => {
    const a = fixture(),
      b = fixture(100);
    let sequence = 500;
    const options: CustomerDiningJoinCompositionOptions = {
      ...a.options,
      session: {
        ...a.options.session,
        store: {
          ...a.options.session.store,
          resolve: async (key) => a.records.get(key) ?? b.records.get(key) ?? null,
        },
      },
      contexts: {
        resolve: async (input) =>
          input.session.sessionReference === a.prior.session.sessionReference
            ? a.context
            : b.context,
      },
      dining: {
        ...a.options.dining,
        credentials: { ...a.options.dining.credentials, generateReference: () => id(++sequence) },
        store: {
          resolveJoinState: async (key) =>
            (await a.store.resolveJoinState(key)) ?? (await b.store.resolveJoinState(key)),
          resolveJoinOperation: async (key) => a.history.get(key) ?? b.history.get(key) ?? null,
          join: async (input) =>
            String(input.record.session.tableReference) === String(a.context.tableReference)
              ? a.store.join(input)
              : b.store.join(input),
        },
      },
    };
    const composed = createCustomerDiningJoinComposition(options);
    const results = await Promise.all([
      composed.join(a.input, a.request),
      composed.join(b.input, b.request),
    ]);
    expect(results.map((result) => result.operationReference)).toEqual([
      a.input.operationReference,
      b.input.operationReference,
    ]);
    expect(a.request.abuse.admit).toHaveBeenCalledExactlyOnceWith({
      guestSessionReference: id(1),
      kind: "Invitation",
      observedAt: at(0),
    });
    expect(b.request.abuse.admit).toHaveBeenCalledExactlyOnceWith({
      guestSessionReference: id(101),
      kind: "Invitation",
      observedAt: at(0),
    });
    expect(a.store.join).toHaveBeenCalledWith(
      expect.objectContaining({ guestSessionReference: id(1) }),
    );
    expect(b.store.join).toHaveBeenCalledWith(
      expect.objectContaining({ guestSessionReference: id(101) }),
    );
  });
  it("does not expose restricted provider exceptions", async () => {
    const f = fixture();
    f.request.abuse.admit.mockRejectedValue(new Error(f.input.joinCredential));
    const error = await f.composition.join(f.input, f.request).catch((value: unknown) => value);
    expect(error).toMatchObject(unavailable);
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(f.input.joinCredential);
  });
});
