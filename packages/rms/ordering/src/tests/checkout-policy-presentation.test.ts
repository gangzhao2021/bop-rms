import { expect, it, vi } from "vitest";
import {
  createCheckoutPolicyPresentationSource,
  type CheckoutPolicyDocumentPort,
} from "../application/checkout-policy-presentation.js";
import type { CheckoutDetailsPorts } from "../application/checkout-details-service.js";
const id = (n: number) => "01909993-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T00:00:00.000Z",
  until = "2026-09-11T00:05:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2), orderType: "Pickup" as const };
const input = { ...scope, cartReference: id(3), cartVersion: 1 };
const document = {
  documentReference: id(4),
  documentVersion: 2,
  documentDigest: "sha256:" + "a".repeat(64),
  purposeCode: "ORDER_TERMS",
};
function setup() {
  let now = at;
  const policy = { ...scope, checkedAt: at, validUntil: until, required: [document] };
  const content = {
    ...scope,
    document,
    title: "Synthetic test document",
    bodyText: "Synthetic fixture only. No legal or Store approval.",
    checkedAt: at,
    validUntil: "2026-09-11T00:04:00.000Z",
  };
  const current = vi.fn<CheckoutDetailsPorts["policies"]["current"]>().mockResolvedValue(policy);
  const read = vi.fn<CheckoutPolicyDocumentPort["read"]>().mockResolvedValue(content);
  const source = createCheckoutPolicyPresentationSource({
    now: () => now,
    policies: { current },
    documents: { read },
  });
  return {
    policy,
    content,
    current,
    read,
    source,
    advance: (value: string) => {
      now = value;
    },
  };
}
it("binds displayed plain text to the exact required version and shortest deadline", async () => {
  const f = setup();
  expect(await f.source.read(input)).toEqual({
    cartReference: id(3),
    cartVersion: 1,
    orderType: "Pickup",
    checkedAt: at,
    validUntil: f.content.validUntil,
    documents: [{ ...document, title: f.content.title, bodyText: f.content.bodyText }],
  });
  expect(f.current).toHaveBeenCalledTimes(2);
});
it("accepts no documents only when current policy explicitly requires none", async () => {
  const f = setup();
  f.current.mockResolvedValue({ ...f.policy, required: [] });
  expect((await f.source.read(input)).documents).toEqual([]);
  expect(f.read).not.toHaveBeenCalled();
});
it.each([
  null,
  { ...scope, document, title: "", bodyText: "Synthetic", checkedAt: at, validUntil: until },
])("refuses missing or invalid published text", async (value) => {
  const f = setup();
  f.read.mockResolvedValue(value);
  await expect(f.source.read(input)).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
});
it.each(["storeReference", "brandReference", "document"] as const)(
  "refuses foreign document %s",
  async (field) => {
    const f = setup();
    f.read.mockResolvedValue({
      ...f.content,
      [field]: field === "document" ? { ...document, documentVersion: 3 } : id(99),
    });
    await expect(f.source.read(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("refuses requirements changed while the document was loading", async () => {
  const f = setup();
  f.current.mockResolvedValueOnce(f.policy).mockResolvedValue({ ...f.policy, required: [] });
  await expect(f.source.read(input)).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
});
it("refuses a document which expires before response assembly", async () => {
  const f = setup();
  f.read.mockImplementation(async () => {
    f.advance(f.content.validUntil);
    return f.content;
  });
  await expect(f.source.read(input)).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
});
it("does not assume no policy when current authority is missing", async () => {
  const f = setup();
  f.current.mockResolvedValue(null);
  await expect(f.source.read(input)).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
  expect(f.read).not.toHaveBeenCalled();
});

it("preserves plain-text newlines and tabs but refuses carriage return controls", async () => {
  const f = setup();
  const bodyText = "First" + String.fromCharCode(10) + "Second" + String.fromCharCode(9) + "line";
  f.read.mockResolvedValue({ ...f.content, bodyText });
  expect((await f.source.read(input)).documents[0]?.bodyText).toBe(bodyText);
  f.read.mockResolvedValue({
    ...f.content,
    bodyText: "First" + String.fromCharCode(13) + "Second",
  });
  await expect(f.source.read(input)).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
});
