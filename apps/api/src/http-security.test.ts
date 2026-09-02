import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
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

async function appUrl(environment: "development" | "production") {
  const server = createServer(createApp({ deploymentEnvironment: environment }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

async function rawRequest(root: string, request: string): Promise<string> {
  const { hostname, port } = new URL(root);
  return await new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let response = "";
    socket.setEncoding("latin1");
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

describe("WP-2047 HTTP security baseline", () => {
  it("emits exact same-origin headers with report-only CSP outside production", async () => {
    const response = await fetch(`${await appUrl("development")}/health`);
    expect(response.headers.get("content-security-policy")).toBeNull();
    const csp = response.headers.get("content-security-policy-report-only") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]+=*'/u);
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBeNull();
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), usb=(), bluetooth=(), payment=()",
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("enforces CSP and HSTS only for the production contract", async () => {
    const response = await fetch(`${await appUrl("production")}/health`);
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("denies credentialed cross-origin preflight without CORS reflection", async () => {
    const response = await fetch(`${await appUrl("development")}/bff/customer/cart`, {
      headers: {
        "access-control-request-headers": "authorization,x-csrf-token",
        "access-control-request-method": "POST",
        origin: "https://evil.invalid",
      },
      method: "OPTIONS",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("returns stable 414 and 431 errors without reflecting attacker input", async () => {
    const root = await appUrl("development");
    const longTarget = await fetch(`${root}/${"x".repeat(8_193)}`);
    expect(longTarget.status).toBe(414);
    expect(await longTarget.json()).toEqual({
      error: { code: "request_target_too_long", message: "The request was rejected." },
    });

    const headers = new Headers();
    for (let index = 0; index < 101; index += 1) headers.set(`x-bounded-${index}`, "value");
    const manyHeaders = await fetch(`${root}/health`, { headers });
    expect(manyHeaders.status).toBe(431);
    expect(await manyHeaders.json()).toEqual({
      error: { code: "request_headers_too_large", message: "The request was rejected." },
    });
  });

  it("rejects ambiguous paths and framing before business routing", async () => {
    const root = await appUrl("development");
    const ambiguousPath = await rawRequest(
      root,
      "GET /public/%2fprivate HTTP/1.1\r\nHost: local.invalid\r\nConnection: close\r\n\r\n",
    );
    expect(ambiguousPath).toMatch(/^HTTP\/1\.1 400 /u);
    expect(ambiguousPath).toContain('"code":"ambiguous_request"');

    const conflictingFraming = await rawRequest(
      root,
      "POST /health HTTP/1.1\r\nHost: local.invalid\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
    );
    expect(conflictingFraming).toMatch(/^HTTP\/1\.1 400 /u);
    expect(conflictingFraming).not.toContain("raw-secret");
  });

  it("keeps the precached offline fallback free of executable inline content", async () => {
    const offline = await readFile(
      new URL("../../customer-pwa/public/offline.html", import.meta.url),
      "utf8",
    );
    expect(offline).not.toMatch(/<script\b/iu);
    expect(offline).not.toMatch(/<iframe\b/iu);
    expect(offline).not.toMatch(/\son[a-z]+\s*=/iu);
  });
});
