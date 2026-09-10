import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiningBindingCoordinator } from "./dining-binding-coordinator.js";
import type { DiningBindingClient } from "./dining-binding-client.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
const id = (n: number) => `01902302-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const source = "a".repeat(43),
  candidate = "b".repeat(43),
  proof = "c".repeat(43),
  other = "d".repeat(43);
const input = { operationReference: id(1), admissionReference: id(2) };
const preparation = (operationReference = id(10)) => ({
  status: "Prepared" as const,
  operationReference,
  candidateCsrfToken: candidate,
  recoveryProof: proof,
  expiresAt: "2026-09-09T09:08:00.000Z",
});
const activation = (operationReference = id(10)) => ({
  status: "Activated" as const,
  operationReference,
  csrfToken: candidate,
});
const error = () => new Error("synthetic restricted failure");
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
    return () => version === generation;
  };
  const binding = {
    prepare: vi.fn<DiningBindingClient["prepare"]>(async (value) =>
      preparation((value as { operationReference: string }).operationReference),
    ),
    activate: vi.fn<DiningBindingClient["activate"]>(async (value) =>
      activation((value as { operationReference: string }).operationReference),
    ),
    complete: vi.fn<DiningBindingClient["complete"]>(async (value) =>
      activation((value as { operationReference: string }).operationReference),
    ),
  };
  const options = {
    binding,
    csrf: { get: () => csrf, set: vi.fn(reset), capture },
    online: () => online,
    generatePreparationReference: vi.fn(() => id(++sequence)),
  };
  return {
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
    coordinator: createDiningBindingCoordinator(options),
  };
}
afterEach(() => setCustomerCsrfCredential(null));
describe("foreground Dining binding coordination", () => {
  it("does no construction I/O and publishes only confirmed binding metadata", async () => {
    const f = fixture();
    expect(f.binding.prepare).not.toHaveBeenCalled();
    const result = await f.coordinator.bind(input);
    expect(result).toEqual({ status: "Bound", operationReference: id(1) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.binding.prepare).toHaveBeenCalledWith({
      operationReference: id(10),
      admissionReference: id(2),
      csrfToken: source,
    });
    expect(f.binding.activate).toHaveBeenCalledWith({
      operationReference: id(10),
      csrfToken: source,
      candidateCsrfToken: candidate,
      recoveryProof: proof,
    });
    expect(f.options.csrf.set).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(f.binding.complete).not.toHaveBeenCalled();
    for (const secret of [source, candidate, proof, id(2)])
      expect(JSON.stringify(result)).not.toContain(secret);
    await f.coordinator.bind(input);
    expect(f.binding.complete).toHaveBeenCalledExactlyOnceWith({
      operationReference: id(10),
      csrfToken: candidate,
    });
    expect(f.options.csrf.set).toHaveBeenCalledTimes(1);
  });
  it("coalesces only exact concurrent intent and captures inputs before scheduling", async () => {
    const f = fixture();
    const mutable = { ...input };
    const first = f.coordinator.bind(mutable);
    mutable.admissionReference = id(3);
    expect(f.coordinator.bind(input)).toBe(first);
    await expect(f.coordinator.bind(mutable)).rejects.toMatchObject({ code: "outcome-unknown" });
    await expect(f.coordinator.bind({ ...input, operationReference: id(4) })).rejects.toMatchObject(
      { code: "outcome-unknown" },
    );
    await first;
    expect(f.binding.prepare).toHaveBeenCalledTimes(1);
    expect(f.binding.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ admissionReference: id(2) }),
    );
  });
  it.each([
    null,
    [],
    {},
    { ...input, extra: true },
    { ...input, admissionReference: "bad" },
    { ...input, operationReference: "bad" },
  ])("rejects malformed input before effects", async (value) => {
    const f = fixture();
    await expect(f.coordinator.bind(value)).rejects.toMatchObject({ code: "request-invalid" });
    expect(f.binding.prepare).not.toHaveBeenCalled();
    expect(f.options.generatePreparationReference).not.toHaveBeenCalled();
  });
  it("rejects getters without evaluating them", async () => {
    const f = fixture();
    const getter = vi.fn(() => id(2));
    await expect(
      f.coordinator.bind(
        Object.defineProperty({ ...input }, "admissionReference", { get: getter }),
      ),
    ).rejects.toMatchObject({ code: "request-invalid" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("retries only read-only preparation with a fresh technical operation", async () => {
    const f = fixture();
    f.binding.prepare.mockRejectedValueOnce(error());
    await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.activate).not.toHaveBeenCalled();
    await f.coordinator.bind(input);
    expect(
      f.binding.prepare.mock.calls.map(
        ([value]) => (value as { operationReference: string }).operationReference,
      ),
    ).toEqual([id(10), id(11)]);
    expect(f.binding.activate).toHaveBeenCalledWith(
      expect.objectContaining({ operationReference: id(11) }),
    );
  });
  it("retains original candidate after unknown activation and completes on explicit retry", async () => {
    const f = fixture();
    f.binding.activate.mockRejectedValueOnce(error());
    await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.get()).toBe(source);
    expect(f.binding.complete).not.toHaveBeenCalled();
    await expect(f.coordinator.bind({ ...input, operationReference: id(3) })).rejects.toMatchObject(
      { code: "outcome-unknown" },
    );
    await expect(f.coordinator.bind({ ...input, admissionReference: id(3) })).rejects.toMatchObject(
      { code: "outcome-unknown" },
    );
    await f.coordinator.bind(input);
    expect(f.binding.prepare).toHaveBeenCalledTimes(1);
    expect(f.binding.activate).toHaveBeenCalledTimes(1);
    expect(f.binding.complete).toHaveBeenCalledWith({
      operationReference: id(10),
      csrfToken: candidate,
    });
    expect(f.get()).toBe(candidate);
  });
  it("may activate only the same candidate after failed completion", async () => {
    const f = fixture();
    f.binding.activate.mockRejectedValueOnce(error());
    f.binding.complete.mockRejectedValueOnce(error());
    await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    await f.coordinator.bind(input);
    expect(f.binding.activate.mock.calls[1]).toEqual(f.binding.activate.mock.calls[0]);
    expect(f.binding.prepare).toHaveBeenCalledTimes(1);
  });
  it.each(["prepare", "activate", "complete"] as const)(
    "rejects malformed %s output without installing credentials",
    async (stage) => {
      const f = fixture();
      if (stage === "complete") {
        f.binding.activate.mockRejectedValueOnce(error());
        await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
      }
      if (stage === "prepare") f.binding.prepare.mockResolvedValueOnce(preparation(id(99)));
      else f.binding[stage].mockResolvedValueOnce(activation(id(99)));
      await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
      expect(f.options.csrf.set).not.toHaveBeenCalled();
      if (stage === "prepare") expect(f.binding.activate).not.toHaveBeenCalled();
    },
  );
  it.each(["before", "prepare", "activate", "recover", "confirmed"] as const)(
    "rejects replaced context at %s",
    async (stage) => {
      const f = fixture();
      if (stage === "before") {
        const result = f.coordinator.bind(input);
        f.reset(source);
        await expect(result).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(f.binding.prepare).not.toHaveBeenCalled();
        return;
      }
      if (stage === "recover") {
        f.binding.activate.mockRejectedValueOnce(error());
        await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
      }
      if (stage === "confirmed") await f.coordinator.bind(input);
      const method = stage === "recover" || stage === "confirmed" ? "complete" : stage;
      const writes = f.options.csrf.set.mock.calls.length;
      if (method === "prepare")
        f.binding.prepare.mockImplementationOnce(async () => {
          f.reset(other);
          return preparation();
        });
      else
        f.binding[method].mockImplementationOnce(async () => {
          f.reset(other);
          return activation();
        });
      await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
      expect(f.get()).toBe(other);
      expect(f.options.csrf.set).toHaveBeenCalledTimes(writes);
    },
  );
  it("does not fall back under a superseded generation", async () => {
    const f = fixture();
    f.binding.activate.mockRejectedValueOnce(error());
    await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    f.binding.complete.mockImplementationOnce(async () => {
      f.reset(source);
      throw error();
    });
    await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.activate).toHaveBeenCalledTimes(1);
    expect(f.options.csrf.set).not.toHaveBeenCalled();
  });
  it.each(["same", "ABA"] as const)(
    "uses actual shared context to reject %s resets",
    async (kind) => {
      const f = fixture();
      setCustomerCsrfCredential(source);
      const set = vi.fn(setCustomerCsrfCredential);
      const coordinator = createDiningBindingCoordinator({
        ...f.options,
        csrf: { get: getCustomerCsrfCredential, set, capture: captureCustomerCsrfContext },
      });
      f.binding.activate.mockImplementationOnce(async () => {
        if (kind === "ABA") setCustomerCsrfCredential(other);
        setCustomerCsrfCredential(source);
        return activation();
      });
      await expect(coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
      expect(set).not.toHaveBeenCalled();
      expect(getCustomerCsrfCredential()).toBe(source);
    },
  );
  it.each(["before", "prepare", "recovery"] as const)(
    "stays foreground-only and checks offline at %s",
    async (stage) => {
      const f = fixture();
      if (stage === "before") f.offline();
      if (stage === "prepare")
        f.binding.prepare.mockImplementationOnce(async () => {
          f.offline();
          return preparation();
        });
      if (stage === "recovery") {
        f.binding.activate.mockRejectedValueOnce(error());
        await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
        f.offline();
      }
      await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
      const calls =
        f.binding.prepare.mock.calls.length +
        f.binding.activate.mock.calls.length +
        f.binding.complete.mock.calls.length;
      f.reconnect();
      await Promise.resolve();
      expect(
        f.binding.prepare.mock.calls.length +
          f.binding.activate.mock.calls.length +
          f.binding.complete.mock.calls.length,
      ).toBe(calls);
      expect(f.options.csrf.set).not.toHaveBeenCalled();
    },
  );
  it.each([null, "bad"])("denies missing/malformed source CSRF", async (value) => {
    const f = fixture();
    f.reset(value);
    await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.prepare).not.toHaveBeenCalled();
  });
  it.each([id(1), "bad"])("rejects an invalid technical operation", async (value) => {
    const f = fixture();
    f.options.generatePreparationReference.mockReturnValue(value);
    await expect(f.coordinator.bind(input)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.binding.prepare).not.toHaveBeenCalled();
  });
  it("rejects context replacement at the final asynchronous delivery boundary", async () => {
    const f = fixture();
    let deliver!: (value: ReturnType<typeof activation>) => void;
    f.binding.activate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const pending = f.coordinator.bind(input);
    await vi.waitFor(() => expect(f.binding.activate).toHaveBeenCalledOnce());
    deliver(activation());
    queueMicrotask(() => f.reset(other));
    await expect(pending).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.options.csrf.set).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(f.get()).toBe(other);
  });
  it("never reflects private exceptions", async () => {
    const f = fixture();
    f.binding.prepare.mockRejectedValueOnce(new Error(proof));
    const result = await f.coordinator.bind(input).catch((value: unknown) => value);
    expect(result).toMatchObject({
      code: "outcome-unknown",
      message: "dining binding is unavailable",
    });
    expect(result).not.toHaveProperty("cause");
    expect(JSON.stringify(result)).not.toContain(proof);
  });
});
