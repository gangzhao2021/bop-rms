import assert from "node:assert/strict";

/** Test assembly bridge; methods delegate only after actual owner options are attached. */
export function deferredCheckoutPayment(journey, scope) {
  assert.equal(typeof journey.tenantReference, "string");
  const current = () => {
    if (!journey.paymentOptions) throw new Error("Payment owner composition not attached");
    return journey.paymentOptions;
  };
  const call = (path, ...args) => {
    let target = current();
    for (const key of path.slice(0, -1)) target = target[key];
    const method = target[path.at(-1)];
    if (typeof method !== "function") throw new Error("Payment owner method not attached");
    const label = path.join(".");
    (journey.paymentCalls ??= []).push(label);
    try {
      const result = method.apply(target, args);
      return result && typeof result.then === "function"
        ? result.catch((error) => {
            journey.paymentCalls.push(label + ":" + (error?.code ?? error?.name ?? "failed"));
            throw error;
          })
        : result;
    } catch (error) {
      journey.paymentCalls.push(label + ":" + (error?.code ?? error?.name ?? "failed"));
      throw error;
    }
  };
  const access = {
    transactions: { run: (...args) => call(["payment", "access", "transactions", "run"], ...args) },
    binding: (...args) => call(["payment", "access", "binding"], ...args),
  };
  const history = {
    resolveOperation: (...args) => call(["payment", "history", "resolveOperation"], ...args),
  };
  return {
    payment: {
      access,
      history,
      intent: {
        // Tenant scope is fixed at startup; owner methods attach before payment requests.
        tenantReference: journey.tenantReference,
        resolveSubmission: (...args) => call(["payment", "intent", "resolveSubmission"], ...args),
        orders: {
          create: (...args) => call(["payment", "intent", "orders", "create"], ...args),
          preparePaymentClock: (...args) =>
            call(["payment", "intent", "orders", "preparePaymentClock"], ...args),
        },
        tips: { select: (...args) => call(["payment", "intent", "tips", "select"], ...args) },
        inventory: { load: (...args) => call(["payment", "intent", "inventory", "load"], ...args) },
        nextPreparationReference: (...args) =>
          call(["payment", "intent", "nextPreparationReference"], ...args),
        payment: (...args) => call(["payment", "intent", "payment"], ...args),
      },
      handoff: {
        transactions: {
          run: (...args) => call(["payment", "handoff", "transactions", "run"], ...args),
        },
        currentAdmission: (...args) => call(["payment", "handoff", "currentAdmission"], ...args),
        allowConfirmation: (...args) => call(["payment", "handoff", "allowConfirmation"], ...args),
        provider: {
          retrieve: (...args) => call(["payment", "handoff", "provider", "retrieve"], ...args),
        },
      },
      result: {
        terminal: { read: (...args) => call(["payment", "result", "terminal", "read"], ...args) },
      },
    },
    receipt: {
      binding: (...args) => call(["receipt", "binding"], ...args),
      transactions: { run: (...args) => call(["receipt", "transactions", "run"], ...args) },
    },
    orderStatus: {
      binding: (...args) => call(["orderStatus", "binding"], ...args),
      transactions: { run: (...args) => call(["orderStatus", "transactions", "run"], ...args) },
      paymentScope: {
        ...scope,
        // Same explicit synthetic Provider account as submission-inventory-payment.
        providerAccountReference: "01909992-0000-7000-8000-00000000005a",
        environment: "Test",
      },
    },
    attach(options) {
      assert.equal(journey.paymentOptions, undefined);
      assert.deepEqual(options.payment.access.scope, scope);
      assert.equal(options.payment.intent.tenantReference, journey.tenantReference);
      assert.deepEqual(options.orderStatus.paymentScope, this.orderStatus.paymentScope);
      journey.paymentOptions = options;
    },
  };
}
