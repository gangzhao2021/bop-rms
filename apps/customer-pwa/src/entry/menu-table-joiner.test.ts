import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiningAdmissionJourney } from "../dining/dining-admission-journey.js";
import type { DiningBindingClient } from "../dining/dining-binding-client.js";
import { DiningJoinClientError, type DiningJoinClient } from "../dining/dining-join-client.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createMenuTableJoiner } from "./menu-table-joiner.js";

const id = (n: number) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const candidate = "b".repeat(43);

/** The real admission journey over stand-in join and binding clients. */
function world() {
  let csrf: string | null = "a".repeat(43),
    generation = 0,
    sequence = 20,
    operations = 0;
  const join = {
    join: vi.fn<DiningJoinClient["join"]>(async (value) => ({
      status: "Joined" as const,
      operationReference: (value as { operationReference: string }).operationReference,
      admissionReference: id(3),
    })),
  };
  const echo = (value: unknown) => ({
    status: "Activated" as const,
    operationReference: (value as { operationReference: string }).operationReference,
    csrfToken: candidate,
  });
  const binding = {
    prepare: vi.fn<DiningBindingClient["prepare"]>(async (value) => ({
      status: "Prepared" as const,
      operationReference: (value as { operationReference: string }).operationReference,
      candidateCsrfToken: candidate,
      recoveryProof: "c".repeat(43),
      expiresAt: "2026-11-06T22:00:00.000Z",
    })),
    activate: vi.fn<DiningBindingClient["activate"]>(async (value) => echo(value)),
    complete: vi.fn<DiningBindingClient["complete"]>(async (value) => echo(value)),
  };
  const journey = createDiningAdmissionJourney({
    join,
    binding,
    csrf: {
      get: () => csrf,
      set: (value) => {
        csrf = value;
        generation++;
      },
      capture: () => {
        const version = generation;
        return () => generation === version;
      },
    },
    online: () => true,
    generateBindingOperationReference: () => id(2),
    generatePreparationReference: () => id(++sequence),
  });
  const joined = vi.fn();
  const joiner = createMenuTableJoiner(
    { journey, generateOperationReference: () => id(10 + ++operations) },
    joined,
  );
  return { join, joiner, joined };
}
afterEach(() => setCustomerCsrfCredential(null));

describe("WP-2423 M115: the join a tap on Add runs from the menu", () => {
  it("after an answer that did not come back, the next tap resumes the same join, never a second one", async () => {
    const w = world();
    // The QR join reached the table but its answer was lost.
    w.join.join.mockRejectedValueOnce(new Error("network"));
    expect(await w.joiner()).toBe("Refused");
    expect(w.joined).not.toHaveBeenCalled();
    // The next tap: the same operation (the server replays it), and the guest is in.
    expect(await w.joiner()).toBe("Started");
    expect(
      w.join.join.mock.calls.map(
        ([value]) => (value as { operationReference: string }).operationReference,
      ),
    ).toEqual([id(11), id(11)]);
    expect(w.joined).toHaveBeenCalledTimes(1);
  });

  it("a definitive refusal joined nothing: the next tap is a new join", async () => {
    const w = world();
    w.join.join.mockRejectedValueOnce(new DiningJoinClientError("qr-paused"));
    expect(await w.joiner()).toBe("Refused");
    w.join.join.mockRejectedValueOnce(new DiningJoinClientError("table-in-use"));
    expect(await w.joiner()).toBe("InUse");
    expect(await w.joiner()).toBe("Started");
    expect(
      w.join.join.mock.calls.map(
        ([value]) => (value as { operationReference: string }).operationReference,
      ),
    ).toEqual([id(11), id(12), id(13)]);
  });
});
