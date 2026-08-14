import { describe, expect, it, vi } from "vitest";

import {
  createReservation,
  createReservationService,
  parseReservationReference,
  type ReservationAction,
  type ReservationOperationRecord,
  type ReservationPorts,
  ReservationWorkflowError,
} from "../index.js";

const id = (n: number) => `018fa100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ref = (n: number) => parseReservationReference(id(n));
const at = (hour: number) => `2026-09-01T${hour.toString().padStart(2, "0")}:00:00.000Z`;

function reservation(overrides: Record<string, unknown> = {}) {
  return createReservation({
    reservationReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    capacityPoolReference: id(5),
    capacityHoldReference: id(6),
    capacityHoldExpiresAt: at(14),
    startAt: at(15),
    expectedEndAt: at(17),
    partySize: 2,
    contact: {
      displayName: "Synthetic Guest",
      contactKind: "Phone",
      contactValue: "+14165550100",
    },
    channel: "Staff",
    accessibilityRequestCodes: [],
    specialRequestCode: null,
    depositPolicyReference: null,
    depositPolicyVersion: null,
    paymentIntentReference: null,
    depositOutcome: "NotRequired",
    status: "Pending",
    revisionNumber: 1,
    aggregateVersion: 1,
    diningSessionReference: null,
    terminalReasonCode: null,
    createdAt: at(9),
    observedAt: at(10),
    ...overrides,
  });
}

function fixture(options: { readonly denied?: boolean } = {}) {
  let aggregate = null as ReturnType<typeof reservation> | null;
  const operations = new Map<string, ReservationOperationRecord>();
  const repositoryReads = vi.fn();
  const ports: ReservationPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantReference: ref(2),
          brandReference: ref(3),
          storeReference: ref(4),
          actorReference: ref(7),
          purpose: "reservation-management",
          permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
          audit: {
            auditId: id(8),
            brandId: id(3),
            storeId: id(4),
            actor: { type: "User", reference: id(7) },
            actionCode: `RESERVATION_${input.action.toUpperCase()}`,
            targetType: "Reservation",
            targetId: id(1),
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: id(9),
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        };
      },
    },
    references: {
      hashIntent(value) {
        let state = 2166136261;
        for (const character of value) {
          state ^= character.charCodeAt(0);
          state = Math.imul(state, 16777619);
        }
        return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
      },
      equals: (left, right) => left === right,
    },
    repository: {
      async resolveOperation(reference) {
        repositoryReads();
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        repositoryReads();
        return aggregate?.reservationReference === reference ? aggregate : null;
      },
      async commit(record) {
        aggregate = record.reservation;
        operations.set(record.operationReference, record);
      },
    },
  };
  return {
    execute: createReservationService(ports).execute,
    repositoryReads,
    current: () => aggregate,
    operation: (reference = id(10)) => operations.get(reference),
  };
}

function command(
  action: ReservationAction,
  candidate: ReturnType<typeof reservation>,
  overrides: Record<string, unknown> = {},
) {
  return {
    action,
    operationReference: id(10),
    expectedAggregateVersion: action === "Create" ? null : candidate.aggregateVersion - 1,
    candidate,
    evidence: null,
    observedAt: candidate.observedAt,
    ...overrides,
  };
}

describe("Reservation application service", () => {
  it("authorizes before repository access, commits once and replays idempotently", async () => {
    const denied = fixture({ denied: true });
    await expect(denied.execute(command("Create", reservation()))).rejects.toThrowError(
      expect.objectContaining({ code: "RESERVATION_PERMISSION_DENIED" }),
    );
    expect(denied.repositoryReads).not.toHaveBeenCalled();

    const allowed = fixture();
    const input = command("Create", reservation());
    await expect(allowed.execute(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(allowed.execute(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
    expect(allowed.current()).toMatchObject({ status: "Pending", aggregateVersion: 1 });
    expect(allowed.operation()?.event).toMatchObject({ eventType: "ReservationCreated" });
  });

  it("requires exact revision evidence and appends the revision atomically", async () => {
    const context = fixture();
    await context.execute(command("Create", reservation()));
    const candidate = reservation({
      capacityHoldReference: id(11),
      capacityHoldExpiresAt: at(18),
      startAt: at(16),
      expectedEndAt: at(18),
      revisionNumber: 2,
      aggregateVersion: 2,
      observedAt: at(11),
    });
    await expect(
      context.execute(
        command("Revise", candidate, {
          operationReference: id(12),
          evidence: {
            revisionReference: id(13),
            reasonCode: "CUSTOMER_RESCHEDULE",
            critical: true,
            noShowEligibleAt: null,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "Applied" });
    expect(context.operation(id(12))?.revision).toMatchObject({
      revisionNumber: 2,
      previousCapacityHoldReference: id(6),
      replacementCapacityHoldReference: id(11),
    });
  });

  it("rejects unrelated evidence and stale expected versions without mutation", async () => {
    const context = fixture();
    await expect(
      context.execute(
        command("Create", reservation(), {
          evidence: {
            revisionReference: null,
            reasonCode: null,
            critical: false,
            noShowEligibleAt: at(12),
          },
        }),
      ),
    ).rejects.toThrow(ReservationWorkflowError);
    expect(context.current()).toBeNull();

    await context.execute(command("Create", reservation()));
    const confirmed = reservation({ status: "Confirmed", aggregateVersion: 2, observedAt: at(11) });
    await expect(
      context.execute(
        command("Confirm", confirmed, {
          operationReference: id(14),
          expectedAggregateVersion: 99,
        }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "RESERVATION_VERSION_CONFLICT" }));
    expect(context.current()).toMatchObject({ status: "Pending", aggregateVersion: 1 });
  });
});
