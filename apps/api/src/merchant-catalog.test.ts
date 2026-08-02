import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MenuPublicationRecord } from "@rms/catalog";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type {
  MerchantCatalogPort,
  MerchantMenuCommandResult,
  MerchantMenuListResult,
} from "./merchant-catalog.js";

const id = (n: number) => `018f7600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const BRAND = id(1);
const MENU = id(2);
const VERSION = id(3);
const OPERATION = id(4);
const LIFECYCLE = id(5);
const RELEASE = id(6);
const AT = "2026-08-02T17:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
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

function publication(): MenuPublicationRecord {
  return {
    lifecycle: {
      lifecycleId: LIFECYCLE,
      familyReference: MENU,
      configurationType: "MENU",
      purposeCode: "CUSTOMER_ORDERING",
      snapshotReference: VERSION,
      snapshotDigest: DIGEST,
      scope: { kind: "Brand", brandReference: BRAND, storeReference: null },
      version: 4,
      state: "Published",
      validationEvidenceReference: id(7),
      approvalEvidenceReference: id(8),
      createdAt: AT,
      changedAt: AT,
    },
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: AT, localDateTime: "2026-08-02T17:00:00.000", utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    release: {
      releaseId: RELEASE,
      familyReference: MENU,
      configurationType: "MENU",
      purposeCode: "CUSTOMER_ORDERING",
      snapshotReference: VERSION,
      snapshotDigest: DIGEST,
      scope: { kind: "Brand", brandReference: BRAND, storeReference: null },
      sequence: 1,
      sourceLifecycleId: LIFECYCLE,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: AT,
    },
  } as never;
}

class MutablePort implements MerchantCatalogPort {
  listCalls: unknown[] = [];
  commandCalls: unknown[] = [];
  listResult: unknown = {
    status: "Found",
    projection: {
      name: "catalog_menu_management_v1",
      version: 1,
      asOfUtc: AT,
      stale: false,
      partial: false,
      internal: "raw-secret",
    },
    items: [
      {
        menuReference: MENU,
        menuVersionReference: VERSION,
        internalCode: "ALL_DAY",
        name: "All Day",
        lifecycle: "Published",
        version: 4,
        updatedAt: AT,
        internal: "raw-secret",
      },
    ],
    nextCursor: null,
    internal: "raw-secret",
  };
  commandResult: unknown = { status: "Applied", record: publication(), internal: "raw-secret" };

  async listMenus(input: unknown): Promise<MerchantMenuListResult> {
    this.listCalls.push(input);
    return this.listResult as MerchantMenuListResult;
  }
  async executeMenuPublication(input: unknown): Promise<MerchantMenuCommandResult> {
    this.commandCalls.push(input);
    return this.commandResult as MerchantMenuCommandResult;
  }
}

async function listen(
  port?: MutablePort,
  authorize: RequestHandler = (_request, _response, next) => next(),
): Promise<number> {
  const server = createServer(
    createApp({
      ...(port === undefined ? {} : { merchantCatalog: { authorize, now: () => AT, port } }),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function base(port: number) {
  return `http://127.0.0.1:${port}/api/v1/merchant/brands/${BRAND}/catalog/menus`;
}

describe("WP-1027 Merchant Catalog Management API", () => {
  it("lists bounded menu summaries through the required authorization chain", async () => {
    const catalog = new MutablePort();
    const response = await fetch(`${base(await listen(catalog))}?limit=25&status=Published`);
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("catalog_menu_management_v1");
    expect(body).not.toContain("raw-secret");
    expect(catalog.listCalls).toEqual([
      { brandReference: BRAND, cursor: null, limit: 25, status: "Published" },
    ]);
  });

  it("derives Publish from the route and binds idempotency, expected version and server time", async () => {
    const catalog = new MutablePort();
    const port = await listen(catalog);
    const response = await fetch(`${base(port)}/${MENU}/versions/${VERSION}/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": OPERATION,
        "if-match": '"3"',
      },
      body: JSON.stringify({
        snapshotDigest: DIGEST,
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: {
            instant: AT,
            localDateTime: "2026-08-02T17:00:00.000",
            utcOffsetMinutes: 0,
          },
          effectiveUntil: null,
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      status: "Applied",
      publication: { lifecycle: "Published", releaseReference: RELEASE },
    });
    expect(catalog.commandCalls).toEqual([
      {
        brandReference: BRAND,
        command: expect.objectContaining({
          action: "Publish",
          operationReference: OPERATION,
          expectedVersion: 3,
          menuReference: MENU,
          menuVersionReference: VERSION,
          requestedAt: AT,
        }),
      },
    ]);
  });

  it("rejects target-state, open query and malformed command input before Catalog", async () => {
    const catalog = new MutablePort();
    const port = await listen(catalog);
    const list = await fetch(`${base(port)}?sql=select`);
    const command = await fetch(`${base(port)}/${MENU}/versions/${VERSION}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": OPERATION,
        "if-match": '"2"',
      },
      body: JSON.stringify({ snapshotDigest: DIGEST, targetState: "Published" }),
    });
    expect([list.status, command.status]).toEqual([400, 400]);
    expect(catalog.listCalls).toEqual([]);
    expect(catalog.commandCalls).toEqual([]);
  });

  it("does not call Catalog when the injected Merchant authorization chain denies", async () => {
    const catalog = new MutablePort();
    const port = await listen(catalog, (_request, response) => {
      response.status(403).json({ error: "permission_denied" });
    });
    expect((await fetch(base(port))).status).toBe(403);
    expect(catalog.listCalls).toEqual([]);
  });

  it("maps Catalog conflict, denial and stale states without leaking errors", async () => {
    const catalog = new MutablePort();
    const port = await listen(catalog);
    catalog.listResult = { status: "ProjectionStale", secret: "raw-secret" };
    const stale = await fetch(base(port));
    expect(stale.status).toBe(503);
    expect(stale.headers.get("retry-after")).toBe("5");
    catalog.commandResult = { status: "Conflict", secret: "raw-secret" };
    const conflict = await fetch(`${base(port)}/${MENU}/versions/${VERSION}/archive`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": OPERATION,
        "if-match": '"4"',
      },
      body: JSON.stringify({ snapshotDigest: DIGEST }),
    });
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(await conflict.json())).not.toContain("raw-secret");
  });

  it("fails closed when the Merchant Catalog composition is unavailable", async () => {
    expect((await fetch(base(await listen()))).status).toBe(503);
  });
});
