import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CustomerMenuQueryInput, CustomerMenuQueryResult } from "@rms/catalog";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { CustomerMenuHandler, type CustomerMenuPort } from "./customer-menu.js";

const STORE_REFERENCE = "018f7500-0000-7000-8000-000000000001";
const MENU_REFERENCE = "018f7500-0000-7000-8000-000000000002";
const VERSION_REFERENCE = "018f7500-0000-7000-8000-000000000003";
const RELEASE_REFERENCE = "018f7500-0000-7000-8000-000000000004";
const CHECKPOINT_REFERENCE = "018f7500-0000-7000-8000-000000000005";
const AT = "2026-08-02T16:00:00.000Z";
const servers: Server[] = [];

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

function found(): CustomerMenuQueryResult {
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: AT as never,
      sourceCheckpoint: CHECKPOINT_REFERENCE as never,
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5_000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: STORE_REFERENCE as never,
      channelCode: "DINE_IN" as never,
      orderTypeCode: "TABLE_SERVICE" as never,
      effectiveAt: AT as never,
    },
    menu: {
      menuReference: MENU_REFERENCE as never,
      menuVersionReference: VERSION_REFERENCE as never,
      releaseReference: RELEASE_REFERENCE as never,
      locale: "en-CA",
      name: "All Day",
      effectiveFrom: AT as never,
      effectiveUntil: null,
      sections: [],
    },
  };
}

class MutablePort implements CustomerMenuPort {
  readonly calls: CustomerMenuQueryInput[] = [];
  result: unknown = found();
  error: unknown;

  async getPublishedMenu(
    input: Readonly<CustomerMenuQueryInput>,
  ): Promise<CustomerMenuQueryResult> {
    this.calls.push(input);
    if (this.error !== undefined) throw this.error;
    return this.result as CustomerMenuQueryResult;
  }
}

async function listen(port?: MutablePort): Promise<number> {
  const customerMenu =
    port === undefined ? undefined : new CustomerMenuHandler({ now: () => AT, port });
  const server = createServer(createApp(customerMenu === undefined ? {} : { customerMenu }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function url(port: number, query = "channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA") {
  return `http://127.0.0.1:${port}/api/v1/public/stores/${STORE_REFERENCE}/menu?${query}`;
}

describe("WP-1026 Customer Menu REST API", () => {
  it("maps the canonical public route to the exact side-effect-free Catalog query", async () => {
    const catalog = new MutablePort();
    const port = await listen(catalog);
    const response = await fetch(
      url(port, "channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA&q=latte"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(found());
    expect(catalog.calls).toEqual([
      {
        publicStoreReference: STORE_REFERENCE,
        channelCode: "DINE_IN",
        orderTypeCode: "TABLE_SERVICE",
        locale: "en-CA",
        requestedAt: AT,
        searchTerm: "latte",
        sectionReference: null,
      },
    ]);
  });

  it("rejects malformed, missing, repeated or open query input without calling Catalog", async () => {
    const catalog = new MutablePort();
    const port = await listen(catalog);
    const responses = await Promise.all([
      fetch(url(port, "orderType=TABLE_SERVICE&locale=en-CA")),
      fetch(url(port, "channel=DINE_IN&orderType=TABLE_SERVICE&locale=bad/locale")),
      fetch(url(port, "channel=DINE_IN&channel=PICKUP&orderType=TABLE_SERVICE&locale=en-CA")),
      fetch(url(port, "channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA&token=raw-secret")),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(catalog.calls).toEqual([]);
    for (const response of responses) {
      expect(JSON.stringify(await response.json())).not.toContain("raw-secret");
    }
  });

  it("maps not-found and stale projection states without leaking internal facts", async () => {
    const catalog = new MutablePort();
    const port = await listen(catalog);
    catalog.result = { status: "NotFound" };
    const missing = await fetch(url(port));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      schemaVersion: 1,
      error: { code: "menu_not_found", messageKey: "customer.menu.not_found" },
    });
    catalog.result = { status: "ProjectionStale" };
    const stale = await fetch(url(port));
    expect(stale.status).toBe(503);
    expect(stale.headers.get("retry-after")).toBe("5");
  });

  it("fails closed for unconfigured, throwing or malformed Catalog adapters", async () => {
    const unconfigured = await fetch(url(await listen()));
    expect(unconfigured.status).toBe(503);

    const catalog = new MutablePort();
    const port = await listen(catalog);
    catalog.error = new Error("private database details");
    const failed = await fetch(url(port));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("private database details");
    catalog.error = undefined;
    catalog.result = { status: "invented", secret: "raw-secret" };
    const malformed = await fetch(url(port));
    expect(malformed.status).toBe(503);
    expect(JSON.stringify(await malformed.json())).not.toContain("raw-secret");
  });

  it("serializes an allowlisted DTO and drops unexpected internal adapter fields", async () => {
    const catalog = new MutablePort();
    catalog.result = { ...found(), internalDatabaseFact: "raw-secret" };
    const response = await fetch(url(await listen(catalog)));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("raw-secret");
  });
});
