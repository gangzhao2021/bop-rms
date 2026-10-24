import { expect, test, vi } from "vitest";
import { createPilotStaffSessionFactory } from "./pilot-staff-session.mjs";

const installation = {
  database: "synthetic",
  loadCustomerData: vi.fn(async () => ({ roster: true })),
};
const credentials = { createInternalMerchantCredentials: vi.fn() };
const implementations = (mode) => ({
  loadPilotStaffSignIn: vi.fn(async () =>
    mode === "cognito"
      ? { mode: "cognito", exactOrigin: "https://order.store-pilot.ca" }
      : { mode },
  ),
  createInternalMerchantSession: vi.fn(async () => ({ mode: "internal-test" })),
  createInternalMerchantCognitoSession: vi.fn(async () => ({ mode: "cognito" })),
});

test("Cognito sign-in is chosen by staff-sign-in.json and shared by every composition of one process", async () => {
  const f = implementations("cognito");
  const options = { credentials, publicOrigin: "https://order.store-pilot.ca", implementations: f };
  // The merchant BFF and the customer-side dining staff commands each build their own factory.
  const merchant = createPilotStaffSessionFactory("/runtime", installation, options);
  const customer = createPilotStaffSessionFactory("/runtime", installation, options);
  const resources = {};
  const first = await merchant(resources);
  expect(first).toEqual({ mode: "cognito" });
  expect(await customer(resources)).toBe(first);
  expect(f.createInternalMerchantCognitoSession).toHaveBeenCalledTimes(1);
  expect(f.createInternalMerchantCognitoSession).toHaveBeenCalledWith(resources, {
    signIn: { mode: "cognito", exactOrigin: "https://order.store-pilot.ca" },
    createInternalMerchantCredentials: credentials.createInternalMerchantCredentials,
    staffOrigin: "https://order.store-pilot.ca",
  });
  expect(f.createInternalMerchantSession).not.toHaveBeenCalled();
  // Another resources object (another process composition) gets its own session.
  await merchant({});
  expect(f.createInternalMerchantCognitoSession).toHaveBeenCalledTimes(2);
});

test("without Cognito the InternalTest roster sign-in is used, unchanged", async () => {
  const f = implementations("internal-test");
  const factory = createPilotStaffSessionFactory("/runtime", installation, {
    credentials,
    publicOrigin: "https://127.0.0.1:4443",
    implementations: f,
  });
  expect(await factory({})).toEqual({ mode: "internal-test" });
  const [, options] = f.createInternalMerchantSession.mock.calls[0];
  expect(options.expectedDatabaseName).toBe("synthetic");
  await options.loadEmployee();
  expect(installation.loadCustomerData).toHaveBeenCalledWith("internal-test-merchant.json");
  expect(f.createInternalMerchantCognitoSession).not.toHaveBeenCalled();
});

test("a failed start is not remembered", async () => {
  const f = implementations("cognito");
  f.createInternalMerchantCognitoSession
    .mockRejectedValueOnce(new Error("INTERNAL_MERCHANT_DENIED"))
    .mockResolvedValueOnce({ mode: "cognito" });
  const factory = createPilotStaffSessionFactory("/runtime", installation, {
    credentials,
    publicOrigin: "https://order.store-pilot.ca",
    implementations: f,
  });
  const resources = {};
  await expect(factory(resources)).rejects.toThrow("INTERNAL_MERCHANT_DENIED");
  expect(await factory(resources)).toEqual({ mode: "cognito" });
});
