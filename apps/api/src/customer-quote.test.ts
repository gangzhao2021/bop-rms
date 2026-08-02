import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PriceQuoteRequoteResult, PriceQuoteSnapshot } from "@rms/pricing";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerQuoteHandler,
  type CustomerQuotePort,
  type QuoteCartCommand,
  type QuoteCartResult,
} from "./customer-quote.js";

const id = (n: number) => `018fc000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const key = id(90);
const session = id(91);
const servers: Server[] = [];

function quote(): PriceQuoteSnapshot {
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  return {
    quoteReference: id(1),
    quoteVersion: 1,
    brandReference: id(2),
    storeReference: id(3),
    cartReference: id(4),
    cartVersion: 7,
    inputDigest: `sha256:${"a".repeat(64)}`,
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(5),
      metadataDigest: `sha256:${"b".repeat(64)}`,
    },
    subtotal: money(1000n),
    discount: money(0n),
    tax: money(130n),
    fee: money(0n),
    total: money(1130n),
    lines: [
      {
        lineReference: id(6),
        sellableReference: id(7),
        productVersionReference: id(8),
        menuVersionReference: id(9),
        quantity: 1,
        unitPrice: money(1000n),
        subtotal: money(1000n),
        discount: money(0n),
        tax: money(130n),
        fee: money(0n),
        total: money(1130n),
        resolvedPrice: {
          priceBookReference: id(10),
          versionReference: id(11),
          snapshotDigest: `sha256:${"c".repeat(64)}`,
          entryReference: id(12),
        },
        taxResolution: {
          configurationReference: id(13),
          versionReference: id(14),
          snapshotDigest: `sha256:${"d".repeat(64)}`,
        },
        taxLines: [
          {
            ruleReference: id(15),
            taxAmount: money(130n),
            calculationOrder: 1,
            compoundOnPriorTax: false,
          },
        ],
      },
    ],
    appliedPromotionReferences: [],
    warnings: [],
    blockingReasons: [],
    createdAt: at,
    expiresAt: "2026-08-02T16:05:00.000Z",
  } as unknown as PriceQuoteSnapshot;
}

function requote(): PriceQuoteRequoteResult {
  return {
    previousQuoteReference: id(99) as never,
    replacementQuote: quote(),
    change: "ReconfirmationRequired",
    totalChange: { amountMinor: 100n, currencyCode: "CAD" } as never,
    requiresReconfirmation: true,
    evaluatedAt: at,
  };
}

class Port implements CustomerQuotePort {
  readonly calls: QuoteCartCommand[] = [];
  result: QuoteCartResult = { status: "Created", quote: quote() };
  error: unknown;
  async quoteCart(input: Readonly<QuoteCartCommand>): Promise<QuoteCartResult> {
    this.calls.push(input);
    if (this.error !== undefined) throw this.error;
    return this.result;
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(port?: Port): Promise<number> {
  const customerQuote =
    port === undefined ? undefined : new CustomerQuoteHandler({ now: () => at, port });
  const server = createServer(createApp(customerQuote === undefined ? {} : { customerQuote }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function post(
  port: number,
  body: unknown = { cartVersion: 7 },
  headers: Record<string, string> = {},
) {
  return fetch(`http://127.0.0.1:${port}/api/v1/carts/${id(4)}/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-customer-session-id": session,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("WP-1103/1104 Customer Quote API", () => {
  it("passes only authoritative Cart identity/version/session/idempotency context", async () => {
    const service = new Port();
    const response = await post(await listen(service));
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"1"');
    expect(response.headers.get("location")).toBe(`/api/v1/price-quotes/${id(1)}`);
    expect(service.calls).toEqual([
      {
        cartReference: id(4),
        expectedCartVersion: 7,
        customerSessionReference: session,
        idempotencyKey: key,
        requestedAt: at,
      },
    ]);
    const body = (await response.json()) as {
      quote: { total: { amountMinor: string }; lines: unknown[] };
    };
    expect(body.quote.total.amountMinor).toBe("1130");
    expect(body.quote.lines).toHaveLength(1);
  });

  it("returns the exact current Quote without recalculating its snapshot", async () => {
    const service = new Port();
    service.result = { status: "Current", quote: quote() };
    const response = await post(await listen(service));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { quote: { priceChange: unknown } };
    expect(body.quote.priceChange).toBeNull();
  });

  it("returns a replacement Quote with an explicit price-increase decision", async () => {
    const service = new Port();
    service.result = { status: "Requoted", requote: requote() };
    const response = await post(await listen(service));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      quote: {
        priceChange: {
          outcome: string;
          totalChange: { amountMinor: string };
          requiresReconfirmation: boolean;
        };
      };
    };
    expect(body.quote.priceChange).toEqual({
      previousQuoteReference: id(99),
      outcome: "ReconfirmationRequired",
      totalChange: { amountMinor: "100", currency: "CAD" },
      requiresReconfirmation: true,
      evaluatedAt: at,
    });
  });

  it("never accepts client price, tax, total or open fields", async () => {
    const service = new Port();
    const port = await listen(service);
    for (const body of [
      { cartVersion: 7, total: "0.01" },
      { cartVersion: 7, price: 1 },
      {},
      { cartVersion: 0 },
    ])
      expect((await post(port, body)).status).toBe(400);
    expect(service.calls).toEqual([]);
  });

  it("rejects missing, malformed or repeated security headers", async () => {
    const service = new Port();
    const port = await listen(service);
    const missing = await fetch(`http://127.0.0.1:${port}/api/v1/carts/${id(4)}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"cartVersion":7}',
    });
    const malformed = await post(port, undefined, { "idempotency-key": "raw-secret" });
    const repeated = await post(port, undefined, { "idempotency-key": `${key}, ${id(92)}` });
    expect([missing.status, malformed.status, repeated.status]).toEqual([400, 400, 400]);
    expect(service.calls).toEqual([]);
  });

  it("maps Cart, version, idempotency and configuration failures safely", async () => {
    const service = new Port();
    const port = await listen(service);
    const cases = [
      ["NotFound", 404],
      ["VersionConflict", 409],
      ["IdempotencyConflict", 409],
      ["InvalidConfiguration", 422],
    ] as const;
    for (const [status, expected] of cases) {
      service.result = { status };
      expect((await post(port)).status).toBe(expected);
    }
  });

  it("fails closed on thrown or declared service unavailability", async () => {
    const service = new Port();
    const port = await listen(service);
    service.error = new Error("private database detail");
    const thrown = await post(port);
    expect(thrown.status).toBe(503);
    expect(JSON.stringify(await thrown.json())).not.toContain("private");
    service.error = undefined;
    service.result = { status: "Unavailable" };
    const declared = await post(port);
    expect(declared.status).toBe(503);
    expect(declared.headers.get("retry-after")).toBe("5");
  });

  it("defaults to unavailable when the Pricing service is not wired", async () => {
    expect((await post(await listen())).status).toBe(503);
  });
});
