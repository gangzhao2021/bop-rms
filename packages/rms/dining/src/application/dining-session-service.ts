import { captureSessionData, sessionDependency } from "./dining-session-snapshot.js";
import { parseDiningJoinRecord } from "./dining-join-record.js";
import { parseStaffStartRecord, parseStaffRegenerationRecord } from "./dining-staff-record.js";
import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  diningJoinMaximumLifetimeMs,
  evaluateDiningJoin,
  parseDiningJoinCapability,
  parseDiningJoinHumanCode,
  parseDiningJoinInvitationCredential,
  parsePublicCapabilityReference,
  parsePublicCapabilityScopeReference,
  regenerateDiningJoinCapability,
  type DiningJoinCapability,
  type DiningJoinCapabilityKind,
  type DiningJoinHumanCode,
  type DiningJoinInvitationCredential,
} from "@bop/public-capability";
import { revalidateTenantContext, type PermissionDecision } from "@bop/permission";

import {
  DiningSessionError,
  parseDiningGuestContextEvidence,
  parseDiningHash,
  parseDiningIdentityAdmission,
  parseDiningInstant,
  parseDiningParticipant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableStartEvidence,
  type DiningInstant,
  type DiningReference,
} from "../contracts/dining-session.js";
import type {
  DiningSessionPorts,
  DiningStaffAuthorizationEvidence,
} from "./ports/dining-session-ports.js";

const fifteenMinutes = diningJoinMaximumLifetimeMs;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  }
  return value as number;
}

function plus(instant: DiningInstant, milliseconds: number): DiningInstant {
  return parseDiningInstant(new Date(Date.parse(instant) + milliseconds).toISOString());
}

function permission(value: PermissionDecision): PermissionDecision {
  if (
    !Object.isFrozen(value) ||
    value.effect !== "Allow" ||
    value.scopeKind !== "Store" ||
    typeof value.action !== "string" ||
    value.action.length === 0
  ) {
    throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
  }
  return value;
}

function staffEvidence(
  value: DiningStaffAuthorizationEvidence | null,
  expected: {
    tableReference: DiningReference;
    assignmentVersion: number;
    observedAt: DiningInstant;
    auditAction: "DINING_SESSION_START" | "DINING_JOIN_CREDENTIAL_REGENERATE";
  },
): {
  readonly actorReference: DiningReference;
  readonly table: ReturnType<typeof parseDiningTableStartEvidence>;
  readonly audit: AppendAuditRecordInput;
} {
  if (value === null) throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
  let context;
  let table;
  let audit;
  try {
    const raw = closed(value, ["tenantContext", "table", "permission", "audit"]);
    if (!Object.isFrozen(raw.tenantContext) || !Object.isFrozen(raw.permission))
      throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
    const captured = captureSessionData(raw);
    context = revalidateTenantContext(
      captured.tenantContext as DiningStaffAuthorizationEvidence["tenantContext"],
    );
    table = parseDiningTableStartEvidence(captured.table);
    permission(captured.permission as PermissionDecision);
    audit = validateAuditRecord(captured.audit, Date.parse(expected.observedAt));
  } catch (error) {
    void error;
    throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
  }
  const actorReference = context.actor.actorReference;
  if (
    context.scopeKind !== "Store" ||
    String(context.resolvedAt) !== expected.observedAt ||
    actorReference === null ||
    String(context.brand.brandReference) !== table.brandReference ||
    String(context.store?.storeReference) !== table.storeReference ||
    table.tableReference !== expected.tableReference ||
    table.assignmentVersion !== expected.assignmentVersion ||
    table.observedAt !== expected.observedAt ||
    audit.brandId !== table.brandReference ||
    audit.storeId !== table.storeReference ||
    audit.actor.type !== "User" ||
    audit.actor.reference !== actorReference ||
    audit.actionCode !== expected.auditAction ||
    audit.targetType !== "DiningTable" ||
    audit.targetId !== table.tableReference ||
    audit.occurredAt !== expected.observedAt
  ) {
    throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
  }
  return Object.freeze({
    actorReference: parseDiningReference(actorReference),
    table,
    audit,
  });
}

function rawCredential(
  kind: DiningJoinCapabilityKind,
  value: unknown,
): DiningJoinInvitationCredential | DiningJoinHumanCode {
  return kind === "Invitation"
    ? parseDiningJoinInvitationCredential(value)
    : parseDiningJoinHumanCode(value);
}

function inferCredential(value: unknown): Readonly<{
  kind: DiningJoinCapabilityKind;
  credential: DiningJoinInvitationCredential | DiningJoinHumanCode;
}> {
  try {
    return Object.freeze({
      kind: "Invitation",
      credential: parseDiningJoinInvitationCredential(value),
    });
  } catch {
    return Object.freeze({
      kind: "HumanCode",
      credential: parseDiningJoinHumanCode(value),
    });
  }
}

function storeFailure(error: unknown): never {
  if (
    error instanceof DiningSessionError &&
    (error.code === "DINING_SESSION_VERSION_CONFLICT" ||
      error.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT")
  ) {
    throw new DiningSessionError(error.code);
  }
  throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
}

export type StartDiningSessionResult =
  | {
      readonly status: "Issued";
      readonly session: ReturnType<typeof parseDiningSession>;
      readonly capability: DiningJoinCapability;
      readonly joinCredential: DiningJoinInvitationCredential | DiningJoinHumanCode;
    }
  | {
      readonly status: "AlreadyApplied";
      readonly session: ReturnType<typeof parseDiningSession>;
      readonly capability: DiningJoinCapability;
    };

export type JoinDiningSessionResult =
  | {
      readonly status: "Joined" | "AlreadyApplied";
      readonly session: ReturnType<typeof parseDiningSession>;
      readonly participant: ReturnType<typeof parseDiningParticipant>;
      readonly admission: ReturnType<typeof parseDiningIdentityAdmission>;
    }
  | { readonly status: "DiningJoinUnavailable" };

export type RegenerateDiningJoinResult =
  | {
      readonly status: "Issued";
      readonly capability: DiningJoinCapability;
      readonly joinCredential: DiningJoinInvitationCredential | DiningJoinHumanCode;
    }
  | { readonly status: "AlreadyApplied"; readonly capability: DiningJoinCapability };

function sessionPort<T>(action: () => T): T {
  try {
    return action();
  } catch {
    return sessionDependency();
  }
}

async function sessionAsync<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    return storeFailure(error);
  }
}

export function createDiningSessionService(ports: DiningSessionPorts) {
  if (!Number.isSafeInteger(ports.pepperVersion) || ports.pepperVersion < 1) {
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  }
  const unavailable = Object.freeze({ status: "DiningJoinUnavailable" } as const);

  return Object.freeze({
    async start(input: unknown): Promise<StartDiningSessionResult> {
      const raw = closed(input, [
        "tableReference",
        "expectedAssignmentVersion",
        "operationReference",
        "joinKind",
        "requestedAt",
      ]);
      const tableReference = parseDiningReference(raw.tableReference);
      const expectedAssignmentVersion = positive(raw.expectedAssignmentVersion);
      const operationReference = parseDiningReference(raw.operationReference);
      const requestedAt = parseDiningInstant(raw.requestedAt);
      if (raw.joinKind !== "Invitation" && raw.joinKind !== "HumanCode") {
        throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
      }
      const joinKind = raw.joinKind;
      const intent = sessionPort(() =>
        parseDiningHash(
          ports.credentials.hashOperationIntent(
            `Start:${tableReference}:${expectedAssignmentVersion}:${joinKind}`,
          ),
        ),
      );
      const staff = staffEvidence(
        await sessionAsync(() =>
          ports.staff.authorize({
            operation: "StartSession",
            tableReference,
            operationReference,
            observedAt: requestedAt,
          }),
        ),
        {
          tableReference,
          assignmentVersion: expectedAssignmentVersion,
          observedAt: requestedAt,
          auditAction: "DINING_SESSION_START",
        },
      );
      const scope = {
        operationReference,
        brandReference: staff.table.brandReference,
        storeReference: staff.table.storeReference,
        tableReference,
        assignmentVersion: expectedAssignmentVersion,
        observedAt: requestedAt,
        actorReference: staff.actorReference,
      };
      const priorValue = await sessionAsync(() =>
        ports.store.resolveStartOperation(operationReference),
      );
      if (priorValue !== null) {
        const prior = parseStaffStartRecord(priorValue, scope);
        if (sessionPort(() => ports.credentials.equals(prior.operationIntentHash, intent)) !== true)
          throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
        if (prior.capability.kind !== joinKind) return sessionDependency();
        return Object.freeze({
          status: "AlreadyApplied",
          session: prior.session,
          capability: prior.capability,
        });
      }
      if (
        staff.table.tableState !== "Eligible" ||
        staff.table.activeDiningSessionReference !== null
      ) {
        throw new DiningSessionError("DINING_SESSION_UNAVAILABLE");
      }
      const diningSessionReference = sessionPort(() =>
        parseDiningReference(ports.credentials.generateReference("DiningSession")),
      );
      const joinCredential = sessionPort(() =>
        rawCredential(joinKind, ports.credentials.generateJoinCredential(joinKind)),
      );
      const capability = sessionPort(() =>
        parseDiningJoinCapability({
          capabilityReference: parsePublicCapabilityReference(
            ports.credentials.generateReference("JoinCapability"),
          ),
          purpose: "DiningJoin",
          kind: joinKind,
          storeReference: parsePublicCapabilityScopeReference(staff.table.storeReference),
          tableReference: parsePublicCapabilityScopeReference(staff.table.tableReference),
          diningSessionReference: parsePublicCapabilityScopeReference(diningSessionReference),
          selectorHash: ports.credentials.hashJoinCredential(joinKind, joinCredential),
          pepperVersion: ports.pepperVersion,
          assignmentVersion: staff.table.assignmentVersion,
          generation: 1,
          status: "Active",
          version: 1,
          issuedAt: requestedAt,
          expiresAt: plus(requestedAt, fifteenMinutes),
          consumedAt: null,
          revokedAt: null,
        }),
      );
      const session = parseDiningSession({
        diningSessionReference,
        brandReference: staff.table.brandReference,
        storeReference: staff.table.storeReference,
        tableReference: staff.table.tableReference,
        tableAssignmentVersion: staff.table.assignmentVersion,
        phase: "Active",
        version: 1,
        startedByActorReference: staff.actorReference,
        startedAt: requestedAt,
        hostParticipantReference: null,
      });
      const generated = Object.freeze({
        session,
        capability,
        operationReference,
        operationIntentHash: intent,
      });
      const persistedValue = await sessionAsync(() =>
        ports.store.start({
          record: generated,
          expectedAssignmentVersion,
          audit: staff.audit,
        }),
      );
      const persisted = parseStaffStartRecord(persistedValue, scope);
      if (
        sessionPort(() => ports.credentials.equals(persisted.operationIntentHash, intent)) !== true
      )
        throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
      if (persisted.capability.kind !== joinKind) return sessionDependency();
      if (JSON.stringify(persisted) !== JSON.stringify(generated))
        return Object.freeze({
          status: "AlreadyApplied",
          session: persisted.session,
          capability: persisted.capability,
        });
      return Object.freeze({
        status: "Issued",
        session: parseDiningSession(persisted.session),
        capability: parseDiningJoinCapability(persisted.capability),
        joinCredential,
      });
    },

    async join(input: unknown): Promise<JoinDiningSessionResult> {
      let raw;
      let guestSessionReference;
      let operationReference;
      let requestedAt;
      let inferred;
      try {
        raw = closed(input, [
          "guestSessionReference",
          "joinCredential",
          "expectedSessionVersion",
          "expectedCapabilityVersion",
          "operationReference",
          "requestedAt",
        ]);
        guestSessionReference = parseDiningReference(raw.guestSessionReference);
        operationReference = parseDiningReference(raw.operationReference);
        requestedAt = parseDiningInstant(raw.requestedAt);
        inferred = inferCredential(raw.joinCredential);
      } catch {
        throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
      }
      const expectedSessionVersion = positive(raw.expectedSessionVersion);
      const expectedCapabilityVersion = positive(raw.expectedCapabilityVersion);
      const abuseDecision = await sessionAsync(() =>
        ports.abuse.admit({
          guestSessionReference,
          kind: inferred.kind,
          observedAt: requestedAt,
        }),
      );
      if (abuseDecision !== "Admitted") return unavailable;
      let guest;
      try {
        guest = parseDiningGuestContextEvidence(
          captureSessionData(
            await sessionAsync(() =>
              ports.guests.resolve({ guestSessionReference, observedAt: requestedAt }),
            ),
          ),
        );
      } catch {
        return unavailable;
      }
      if (
        guest.guestSessionReference !== guestSessionReference ||
        guest.diningState !== "ContextOnly" ||
        guest.channel !== "DineIn" ||
        guest.tableReference === null ||
        guest.observedAt !== requestedAt
      )
        return unavailable;
      const selectorHash = sessionPort(() => {
        const result = ports.credentials.hashJoinCredential(inferred.kind, inferred.credential);
        parseDiningHash(result);
        return result;
      });
      const state = await sessionAsync(() => ports.store.resolveJoinState(selectorHash));
      if (state === null) return unavailable;
      let session;
      let capability;
      try {
        const captured = closed(captureSessionData(state), ["session", "capability"]);
        session = parseDiningSession(captured.session);
        capability = parseDiningJoinCapability(captured.capability);
      } catch {
        return unavailable;
      }
      if (
        session.phase !== "Active" ||
        session.startedAt > requestedAt ||
        guest.storeReference !== session.storeReference ||
        guest.tableReference !== session.tableReference ||
        capability.assignmentVersion !== session.tableAssignmentVersion ||
        String(capability.issuedAt) > requestedAt ||
        capability.issuedAt < String(session.startedAt) ||
        capability.selectorHash !== selectorHash ||
        capability.kind !== inferred.kind ||
        capability.storeReference !== String(session.storeReference) ||
        capability.tableReference !== String(session.tableReference) ||
        capability.diningSessionReference !== String(session.diningSessionReference)
      ) {
        return unavailable;
      }
      const intent = sessionPort(() =>
        parseDiningHash(
          ports.credentials.hashOperationIntent(
            `Join:${guestSessionReference}:${capability.capabilityReference}`,
          ),
        ),
      );
      const priorValue = await sessionAsync(() =>
        ports.store.resolveJoinOperation(operationReference),
      );
      if (priorValue !== null) {
        if (capability.status !== "Consumed") return unavailable;
        const prior = parseDiningJoinRecord(priorValue, {
          operationReference,
          session,
          consumedCapability: capability,
          maximumSessionVersion: session.version,
          exactConsumedAt: true,
          observedAt: requestedAt,
        });
        if (sessionPort(() => ports.credentials.equals(prior.operationIntentHash, intent)) !== true)
          throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
        return Object.freeze({
          status: "AlreadyApplied",
          session: prior.session,
          participant: prior.participant,
          admission: prior.admission,
        });
      }
      if (session.version !== expectedSessionVersion) return unavailable;
      const decision = sessionPort(() =>
        evaluateDiningJoin({
          capability,
          purpose: "DiningJoin",
          storeReference: session.storeReference,
          tableReference: session.tableReference,
          diningSessionReference: session.diningSessionReference,
          assignmentVersion: session.tableAssignmentVersion,
          generation: capability.generation,
          selectorHash,
          sessionPhase: session.phase,
          abuseDecision,
          observedAt: requestedAt,
          expectedVersion: expectedCapabilityVersion,
        }),
      );
      if (decision.decision !== "Allowed") return unavailable;
      const participantReference = sessionPort(() =>
        parseDiningReference(ports.credentials.generateReference("Participant")),
      );
      const participant = sessionPort(() =>
        parseDiningParticipant({
          participantReference,
          diningSessionReference: session.diningSessionReference,
          status: "Active",
          version: 1,
          joinedAt: requestedAt,
          leftAt: null,
        }),
      );
      const nextSession = sessionPort(() =>
        parseDiningSession({
          ...session,
          version: session.version + 1,
          hostParticipantReference: session.hostParticipantReference ?? participantReference,
        }),
      );
      const admission = sessionPort(() =>
        parseDiningIdentityAdmission({
          admissionReference: ports.credentials.generateReference("IdentityAdmission"),
          diningSessionReference: session.diningSessionReference,
          participantReference,
          storeReference: session.storeReference,
          tableReference: session.tableReference,
          tableAssignmentVersion: session.tableAssignmentVersion,
          operationReference,
          operationIntentHash: intent,
          status: "Active",
          version: 1,
          issuedAt: requestedAt,
          consumedAt: null,
        }),
      );
      const generated = Object.freeze({
        session: nextSession,
        participant,
        admission,
        capability: decision.capability,
        operationReference,
        operationIntentHash: intent,
      });
      const persistedValue = await sessionAsync(() =>
        ports.store.join({
          record: generated,
          expectedSessionVersion,
          expectedCapabilityVersion,
          guestSessionReference,
        }),
      );
      const persisted = parseDiningJoinRecord(persistedValue, {
        operationReference,
        session,
        consumedCapability: decision.capability,
        maximumSessionVersion: nextSession.version,
        exactConsumedAt: false,
        observedAt: requestedAt,
      });
      if (persisted.session.version !== nextSession.version) return sessionDependency();
      if (
        sessionPort(() => ports.credentials.equals(persisted.operationIntentHash, intent)) !== true
      )
        throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
      return Object.freeze({
        status:
          JSON.stringify(persisted) === JSON.stringify(generated) ? "Joined" : "AlreadyApplied",
        session: parseDiningSession(persisted.session),
        participant: parseDiningParticipant(persisted.participant),
        admission: parseDiningIdentityAdmission(persisted.admission),
      });
    },

    async regenerate(input: unknown): Promise<RegenerateDiningJoinResult> {
      const raw = closed(input, [
        "diningSessionReference",
        "tableReference",
        "expectedAssignmentVersion",
        "expectedSessionVersion",
        "expectedCapabilityVersion",
        "operationReference",
        "requestedAt",
      ]);
      const diningSessionReference = parseDiningReference(raw.diningSessionReference);
      const tableReference = parseDiningReference(raw.tableReference);
      const expectedAssignmentVersion = positive(raw.expectedAssignmentVersion);
      const expectedSessionVersion = positive(raw.expectedSessionVersion);
      const expectedCapabilityVersion = positive(raw.expectedCapabilityVersion);
      const operationReference = parseDiningReference(raw.operationReference);
      const requestedAt = parseDiningInstant(raw.requestedAt);
      const intent = sessionPort(() =>
        parseDiningHash(
          ports.credentials.hashOperationIntent(
            `Regenerate:${diningSessionReference}:${tableReference}:${expectedAssignmentVersion}`,
          ),
        ),
      );
      const staff = staffEvidence(
        await sessionAsync(() =>
          ports.staff.authorize({
            operation: "RegenerateJoinCredential",
            tableReference,
            operationReference,
            observedAt: requestedAt,
          }),
        ),
        {
          tableReference,
          assignmentVersion: expectedAssignmentVersion,
          observedAt: requestedAt,
          auditAction: "DINING_JOIN_CREDENTIAL_REGENERATE",
        },
      );
      const scope = {
        operationReference,
        brandReference: staff.table.brandReference,
        storeReference: staff.table.storeReference,
        tableReference,
        assignmentVersion: expectedAssignmentVersion,
        observedAt: requestedAt,
        diningSessionReference,
      };
      const priorValue = await sessionAsync(() =>
        ports.store.resolveRegenerationOperation(operationReference),
      );
      if (priorValue !== null) {
        const prior = parseStaffRegenerationRecord(priorValue, scope);
        if (sessionPort(() => ports.credentials.equals(prior.operationIntentHash, intent)) !== true)
          throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied", capability: prior.capability });
      }
      const state = await sessionAsync(() => ports.store.resolveActiveJoin(diningSessionReference));
      if (state === null) throw new DiningSessionError("DINING_SESSION_UNAVAILABLE");
      let session;
      let previous;
      try {
        const captured = closed(captureSessionData(state), ["session", "capability"]);
        session = parseDiningSession(captured.session);
        previous = parseDiningJoinCapability(captured.capability);
      } catch {
        return sessionDependency();
      }
      if (
        session.diningSessionReference !== diningSessionReference ||
        session.brandReference !== staff.table.brandReference ||
        session.startedAt > requestedAt ||
        String(previous.storeReference) !== session.storeReference ||
        String(previous.tableReference) !== session.tableReference ||
        String(previous.diningSessionReference) !== session.diningSessionReference ||
        previous.assignmentVersion !== session.tableAssignmentVersion ||
        session.phase !== "Active" ||
        staff.table.tableState !== "Eligible" ||
        staff.table.activeDiningSessionReference !== diningSessionReference ||
        session.tableReference !== tableReference ||
        session.storeReference !== staff.table.storeReference ||
        session.tableAssignmentVersion !== expectedAssignmentVersion ||
        session.version !== expectedSessionVersion ||
        previous.version !== expectedCapabilityVersion
      ) {
        throw new DiningSessionError("DINING_SESSION_UNAVAILABLE");
      }
      const joinCredential = sessionPort(() =>
        rawCredential(previous.kind, ports.credentials.generateJoinCredential(previous.kind)),
      );
      const replacement = sessionPort(() =>
        parseDiningJoinCapability({
          ...previous,
          pepperVersion: ports.pepperVersion,
          capabilityReference: ports.credentials.generateReference("JoinCapability"),
          selectorHash: ports.credentials.hashJoinCredential(previous.kind, joinCredential),
          generation: previous.generation + 1,
          status: "Active",
          version: 1,
          issuedAt: requestedAt,
          expiresAt: plus(requestedAt, fifteenMinutes),
          consumedAt: null,
          revokedAt: null,
        }),
      );
      const transition = sessionPort(() =>
        regenerateDiningJoinCapability({
          previous,
          replacement,
          observedAt: requestedAt,
        }),
      );
      const persistedValue = await sessionAsync(() =>
        ports.store.regenerate({
          session,
          previous: transition.previous,
          replacement: transition.current,
          expectedCapabilityVersion,
          operationReference,
          operationIntentHash: intent,
          audit: staff.audit,
        }),
      );
      const persisted = parseStaffRegenerationRecord(persistedValue, scope);
      if (
        sessionPort(() => ports.credentials.equals(persisted.operationIntentHash, intent)) !== true
      )
        throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
      if (JSON.stringify(persisted.capability) !== JSON.stringify(replacement))
        return Object.freeze({ status: "AlreadyApplied", capability: persisted.capability });
      return Object.freeze({
        status: "Issued",
        capability: parseDiningJoinCapability(persisted.capability),
        joinCredential,
      });
    },
  });
}
