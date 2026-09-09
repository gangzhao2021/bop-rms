import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  parseDiningJoinCapability,
  parseDiningJoinInvitationCredential,
  parsePublicCapabilitySelectorHash,
} from "@bop/public-capability";
import { parseMovedJoinState } from "../application/dining-moved-join-record.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDiningTable,
  moveActiveDiningSession,
  parseDiningSession,
  createDiningSessionService,
  type DiningSessionPorts,
  type DiningMovedJoinPort,
  type DiningRegenerationRecord,
  parseDiningHash,
} from "../index.js";
import {
  parseDiningMoveCommand,
  parseDiningSessionMoveRecord,
} from "../application/dining-move-record.js";
const id = (n: number) => `01902286-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T09:02:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const hashes = {
  hashIntent: (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
  equals: (a: string, b: string) => a === b,
};
function sourceFacts() {
  const table = (ref: string, occupied: boolean) =>
    createDiningTable({
      ...scope,
      tableReference: ref,
      stableLabel: "T",
      areaReference: id(10),
      areaCode: "ROOM",
      capacity: 4,
      accessibilityAttributes: [],
      lifecycle: "Published",
      qrStatus: "Inactive",
      qrVersion: 0,
      operationalState: "Available",
      blockReasonCode: null,
      activeDiningSessionReference: occupied ? id(5) : null,
      aggregateVersion: occupied ? 3 : 2,
      createdAt: at,
      observedAt: at,
    });
  return {
    source: table(id(4), true),
    target: table(id(6), false),
    session: parseDiningSession({
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(4),
      tableAssignmentVersion: 2,
      phase: "Active",
      version: 1,
      startedByActorReference: id(8),
      startedAt: at,
      hostParticipantReference: null,
    }),
  };
}
function record() {
  const { source, target, session } = sourceFacts();
  const command = parseDiningMoveCommand({
    operationReference: id(7),
    diningSessionReference: id(5),
    sourceTableReference: id(4),
    targetTableReference: id(6),
    expectedSessionVersion: 1,
    expectedSourceTableVersion: 3,
    expectedTargetTableVersion: 2,
    partySize: 2,
    observedAt: at,
  });
  return parseDiningSessionMoveRecord(
    {
      command,
      operationReference: id(7),
      intentDigest: hashes.hashIntent(JSON.stringify(command)),
      ...moveActiveDiningSession(session, source, target, 2, command.observedAt),
      audit: {
        auditId: id(11),
        brandId: id(2),
        storeId: id(3),
        actor: { type: "User", reference: id(8) },
        actionCode: "DINING_SESSION_MOVE_TABLE",
        targetType: "DiningSession",
        targetId: id(5),
        reasonCode: "AUTHORIZED_OPERATION",
        correlationId: id(12),
        occurredAt: at,
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      },
      event: {
        eventType: "DiningSessionTableMoved",
        diningSessionReference: id(5),
        sourceTableReference: id(4),
        targetTableReference: id(6),
        aggregateVersion: "2",
        occurredAt: at,
      },
    },
    hashes,
  );
}

const issuedAt = "2026-09-09T09:03:00.000Z";
function fixture(includeMoved = true) {
  const move = record();
  const capability = parseDiningJoinCapability({
    capabilityReference: id(20),
    purpose: "DiningJoin",
    kind: "Invitation",
    storeReference: id(3),
    tableReference: id(4),
    diningSessionReference: id(5),
    selectorHash: "a".repeat(64),
    pepperVersion: 1,
    assignmentVersion: 2,
    generation: 1,
    status: "Active",
    version: 1,
    issuedAt: at,
    expiresAt: "2026-09-09T09:17:00.000Z",
    consumedAt: null,
    revokedAt: null,
  });
  const state = { session: move.session, capability, move };
  const brand = createBrand({
    brandReference: id(2),
    code: "DINING",
    displayName: "Synthetic",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: id(3),
    brandReference: id(2),
    code: "STORE",
    displayName: "Synthetic",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const authorize = vi.fn<DiningSessionPorts["staff"]["authorize"]>(async (input) => ({
    tenantContext: createTenantContext(
      {
        actorType: "User",
        actorReference: id(8),
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: input.observedAt,
        recentMfaAt: null,
      } as unknown as Parameters<typeof createTenantContext>[0],
      brand,
      store,
      input.observedAt,
    ),
    permission: Object.freeze({
      effect: "Allow",
      scopeKind: "Store",
      action: parseBusinessAction("dining.session.manage"),
      reason: "EXPLICIT_ALLOW",
      source: "ExplicitAllow",
      policySnapshotReference: parsePolicyReference(id(31)),
      policyVersion: parsePolicyVersion(1),
      audit: Object.freeze({ effect: "Allow", reason: "EXPLICIT_ALLOW", source: "ExplicitAllow" }),
    }),
    table: {
      brandReference: move.session.brandReference,
      storeReference: move.session.storeReference,
      tableReference: move.session.tableReference,
      assignmentVersion: move.session.tableAssignmentVersion,
      tableState: "Eligible",
      activeDiningSessionReference: move.session.diningSessionReference,
      observedAt: input.observedAt,
    },
    audit: {
      ...move.audit,
      auditId: id(30),
      actionCode: "DINING_JOIN_CREDENTIAL_REGENERATE",
      targetType: "DiningTable",
      targetId: id(6),
      occurredAt: input.observedAt,
    },
  }));
  let history: DiningRegenerationRecord | null = null;
  const resolveMoved = vi.fn<DiningMovedJoinPort["resolveMovedJoinState"]>(async () => state);
  const write = vi.fn<DiningMovedJoinPort["reissueAfterMove"]>(async (input) => {
    history = {
      capability: input.replacement,
      operationReference: input.operationReference,
      operationIntentHash: input.operationIntentHash,
    };
    return history;
  });
  const resolveHistory = vi.fn(async () => history);
  const normalWrite = vi.fn<DiningSessionPorts["store"]["regenerate"]>(async () => {
    throw new Error("unexpected normal write");
  });
  const generate = vi.fn(() => parseDiningJoinInvitationCredential("AQEBAQEBAQEBAQEBAQEBAQ"));
  const ports: DiningSessionPorts = {
    pepperVersion: 2,
    credentials: {
      generateReference: () => id(21),
      generateJoinCredential: generate,
      hashJoinCredential: () => parsePublicCapabilitySelectorHash("b".repeat(64)),
      hashOperationIntent: (text) =>
        parseDiningHash(createHash("sha256").update(text).digest("hex")),
      equals: (a, b) => a === b,
    },
    staff: { authorize },
    guests: { resolve: async () => null },
    abuse: { admit: async () => "Admitted" },
    store: {
      resolveStartOperation: async () => null,
      start: async () => {
        throw new Error("unused");
      },
      resolveJoinState: async () => null,
      resolveActiveJoin: async () => null,
      resolveJoinOperation: async () => null,
      join: async () => {
        throw new Error("unused");
      },
      resolveRegenerationOperation: resolveHistory,
      regenerate: normalWrite,
    },
    ...(includeMoved
      ? {
          movedJoin: {
            references: hashes,
            resolveMovedJoinState: resolveMoved,
            reissueAfterMove: write,
          },
        }
      : {}),
  };
  const input = {
    diningSessionReference: id(5),
    tableReference: id(6),
    expectedAssignmentVersion: 3,
    expectedSessionVersion: 2,
    expectedCapabilityVersion: 1,
    operationReference: id(22),
    requestedAt: issuedAt,
  };
  return {
    service: createDiningSessionService(ports),
    ports,
    input,
    state,
    authorize,
    resolveMoved,
    write,
    resolveHistory,
    normalWrite,
    generate,
  };
}
const denied = { code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" };

describe("currently authorized Join reissue after Move", () => {
  it("issues at the new assignment and records the current Staff Audit", async () => {
    const x = fixture();
    const result = await x.service.regenerate(x.input);
    expect(result.status).toBe("Issued");
    expect(result.capability).toMatchObject({
      tableReference: id(6),
      assignmentVersion: 3,
      generation: 2,
      pepperVersion: 2,
    });
    expect(x.write.mock.calls[0]?.[0]).toMatchObject({
      move: x.state.move,
      previous: { status: "Revoked", tableReference: id(4) },
      audit: { actor: { type: "User", reference: id(8) }, targetId: id(6) },
    });
    expect(x.normalWrite).not.toHaveBeenCalled();
    expect(x.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      x.resolveHistory.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
  it("replays the unified original result without generating or writing another secret", async () => {
    const x = fixture();
    const first = await x.service.regenerate(x.input);
    const replay = await x.service.regenerate(x.input);
    expect(replay).toEqual({ status: "AlreadyApplied", capability: first.capability });
    expect(replay).not.toHaveProperty("joinCredential");
    expect(x.generate).toHaveBeenCalledTimes(1);
    expect(x.write).toHaveBeenCalledTimes(1);
    expect(x.authorize).toHaveBeenCalledTimes(2);
  });
  it("requires current authorization even for a stored original result", async () => {
    const x = fixture();
    await x.service.regenerate(x.input);
    x.authorize.mockResolvedValue(null);
    await expect(x.service.regenerate(x.input)).rejects.toMatchObject({
      code: "DINING_SESSION_PERMISSION_DENIED",
    });
    expect(x.resolveHistory).toHaveBeenCalledTimes(1);
  });
  it("fails closed without the optional moved provider", async () => {
    const x = fixture(false);
    await expect(x.service.regenerate(x.input)).rejects.toMatchObject({
      code: "DINING_SESSION_UNAVAILABLE",
    });
    expect(x.generate).not.toHaveBeenCalled();
  });
  it("does not treat missing committed Move facts as permission to sign", async () => {
    const x = fixture();
    x.resolveMoved.mockResolvedValue(null);
    await expect(x.service.regenerate(x.input)).rejects.toMatchObject({
      code: "DINING_SESSION_UNAVAILABLE",
    });
    expect(x.write).not.toHaveBeenCalled();
  });
  it.each(["expectedSessionVersion", "expectedCapabilityVersion"] as const)(
    "denies stale %s",
    async (field) => {
      const x = fixture();
      await expect(x.service.regenerate({ ...x.input, [field]: 99 })).rejects.toMatchObject({
        code: "DINING_SESSION_UNAVAILABLE",
      });
      expect(x.generate).not.toHaveBeenCalled();
    },
  );
  it("retains terminal Consumed facts instead of reactivating them", async () => {
    const x = fixture();
    x.resolveMoved.mockResolvedValue({
      ...x.state,
      capability: parseDiningJoinCapability({
        ...x.state.capability,
        status: "Consumed",
        version: 2,
        consumedAt: at,
      }),
    });
    await x.service.regenerate({ ...x.input, expectedCapabilityVersion: 2 });
    expect(x.write.mock.calls[0]?.[0].previous).toMatchObject({
      status: "Consumed",
      version: 2,
      consumedAt: at,
    });
  });
  it("bounds a private synchronous dependency failure", async () => {
    const x = fixture();
    x.resolveMoved.mockImplementation(() => {
      throw new Error("synthetic private dependency");
    });
    await expect(x.service.regenerate(x.input)).rejects.toMatchObject(denied);
    expect(x.generate).not.toHaveBeenCalled();
  });
  it("rejects changed complete Move history despite a fake colliding digest provider", () => {
    const x = fixture();
    const value = {
      ...x.state,
      move: { ...x.state.move, session: { ...x.state.move.session, tableReference: id(99) } },
    };
    expect(() =>
      parseMovedJoinState(
        value,
        { ...hashes, equals: () => true },
        { ...scope, diningSessionReference: id(5) },
      ),
    ).toThrow();
  });
  it.each([
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "tableReference",
    "tableAssignmentVersion",
    "startedAt",
    "startedByActorReference",
    "version",
    "phase",
  ])("rejects inconsistent current Session %s", (field) => {
    const x = fixture();
    const value = {
      ...x.state,
      session: { ...x.state.session, [field]: field === "version" ? 1 : id(99) },
    };
    expect(() =>
      parseMovedJoinState(value, hashes, { ...scope, diningSessionReference: id(5) }),
    ).toThrow();
  });
  it("captures history and rejects accessors without evaluating them", () => {
    const x = fixture();
    const value = structuredClone(x.state);
    const get = vi.fn();
    Object.defineProperty(value.move, "audit", { get, enumerable: true });
    expect(() =>
      parseMovedJoinState(value, hashes, { ...scope, diningSessionReference: id(5) }),
    ).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
