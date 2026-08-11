import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildKdsContinuityState,
  createKdsOperatorHandover,
  createKdsRecoveryReconciliation,
  KdsContinuityError,
  parseKdsOperatorSessionEvidence,
  parseKdsProjectionEvidence,
} from "../index.js";

const id = (value: number) => `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function session(state: "Active" | "Locked" | "Ended" = "Active", offset = 0) {
  return parseKdsOperatorSessionEvidence({
    sessionReference: id(1 + offset),
    actorReference: id(2 + offset),
    brandReference: id(30),
    storeReference: id(31),
    sessionVersion: 1,
    sessionKind: "NamedKdsOperator",
    state,
    observedAt: "2026-08-11T14:00:00.000Z",
    validUntil: "2026-08-11T15:00:00.000Z",
  });
}

const projection = parseKdsProjectionEvidence({
  projectionGenerationReference: id(40),
  sourceCheckpointReference: id(41),
  freshnessStatus: "Fresh",
  partial: false,
  asOfUtc: "2026-08-11T14:10:00.000Z",
});

describe("WP-1408 KDS continuity", () => {
  it("allows commands only for online, fresh, active named-operator state", () => {
    expect(
      buildKdsContinuityState({
        session: session(),
        projection,
        connection: "Online",
        observedAt: "2026-08-11T14:10:01.000Z",
        recoveryRequired: false,
      }),
    ).toMatchObject({ mode: "Live", commandsAllowed: true, commandQueueing: false });
  });

  it.each([
    ["Offline", "OfflineReadOnly"],
    ["Reconnecting", "ReconnectingReadOnly"],
  ] as const)(
    "maps %s to explicit read-only without an offline command queue",
    (connection, mode) => {
      expect(
        buildKdsContinuityState({
          session: session(),
          projection,
          connection,
          observedAt: "2026-08-11T14:10:01.000Z",
          recoveryRequired: false,
        }),
      ).toMatchObject({
        mode,
        commandsAllowed: false,
        commandQueueing: false,
        nonColorIndicator: true,
      });
    },
  );

  it("makes stale, locked and recovery-required states fail closed", () => {
    const stale = parseKdsProjectionEvidence({ ...projection, freshnessStatus: "Stale" });
    expect(
      buildKdsContinuityState({
        session: session(),
        projection: stale,
        connection: "Online",
        observedAt: "2026-08-11T14:10:01.000Z",
        recoveryRequired: false,
      }).mode,
    ).toBe("StaleReadOnly");
    expect(
      buildKdsContinuityState({
        session: session("Locked"),
        projection,
        connection: "Online",
        observedAt: "2026-08-11T14:10:01.000Z",
        recoveryRequired: false,
      }).mode,
    ).toBe("Locked");
    expect(
      buildKdsContinuityState({
        session: session("Locked"),
        projection,
        connection: "Online",
        observedAt: "2026-08-11T14:10:01.000Z",
        recoveryRequired: false,
      }).safeSnapshotVisible,
    ).toBe(false);
    expect(
      buildKdsContinuityState({
        session: session(),
        projection,
        connection: "Online",
        observedAt: "2026-08-11T14:10:01.000Z",
        recoveryRequired: true,
      }),
    ).toMatchObject({ mode: "ReconciliationRequired", manualRunbookCode: "KDS_MANUAL_CONTINUITY" });
  });

  it("requires prior lock/end before a distinct named operator becomes active", () => {
    expect(
      createKdsOperatorHandover({
        handoverReference: id(50),
        priorSession: session("Locked"),
        nextSession: session("Active", 10),
        priorFinalizedAt: "2026-08-11T14:10:00.000Z",
        nextActivatedAt: "2026-08-11T14:10:01.000Z",
        recordedAt: "2026-08-11T14:10:02.000Z",
        reasonCode: "ShiftHandover",
      }),
    ).toMatchObject({ priorFinalState: "Locked", nextActorReference: id(12) });
    expect(() =>
      createKdsOperatorHandover({
        handoverReference: id(50),
        priorSession: session("Active"),
        nextSession: session("Active", 10),
        priorFinalizedAt: "2026-08-11T14:10:00.000Z",
        nextActivatedAt: "2026-08-11T14:10:01.000Z",
        recordedAt: "2026-08-11T14:10:02.000Z",
        reasonCode: "ShiftHandover",
      }),
    ).toThrowError(expect.objectContaining({ code: "KDS_HANDOVER_PRECONDITION_FAILED" }));
  });

  it("reconciles unchanged state without replay and escalates source/manual differences", () => {
    const common = {
      reconciliationReference: id(60),
      brandReference: id(30),
      storeReference: id(31),
      operatorActorReference: id(2),
      offlineSnapshotDigest: sha("snapshot"),
      offlineCheckpointReference: id(61),
      offlineCapturedAt: "2026-08-11T14:10:00.000Z",
      sourceSnapshotDigest: sha("snapshot"),
      sourceCheckpointReference: id(61),
      sourceLoadedAt: "2026-08-11T14:20:00.000Z",
      reconciledAt: "2026-08-11T14:20:01.000Z",
    };
    expect(
      createKdsRecoveryReconciliation({ ...common, manualContinuityEvidenceReference: null }),
    ).toMatchObject({ outcome: "ConvergedNoAction", commandReplayCount: 0 });
    expect(
      createKdsRecoveryReconciliation({
        ...common,
        sourceSnapshotDigest: sha("changed"),
        manualContinuityEvidenceReference: id(62),
      }),
    ).toMatchObject({
      outcome: "RequiresAuthorizedResolution",
      reasonCode: "ManualContinuityUsed",
      commandReplayCount: 0,
    });
  });

  it("rejects shared/anonymous session shapes and open objects", () => {
    expect(() =>
      parseKdsOperatorSessionEvidence({ ...session(), sessionKind: "SharedKds" }),
    ).toThrowError(expect.objectContaining({ code: "KDS_OPERATOR_SESSION_UNAVAILABLE" }));
    expect(KdsContinuityError).toBeTypeOf("function");
  });
});
