import process from "node:process";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConsumerRegistry } from "../../packages/bop/eventing/src/index.ts";
import {
  createInternalCustomerOrderMessageConsumers,
  createPilotOrderMessaging,
  receiptEmailInput,
} from "./pilot-order-messaging.mjs";

const id = (n) => `0190aa20-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const resources = {
  scope: { brandReference: id(1), storeReference: id(2) },
  now: () => "2026-10-20T12:00:00.000Z",
  credentials: { reference: () => id(9), sessions: {} },
  transactions: { run: vi.fn() },
  database: { acquire: vi.fn() },
  publicProfile: { binding: { validUntil: "2026-11-14T00:00:00.000Z" } },
};
const keys = async () => ({
  peppers: [{ version: 1, key: new Uint8Array(32).fill(1) }],
  abuse: new Uint8Array(32).fill(2),
});
const sesConfig = {
  schemaVersion: 1,
  email: {
    provider: "ses",
    region: "ca-central-1",
    fromAddress: "orders@mail.example.test",
    fromDisplayName: "DEMO Store",
    configurationSetName: "bop-transactional",
    feedbackTopicArn: "arn:aws:sns:ca-central-1:123456789012:bop-transactional-events",
  },
  customerOrigin: "https://127.0.0.1:4443",
  contactDigestKeyFile: "notification-contact-digest-key",
};

async function directory(config) {
  const dir = await mkdtemp(join(tmpdir(), "bop-notification-"));
  if (config !== undefined) {
    await writeFile(join(dir, "notification.json"), JSON.stringify(config), { mode: 0o600 });
    await chmod(join(dir, "notification.json"), 0o600);
  }
  return dir;
}

describe("DEC-PILOT-NOTIFICATIONS pilot composition", () => {
  it("is disabled without notification.json: nothing offered, no consumers, no feedback endpoint", async () => {
    process.env.NODE_ENV = "development";
    const messaging = await createPilotOrderMessaging({
      resources,
      directory: await directory(undefined),
      loadRecoveryKeys: keys,
    });
    expect(messaging.availability()).toEqual({ sms: false, email: false });
    expect(messaging.sending).toBe(false);
    expect(messaging.feedback).toBeUndefined();
    expect(
      createInternalCustomerOrderMessageConsumers(resources, {
        orderMessaging: messaging,
        createTrigger: vi.fn(),
      }),
    ).toEqual([]);
  });

  it("with SES configured (local fake transport) registers three valid consumers and the feedback endpoint", async () => {
    process.env.NODE_ENV = "development";
    const readSecret = vi.fn(async () => `v1:${"ab".repeat(32)}`);
    const messaging = await createPilotOrderMessaging({
      resources,
      directory: await directory(sesConfig),
      loadRecoveryKeys: keys,
      readSecret,
      transports: {
        ses: { sendEmail: vi.fn(async () => ({ MessageId: "ses-1" })) },
        sns: { publish: vi.fn(), confirmSubscription: vi.fn() },
      },
      fetchCertificate: vi.fn(),
    });
    expect(messaging.availability()).toEqual({ sms: false, email: true });
    expect(messaging.feedback).toBeDefined();
    expect(readSecret).toHaveBeenCalledWith(expect.any(String), "notification-contact-digest-key");
    const createTrigger = vi.fn(() => ({
      onPaymentSucceeded: vi.fn(),
      onKitchenOrderReady: vi.fn(),
    }));
    const consumers = createInternalCustomerOrderMessageConsumers(resources, {
      orderMessaging: messaging,
      createTrigger,
    });
    const registrations = consumers.map((consumer) => consumer.registration);
    expect(registrations.map((r) => [r.consumerName, r.eventType])).toEqual([
      ["notification.customer-receipt-email:v1", "PaymentSucceeded"],
      ["notification.customer-order-placed:v1", "PaymentSucceeded"],
      ["notification.customer-order-ready:v1", "KitchenOrderReady"],
    ]);
    expect(() => new ConsumerRegistry(registrations)).not.toThrow();
    expect(createTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ orderLink: messaging.mintOrderLink }),
    );
  });

  it("maps an issued receipt to the email template with the item price before tax", () => {
    const cad = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
    expect(
      receiptEmailInput({
        locale: "en-CA",
        storeDisplayName: "DEMO Store",
        orderNumber: "12",
        issuedAt: "2026-10-20T11:59:00.000Z",
        lines: [
          { displayName: "Latte", quantity: 2, lineTotal: cad(1130n), lineSubtotal: cad(1000n) },
        ],
        subtotal: cad(1000n),
        tax: cad(130n),
        tip: cad(0n),
        total: cad(1130n),
      }),
    ).toEqual({
      locale: "en-CA",
      storeDisplayName: "DEMO Store",
      orderNumber: "12",
      issuedAt: "2026-10-20T11:59:00.000Z",
      lines: [{ displayName: "Latte", quantity: 2, amountMinor: 1000n, currencyCode: "CAD" }],
      subtotalMinor: 1000n,
      taxMinor: 130n,
      tipMinor: 0n,
      totalMinor: 1130n,
      currencyCode: "CAD",
    });
  });
});
