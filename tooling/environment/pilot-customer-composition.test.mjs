import { expect, it, vi } from "vitest";
import { createConfiguredPilotApiRuntime } from "./pilot-customer-composition.mjs";
import { parsePilotApiArguments } from "./pilot-api-entry.mjs";
const scope = { tenantReference: "tenant", brandReference: "brand", storeReference: "store" };
const config = { scope, providerAccountReference: "account", cart: {}, diningTableFiles: [] };
const installation = { database: "synthetic", loadCustomerRuntime: async () => config };
it("passes all existing customer routes and configured resources to the API runtime without creating resources eagerly", async () => {
  const r = { publicProfile: { binding: scope } },
    createResources = vi.fn(async () => r);
  const sentinel = { runtime: true };
  const actual = await createConfiguredPilotApiRuntime(
    "/synthetic",
    { port: 4300 },
    {
      loadInstallation: async () => installation,
      createResources,
      composeRuntime: async (options, deps) => {
        expect(options).toEqual({ port: 4300 });
        expect(createResources).not.toHaveBeenCalled();
        expect(deps.paymentChannel).toBe("InternalTestOnlineCardAutomatic");
        expect(Object.keys(deps).sort()).toEqual(
          [
            "createInternalCartReplacement",
            "createInternalDiningCheckout",
            "createInternalChannelQuote",
            "createInternalDiningCart",
            "createInternalPickupReadiness",
            "createInternalPickupProof",
            "createInternalPaymentTerminal",
            "createInternalChannelPayment",
            "createInternalSimulatedProvider",
            "createInternalOrder",
            "createInternalCheckout",
            "createInternalCheckoutDetails",
            "createInternalTestItems",
            "createInternalTestCart",
            "createInternalTestResources",
            "createInternalCustomerEntry",
            "providerAccountReference",
            "paymentChannel",
          ].sort(),
        );
        expect(deps.providerAccountReference).toBe(config.providerAccountReference);
        expect(await deps.createInternalTestResources()).toBe(r);
        return sentinel;
      },
    },
  );
  expect(actual).toBe(sentinel);
  expect(createResources).toHaveBeenCalledWith("/synthetic");
});
it("closes newly opened resources on a changed Store binding", async () => {
  const close = vi.fn(async () => undefined);
  await expect(
    createConfiguredPilotApiRuntime(
      "/synthetic",
      {},
      {
        loadInstallation: async () => installation,
        createResources: async () => ({
          close,
          publicProfile: { binding: { ...scope, storeReference: "other" } },
        }),
        composeRuntime: async (_options, deps) => deps.createInternalTestResources(),
      },
    ),
  ).rejects.toThrow("CUSTOMER_RUNTIME_SCOPE_CHANGED");
  expect(close).toHaveBeenCalledOnce();
});
it("configuration failure precedes resource or runtime creation", async () => {
  const createResources = vi.fn(),
    composeRuntime = vi.fn();
  await expect(
    createConfiguredPilotApiRuntime(
      "/synthetic",
      {},
      {
        loadInstallation: async () => {
          throw Error("unavailable");
        },
        createResources,
        composeRuntime,
      },
    ),
  ).rejects.toThrow("unavailable");
  expect(createResources).not.toHaveBeenCalled();
  expect(composeRuntime).not.toHaveBeenCalled();
});
it("rejects extra flags or paths outside the local installation", () => {
  expect(parsePilotApiArguments([".local/pilot-example"])).toBe(".local/pilot-example");
  for (const value of [[], ["../other"], [".local/pilot", "--configuration"], [null]])
    expect(() => parsePilotApiArguments(value)).toThrow();
});
