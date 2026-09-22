import { afterEach, it, expect, vi } from "vitest";
import { restoreCustomerSession } from "./session-bootstrap.js";
import {
  getCustomerCsrfCredential,
  getCheckoutSessionReference,
  setCustomerCsrfCredential,
} from "./customer-transaction-context.js";
afterEach(() => setCustomerCsrfCredential(null));
const response = (
  value: unknown = { schemaVersion: 1, csrfToken: "B".repeat(43) },
  cache = "no-store",
) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": cache },
  });
it("restores only in memory with same-origin cookie, no-store and bounded foreground fetch", async () => {
  const fetcher = vi.fn().mockResolvedValue(response());
  expect(await restoreCustomerSession(fetcher)).toBe(true);
  expect(getCustomerCsrfCredential()).toBe("B".repeat(43));
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/customer/session/csrf",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "x-bop-session-bootstrap": "1" },
    }),
  );
});
it("rejects caching, extra fields and oversized responses", async () => {
  for (const r of [
    response(undefined, "public"),
    response({ schemaVersion: 1, csrfToken: "B".repeat(43), secret: "x" }),
    response({ csrfToken: "x".repeat(2000) }),
  ]) {
    expect(await restoreCustomerSession(vi.fn().mockResolvedValue(r))).toBe(false);
    expect(getCustomerCsrfCredential()).toBeNull();
  }
});
it("never overwrites a changed session during an in-flight bootstrap", async () => {
  const fetcher = vi.fn().mockImplementation(async () => {
    setCustomerCsrfCredential("C".repeat(43));
    return response();
  });
  expect(await restoreCustomerSession(fetcher)).toBe(false);
  expect(getCustomerCsrfCredential()).toBe("C".repeat(43));
});
it("uses an existing foreground context and handles unavailable backend without credential persistence", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("unavailable"));
  expect(await restoreCustomerSession(fetcher)).toBe(false);
  setCustomerCsrfCredential("C".repeat(43));
  expect(await restoreCustomerSession(fetcher)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const menuContext = {
  publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
  channel: "DineIn",
  locale: "en-CA",
  brandDisplayName: "DEMO Brand",
  storeDisplayName: "DEMO Store",
};
it("restores public menu context with the same successful foreground session", async () => {
  const established = vi.fn();
  expect(
    await restoreCustomerSession(
      vi
        .fn()
        .mockResolvedValue(response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext })),
      established,
    ),
  ).toBe(true);
  expect(established).toHaveBeenCalledWith(menuContext);
});
it("rejects malformed or private context and never restores it after a session change", async () => {
  for (const context of [
    null,
    { ...menuContext, channel: "Delivery" },
    { ...menuContext, privateReference: "hidden" },
    { ...menuContext, publicStoreReference: "invalid" },
  ]) {
    const established = vi.fn();
    expect(
      await restoreCustomerSession(
        vi
          .fn()
          .mockResolvedValue(
            response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext: context }),
          ),
        established,
      ),
    ).toBe(false);
    expect(established).not.toHaveBeenCalled();
    expect(getCustomerCsrfCredential()).toBeNull();
  }
  const established = vi.fn();
  expect(
    await restoreCustomerSession(
      vi.fn().mockImplementation(async () => {
        setCustomerCsrfCredential("C".repeat(43));
        return response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext });
      }),
      established,
    ),
  ).toBe(false);
  expect(established).not.toHaveBeenCalled();
});

it("restores only the server checkout reference in memory without replaying Payment", async () => {
  const checkoutSessionReference = "0190fa21-0000-7000-8000-000000000002";
  const fetcher = vi.fn().mockResolvedValue(
    response({
      schemaVersion: 1,
      csrfToken: "B".repeat(43),
      menuContext,
      checkoutSessionReference,
    }),
  );
  expect(await restoreCustomerSession(fetcher)).toBe(true);
  expect(getCheckoutSessionReference()).toBe(checkoutSessionReference);
  expect(fetcher).toHaveBeenCalledTimes(1);
  setCustomerCsrfCredential(null);
  expect(getCheckoutSessionReference()).toBeNull();
});
it("rejects invalid recovery references before installing any session state", async () => {
  for (const checkoutSessionReference of [null, "invalid", 3, { secret: "hidden" }]) {
    expect(
      await restoreCustomerSession(
        vi
          .fn()
          .mockResolvedValue(
            response({ schemaVersion: 1, csrfToken: "B".repeat(43), checkoutSessionReference }),
          ),
      ),
    ).toBe(false);
    expect(getCustomerCsrfCredential()).toBeNull();
    expect(getCheckoutSessionReference()).toBeNull();
  }
});
