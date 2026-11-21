import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandLifecycleClient,
  parseBrandLifecycleOriginal,
  parseBrandLifecycleReceipt,
} from "./merchant-brand-lifecycle-client.js";
const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(2) },
  at = "2026-10-06T12:00:00.000Z";
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
const original = createMerchantBrandLifecycleClient().prepare(scope, "ActivateBrand", 1, id(3));
const receipt = {
  profile: "MerchantBrandLifecycleReceiptV1",
  actorReference: id(2),
  brandReference: id(1),
  action: "ActivateBrand",
  operationReference: id(3),
  expectedBrandVersion: 1,
  status: "Applied",
  lifecycle: "Active",
  version: 2,
  occurredAt: at,
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("binds immutable original scalar scope, operation, version and historical receipt", () => {
  expect(Object.isFrozen(original)).toBe(true);
  expect(
    parseBrandLifecycleReceipt(
      { ...receipt, status: "AlreadyApplied" },
      original,
      Date.parse(at) + 100000,
    ).lifecycle,
  ).toBe("Active");
  for (const value of [
    { ...receipt, actorReference: id(9) },
    { ...receipt, version: 3 },
    { ...receipt, lifecycle: "Archived" },
    { ...receipt, operationReference: id(8) },
    { ...receipt, occurredAt: "2026-10-06T12:00:00.001Z" },
  ])
    expect(() => parseBrandLifecycleReceipt(value, original, Date.parse(at))).toThrow();
  expect(() => parseBrandLifecycleOriginal({ ...original, csrf: "c".repeat(43) })).toThrow();
});
it("sends only exact owning command fields with same-origin cookie and CSRF", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt)),
    client = createMerchantBrandLifecycleClient(fetcher);
  await client.execute(original, scope, { csrf: "c".repeat(43) });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/organization/brands/lifecycle");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "X-BOP-CSRF": "c".repeat(43) },
  });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    brandReference: id(1),
    action: "ActivateBrand",
    expectedBrandVersion: 1,
    operationReference: id(3),
  });
});
it("only strict authoritative request-conflict is releasable; denial and ambiguous responses keep original", async () => {
  const client = createMerchantBrandLifecycleClient(
    vi.fn<typeof fetch>().mockResolvedValue(response({ error: "brand_lifecycle_conflict" }, 409)),
  );
  await expect(client.execute(original, scope, { csrf: "c".repeat(43) })).rejects.toMatchObject({
    code: "RequestConflict",
    original,
  });
  for (const [status, body, code] of [
    [403, { error: "request_denied" }, "Denied"],
    [503, { error: "brand_lifecycle_unavailable" }, "Unavailable"],
    [409, { error: "idempotency_conflict" }, "Unavailable"],
    [200, { ...receipt, actorReference: id(9) }, "OutcomeUnknown"],
  ] as const) {
    const candidate = createMerchantBrandLifecycleClient(
      vi.fn<typeof fetch>().mockResolvedValue(response(body, status)),
    );
    await expect(
      candidate.execute(original, scope, { csrf: "c".repeat(43) }),
    ).rejects.toMatchObject({ code });
  }
});
it("lost response and aborted or invalidated generations cannot confirm success", async () => {
  const lost = createMerchantBrandLifecycleClient(
    vi.fn<typeof fetch>().mockRejectedValue(new Error("controlled network")),
  );
  await expect(lost.execute(original, scope, { csrf: "c".repeat(43) })).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  let release: (r: Response) => void = () => undefined;
  const client = createMerchantBrandLifecycleClient(
    vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  );
  const pending = client.execute(original, scope, { csrf: "c".repeat(43) });
  client.invalidate();
  release(response(receipt));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("rejects other actual Actor before dispatch and refuses secret-bearing original getters", async () => {
  const fetcher = vi.fn<typeof fetch>(),
    client = createMerchantBrandLifecycleClient(fetcher);
  await expect(
    client.execute(original, { ...scope, actorReference: id(9) }, { csrf: "c".repeat(43) }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(fetcher).not.toHaveBeenCalled();
  let invoked = false;
  const bad = { ...original };
  Object.defineProperty(bad, "operationReference", {
    enumerable: true,
    get() {
      invoked = true;
      return id(3);
    },
  });
  expect(() => parseBrandLifecycleOriginal(bad)).toThrow();
  expect(invoked).toBe(false);
});
