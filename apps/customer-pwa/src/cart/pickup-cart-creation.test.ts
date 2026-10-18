import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { describe, expect, it } from "vitest";
import type { CartBindingClient } from "./cart-binding-client.js";
import { createPickupCartCreationCoordinator } from "./pickup-cart-creation.js";
import { CartClientError, type CartView } from "./types.js";

const id = (n: number) => `018f9900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const source = "s".repeat(43);
const candidate = "c".repeat(43);
const proof = "p".repeat(43);
const view: CartView = {
  schemaVersion: 1,
  cart: {
    cartReference: id(1),
    version: 1,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2026-09-09T02:00:00.000Z",
      absoluteExpiresAt: "2026-09-10T01:00:00.000Z",
    },
    items: [],
    quote: null,
    warnings: [],
  },
};
function fixture() {
  const state = {
    csrf: source as string | null,
    epoch: 0,
    online: true,
    current: null as CartView | null,
    prepareFailures: 0,
    activateFailure: null as "before" | "after" | null,
    completeFailure: false,
    readFailure: false,
    installed: false,
    creates: 0,
    next: 90,
    afterPrepare: (): void => undefined,
    afterActivate: (): void => undefined,
    afterComplete: (): void => undefined,
    afterRead: (): void => undefined,
  };
  const calls: { name: string; input?: unknown }[] = [];
  const confirmed = (input: unknown) => ({
    status: "Activated" as const,
    operationReference: (input as { operationReference: string }).operationReference,
    csrfToken: candidate,
  });
  const install = () => {
    if (!state.installed) {
      state.installed = true;
      state.creates++;
    }
    state.current = view;
  };
  const binding: CartBindingClient = {
    async prepare(input) {
      calls.push({ name: "prepare", input });
      if (state.prepareFailures-- > 0) throw new Error("synthetic prepare response lost");
      state.afterPrepare();
      return {
        status: "Prepared",
        operationReference: (input as { operationReference: string }).operationReference,
        candidateCsrfToken: candidate,
        recoveryProof: proof,
        expiresAt: "2026-09-09T01:05:00.000Z",
      };
    },
    async activate(input) {
      calls.push({ name: "activate", input });
      if (state.activateFailure === "before") throw new Error("synthetic activation not delivered");
      install();
      state.afterActivate();
      if (state.activateFailure === "after") throw new Error("synthetic activation response lost");
      return confirmed(input);
    },
    async complete(input) {
      calls.push({ name: "complete", input });
      if (state.completeFailure || !state.installed)
        throw new Error("synthetic completion unavailable");
      state.afterComplete();
      return confirmed(input);
    },
  };
  const options = {
    binding,
    cart: {
      async loadCurrent() {
        calls.push({ name: "read" });
        if (state.readFailure) throw new Error("synthetic read unavailable");
        state.afterRead();
        return state.current;
      },
    },
    csrf: {
      get: () => state.csrf,
      capture: () => {
        const epoch = state.epoch;
        return () => epoch === state.epoch;
      },
      set(value: string) {
        state.epoch++;
        calls.push({ name: "csrf" });
        state.csrf = value;
      },
    },
    online: () => state.online,
    generatePreparationReference: () => {
      calls.push({ name: "key" });
      return id(state.next++);
    },
  };
  return { state, calls, options, coordinator: createPickupCartCreationCoordinator(options) };
}
const input = { operationReference: id(20) };

describe("foreground Pickup Cart creation", () => {
  it("reads an existing Cart without preparation or credential changes and reauthorizes replay", async () => {
    const f = fixture();
    f.state.current = view;
    await expect(f.coordinator.createCart(input)).resolves.toEqual(view);
    await expect(f.coordinator.createCart(input)).resolves.toEqual(view);
    expect(f.calls).toEqual([{ name: "read" }, { name: "read" }]);
    expect(f.state.csrf).toBe(source);
  });

  it("creates once, installs only confirmed CSRF, and returns only the safe Cart", async () => {
    const f = fixture();
    const result = await f.coordinator.createCart(input);
    expect(result).toEqual(view);
    expect(f.calls.map((call) => call.name)).toEqual([
      "read",
      "key",
      "prepare",
      "activate",
      "csrf",
      "read",
    ]);
    expect(f.state.csrf).toBe(candidate);
    expect(f.state.creates).toBe(1);
    expect(Object.keys(f.coordinator)).toEqual(["createCart"]);
    for (const secret of [source, candidate, proof])
      expect(JSON.stringify(result)).not.toContain(secret);
    await f.coordinator.createCart(input);
    expect(f.state.creates).toBe(1);
    expect(f.calls.at(-1)?.name).toBe("read");
  });

  it("coalesces same-operation calls and rejects a competing in-flight operation", async () => {
    const f = fixture();
    const first = f.coordinator.createCart(input);
    const second = f.coordinator.createCart(input);
    expect(second).toBe(first);
    await expect(f.coordinator.createCart({ operationReference: id(21) })).rejects.toMatchObject({
      code: "network_unknown",
    });
    await first;
    expect(f.state.creates).toBe(1);
    expect(f.calls.filter((call) => call.name === "key")).toHaveLength(1);
  });

  it("uses a fresh technical preparation only on explicit retry after lost prepare", async () => {
    const f = fixture();
    f.state.prepareFailures = 1;
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.state.creates).toBe(0);
    expect(f.state.csrf).toBe(source);
    expect(f.calls.map((call) => call.name)).toEqual(["read", "key", "prepare"]);
    await f.coordinator.createCart(input);
    expect(f.calls.filter((call) => call.name === "prepare").map((call) => call.input)).toEqual([
      { operationReference: id(90), csrfToken: source },
      { operationReference: id(91), csrfToken: source },
    ]);
    expect(f.state.creates).toBe(1);
  });

  it("completes an uncertain activation with its original candidate and blocks replacement", async () => {
    const f = fixture();
    f.state.activateFailure = "after";
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.state.csrf).toBe(source);
    await expect(f.coordinator.createCart({ operationReference: id(21) })).rejects.toMatchObject({
      code: "network_unknown",
    });
    await expect(f.coordinator.createCart(input)).resolves.toEqual(view);
    expect(f.calls.filter((call) => call.name === "prepare")).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === "activate")).toHaveLength(1);
    expect(f.calls.find((call) => call.name === "complete")?.input).toEqual({
      operationReference: id(90),
      csrfToken: candidate,
    });
    expect(f.state.creates).toBe(1);
  });

  it("falls back to the same activation after a request never reached the server", async () => {
    const f = fixture();
    f.state.activateFailure = "before";
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    f.state.activateFailure = null;
    await expect(f.coordinator.createCart(input)).resolves.toEqual(view);
    const activations = f.calls.filter((call) => call.name === "activate");
    expect(activations).toHaveLength(2);
    expect(activations[1]).toEqual(activations[0]);
    expect(f.calls.filter((call) => call.name === "prepare")).toHaveLength(1);
    expect(f.state.creates).toBe(1);
  });

  it("never starts a fresh preparation after repeated completion/activation failure", async () => {
    const f = fixture();
    f.state.activateFailure = "before";
    f.state.completeFailure = true;
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls.filter((call) => call.name === "prepare")).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === "activate")).toHaveLength(2);
    expect(f.state.creates).toBe(0);
  });

  it("retries only the read after confirmed activation", async () => {
    const f = fixture();
    f.state.afterActivate = () => {
      f.state.readFailure = true;
    };
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    const count = f.calls.length;
    f.state.readFailure = false;
    await expect(f.coordinator.createCart(input)).resolves.toEqual(view);
    expect(f.calls.slice(count)).toEqual([{ name: "read" }]);
    expect(f.state.creates).toBe(1);
  });

  it.each(["initial", "prepared", "activated"] as const)(
    "does not advance while offline at %s",
    async (stage) => {
      const f = fixture();
      if (stage === "initial") f.state.online = false;
      if (stage === "prepared")
        f.state.afterPrepare = () => {
          f.state.online = false;
        };
      if (stage === "activated")
        f.state.afterActivate = () => {
          f.state.online = false;
        };
      await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
        code: "network_unknown",
      });
      if (stage === "initial") expect(f.calls).toEqual([]);
      if (stage === "prepared")
        expect(f.calls.some((call) => call.name === "activate")).toBe(false);
      const count = f.calls.length;
      f.state.online = true;
      await Promise.resolve();
      expect(f.calls).toHaveLength(count);
      f.state.afterPrepare = () => undefined;
      f.state.afterActivate = () => undefined;
      await expect(f.coordinator.createCart(input)).resolves.toEqual(view);
      expect(f.state.creates).toBe(1);
    },
  );

  it("does not overwrite an unrelated CSRF context after activation", async () => {
    const f = fixture();
    f.state.afterActivate = () => {
      f.state.csrf = "x".repeat(43);
    };
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.state.csrf).toBe("x".repeat(43));
    expect(f.calls.some((call) => call.name === "csrf")).toBe(false);
    expect(f.calls.filter((call) => call.name === "prepare")).toHaveLength(1);
  });

  it("rejects a foreign Cart or a context changed during reading before binding", async () => {
    for (const change of ["cart", "context"]) {
      const f = fixture();
      f.state.current = view;
      if (change === "cart")
        f.state.current = { ...view, cart: { ...view.cart, orderType: "DineIn" } };
      else
        f.state.afterRead = () => {
          f.state.csrf = "x".repeat(43);
        };
      await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
        code: "network_unknown",
      });
      expect(f.calls).toEqual([{ name: "read" }]);
    }
  });

  it("does not invoke malformed input accessors or read without CSRF", async () => {
    const f = fixture();
    let reads = 0;
    const invalid = {
      get operationReference() {
        reads++;
        return id(20);
      },
    };
    await expect(f.coordinator.createCart(invalid)).rejects.toMatchObject({
      code: "cart_request_invalid",
    });
    expect(reads).toBe(0);
    expect(f.calls).toEqual([]);
    f.state.csrf = null;
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "cart_session_expired",
    });
    expect(f.calls).toEqual([]);
  });

  it("rejects substituted candidate output without publishing credentials", async () => {
    const f = fixture();
    f.options.binding.activate = async () => ({
      status: "Activated",
      operationReference: id(999),
      csrfToken: candidate,
    });
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.state.csrf).toBe(source);
    expect(f.calls.some((call) => call.name === "csrf")).toBe(false);
  });
});

it.each(["operation", "credential", "proof", "expiry", "accessor"] as const)(
  "rejects malformed preparation %s without activating",
  async (kind) => {
    const f = fixture();
    let getterCalls = 0;
    const prepare = f.options.binding.prepare;
    f.options.binding.prepare = async (input) => {
      const result = { ...(await prepare(input)) };
      if (kind === "operation") result.operationReference = id(999);
      if (kind === "credential") result.candidateCsrfToken = source;
      if (kind === "proof") result.recoveryProof = candidate;
      if (kind === "expiry") result.expiresAt = "invalid";
      if (kind === "accessor")
        Object.defineProperty(result, "recoveryProof", {
          enumerable: true,
          get() {
            getterCalls++;
            return proof;
          },
        });
      return result;
    };
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(getterCalls).toBe(0);
    expect(f.state.csrf).toBe(source);
    expect(f.calls.some((call) => call.name === "activate")).toBe(false);
  },
);

it("preserves definitive session rejection before any creation was attempted", async () => {
  const f = fixture();
  f.options.cart.loadCurrent = async () => {
    throw new CartClientError("cart_session_expired");
  };
  await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
    code: "cart_session_expired",
  });
  expect(f.calls).toEqual([]);
});

it("rechecks connectivity before the completion-to-activation fallback", async () => {
  const f = fixture();
  f.state.activateFailure = "before";
  await expect(f.coordinator.createCart(input)).rejects.toMatchObject({ code: "network_unknown" });
  f.options.binding.complete = async () => {
    f.state.online = false;
    throw new Error("synthetic disconnected completion");
  };
  await expect(f.coordinator.createCart(input)).rejects.toMatchObject({ code: "network_unknown" });
  expect(f.calls.filter((call) => call.name === "activate")).toHaveLength(1);
  expect(f.calls.filter((call) => call.name === "prepare")).toHaveLength(1);
});

describe("Pickup creation Session generation ownership", () => {
  it("keeps a late definitive failure from a superseded generation unknown", async () => {
    const f = fixture();
    f.options.cart.loadCurrent = async () => {
      f.state.epoch++;
      throw new CartClientError("cart_session_expired");
    };
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls).toEqual([]);
  });
  it("rejects an invalidated plan before its scheduled execution", async () => {
    const f = fixture();
    const pending = f.coordinator.createCart(input);
    f.state.epoch++;
    await expect(pending).rejects.toMatchObject({ code: "network_unknown" });
    expect(f.calls).toEqual([]);
  });
  it.each(["afterRead", "afterPrepare", "afterActivate"] as const)(
    "rejects a same-value generation reset at %s",
    async (hook) => {
      const f = fixture();
      f.state[hook] = () => {
        f.state.epoch++;
      };
      await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
        code: "network_unknown",
      });
      const before = f.calls.length;
      await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
        code: "network_unknown",
      });
      expect(f.calls).toHaveLength(before);
      expect(f.calls.some((x) => x.name === "csrf")).toBe(false);
      expect(f.state.csrf).toBe(source);
      if (hook !== "afterActivate") expect(f.calls.some((x) => x.name === "activate")).toBe(false);
    },
  );
  it("does not recover an old candidate after the Session generation changes", async () => {
    const f = fixture();
    f.state.activateFailure = "after";
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    f.state.epoch++;
    const before = f.calls.length;
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls).toHaveLength(before);
    expect(f.state.csrf).toBe(source);
  });
  it("does not publish a late recovery response into a newer Session", async () => {
    const f = fixture();
    f.state.activateFailure = "after";
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    f.state.afterComplete = () => {
      f.state.epoch++;
    };
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls.filter((x) => x.name === "complete")).toHaveLength(1);
    expect(f.calls.filter((x) => x.name === "activate")).toHaveLength(1);
    expect(f.calls.some((x) => x.name === "csrf")).toBe(false);
  });
  it("does not fall back to activation after failed recovery under a superseded context", async () => {
    const f = fixture();
    f.state.activateFailure = "before";
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    f.options.binding.complete = async () => {
      f.state.epoch++;
      throw new Error("synthetic failure");
    };
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls.filter((x) => x.name === "activate")).toHaveLength(1);
  });
  it("owns the new generation after its own credential handoff and checks final readback", async () => {
    const f = fixture();
    let reads = 0;
    f.state.afterRead = () => {
      if (++reads === 2) f.state.epoch++;
    };
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.state.creates).toBe(1);
    expect(f.state.csrf).toBe(candidate);
    expect(f.calls.filter((x) => x.name === "csrf")).toHaveLength(1);
    const before = f.calls.length;
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls).toHaveLength(before);
  });
  it("does not replay a completed plan in a different generation", async () => {
    const f = fixture();
    expect(await f.coordinator.createCart(input)).toEqual(view);
    f.state.epoch++;
    const before = f.calls.length;
    await expect(f.coordinator.createCart(input)).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls).toHaveLength(before);
  });
  it.each(["same-value", "ABA"] as const)(
    "uses the real shared context to reject %s reset after activation",
    async (mode) => {
      const f = fixture();
      setCustomerCsrfCredential(source);
      const coordinator = createPickupCartCreationCoordinator({
        ...f.options,
        csrf: {
          get: getCustomerCsrfCredential,
          set: setCustomerCsrfCredential,
          capture: captureCustomerCsrfContext,
        },
      });
      f.state.afterActivate = () => {
        if (mode === "ABA") setCustomerCsrfCredential("x".repeat(43));
        setCustomerCsrfCredential(source);
      };
      try {
        await expect(coordinator.createCart(input)).rejects.toMatchObject({
          code: "network_unknown",
        });
        expect(getCustomerCsrfCredential()).toBe(source);
        expect(f.calls.filter((x) => x.name === "read")).toHaveLength(1);
      } finally {
        setCustomerCsrfCredential(null);
      }
    },
  );
  it("preserves original response-loss recovery under the real owning generation", async () => {
    const f = fixture();
    setCustomerCsrfCredential(source);
    f.state.activateFailure = "after";
    const coordinator = createPickupCartCreationCoordinator({
      ...f.options,
      csrf: {
        get: getCustomerCsrfCredential,
        set: setCustomerCsrfCredential,
        capture: captureCustomerCsrfContext,
      },
    });
    try {
      await expect(coordinator.createCart(input)).rejects.toMatchObject({
        code: "network_unknown",
      });
      expect(await coordinator.createCart(input)).toEqual(view);
      expect(getCustomerCsrfCredential()).toBe(candidate);
      expect(f.state.creates).toBe(1);
    } finally {
      setCustomerCsrfCredential(null);
    }
  });
});
