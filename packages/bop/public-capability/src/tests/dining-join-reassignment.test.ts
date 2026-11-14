import { describe, expect, it, vi } from "vitest";
import {
  evaluateDiningJoin,
  parseDiningJoinMoveAssignment,
  regenerateDiningJoinCapability,
  reissueDiningJoinCapabilityAfterMove,
} from "../index.js";

const reference = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const observedAt = "2026-09-09T12:10:00.000Z";
function fixture() {
  const previous = {
    capabilityReference: reference(1),
    purpose: "DiningJoin",
    kind: "Invitation",
    storeReference: reference(2),
    tableReference: reference(3),
    diningSessionReference: reference(4),
    selectorHash: "a".repeat(64),
    pepperVersion: 1,
    assignmentVersion: 20,
    generation: 5,
    status: "Active",
    version: 1,
    issuedAt: "2026-09-09T12:00:00.000Z",
    expiresAt: "2026-09-09T12:15:00.000Z",
    consumedAt: null as string | null,
    revokedAt: null as string | null,
  };
  const assignment = {
    moveOperationReference: reference(6),
    storeReference: previous.storeReference,
    diningSessionReference: previous.diningSessionReference,
    tableReference: reference(7),
    assignmentVersion: 3,
    sessionVersion: 9,
    movedAt: "2026-09-09T12:05:00.000Z",
  };
  return {
    previous,
    replacement: {
      ...previous,
      capabilityReference: reference(8),
      selectorHash: "b".repeat(64),
      pepperVersion: 2,
      tableReference: assignment.tableReference,
      assignmentVersion: assignment.assignmentVersion,
      generation: 6,
      issuedAt: observedAt,
      expiresAt: "2026-09-09T12:25:00.000Z",
    },
    assignment,
    currentPepperVersion: 2,
    observedAt,
  };
}
type Input = ReturnType<typeof fixture>;
const reject = (input: unknown, code = "PUBLIC_CAPABILITY_STATE_INVALID") =>
  expect(() => reissueDiningJoinCapabilityAfterMove(input)).toThrowError(
    expect.objectContaining({ code }),
  );

describe("Join generation after a Dining Move", () => {
  it("revokes the old scope and issues a fresh current-pepper generation at a lower target version", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = reissueDiningJoinCapabilityAfterMove(input);
    expect(result.previous).toEqual({
      ...input.previous,
      status: "Revoked",
      version: 2,
      revokedAt: observedAt,
    });
    expect(result.current).toEqual(input.replacement);
    expect(input).toEqual(before);
    expect(result.previous.tableReference).toBe(input.previous.tableReference);
    expect(result.previous.expiresAt).toBe(input.previous.expiresAt);
    const evaluation = {
      purpose: "DiningJoin",
      storeReference: input.assignment.storeReference,
      tableReference: input.assignment.tableReference,
      diningSessionReference: input.assignment.diningSessionReference,
      assignmentVersion: input.assignment.assignmentVersion,
      generation: result.current.generation,
      selectorHash: result.current.selectorHash,
      sessionPhase: "Active",
      abuseDecision: "Admitted",
      observedAt,
      expectedVersion: 1,
    };
    expect(evaluateDiningJoin({ ...evaluation, capability: result.current }).decision).toBe(
      "Allowed",
    );
    expect(evaluateDiningJoin({ ...evaluation, capability: result.previous }).decision).toBe(
      "Unavailable",
    );
    expect(evaluateDiningJoin({ ...evaluation, capability: input.previous }).decision).toBe(
      "Unavailable",
    );
    input.previous.tableReference = reference(99);
    input.replacement.selectorHash = "c".repeat(64);
    expect(result.current).toEqual(before.replacement);
    expect(result.previous.tableReference).toBe(before.previous.tableReference);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.current)).toBe(true);
    expect(Object.isFrozen(result.previous)).toBe(true);
  });

  it.each(["Consumed", "Expired"])("preserves the %s predecessor as terminal history", (status) => {
    const input = fixture();
    input.previous.status = status;
    if (status === "Consumed") input.previous.consumedAt = "2026-09-09T12:03:00.000Z";
    else input.previous.expiresAt = observedAt;
    const result = reissueDiningJoinCapabilityAfterMove(input);
    expect(result.previous).toEqual(input.previous);
    expect(result.previous).not.toBe(input.previous);
    expect(result.current.status).toBe("Active");
  });

  it("revokes a clock-expired Active predecessor without extending it", () => {
    const input = fixture();
    input.previous.expiresAt = observedAt;
    expect(reissueDiningJoinCapabilityAfterMove(input).previous).toMatchObject({
      status: "Revoked",
      expiresAt: observedAt,
    });
  });

  it("permits return to an earlier Table with a new assignment after several Moves", () => {
    const input = fixture();
    input.assignment.tableReference = input.previous.tableReference;
    input.assignment.assignmentVersion = 24;
    input.replacement.tableReference = input.assignment.tableReference;
    input.replacement.assignmentVersion = 24;
    expect(reissueDiningJoinCapabilityAfterMove(input).current.assignmentVersion).toBe(24);
  });

  it("supports a fresh HumanCode while retaining the original kind", () => {
    const input = fixture();
    input.previous.kind = "HumanCode";
    input.replacement.kind = "HumanCode";
    expect(reissueDiningJoinCapabilityAfterMove(input).current.kind).toBe("HumanCode");
  });

  const mutations: readonly [string, (input: Input) => void][] = [
    [
      "unmoved assignment",
      (x) => {
        x.assignment.tableReference = x.previous.tableReference;
        x.assignment.assignmentVersion = x.previous.assignmentVersion;
        x.replacement.tableReference = x.previous.tableReference;
        x.replacement.assignmentVersion = x.previous.assignmentVersion;
      },
    ],
    [
      "foreign Store",
      (x) => {
        x.assignment.storeReference = reference(98);
        x.replacement.storeReference = reference(98);
      },
    ],
    [
      "foreign Session",
      (x) => {
        x.assignment.diningSessionReference = reference(98);
        x.replacement.diningSessionReference = reference(98);
      },
    ],
    [
      "wrong replacement Store",
      (x) => {
        x.replacement.storeReference = reference(98);
      },
    ],
    [
      "wrong replacement Session",
      (x) => {
        x.replacement.diningSessionReference = reference(98);
      },
    ],
    [
      "old Table",
      (x) => {
        x.replacement.tableReference = x.previous.tableReference;
      },
    ],
    [
      "wrong assignment",
      (x) => {
        x.replacement.assignmentVersion += 1;
      },
    ],
    [
      "changed kind",
      (x) => {
        x.replacement.kind = "HumanCode";
      },
    ],
    [
      "old pepper",
      (x) => {
        x.replacement.pepperVersion = 1;
      },
    ],
    [
      "generation skip",
      (x) => {
        x.replacement.generation += 1;
      },
    ],
    [
      "same generation",
      (x) => {
        x.replacement.generation = x.previous.generation;
      },
    ],
    [
      "reused identity",
      (x) => {
        x.replacement.capabilityReference = x.previous.capabilityReference;
      },
    ],
    [
      "reused selector",
      (x) => {
        x.replacement.selectorHash = x.previous.selectorHash;
      },
    ],
    [
      "noninitial version",
      (x) => {
        x.replacement.version = 2;
      },
    ],
    [
      "inactive replacement",
      (x) => {
        x.replacement.status = "Expired";
      },
    ],
    [
      "revoked predecessor",
      (x) => {
        x.previous.status = "Revoked";
        x.previous.revokedAt = x.assignment.movedAt;
      },
    ],
    [
      "future consumption",
      (x) => {
        x.previous.status = "Consumed";
        x.previous.consumedAt = "2026-09-09T12:11:00.000Z";
      },
    ],
    [
      "future explicit expiry",
      (x) => {
        x.previous.status = "Expired";
      },
    ],
    [
      "future Move",
      (x) => {
        x.assignment.movedAt = "2026-09-09T12:11:00.000Z";
      },
    ],
    [
      "future issuance",
      (x) => {
        x.replacement.issuedAt = "2026-09-09T12:11:00.000Z";
      },
    ],
    [
      "backdated issuance",
      (x) => {
        x.replacement.issuedAt = "2026-09-09T12:09:00.000Z";
        x.replacement.expiresAt = "2026-09-09T12:24:00.000Z";
      },
    ],
    [
      "future predecessor",
      (x) => {
        x.previous.issuedAt = "2026-09-09T12:11:00.000Z";
      },
    ],
  ];
  it.each(mutations)("denies %s", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    reject(input);
  });

  it.each([
    (x: Input) => {
      x.previous.version = Number.MAX_SAFE_INTEGER;
    },
    (x: Input) => {
      x.previous.generation = Number.MAX_SAFE_INTEGER;
      x.replacement.generation = Number.MAX_SAFE_INTEGER + 1;
    },
    (x: Input) => {
      x.replacement.expiresAt = "2026-09-09T12:25:00.001Z";
    },
    (x: Input) => {
      x.currentPepperVersion = 0;
    },
    (x: Input) => {
      x.assignment.assignmentVersion = 1;
    },
    (x: Input) => {
      x.assignment.sessionVersion = 1;
    },
    (x: Input) => {
      x.assignment.sessionVersion = 2.5;
    },
    (x: Input) => {
      x.assignment.assignmentVersion = Number.MAX_SAFE_INTEGER + 1;
    },
    (x: Input) => {
      x.assignment.moveOperationReference = "invalid";
    },
    (x: Input) => {
      x.assignment.movedAt = "2026-09-09T12:05:00Z";
    },
  ])("rejects malformed, excessive lifetime and overflow data", (mutate) => {
    const input = fixture();
    mutate(input);
    reject(input, "PUBLIC_CAPABILITY_INPUT_INVALID");
  });

  it.each(["assignment", "previous", "replacement", "root"] as const)(
    "rejects extra %s fields and accessors without invoking them",
    (field) => {
      const input = fixture();
      const target = field === "root" ? input : input[field];
      Object.defineProperty(target, "privateValue", { value: "synthetic", enumerable: true });
      reject(input, "PUBLIC_CAPABILITY_INPUT_INVALID");
      const withAccessor = fixture();
      const nextTarget = field === "root" ? withAccessor : withAccessor[field];
      const key = Object.keys(nextTarget)[0];
      if (key === undefined) throw new Error("fixture must have a field");
      const getter = vi.fn(() => {
        throw new Error("must not run");
      });
      Object.defineProperty(nextTarget, key, { get: getter, enumerable: true });
      reject(withAccessor, "PUBLIC_CAPABILITY_INPUT_INVALID");
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("copies and freezes the exact assignment without treating it as authority", () => {
    const input = fixture().assignment;
    const result = parseDiningJoinMoveAssignment(input);
    expect(result).toEqual(input);
    expect(Object.isFrozen(result)).toBe(true);
    input.tableReference = reference(99);
    expect(result.tableReference).not.toBe(input.tableReference);
    expect(() => parseDiningJoinMoveAssignment({ ...input, permission: "Allowed" })).toThrow();
  });

  it("retains legacy same-assignment regeneration and denies using it to reassign", () => {
    const input = fixture();
    expect(() =>
      regenerateDiningJoinCapability({
        previous: input.previous,
        replacement: input.replacement,
        observedAt,
      }),
    ).toThrowError(expect.objectContaining({ code: "PUBLIC_CAPABILITY_STATE_INVALID" }));
    const replacement = {
      ...input.replacement,
      tableReference: input.previous.tableReference,
      assignmentVersion: input.previous.assignmentVersion,
    };
    expect(
      regenerateDiningJoinCapability({ previous: input.previous, replacement, observedAt }).current,
    ).toEqual(replacement);
  });
});
