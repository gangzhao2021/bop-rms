import { createHash } from "node:crypto";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it, vi } from "vitest";

import {
  createDiningSessionService,
  DiningSessionError,
  type DiningJoinRecord,
  type DiningRegenerationRecord,
  type DiningSessionPorts,
  type DiningStartRecord,
} from "../index.js";

const ids = {
  actor: "018f2000-0000-7000-8000-000000000001",
  brand: "018f2000-0000-7000-8000-000000000002",
  store: "018f2000-0000-7000-8000-000000000003",
  table: "018f2000-0000-7000-8000-000000000004",
  session: "018f2000-0000-7000-8000-000000000005",
  participant: "018f2000-0000-7000-8000-000000000006",
  admission: "018f2000-0000-7000-8000-000000000007",
  firstCapability: "018f2000-0000-7000-8000-000000000008",
  nextCapability: "018f2000-0000-7000-8000-000000000009",
  guest: "018f2000-0000-7000-8000-00000000000a",
  startOperation: "018f2000-0000-7000-8000-00000000000b",
  joinOperation: "018f2000-0000-7000-8000-00000000000c",
  regenerateOperation: "018f2000-0000-7000-8000-00000000000d",
  audit: "018f2000-0000-7000-8000-00000000000e",
  correlation: "018f2000-0000-7000-8000-00000000000f",
  policy: "018f2000-0000-7000-8000-000000000010",
} as const;
const startAt = "2026-07-29T12:00:00.000Z";
const joinAt = "2026-07-29T12:01:00.000Z";
const regenerateAt = "2026-07-29T12:02:00.000Z";
const firstCredential = "AAAAAAAAAAAAAAAAAAAAAA";
const nextCredential = "AQEBAQEBAQEBAQEBAQEBAQ";
const hash = (digit: string) => digit.repeat(64);

function tenantContext(at: string) {
  const brand = createBrand({
    brandReference: ids.brand,
    code: "DINING",
    displayName: "Dining Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: startAt,
    updatedAt: startAt,
  });
  const store = createStore({
    storeReference: ids.store,
    brandReference: ids.brand,
    code: "DINING-1",
    displayName: "Dining Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: startAt,
    updatedAt: startAt,
  });
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    brand,
    store,
    at,
  );
}

function staffEvidence(
  operation: "StartSession" | "RegenerateJoinCredential",
  at: string,
  activeDiningSessionReference: string | null,
) {
  const action =
    operation === "StartSession" ? "DINING_SESSION_START" : "DINING_JOIN_CREDENTIAL_REGENERATE";
  return {
    tenantContext: tenantContext(at),
    permission: Object.freeze({
      effect: "Allow",
      reason: "ROLE_PERMISSION",
      source: "RolePermission",
      action: "dining.session.manage",
      scopeKind: "Store",
      policySnapshotReference: ids.policy,
      policyVersion: 1,
      audit: Object.freeze({
        effect: "Allow",
        reason: "ROLE_PERMISSION",
        source: "RolePermission",
      }),
    }),
    table: {
      brandReference: ids.brand,
      storeReference: ids.store,
      tableReference: ids.table,
      assignmentVersion: 7,
      tableState: "Eligible",
      activeDiningSessionReference,
      observedAt: at,
    },
    audit: {
      auditId: ids.audit,
      brandId: ids.brand,
      storeId: ids.store,
      actor: { type: "User", reference: ids.actor },
      actionCode: action,
      targetType: "DiningTable",
      targetId: ids.table,
      beforeSummary: {},
      afterSummary: {},
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: ids.correlation,
      occurredAt: at,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  } as const;
}

function fixture(
  options: {
    cooldown?: boolean;
    wrongTable?: boolean;
    staffDenied?: boolean;
    occupied?: boolean;
  } = {},
) {
  let startRecord: DiningStartRecord | null = null;
  let joinRecord: DiningJoinRecord | null = null;
  let regenerationRecord: DiningRegenerationRecord | null = null;
  let capabilityIndex = 0;
  let credentialIndex = 0;
  const startOperations = new Map<string, DiningStartRecord>();
  const joinOperations = new Map<string, DiningJoinRecord>();
  const regenerationOperations = new Map<string, DiningRegenerationRecord>();
  const ports: DiningSessionPorts = {
    pepperVersion: 2,
    staff: {
      async authorize(input) {
        if (options.staffDenied) return null;
        return staffEvidence(
          input.operation,
          input.observedAt,
          input.operation === "StartSession"
            ? options.occupied
              ? ids.session
              : null
            : ids.session,
        ) as never;
      },
    },
    guests: {
      async resolve(input) {
        return {
          guestSessionReference: input.guestSessionReference,
          diningState: "ContextOnly",
          channel: "DineIn",
          storeReference: ids.store,
          tableReference: options.wrongTable ? "018f2000-0000-7000-8000-000000000099" : ids.table,
          observedAt: input.observedAt,
        } as never;
      },
    },
    abuse: { admit: async () => (options.cooldown ? "Cooldown" : "Admitted") },
    credentials: {
      generateReference(purpose) {
        if (purpose === "DiningSession") return ids.session;
        if (purpose === "Participant") return ids.participant;
        if (purpose === "IdentityAdmission") return ids.admission;
        return [ids.firstCapability, ids.nextCapability][capabilityIndex++] ?? ids.nextCapability;
      },
      generateJoinCredential() {
        return [firstCredential, nextCredential][credentialIndex++] as never;
      },
      hashJoinCredential(_kind, credential) {
        return hash(credential === firstCredential ? "a" : "b") as never;
      },
      hashOperationIntent(intent) {
        if (intent.startsWith("Join:"))
          return createHash("sha256").update(intent).digest("hex") as never;
        return hash(
          intent.startsWith("Start:")
            ? intent.endsWith(":HumanCode")
              ? "f"
              : "c"
            : intent.startsWith("Join:")
              ? "d"
              : "e",
        ) as never;
      },
      equals: (left, right) => left === right,
    },
    store: {
      async resolveStartOperation(reference) {
        return startOperations.get(reference) ?? null;
      },
      async start(input) {
        startRecord = input.record;
        startOperations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async resolveJoinState(selectorHash) {
        if (startRecord === null || startRecord.capability.selectorHash !== selectorHash)
          return null;
        return { session: startRecord.session, capability: startRecord.capability };
      },
      async resolveActiveJoin(reference) {
        if (startRecord === null || startRecord.session.diningSessionReference !== reference)
          return null;
        return joinRecord === null
          ? { session: startRecord.session, capability: startRecord.capability }
          : { session: joinRecord.session, capability: joinRecord.capability };
      },
      async resolveJoinOperation(reference) {
        return joinOperations.get(reference) ?? null;
      },
      async join(input) {
        joinRecord = input.record;
        if (startRecord !== null) {
          startRecord = {
            ...startRecord,
            session: input.record.session,
            capability: input.record.capability,
          };
        }
        joinOperations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async resolveRegenerationOperation(reference) {
        return regenerationOperations.get(reference) ?? null;
      },
      async regenerate(input) {
        regenerationRecord = {
          capability: input.replacement,
          operationReference: input.operationReference,
          operationIntentHash: input.operationIntentHash,
        };
        regenerationOperations.set(input.operationReference, regenerationRecord);
        return regenerationRecord;
      },
    },
  };
  return {
    service: createDiningSessionService(ports),
    ports,
    records: () => ({ startRecord, joinRecord }),
  };
}

async function start(service: ReturnType<typeof createDiningSessionService>) {
  return service.start({
    tableReference: ids.table,
    expectedAssignmentVersion: 7,
    operationReference: ids.startOperation,
    joinKind: "Invitation",
    requestedAt: startAt,
  });
}

describe("staff-started Dining Session contract", () => {
  it("starts with server authorization and joins the first guest as Host using a consumed capability", async () => {
    const { service, records } = fixture();
    const started = await start(service);
    expect(started).toMatchObject({
      status: "Issued",
      joinCredential: firstCredential,
      session: { phase: "Active", hostParticipantReference: null },
      capability: { generation: 1, status: "Active", pepperVersion: 2 },
    });
    const joined = await service.join({
      guestSessionReference: ids.guest,
      joinCredential: firstCredential,
      expectedSessionVersion: 1,
      expectedCapabilityVersion: 1,
      operationReference: ids.joinOperation,
      requestedAt: joinAt,
    });
    expect(joined).toMatchObject({
      status: "Joined",
      session: { version: 2, hostParticipantReference: ids.participant },
      participant: { participantReference: ids.participant, status: "Active" },
      admission: {
        admissionReference: ids.admission,
        diningSessionReference: ids.session,
        participantReference: ids.participant,
        status: "Active",
      },
    });
    expect(records().joinRecord?.capability).toMatchObject({
      status: "Consumed",
      consumedAt: joinAt,
      version: 2,
    });
    await expect(
      service.join({
        guestSessionReference: ids.guest,
        joinCredential: firstCredential,
        expectedSessionVersion: 1,
        expectedCapabilityVersion: 1,
        operationReference: ids.joinOperation,
        requestedAt: joinAt,
      }),
    ).resolves.toMatchObject({
      status: "AlreadyApplied",
      participant: { participantReference: ids.participant },
    });
  });

  it("returns one bounded unavailable result for cooldown and context scope mismatch", async () => {
    for (const options of [{ cooldown: true }, { wrongTable: true }]) {
      const { service } = fixture(options);
      await start(service);
      await expect(
        service.join({
          guestSessionReference: ids.guest,
          joinCredential: firstCredential,
          expectedSessionVersion: 1,
          expectedCapabilityVersion: 1,
          operationReference: ids.joinOperation,
          requestedAt: joinAt,
        }),
      ).resolves.toEqual({ status: "DiningJoinUnavailable" });
    }
  });

  it("fails closed for denied Staff or an occupied Table and preserves start idempotency", async () => {
    for (const options of [{ staffDenied: true }, { occupied: true }]) {
      await expect(start(fixture(options).service)).rejects.toBeInstanceOf(DiningSessionError);
    }
    const { service } = fixture();
    await start(service);
    await expect(start(service)).resolves.toMatchObject({
      status: "AlreadyApplied",
      session: { diningSessionReference: ids.session },
    });
    await expect(
      service.start({
        tableReference: ids.table,
        expectedAssignmentVersion: 7,
        operationReference: ids.startOperation,
        joinKind: "HumanCode",
        requestedAt: startAt,
      }),
    ).rejects.toMatchObject({ code: "DINING_SESSION_IDEMPOTENCY_CONFLICT" });
  });

  it("regenerates a fresh same-scope credential, increments generation and revokes the prior one", async () => {
    const { service } = fixture();
    await start(service);
    const regenerated = await service.regenerate({
      diningSessionReference: ids.session,
      tableReference: ids.table,
      expectedAssignmentVersion: 7,
      expectedSessionVersion: 1,
      expectedCapabilityVersion: 1,
      operationReference: ids.regenerateOperation,
      requestedAt: regenerateAt,
    });
    expect(regenerated).toMatchObject({
      status: "Issued",
      joinCredential: nextCredential,
      capability: {
        capabilityReference: ids.nextCapability,
        generation: 2,
        status: "Active",
        version: 1,
      },
    });
  });

  it("rejects unknown fields and denied staff evidence without widening the contract", async () => {
    const { service } = fixture();
    await expect(
      service.start({
        tableReference: ids.table,
        expectedAssignmentVersion: 7,
        operationReference: ids.startOperation,
        joinKind: "Invitation",
        requestedAt: startAt,
        customerCanStart: true,
      }),
    ).rejects.toBeInstanceOf(DiningSessionError);
  });
});

const regenerationInput = {
  diningSessionReference: ids.session,
  tableReference: ids.table,
  expectedAssignmentVersion: 7,
  expectedSessionVersion: 1,
  expectedCapabilityVersion: 1,
  operationReference: ids.regenerateOperation,
  requestedAt: regenerateAt,
};
function changedRecord(value: unknown, path: string, replacement: unknown): never {
  const changed = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const fields = path.split(".");
  let target = changed;
  for (const field of fields.slice(0, -1)) target = target[field] as Record<string, unknown>;
  const last = fields.at(-1);
  if (last === undefined) throw new Error("missing test field");
  target[last] = replacement;
  return changed as never;
}

describe("WP-2273 current Staff authority and original Session results", () => {
  it.each(["start", "regenerate"] as const)(
    "denies revoked Staff before %s history access",
    async (operation) => {
      const { service, ports } = fixture();
      await start(service);
      if (operation === "regenerate") await service.regenerate(regenerationInput);
      const read = vi.spyOn(
        ports.store,
        operation === "start" ? "resolveStartOperation" : "resolveRegenerationOperation",
      );
      const generate = vi.spyOn(ports.credentials, "generateJoinCredential");
      vi.spyOn(ports.staff, "authorize").mockResolvedValue(null);
      await expect(
        operation === "start" ? start(service) : service.regenerate(regenerationInput),
      ).rejects.toMatchObject({ code: "DINING_SESSION_PERMISSION_DENIED" });
      expect(read).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it("returns authorized original start after occupancy changes without issuing credentials", async () => {
    const options = { occupied: false };
    const { service, ports } = fixture(options);
    const first = await start(service);
    options.occupied = true;
    const write = vi.spyOn(ports.store, "start");
    const generate = vi.spyOn(ports.credentials, "generateJoinCredential");
    const replay = await start(service);
    expect(replay).toEqual({
      status: "AlreadyApplied",
      session: first.session,
      capability: first.capability,
    });
    expect(write).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(Object.isFrozen(replay.session)).toBe(true);
  });

  it("returns authorized original regeneration without checking stale write versions or issuing credentials", async () => {
    const { service, ports } = fixture();
    await start(service);
    const first = await service.regenerate(regenerationInput);
    const read = vi.spyOn(ports.store, "resolveActiveJoin");
    const write = vi.spyOn(ports.store, "regenerate");
    const generate = vi.spyOn(ports.credentials, "generateJoinCredential");
    expect(await service.regenerate(regenerationInput)).toEqual({
      status: "AlreadyApplied",
      capability: first.capability,
    });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ["operationReference", ids.joinOperation],
    ["operationIntentHash", "invalid"],
    ["session.brandReference", ids.guest],
    ["session.storeReference", ids.guest],
    ["session.tableReference", ids.guest],
    ["session.tableAssignmentVersion", 8],
    ["session.startedByActorReference", ids.guest],
    ["session.phase", "Closed"],
    ["session.version", 2],
    ["session.hostParticipantReference", ids.participant],
    ["session.startedAt", joinAt],
    ["capability.diningSessionReference", ids.guest],
    ["capability.storeReference", ids.guest],
    ["capability.tableReference", ids.guest],
    ["capability.assignmentVersion", 8],
    ["capability.generation", 2],
    ["capability.version", 2],
    ["capability.issuedAt", joinAt],
    ["extra", true],
  ])("rejects invalid start history %s", async (path, value) => {
    const { service, ports } = fixture();
    await start(service);
    const original = await ports.store.resolveStartOperation(ids.startOperation as never);
    vi.spyOn(ports.store, "resolveStartOperation").mockResolvedValue(
      changedRecord(original, String(path), value),
    );
    const write = vi.spyOn(ports.store, "start");
    await expect(start(service)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["operationReference", ids.startOperation],
    ["operationIntentHash", "invalid"],
    ["capability.storeReference", ids.guest],
    ["capability.tableReference", ids.guest],
    ["capability.diningSessionReference", ids.guest],
    ["capability.assignmentVersion", 8],
    ["capability.generation", 1],
    ["capability.version", 2],
    ["capability.issuedAt", "2026-07-29T12:03:00.000Z"],
    ["extra", true],
  ])("rejects invalid regeneration history %s", async (path, value) => {
    const { service, ports } = fixture();
    await start(service);
    await service.regenerate(regenerationInput);
    const original = await ports.store.resolveRegenerationOperation(
      ids.regenerateOperation as never,
    );
    vi.spyOn(ports.store, "resolveRegenerationOperation").mockResolvedValue(
      changedRecord(original, String(path), value),
    );
    const write = vi.spyOn(ports.store, "regenerate");
    await expect(service.regenerate(regenerationInput)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["session.diningSessionReference", ids.guest],
    ["session.brandReference", ids.guest],
    ["capability.diningSessionReference", ids.guest],
    ["capability.storeReference", ids.guest],
    ["capability.tableReference", ids.guest],
    ["capability.assignmentVersion", 8],
  ])("rejects wrong current regeneration state %s before generation", async (path, value) => {
    const { service, ports } = fixture();
    await start(service);
    const state = await ports.store.resolveActiveJoin(ids.session as never);
    vi.spyOn(ports.store, "resolveActiveJoin").mockResolvedValue(
      changedRecord(state, String(path), value),
    );
    const generate = vi.spyOn(ports.credentials, "generateJoinCredential");
    const write = vi.spyOn(ports.store, "regenerate");
    await expect(service.regenerate(regenerationInput)).rejects.toMatchObject({
      code: "DINING_SESSION_UNAVAILABLE",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("captures history before digest equality can mutate the dependency object", async () => {
    const { service, ports } = fixture();
    await start(service);
    const prior = JSON.parse(
      JSON.stringify(await ports.store.resolveStartOperation(ids.startOperation as never)),
    ) as DiningStartRecord;
    vi.spyOn(ports.store, "resolveStartOperation").mockResolvedValue(prior);
    vi.spyOn(ports.credentials, "equals").mockImplementation(() => {
      Object.assign(prior.session, { storeReference: ids.guest });
      return true;
    });
    expect((await start(service)).session.storeReference).toBe(ids.store);
  });

  it("captures Staff audit and Table evidence before the history callback", async () => {
    const { service, ports } = fixture();
    const evidence = staffEvidence("StartSession", startAt, null);
    vi.spyOn(ports.staff, "authorize").mockResolvedValue(evidence as never);
    vi.spyOn(ports.store, "resolveStartOperation").mockImplementation(async () => {
      Object.assign(evidence.table, { storeReference: ids.guest });
      Object.assign(evidence.audit, { storeId: ids.guest });
      return null;
    });
    const write = vi.spyOn(ports.store, "start");
    expect((await start(service)).session.storeReference).toBe(ids.store);
    expect(write.mock.calls[0]?.[0].audit.storeId).toBe(ids.store);
  });

  it.each(["staff", "history"] as const)(
    "rejects %s accessors without executing them",
    async (source) => {
      const { service, ports } = fixture();
      await start(service);
      const getter = vi.fn(() => {
        throw new Error("private dependency details");
      });
      if (source === "staff") {
        const evidence = staffEvidence("StartSession", startAt, null);
        Object.defineProperty(evidence, "audit", { get: getter, enumerable: true });
        vi.spyOn(ports.staff, "authorize").mockResolvedValue(evidence as never);
      } else {
        const prior = { ...(await ports.store.resolveStartOperation(ids.startOperation as never)) };
        Object.defineProperty(prior, "session", { get: getter, enumerable: true });
        vi.spyOn(ports.store, "resolveStartOperation").mockResolvedValue(prior as never);
      }
      await expect(start(service)).rejects.toBeInstanceOf(DiningSessionError);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(["start", "regenerate"] as const)(
    "rejects foreign %s write acknowledgements",
    async (operation) => {
      const { service, ports } = fixture();
      if (operation === "start") {
        vi.spyOn(ports.store, "start").mockImplementation(async ({ record }) =>
          changedRecord(record, "session.storeReference", ids.guest),
        );
      } else {
        await start(service);
        vi.spyOn(ports.store, "regenerate").mockImplementation(async (input) =>
          changedRecord(
            {
              capability: input.replacement,
              operationReference: input.operationReference,
              operationIntentHash: input.operationIntentHash,
            },
            "capability.storeReference",
            ids.guest,
          ),
        );
      }
      await expect(
        operation === "start" ? start(service) : service.regenerate(regenerationInput),
      ).rejects.toMatchObject({ code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
    },
  );

  it.each(["start", "regenerate"] as const)(
    "never issues unused raw credentials when %s converges on another original",
    async (operation) => {
      const { service, ports } = fixture();
      if (operation === "start") {
        vi.spyOn(ports.store, "start").mockImplementation(async ({ record }) =>
          changedRecord(record, "capability.capabilityReference", ids.nextCapability),
        );
      } else {
        await start(service);
        vi.spyOn(ports.store, "regenerate").mockImplementation(async (input) =>
          changedRecord(
            {
              capability: input.replacement,
              operationReference: input.operationReference,
              operationIntentHash: input.operationIntentHash,
            },
            "capability.capabilityReference",
            ids.firstCapability,
          ),
        );
      }
      const result = await (operation === "start"
        ? start(service)
        : service.regenerate(regenerationInput));
      expect(result.status).toBe("AlreadyApplied");
      expect(result).not.toHaveProperty("joinCredential");
    },
  );

  it.each(["DINING_SESSION_VERSION_CONFLICT", "DINING_SESSION_IDEMPOTENCY_CONFLICT"] as const)(
    "copies bounded %s without dependency details",
    async (code) => {
      const { service, ports } = fixture();
      const error = new DiningSessionError(code);
      error.message = "private dependency details";
      vi.spyOn(ports.store, "start").mockRejectedValue(error);
      const result = await start(service).catch((caught: unknown) => caught);
      expect(result).toMatchObject({ code });
      expect(result).not.toBe(error);
      expect(String(result)).not.toContain("private dependency details");
    },
  );

  it("redacts a failed digest equality dependency", async () => {
    const { service, ports } = fixture();
    await start(service);
    vi.spyOn(ports.credentials, "equals").mockImplementation(() => {
      throw new Error("private dependency details");
    });
    await expect(start(service)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
});

describe("WP-2273 Staff dependency failures", () => {
  it.each([
    "hashOperationIntent",
    "generateReference",
    "generateJoinCredential",
    "hashJoinCredential",
  ] as const)("redacts failed %s for both Staff operations", async (method) => {
    for (const operation of ["start", "regenerate"] as const) {
      const { service, ports } = fixture();
      if (operation === "regenerate") await start(service);
      vi.spyOn(ports.credentials, method).mockImplementation(() => {
        throw new Error("private credential dependency details");
      });
      const error = await (
        operation === "start" ? start(service) : service.regenerate(regenerationInput)
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
      expect(String(error)).not.toContain("private credential dependency details");
    }
  });

  it("rejects stale authorization time before reading history", async () => {
    const { service, ports } = fixture();
    const evidence = staffEvidence("RegenerateJoinCredential", regenerateAt, ids.session);
    vi.spyOn(ports.staff, "authorize").mockResolvedValue({
      ...evidence,
      tenantContext: tenantContext(startAt),
    } as never);
    const read = vi.spyOn(ports.store, "resolveRegenerationOperation");
    await expect(service.regenerate(regenerationInput)).rejects.toMatchObject({
      code: "DINING_SESSION_PERMISSION_DENIED",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps changed regeneration intent an idempotency conflict", async () => {
    const { service, ports } = fixture();
    await start(service);
    await service.regenerate(regenerationInput);
    vi.spyOn(ports.credentials, "hashOperationIntent").mockReturnValue(hash("f") as never);
    const write = vi.spyOn(ports.store, "regenerate");
    await expect(service.regenerate(regenerationInput)).rejects.toMatchObject({
      code: "DINING_SESSION_IDEMPOTENCY_CONFLICT",
    });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("WP-2273 synchronous Staff port failures", () => {
  it.each(["staff", "history", "write"] as const)(
    "redacts synchronous %s failure",
    async (source) => {
      const { service, ports } = fixture();
      const failed = () => {
        throw new Error("private synchronous dependency details");
      };
      if (source === "staff") vi.spyOn(ports.staff, "authorize").mockImplementation(failed);
      if (source === "history")
        vi.spyOn(ports.store, "resolveStartOperation").mockImplementation(failed);
      if (source === "write") vi.spyOn(ports.store, "start").mockImplementation(failed);
      await expect(start(service)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
});

const joinInput = {
  guestSessionReference: ids.guest,
  joinCredential: firstCredential,
  expectedSessionVersion: 1,
  expectedCapabilityVersion: 1,
  operationReference: ids.joinOperation,
  requestedAt: joinAt,
};
const joinUnavailable = { status: "DiningJoinUnavailable" };

describe("WP-2274 current Guest and complete original Join isolation", () => {
  it.each([
    ["guestSessionReference", ids.actor],
    ["diningState", "DiningBound"],
    ["channel", "Pickup"],
    ["storeReference", ids.actor],
    ["tableReference", ids.actor],
    ["tableReference", null],
    ["observedAt", startAt],
  ])("denies current Guest %s mismatch before history", async (path, value) => {
    const { service, ports } = fixture();
    await start(service);
    await service.join(joinInput);
    const guest = await ports.guests.resolve({
      guestSessionReference: ids.guest as never,
      observedAt: joinAt as never,
    });
    vi.spyOn(ports.guests, "resolve").mockResolvedValue(changedRecord(guest, String(path), value));
    const history = vi.spyOn(ports.store, "resolveJoinOperation");
    const write = vi.spyOn(ports.store, "join");
    const generate = vi.spyOn(ports.credentials, "generateReference");
    expect(await service.join(joinInput)).toEqual(joinUnavailable);
    expect(history).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([null, "Cooldown", "unknown"])(
    "denies missing Guest or non-admitted abuse %s",
    async (decision) => {
      const { service, ports } = fixture();
      await start(service);
      await service.join(joinInput);
      if (decision === null) vi.spyOn(ports.guests, "resolve").mockResolvedValue(null);
      else vi.spyOn(ports.abuse, "admit").mockResolvedValue(decision as never);
      const history = vi.spyOn(ports.store, "resolveJoinOperation");
      expect(await service.join(joinInput)).toEqual(joinUnavailable);
      expect(history).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["session.phase", "Closing"],
    ["session.phase", "Closed"],
    ["session.phase", "Cancelled"],
    ["session.startedAt", regenerateAt],
    ["session.tableAssignmentVersion", 8],
    ["capability.selectorHash", hash("f")],
    ["capability.assignmentVersion", 8],
    ["capability.storeReference", ids.actor],
    ["capability.tableReference", ids.actor],
    ["capability.diningSessionReference", ids.actor],
    ["capability.issuedAt", regenerateAt],
    ["capability.kind", "HumanCode"],
  ])("denies current Join state %s mismatch before history", async (path, value) => {
    const { service, ports } = fixture();
    await start(service);
    await service.join(joinInput);
    const state = await ports.store.resolveJoinState(hash("a") as never);
    vi.spyOn(ports.store, "resolveJoinState").mockResolvedValue(
      changedRecord(state, String(path), value),
    );
    const history = vi.spyOn(ports.store, "resolveJoinOperation");
    const generate = vi.spyOn(ports.credentials, "generateReference");
    expect(await service.join(joinInput)).toEqual(joinUnavailable);
    expect(history).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("replays the original consumed Join without generating or consuming again", async () => {
    const { service, ports } = fixture();
    await start(service);
    const first = await service.join(joinInput);
    const write = vi.spyOn(ports.store, "join");
    const generate = vi.spyOn(ports.credentials, "generateReference");
    const replay = await service.join({ ...joinInput, requestedAt: regenerateAt });
    expect(replay).toEqual({ ...first, status: "AlreadyApplied" });
    expect(replay).not.toHaveProperty("joinCredential");
    if (replay.status === "DiningJoinUnavailable") throw new Error("missing replay");
    expect(Object.isFrozen(replay.admission)).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("conflicts for another currently authorized Guest's intent under the same operation", async () => {
    const { service } = fixture();
    await start(service);
    await service.join(joinInput);
    await expect(
      service.join({ ...joinInput, guestSessionReference: ids.actor }),
    ).rejects.toMatchObject({ code: "DINING_SESSION_IDEMPOTENCY_CONFLICT" });
  });

  it.each([
    ["operationReference", ids.startOperation],
    ["operationIntentHash", "invalid"],
    ["extra", true],
    ["session.brandReference", ids.actor],
    ["session.storeReference", ids.actor],
    ["session.tableReference", ids.actor],
    ["session.diningSessionReference", ids.actor],
    ["session.tableAssignmentVersion", 8],
    ["session.startedByActorReference", ids.participant],
    ["session.startedAt", joinAt],
    ["session.phase", "Closing"],
    ["session.version", 1],
    ["session.version", 3],
    ["session.hostParticipantReference", ids.actor],
    ["participant.participantReference", ids.actor],
    ["participant.diningSessionReference", ids.actor],
    ["participant.version", 2],
    ["participant.joinedAt", regenerateAt],
    ["admission.participantReference", ids.actor],
    ["admission.diningSessionReference", ids.actor],
    ["admission.storeReference", ids.actor],
    ["admission.tableReference", ids.actor],
    ["admission.tableAssignmentVersion", 8],
    ["admission.operationReference", ids.startOperation],
    ["admission.operationIntentHash", hash("f")],
    ["admission.version", 2],
    ["admission.issuedAt", startAt],
    ["capability.selectorHash", hash("f")],
    ["capability.capabilityReference", ids.nextCapability],
    ["capability.version", 3],
    ["capability.consumedAt", regenerateAt],
    ["capability.generation", 2],
  ])("rejects malformed original Join %s", async (path, value) => {
    const { service, ports } = fixture();
    await start(service);
    await service.join(joinInput);
    const original = await ports.store.resolveJoinOperation(ids.joinOperation as never);
    vi.spyOn(ports.store, "resolveJoinOperation").mockResolvedValue(
      changedRecord(original, String(path), value),
    );
    const write = vi.spyOn(ports.store, "join");
    await expect(service.join(joinInput)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not accept a rewritten joined/admission/consumption time even when mutually consistent", async () => {
    const { service, ports } = fixture();
    await start(service);
    await service.join(joinInput);
    let original = await ports.store.resolveJoinOperation(ids.joinOperation as never);
    for (const path of ["participant.joinedAt", "admission.issuedAt", "capability.consumedAt"])
      original = changedRecord(original, path, "2026-07-29T12:00:30.000Z");
    vi.spyOn(ports.store, "resolveJoinOperation").mockResolvedValue(original);
    await expect(service.join(joinInput)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });

  it.each(["guest", "state", "history"] as const)(
    "never invokes %s dependency accessors",
    async (source) => {
      const { service, ports } = fixture();
      await start(service);
      await service.join(joinInput);
      const getter = vi.fn(() => {
        throw new Error("private getter details");
      });
      if (source === "guest") {
        const guest = {
          ...(await ports.guests.resolve({
            guestSessionReference: ids.guest as never,
            observedAt: joinAt as never,
          })),
        };
        Object.defineProperty(guest, "guestSessionReference", { get: getter, enumerable: true });
        vi.spyOn(ports.guests, "resolve").mockResolvedValue(guest as never);
      } else if (source === "state") {
        const state = { ...(await ports.store.resolveJoinState(hash("a") as never)) };
        Object.defineProperty(state, "session", { get: getter, enumerable: true });
        vi.spyOn(ports.store, "resolveJoinState").mockResolvedValue(state as never);
      } else {
        const history = { ...(await ports.store.resolveJoinOperation(ids.joinOperation as never)) };
        Object.defineProperty(history, "admission", { get: getter, enumerable: true });
        vi.spyOn(ports.store, "resolveJoinOperation").mockResolvedValue(history as never);
      }
      if (source === "history")
        await expect(service.join(joinInput)).rejects.toMatchObject({
          code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
        });
      else expect(await service.join(joinInput)).toEqual(joinUnavailable);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("captures original admission before digest equality callbacks", async () => {
    const { service, ports } = fixture();
    await start(service);
    await service.join(joinInput);
    const history = JSON.parse(
      JSON.stringify(await ports.store.resolveJoinOperation(ids.joinOperation as never)),
    ) as DiningJoinRecord;
    vi.spyOn(ports.store, "resolveJoinOperation").mockResolvedValue(history);
    vi.spyOn(ports.credentials, "equals").mockImplementation(() => {
      Object.assign(history.admission, { participantReference: ids.actor });
      return true;
    });
    expect(await service.join(joinInput)).toMatchObject({
      status: "AlreadyApplied",
      admission: { participantReference: ids.participant },
    });
  });

  it("captures current Guest before selector callbacks", async () => {
    const { service, ports } = fixture();
    await start(service);
    const guest = await ports.guests.resolve({
      guestSessionReference: ids.guest as never,
      observedAt: joinAt as never,
    });
    if (guest === null) throw new Error("missing guest");
    vi.spyOn(ports.guests, "resolve").mockResolvedValue(guest);
    vi.spyOn(ports.credentials, "hashJoinCredential").mockImplementation(() => {
      Object.assign(guest, { storeReference: ids.actor });
      return hash("a") as never;
    });
    expect(await service.join(joinInput)).toMatchObject({
      status: "Joined",
      admission: { storeReference: ids.store },
    });
  });

  it("captures coherent state before intent callbacks", async () => {
    const { service, ports } = fixture();
    await start(service);
    const state = JSON.parse(
      JSON.stringify(await ports.store.resolveJoinState(hash("a") as never)),
    ) as { session: DiningStartRecord["session"]; capability: DiningStartRecord["capability"] };
    vi.spyOn(ports.store, "resolveJoinState").mockResolvedValue(state);
    vi.spyOn(ports.credentials, "hashOperationIntent").mockImplementation((intent) => {
      Object.assign(state.session, { storeReference: ids.actor });
      return createHash("sha256").update(intent).digest("hex") as never;
    });
    expect(await service.join(joinInput)).toMatchObject({
      status: "Joined",
      session: { storeReference: ids.store },
    });
  });

  it.each([
    "session.storeReference",
    "participant.diningSessionReference",
    "admission.participantReference",
    "operationReference",
  ])("rejects malformed write acknowledgement %s", async (path) => {
    const { service, ports } = fixture();
    await start(service);
    vi.spyOn(ports.store, "join").mockImplementation(async ({ record }) =>
      changedRecord(record, path, ids.actor),
    );
    await expect(service.join(joinInput)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("converges on a complete concurrent original without claiming another new Join", async () => {
    const { service, ports } = fixture();
    await start(service);
    const write = vi.spyOn(ports.store, "join").mockImplementation(async ({ record }) => {
      let original = changedRecord(record, "participant.participantReference", ids.actor);
      original = changedRecord(original, "session.hostParticipantReference", ids.actor);
      original = changedRecord(original, "admission.participantReference", ids.actor);
      return changedRecord(original, "admission.admissionReference", ids.policy);
    });
    expect(await service.join(joinInput)).toMatchObject({
      status: "AlreadyApplied",
      participant: { participantReference: ids.actor },
      admission: { admissionReference: ids.policy },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired outstanding credential without a write", async () => {
    const { service, ports } = fixture();
    await start(service);
    const write = vi.spyOn(ports.store, "join");
    expect(await service.join({ ...joinInput, requestedAt: "2026-07-29T12:15:00.000Z" })).toEqual(
      joinUnavailable,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["abuse", "state", "history", "write", "hash", "generate"] as const)(
    "redacts synchronous %s errors",
    async (source) => {
      const { service, ports } = fixture();
      await start(service);
      const failed = () => {
        throw new Error("private join dependency details");
      };
      if (source === "abuse") vi.spyOn(ports.abuse, "admit").mockImplementation(failed);
      if (source === "state") vi.spyOn(ports.store, "resolveJoinState").mockImplementation(failed);
      if (source === "history")
        vi.spyOn(ports.store, "resolveJoinOperation").mockImplementation(failed);
      if (source === "write") vi.spyOn(ports.store, "join").mockImplementation(failed);
      if (source === "hash")
        vi.spyOn(ports.credentials, "hashJoinCredential").mockImplementation(failed);
      if (source === "generate")
        vi.spyOn(ports.credentials, "generateReference").mockImplementation(failed);
      const error = await service.join(joinInput).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
      expect(String(error)).not.toContain("private join dependency details");
    },
  );
});

describe("WP-2274 first Join invariants", () => {
  it("rejects a second-version Join attributed to a different Host even when current state agrees", async () => {
    const { service, ports } = fixture();
    await start(service);
    await service.join(joinInput);
    const state = changedRecord(
      await ports.store.resolveJoinState(hash("a") as never),
      "session.hostParticipantReference",
      ids.actor,
    );
    const original = changedRecord(
      await ports.store.resolveJoinOperation(ids.joinOperation as never),
      "session.hostParticipantReference",
      ids.actor,
    );
    vi.spyOn(ports.store, "resolveJoinState").mockResolvedValue(state);
    vi.spyOn(ports.store, "resolveJoinOperation").mockResolvedValue(original);
    await expect(service.join(joinInput)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects consumed version one even when current capability and history agree", async () => {
    const { service, ports } = fixture();
    await start(service);
    await service.join(joinInput);
    const state = changedRecord(
      await ports.store.resolveJoinState(hash("a") as never),
      "capability.version",
      1,
    );
    const original = changedRecord(
      await ports.store.resolveJoinOperation(ids.joinOperation as never),
      "capability.version",
      1,
    );
    vi.spyOn(ports.store, "resolveJoinState").mockResolvedValue(state);
    vi.spyOn(ports.store, "resolveJoinOperation").mockResolvedValue(original);
    await expect(service.join(joinInput)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
});
