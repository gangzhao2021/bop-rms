import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";

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
