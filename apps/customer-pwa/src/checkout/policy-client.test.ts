import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createCheckoutPolicyClient } from "./policy-client.js";
const id = (n: number) => "01909992-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T00:00:00.000Z",
  until = "2026-09-11T00:05:00.000Z";
const selection = { cartReference: id(1), cartVersion: 2, orderType: "Pickup" as const };
const document = {
  documentReference: id(2),
  documentVersion: 3,
  documentDigest: "sha256:" + "a".repeat(64),
  purposeCode: "ORDER_TERMS",
  title: "Synthetic fixture",
  bodyText: "Synthetic text, not Store approval.",
};
const policy = { ...selection, checkedAt: at, validUntil: until, documents: [document] };
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
});
const response = (value: unknown = policy) =>
  new Response(JSON.stringify({ schemaVersion: 1, policy: value }), { status: 200 });
it("loads immutable versioned documents without acknowledging them", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  vi.stubGlobal("fetch", fetch);
  const result = await createCheckoutPolicyClient(() => Date.parse(at)).read(selection);
  expect(result).toEqual(policy);
  expect(Object.isFrozen(result.documents[0])).toBe(true);
  expect(result).not.toHaveProperty("acknowledged");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
});
it.each([
  { cartReference: id(99) },
  { cartVersion: 3 },
  { orderType: "DineIn" },
  { validUntil: at },
  { checkedAt: until },
  { documents: [document, document] },
  { documents: [{ ...document, documentDigest: "invalid" }] },
  { documents: [{ ...document, title: "" }] },
  { guestSessionReference: id(99) },
])("refuses stale, foreign or malformed policy", async (change) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ ...policy, ...change })),
  );
  await expect(
    createCheckoutPolicyClient(() => Date.parse(at)).read(selection),
  ).rejects.toMatchObject({ code: "unknown" });
});
it("accepts only an explicitly returned empty list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ ...policy, documents: [] })),
  );
  expect(
    (await createCheckoutPolicyClient(() => Date.parse(at)).read(selection)).documents,
  ).toEqual([]);
});
it("does not read after transaction context is absent", async () => {
  setCustomerCsrfCredential(null);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    createCheckoutPolicyClient(() => Date.parse(at)).read(selection),
  ).rejects.toMatchObject({ code: "denied" });
  expect(fetch).not.toHaveBeenCalled();
});
it("discards a result arriving after Guest replacement", async () => {
  let finish: (value: Response) => void = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = createCheckoutPolicyClient(() => Date.parse(at)).read(selection);
  setCustomerCsrfCredential("d".repeat(43));
  finish(response());
  await expect(pending).rejects.toMatchObject({ code: "unknown" });
});
