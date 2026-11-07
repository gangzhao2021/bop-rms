import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ summary: vi.fn(), contact: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  loadOrderCustomerSummary: f.summary,
  loadOrderPickupContact: f.contact,
}));
import { createCustomerOrderNotificationTrigger } from "./customer-order-notification-trigger.js";

const ref = (n: number) => `0190aa30-0000-7000-8000-${String(n).padStart(12, "0")}`;
const scope = { brandReference: ref(1), storeReference: ref(2) };
const tx = { query: vi.fn() };
function trigger(available = { sms: true, email: false }) {
  const notify = vi.fn(async () => ({ status: "Accepted" }));
  const storeDisplayName = vi.fn(async () => "DEMO Store");
  const run = vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx));
  return {
    notify,
    run,
    storeDisplayName,
    handlers: createCustomerOrderNotificationTrigger({
      scope,
      transactions: { run: run as never },
      storeDisplayName,
      notification: { notify, availability: () => available },
    }),
  };
}
beforeEach(() => {
  f.summary.mockResolvedValue({ orderNumber: "12", orderType: "Pickup" });
  f.contact.mockResolvedValue({
    status: "Available",
    name: "Synthetic Guest",
    channel: "Phone",
    value: "+14165550123",
    detailsReference: ref(9),
    detailsVersion: 2,
  });
});

it("WP-2423 Q10: is inactive in the pilot (no provider): reads nothing, sends nothing", async () => {
  const t = trigger({ sms: false, email: false });
  expect(await t.handlers.onPaymentSucceeded({ orderReference: ref(3) })).toEqual({
    status: "Skipped",
    reason: "ChannelInactive",
  });
  expect(t.run).not.toHaveBeenCalled();
  expect(t.notify).not.toHaveBeenCalled();
});

it("sends 'we have your order' and 'ready' to the pickup customer's own contact only", async () => {
  const t = trigger();
  expect(await t.handlers.onPaymentSucceeded({ orderReference: ref(3) })).toEqual({
    status: "Accepted",
  });
  expect(t.notify).toHaveBeenCalledWith({
    purpose: "OrderPlaced",
    ...scope,
    orderReference: ref(3),
    orderNumber: "12",
    storeDisplayName: "DEMO Store",
    contact: { channel: "Phone", value: "+14165550123" },
    contactDetailsReference: ref(9),
    contactDetailsVersion: 2,
    orderLink: null,
  });
  await t.handlers.onKitchenOrderReady({ orderReference: ref(3) });
  expect(t.notify).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: "PickupReady" }));
});

it("skips dine-in, missing or removed contacts and a channel without a provider", async () => {
  const t = trigger({ sms: false, email: true });
  expect(await t.handlers.onPaymentSucceeded({ orderReference: ref(3) })).toEqual({
    status: "Skipped",
    reason: "ChannelInactive",
  });
  f.contact.mockResolvedValueOnce({ status: "Removed", removedAt: "2026-11-01T00:00:00.000Z" });
  expect((await t.handlers.onKitchenOrderReady({ orderReference: ref(3) })).status).toBe("Skipped");
  f.contact.mockResolvedValueOnce({ status: "NotGiven" });
  expect(await t.handlers.onKitchenOrderReady({ orderReference: ref(3) })).toEqual({
    status: "Skipped",
    reason: "NoContact",
  });
  f.summary.mockResolvedValueOnce({ orderNumber: "13", orderType: "DineIn" });
  expect(await t.handlers.onPaymentSucceeded({ orderReference: ref(4) })).toEqual({
    status: "Skipped",
    reason: "NotPickup",
  });
  expect(t.notify).not.toHaveBeenCalled();
});
