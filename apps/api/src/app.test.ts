import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});
async function request(path: string, init?: RequestInit) {
  const server = createServer(createApp({ now: () => "2026-07-16T00:00:00.000Z" }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe("API skeleton", () => {
  it("reports structured health", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      service: "bop-rms-api",
      status: "healthy",
      checkedAt: "2026-07-16T00:00:00.000Z",
    });
  });
  it("reports database as explicitly unconfigured", async () => {
    const response = await request("/ready");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "not_ready",
      dependencies: { database: { status: "not_configured", required: true } },
    });
  });
  it("uses security headers and a non-reflective 404", async () => {
    const response = await request("/private/secret-value");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(JSON.stringify(await response.json())).not.toContain("secret-value");
  });
  it("rejects oversized JSON", async () => {
    const response = await request("/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(70_000) }),
    });
    expect(response.status).toBe(413);
  });
});
