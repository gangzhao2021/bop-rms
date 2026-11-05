import { describe, expect, it, vi } from "vitest";
import { createPilotGuestTableClose } from "./pilot-guest-table-close.mjs";

const resources = () => ({
  scope: { brandReference: "brand", storeReference: "store" },
  publicProfile: { binding: { tenantReference: "tenant", validUntil: "2999-01-01T00:00:00.000Z" } },
  transactions: { run: vi.fn() },
  database: { acquire: vi.fn() },
  now: () => "2026-11-05T12:00:00.000Z",
  credentials: { reference: () => "reference" },
});

describe("DEC-DINING-GUEST-TABLE-START: the System's close for a Store", () => {
  it("runs in the Store's scope, with the API's transactions and the Store's account", () => {
    const compose = vi.fn((options) => options);
    const options = createPilotGuestTableClose(
      resources(),
      { providerAccountReference: "account" },
      { createDiningGuestTableClose: compose },
    );
    expect(options.scope).toEqual({
      brandReference: "brand",
      storeReference: "store",
      tenantReference: "tenant",
    });
    expect(options.providerAccountReference).toBe("account");
    expect(options.orderAudit.retentionPolicyCode).toBe("ORDER_AUDIT");
    expect(options.retentionPolicyCode).toBe("AUDIT_DEFAULT");
  });
  it("does nothing outside the pilot runtime or past the Store's binding", async () => {
    vi.stubEnv("BOP_PILOT_ENVIRONMENT", "");
    const compose = vi.fn((options) => options);
    const options = createPilotGuestTableClose(
      {
        ...resources(),
        publicProfile: {
          binding: { tenantReference: "tenant", validUntil: "2020-01-01T00:00:00.000Z" },
        },
      },
      { providerAccountReference: "account" },
      { createDiningGuestTableClose: compose },
    );
    expect(await options.authorize()).toBe(false);
    vi.unstubAllEnvs();
  });
});
