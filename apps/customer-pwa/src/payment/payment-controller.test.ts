import { afterEach, describe, expect, it } from "vitest";
import {
  getPaymentOperationReference,
  setPaymentOperationReference,
} from "../session/customer-transaction-context.js";
import {
  createPaymentController,
  createUnavailablePaymentClient,
  PaymentClientError,
  type CustomerPaymentClient,
} from "./payment-controller.js";

const id = (n: number) => `018f7900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

afterEach(() => setPaymentOperationReference(null));

describe("WP-1704 Payment controller", () => {
  it("keeps the real browser runtime Provider-gated without making a request", async () => {
    const controller = createPaymentController("handoff", createUnavailablePaymentClient());
    await controller.load();
    expect(controller.getState()).toEqual({ status: "provider-unavailable" });
    expect(getPaymentOperationReference()).toBeNull();
  });

  it("retries an unknown create result with exactly the same operation", async () => {
    const calls: string[] = [];
    let unknown = true;
    const client: CustomerPaymentClient = {
      available: () => true,
      async create(operationReference) {
        calls.push(operationReference);
        if (unknown) throw new PaymentClientError("network_unknown");
        return { schemaVersion: 1, operationReference, status: "Pending" };
      },
      observe: async () => {
        throw new Error("unused");
      },
    };
    const controller = createPaymentController("handoff", client, () => id(1));
    await controller.load();
    await controller.start();
    expect(controller.getState()).toEqual({
      status: "unknown",
      operationReference: id(1),
      canRetrySameOperation: true,
    });
    unknown = false;
    await controller.retry();
    expect(calls).toEqual([id(1), id(1)]);
    expect(controller.getState()).toEqual({ status: "pending", operationReference: id(1) });
  });

  it("shows success only from a closed observation for the page-memory operation", async () => {
    setPaymentOperationReference(id(2));
    const client: CustomerPaymentClient = {
      available: () => true,
      create: async () => {
        throw new Error("unused");
      },
      observe: async (operationReference) => ({
        schemaVersion: 1,
        operationReference,
        status: "Succeeded",
        orderReference: id(3),
      }),
    };
    const controller = createPaymentController("result", client);
    await controller.load();
    expect(controller.getState()).toEqual({
      status: "succeeded",
      operationReference: id(2),
      orderReference: id(3),
    });
  });

  it("re-verifies an unknown result without creating another Payment", async () => {
    setPaymentOperationReference(id(2));
    let observes = 0;
    let creates = 0;
    const client: CustomerPaymentClient = {
      available: () => true,
      create: async () => {
        creates += 1;
        return {};
      },
      observe: async (operationReference) => {
        observes += 1;
        if (observes === 1) throw new PaymentClientError("network_unknown");
        return { schemaVersion: 1, operationReference, status: "Pending" };
      },
    };
    const controller = createPaymentController("result", client);
    await controller.load();
    await controller.retry();
    expect(observes).toBe(2);
    expect(creates).toBe(0);
    expect(controller.getState()).toEqual({ status: "pending", operationReference: id(2) });
  });

  it("fails an extra Provider field closed and clears the operation", async () => {
    setPaymentOperationReference(id(2));
    const client: CustomerPaymentClient = {
      available: () => true,
      create: async () => {
        throw new Error("unused");
      },
      observe: async (operationReference) => ({
        schemaVersion: 1,
        operationReference,
        status: "Succeeded",
        orderReference: id(3),
        clientSecret: "forbidden",
      }),
    };
    const controller = createPaymentController("result", client);
    await controller.load();
    expect(controller.getState()).toEqual({ status: "provider-unavailable" });
    expect(getPaymentOperationReference()).toBeNull();
  });

  it("rejects accessor, custom-prototype and symbol-bearing results", async () => {
    for (const observation of [
      Object.defineProperty(
        { schemaVersion: 1, operationReference: id(2), status: "Pending" },
        "status",
        { enumerable: true, get: () => "Succeeded" },
      ),
      Object.assign(Object.create({ inherited: true }), {
        schemaVersion: 1,
        operationReference: id(2),
        status: "Pending",
      }),
      {
        schemaVersion: 1,
        operationReference: id(2),
        status: "Pending",
        [Symbol("private")]: true,
      },
    ]) {
      setPaymentOperationReference(id(2));
      const client: CustomerPaymentClient = {
        available: () => true,
        create: async () => {
          throw new Error("unused");
        },
        observe: async () => observation,
      };
      const controller = createPaymentController("result", client);
      await controller.load();
      expect(controller.getState()).toEqual({ status: "provider-unavailable" });
      expect(getPaymentOperationReference()).toBeNull();
    }
  });

  it("makes no call or automatic replay while offline", async () => {
    let calls = 0;
    const client: CustomerPaymentClient = {
      available: () => true,
      create: async () => {
        calls += 1;
        return {};
      },
      observe: async () => {
        calls += 1;
        return {};
      },
    };
    const controller = createPaymentController("handoff", client, () => id(1));
    controller.setOnline(false);
    await controller.load();
    await controller.start();
    controller.setOnline(true);
    expect(calls).toBe(0);
    expect(controller.getState()).toEqual({ status: "offline" });
  });
});
