import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiningAdmissionJourney } from "./dining-admission-journey.js";
import type { DiningBindingClient } from "./dining-binding-client.js";
import type { DiningJoinClient } from "./dining-join-client.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
const id = (n: number) => `01902307-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const source = "a".repeat(43),
  candidate = "b".repeat(43),
  proof = "c".repeat(43);
const input = { operationReference: id(1), joinCredential: "123456" };
const resume = { operationReference: id(1) };
const joined = { status: "Joined" as const, operationReference: id(1), admissionReference: id(3) };
const prepared = (operationReference: string) => ({
  status: "Prepared" as const,
  operationReference,
  candidateCsrfToken: candidate,
  recoveryProof: proof,
  expiresAt: "2026-09-09T09:08:00.000Z",
});
const activated = (operationReference: string) => ({
  status: "Activated" as const,
  operationReference,
  csrfToken: candidate,
});
function fixture() {
  let csrf: string | null = source,
    generation = 0,
    online = true,
    sequence = 9;
  const reset = (value: string | null) => {
    csrf = value;
    generation++;
  };
  const capture = () => {
    const version = generation;
    return () => generation === version;
  };
  const join = { join: vi.fn<DiningJoinClient["join"]>().mockResolvedValue(joined) };
  const binding = {
    prepare: vi.fn<DiningBindingClient["prepare"]>(async (value) =>
      prepared((value as { operationReference: string }).operationReference),
    ),
    activate: vi.fn<DiningBindingClient["activate"]>(async (value) =>
      activated((value as { operationReference: string }).operationReference),
    ),
    complete: vi.fn<DiningBindingClient["complete"]>(async (value) =>
      activated((value as { operationReference: string }).operationReference),
    ),
  };
  const options = {
    join,
    binding,
    csrf: { get: () => csrf, set: vi.fn(reset), capture },
    online: () => online,
    generateBindingOperationReference: vi.fn(() => id(2)),
    generatePreparationReference: vi.fn(() => id(++sequence)),
  };
  return {
    join,
    binding,
    options,
    reset,
    get: () => csrf,
    offline: () => {
      online = false;
    },
    reconnect: () => {
      online = true;
    },
    journey: createDiningAdmissionJourney(options),
  };
}
afterEach(() => setCustomerCsrfCredential(null));
describe("foreground Dining admission journey", () => {
  it("composes one Join and binding, exposes only confirmation, and reauthorizes repeated resume", async () => {
    const f = fixture();
    expect(f.join.join).not.toHaveBeenCalled();
    expect(Object.isFrozen(f.journey)).toBe(true);
    const result = await f.journey.start(input);
    expect(result).toEqual({ status: "Bound", operationReference: id(1) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.join.join).toHaveBeenCalledWith({ ...input, csrfToken: source });
    expect(f.binding.prepare).toHaveBeenCalledWith({
      operationReference: id(10),
      csrfToken: source,
      admissionReference: id(3),
    });
    expect(f.get()).toBe(candidate);
    expect(f.options.csrf.set).toHaveBeenCalledOnce();
    expect(await f.journey.resume(resume)).toEqual(result);
    expect(f.binding.complete).toHaveBeenCalledWith({
      operationReference: id(10),
      csrfToken: candidate,
    });
    expect(f.join.join).toHaveBeenCalledOnce();
    expect(f.binding.prepare).toHaveBeenCalledOnce();
    expect(f.options.csrf.set).toHaveBeenCalledOnce();
    for (const secret of [input.joinCredential, source, candidate, proof, id(3)])
      expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("recovers unknown Join with the original operation and credential", async () => {
    const f = fixture();
    f.join.join.mockRejectedValueOnce(new Error(proof));
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.prepare).not.toHaveBeenCalled();
    await expect(f.journey.start({ ...input, operationReference: id(4) })).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    await expect(f.journey.resume(resume)).resolves.toEqual({
      status: "Bound",
      operationReference: id(1),
    });
    expect(f.join.join.mock.calls).toEqual([
      [{ ...input, csrfToken: source }],
      [{ ...input, csrfToken: source }],
    ]);
  });
  it("recovers unknown binding without another Join or preparation", async () => {
    const f = fixture();
    f.binding.activate.mockRejectedValueOnce(new Error(proof));
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.options.csrf.set).not.toHaveBeenCalled();
    await expect(f.journey.resume(resume)).resolves.toEqual({
      status: "Bound",
      operationReference: id(1),
    });
    expect(f.join.join).toHaveBeenCalledOnce();
    expect(f.binding.prepare).toHaveBeenCalledOnce();
    expect(f.binding.activate).toHaveBeenCalledOnce();
    expect(f.binding.complete).toHaveBeenCalledOnce();
    expect(f.options.generateBindingOperationReference).toHaveBeenCalledOnce();
  });
  it("keeps admission after failed preparation and retries only binding", async () => {
    const f = fixture();
    f.binding.prepare.mockRejectedValueOnce(new Error(proof));
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    await f.journey.resume(resume);
    expect(f.join.join).toHaveBeenCalledOnce();
    expect(f.binding.prepare).toHaveBeenCalledTimes(2);
    expect(
      f.binding.prepare.mock.calls.map(
        (call) => (call[0] as { operationReference: string }).operationReference,
      ),
    ).toEqual([id(10), id(11)]);
    expect(f.options.generateBindingOperationReference).toHaveBeenCalledOnce();
  });
  it("shares exact in-flight intent and explicit resume, denying changed intent", async () => {
    const f = fixture();
    let deliver!: () => void;
    f.join.join.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = () => resolve(joined);
        }),
    );
    const first = f.journey.start(input);
    expect(f.journey.start({ ...input })).toBe(first);
    expect(f.journey.resume(resume)).toBe(first);
    await expect(f.journey.start({ ...input, joinCredential: "654321" })).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    await expect(f.journey.resume({ operationReference: id(4) })).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    deliver();
    await first;
    expect(f.join.join).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    {},
    [],
    { ...input, extra: true },
    { ...input, operationReference: "bad" },
    { ...input, joinCredential: "１２３４５６" },
    { ...input, joinCredential: "A".repeat(21) + "B" },
  ])("denies malformed start %# before I/O", async (value) => {
    const f = fixture();
    await expect(f.journey.start(value)).rejects.toMatchObject({ code: "request-invalid" });
    expect(f.join.join).not.toHaveBeenCalled();
  });
  it.each([null, {}, input, { operationReference: "bad" }])(
    "denies malformed resume %#",
    async (value) => {
      const f = fixture();
      await expect(f.journey.resume(value)).rejects.toMatchObject({ code: "request-invalid" });
      expect(f.join.join).not.toHaveBeenCalled();
    },
  );
  it("requires an existing matching plan to resume", async () => {
    const f = fixture();
    await expect(f.journey.resume(resume)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.join.join).not.toHaveBeenCalled();
  });
  it("does not invoke raw credential getters and captures before caller mutation", async () => {
    const f = fixture(),
      getter = vi.fn(() => "123456");
    await expect(
      f.journey.start(Object.defineProperty({ ...input }, "joinCredential", { get: getter })),
    ).rejects.toMatchObject({ code: "request-invalid" });
    expect(getter).not.toHaveBeenCalled();
    const mutable = { ...input };
    const pending = f.journey.start(mutable);
    mutable.joinCredential = "654321";
    await pending;
    expect(f.join.join).toHaveBeenCalledWith({ ...input, csrfToken: source });
  });
  it.each(["null", "same", "aba"])("denies %s context reset during Join", async (change) => {
    const f = fixture();
    f.join.join.mockImplementationOnce(async () => {
      if (change === "aba") f.reset(candidate);
      f.reset(change === "null" ? null : source);
      return joined;
    });
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    await expect(f.journey.resume(resume)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.prepare).not.toHaveBeenCalled();
    expect(f.options.csrf.set).not.toHaveBeenCalled();
  });
  it.each(["prepare", "activate", "complete"] as const)(
    "denies external reset during binding %s",
    async (stage) => {
      const f = fixture();
      if (stage === "complete") {
        await f.journey.start(input);
        f.binding.complete.mockImplementationOnce(async (value) => {
          f.reset(candidate);
          return activated((value as { operationReference: string }).operationReference);
        });
        await expect(f.journey.resume(resume)).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(f.options.csrf.set).toHaveBeenCalledOnce();
      } else {
        if (stage === "prepare")
          f.binding.prepare.mockImplementationOnce(async (value) => {
            f.reset(source);
            return prepared((value as { operationReference: string }).operationReference);
          });
        else
          f.binding.activate.mockImplementationOnce(async (value) => {
            f.reset(source);
            return activated((value as { operationReference: string }).operationReference);
          });
        await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(f.options.csrf.set).not.toHaveBeenCalled();
      }
      expect(f.join.join).toHaveBeenCalledOnce();
    },
  );
  it.each([
    null,
    { ...joined, status: "Bound" },
    { ...joined, operationReference: id(4) },
    { ...joined, admissionReference: "bad" },
    { ...joined, raw: proof },
  ])("denies substituted Join result %#", async (value) => {
    const f = fixture();
    f.join.join.mockResolvedValue(
      value as unknown as Awaited<ReturnType<DiningJoinClient["join"]>>,
    );
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.prepare).not.toHaveBeenCalled();
  });
  it("rejects malformed activation without publishing or repeating Join", async () => {
    const f = fixture();
    f.binding.activate.mockResolvedValueOnce({ ...activated(id(10)), operationReference: id(99) });
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.options.csrf.set).not.toHaveBeenCalled();
    await f.journey.resume(resume);
    expect(f.join.join).toHaveBeenCalledOnce();
  });
  it("never sends or resumes automatically while offline", async () => {
    const f = fixture();
    f.offline();
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    f.reconnect();
    await Promise.resolve();
    expect(f.join.join).not.toHaveBeenCalled();
    await f.journey.start(input);
    f.offline();
    await expect(f.journey.resume(resume)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.complete).not.toHaveBeenCalled();
  });
  it.each(["binding", "preparation"])("denies reuse of Join operation for %s", async (stage) => {
    const f = fixture();
    if (stage === "binding") f.options.generateBindingOperationReference.mockReturnValue(id(1));
    else f.options.generatePreparationReference.mockReturnValue(id(1));
    await expect(f.journey.start(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.prepare).not.toHaveBeenCalled();
    expect(f.join.join).toHaveBeenCalledOnce();
  });
  it("accepts only its own verified rotation with the real shared CSRF context", async () => {
    const f = fixture();
    setCustomerCsrfCredential(source);
    const journey = createDiningAdmissionJourney({
      ...f.options,
      csrf: {
        get: getCustomerCsrfCredential,
        set: setCustomerCsrfCredential,
        capture: captureCustomerCsrfContext,
      },
    });
    await journey.start(input);
    expect(getCustomerCsrfCredential()).toBe(candidate);
    await journey.resume(resume);
    setCustomerCsrfCredential(candidate);
    await expect(journey.resume(resume)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.complete).toHaveBeenCalledOnce();
  });
  it("bounds errors without private causes", async () => {
    const f = fixture();
    f.join.join.mockRejectedValue(new Error(proof));
    const error = await f.journey.start(input).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "outcome-unknown",
      message: "dining admission is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(proof);
  });
});
