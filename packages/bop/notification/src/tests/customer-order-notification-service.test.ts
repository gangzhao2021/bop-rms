import { describe, expect, it, vi } from "vitest";
import {
  createCustomerOrderNotificationService,
  renderCustomerOrderMessage,
  type CustomerOrderMessageProviderPort,
  type CustomerOrderNotificationAttempt,
  type CustomerOrderNotificationOutcome,
} from "../index.js";

const id = (n: number) => `0190aa20-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const input = (channel: "Phone" | "Email" = "Phone") => ({
  purpose: "OrderPlaced" as const,
  brandReference: id(1),
  storeReference: id(2),
  orderReference: id(3),
  orderNumber: "12",
  storeDisplayName: "DEMO Store",
  contact:
    channel === "Phone"
      ? { channel, value: "+14165550123" }
      : { channel, value: "guest@example.test" },
  contactDetailsReference: id(4),
  contactDetailsVersion: 1,
  orderLink: null,
});
function setup(
  sms: CustomerOrderMessageProviderPort | null,
  email: CustomerOrderMessageProviderPort | null = null,
) {
  const attempts: CustomerOrderNotificationAttempt[] = [];
  const outcomes: CustomerOrderNotificationOutcome[] = [];
  let n = 100;
  const service = createCustomerOrderNotificationService({
    messaging: { sms, email },
    records: {
      async appendAttempt(attempt) {
        if (
          attempts.some(
            (entry) =>
              entry.orderReference === attempt.orderReference && entry.purpose === attempt.purpose,
          )
        )
          return "Exists";
        attempts.push(attempt);
        return "Created";
      },
      async appendOutcome(outcome) {
        outcomes.push(outcome);
      },
    },
    clock: { now: () => "2026-10-14T12:00:00.000Z" },
    references: { generateNotification: () => id(n++) },
  });
  return { service, attempts, outcomes };
}

describe("WP-2423 Q10 customer order notifications", () => {
  it("is inactive without a provider: nothing is rendered, sent or recorded", async () => {
    const { service, attempts, outcomes } = setup(null, null);
    expect(service.availability()).toEqual({ sms: false, email: false });
    expect(await service.notify(input())).toEqual({ status: "NotConfigured" });
    expect(await service.notify(input("Email"))).toEqual({ status: "NotConfigured" });
    expect(attempts).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it("sends once per order and purpose to the given contact and records no customer data", async () => {
    const send = vi.fn(async () => ({
      outcome: "Accepted" as const,
      providerMessageReference: "SM-synthetic-1",
    }));
    const { service, attempts, outcomes } = setup({ channel: "Sms", send });
    expect(service.availability()).toEqual({ sms: true, email: false });
    expect(await service.notify(input())).toEqual({
      status: "Accepted",
      notificationReference: id(100),
    });
    expect(send).toHaveBeenCalledWith({
      channel: "Sms",
      destination: "+14165550123",
      subject: null,
      text: "DEMO Store: we have your order 12. We'll let you know when it's ready.",
      idempotencyKey: id(100),
    });
    expect(await service.notify(input())).toEqual({ status: "AlreadyRecorded" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: "Accepted", providerMessageReference: "SM-synthetic-1" }),
    ]);
    const evidence = JSON.stringify({ attempts, outcomes });
    for (const value of ["+14165550123", "DEMO Store", "we have your order"])
      expect(evidence).not.toContain(value);
  });

  it("records a lost provider response as Unknown and does not resend", async () => {
    const send = vi.fn(async () => {
      throw new Error("synthetic timeout");
    });
    const { service, outcomes } = setup({ channel: "Sms", send });
    expect((await service.notify(input())).status).toBe("Unknown");
    expect(outcomes[0]).toMatchObject({ outcome: "Unknown", providerMessageReference: null });
    expect(await service.notify(input())).toEqual({ status: "AlreadyRecorded" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses only the channel the customer chose and refuses a malformed contact", async () => {
    const sms = vi.fn();
    const send = vi.fn<CustomerOrderMessageProviderPort["send"]>(async () => ({
      outcome: "Rejected" as const,
    }));
    const { service } = setup({ channel: "Sms", send: sms }, { channel: "Email", send });
    expect((await service.notify(input("Email"))).status).toBe("Rejected");
    expect(sms).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      channel: "Email",
      destination: "guest@example.test",
      subject: "DEMO Store: order 12 received",
    });
    await expect(
      service.notify({ ...input(), contact: { channel: "Phone", value: "416-555-0123" } }),
    ).rejects.toThrow();
  });

  it("renders plain customer language with an optional secure link", () => {
    expect(
      renderCustomerOrderMessage({
        purpose: "PickupReady",
        channel: "Sms",
        storeDisplayName: "DEMO Store",
        orderNumber: "12",
        orderLink: "https://order.example.test/resume#t=abc",
      }).text,
    ).toBe(
      "DEMO Store: your order 12 is ready. Show this order number at the pickup counter. See your order: https://order.example.test/resume#t=abc",
    );
    expect(() =>
      renderCustomerOrderMessage({
        purpose: "PickupReady",
        channel: "Sms",
        storeDisplayName: "<b>x</b>",
        orderNumber: "12",
        orderLink: null,
      }),
    ).toThrow();
    expect(() =>
      renderCustomerOrderMessage({
        purpose: "OrderPlaced",
        channel: "Email",
        storeDisplayName: "DEMO",
        orderNumber: "12",
        orderLink: "http://insecure.example.test/x",
      }),
    ).toThrow();
  });
});
