import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { parseDigitalReceiptChain } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerReceiptHandler } from "./customer-receipt.js";
import {
  createCustomerContactRemovalHandler,
  CustomerContactRemovalError,
} from "./customer-contact-removal.js";

/** WP-2423 Q15/Q16: receipt tax details, privacy link and the customer's contact removal over HTTP. */
const id = (n: number) => "0190ec15-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-12T12:00:00.000Z";
const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
// TEST-ONLY registration number: shaped like a CRA number, not a real registration.
const chain = parseDigitalReceiptChain({
  orderReference: id(1),
  records: [
    {
      recordReference: id(2),
      version: 1,
      kind: "Original",
      recordedAt: at,
      previousRecordReference: null,
      reasonCode: null,
      snapshot: {
        receiptReference: id(3),
        orderReference: id(1),
        guestSessionReference: id(4),
        operatingEntityReference: id(5),
        operatingEntityDisplayName: "Synthetic Issuer Ltd.",
        brandReference: id(6),
        storeReference: id(7),
        storeDisplayName: "Synthetic Store",
        orderNumber: "1",
        issuedAt: at,
        locale: "en-CA",
        templateVersion: "RECEIPT_V1",
        lines: [
          {
            lineReference: id(8),
            displayName: "Synthetic item",
            quantity: 1,
            lineTotal: money(100n),
          },
        ],
        subtotal: money(100n),
        tax: money(13n),
        taxDetails: {
          businessAddress: {
            addressLines: ["1 Test-only Street"],
            locality: "Toronto",
            regionCode: "ON",
            postalCode: "M5V 0A0",
            countryCode: "CA",
          },
          taxRegistrations: [{ label: "GST/HST", number: "000000000RT0001" }],
          taxLines: [{ label: "HST", ratePercent: "13", included: false, amount: money(13n) }],
          paymentMethod: "Card",
        },
        tip: money(0n),
        total: money(113n),
        paymentStatus: "Paid",
        refundedTotal: money(0n),
      },
    },
  ],
});
interface Body {
  receipt: { privacyNoticeUrl?: string; records: { snapshot: { taxDetails: unknown } }[] };
}
const receiptHeaders = {
  "sec-fetch-site": "same-origin",
  cookie: "__Host-bop-guest=" + "s".repeat(43),
  "x-csrf-token": "c".repeat(43),
};

it("serializes the frozen address, registration and per-tax lines, and only a safe privacy link", async () => {
  let privacyNoticeUrl: string | null = "https://example.test/privacy";
  const base = await listen(
    createApp({
      customerReceipt: new CustomerReceiptHandler({
        allowedOrigin: "https://pilot.example",
        port: {
          read: vi.fn(),
          readView: async () => ({ chain, financial: null, privacyNoticeUrl }),
        },
      }),
    }),
  );
  const url = base + "/api/v1/orders/" + id(1) + "/receipt";
  const body = (await (await fetch(url, { headers: receiptHeaders })).json()) as Body;
  expect(body.receipt.privacyNoticeUrl).toBe("https://example.test/privacy");
  expect(body.receipt.records[0]?.snapshot.taxDetails).toEqual({
    businessAddress: {
      addressLines: ["1 Test-only Street"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5V 0A0",
      countryCode: "CA",
    },
    taxRegistrations: [{ label: "GST/HST", number: "000000000RT0001" }],
    taxLines: [
      {
        label: "HST",
        ratePercent: "13",
        included: false,
        amount: { amountMinor: "13", currencyCode: "CAD" },
      },
    ],
    paymentMethod: "Card",
  });
  // No link until the Owner enters one, and never an unsafe one.
  for (const value of [null, "javascript:alert(1)", "http://example.test/privacy"]) {
    privacyNoticeUrl = value;
    const next = (await (await fetch(url, { headers: receiptHeaders })).json()) as Body;
    expect(Object.hasOwn(next.receipt, "privacyNoticeUrl")).toBe(false);
  }
});

it("removes the customer's own contact only from a same-origin request with the visit's CSRF token", async () => {
  const port = vi.fn().mockResolvedValue({ status: "Removed" });
  const base = await listen(
    createApp({
      customerContactRemoval: createCustomerContactRemovalHandler({
        allowedOrigin: "https://pilot.example",
        port,
      }),
    }),
  );
  const url = base + "/api/v1/orders/" + id(1) + "/contact-removal";
  const headers = {
    origin: "https://pilot.example",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    cookie: "__Host-bop-guest=" + "s".repeat(43),
    "x-csrf-token": "c".repeat(43),
  };
  const send = (overrides: Record<string, string> = {}, body = "{}") =>
    fetch(url, { method: "POST", headers: { ...headers, ...overrides }, body });
  for (const bad of [
    { origin: "https://elsewhere.example" },
    { "sec-fetch-site": "cross-site" },
    { "x-csrf-token": "" },
    { cookie: "" },
  ])
    expect((await send(bad)).status).toBe(400);
  expect((await send({}, '{"orderReference":"x"}')).status).toBe(400);
  expect(port).not.toHaveBeenCalled();
  const ok = await send();
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.json()).toEqual({ schemaVersion: 1, removal: { status: "Removed" } });
  expect(port).toHaveBeenCalledExactlyOnceWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    orderReference: id(1),
  });
  port.mockRejectedValueOnce(new CustomerContactRemovalError("NotFound"));
  expect((await send()).status).toBe(404);
  port.mockRejectedValueOnce(new CustomerContactRemovalError("Unavailable"));
  const unavailable = await send();
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get("retry-after")).toBe("5");
  // Not configured: the route exists and says it is unavailable.
  const off = await listen(createApp({}));
  expect(
    (
      await fetch(off + "/api/v1/orders/" + id(1) + "/contact-removal", {
        method: "POST",
        headers: { ...headers, origin: "https://127.0.0.1" },
        body: "{}",
      })
    ).status,
  ).toBe(503);
});
