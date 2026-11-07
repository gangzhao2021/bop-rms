import { Buffer } from "node:buffer";
import express from "express";
import { request as httpRequest } from "node:http";
import { createMerchantBffRouter } from "../src/merchant-bff.ts";

export const productCreationFixtureCsrf = Buffer.alloc(32, 37).toString("base64url");

// Real HTTP/BFF/controller; authentication authority remains the caller's test adapter.
export async function withProductCreationHttp(command, work, draftCommand, expectedScope) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: {},
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      productCreation: command,
      ...(draftCommand ? { productDraft: draftCommand } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("synthetic HTTP startup");
    const fetcher = (path, options) => {
      if (
        !["/merchant/catalog/products", "/merchant/catalog/products/draft"].includes(path) ||
        options.method !== "POST" ||
        typeof options.body !== "string"
      )
        throw new Error("synthetic invalid HTTP adapter request");
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path,
            method: options.method,
            signal: options.signal,
            headers: {
              Host: "merchant.invalid",
              Origin: "https://merchant.invalid",
              "Sec-Fetch-Site": "same-origin",
              Cookie: "__Host-bop-merchant=synthetic-cookie",
              ...Object.fromEntries(new globalThis.Headers(options.headers)),
              "Content-Length": Buffer.byteLength(options.body),
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve(
                new globalThis.Response(Buffer.concat(chunks), {
                  status: response.statusCode,
                  headers: response.headers,
                }),
              ),
            );
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end(options.body);
      });
    };
    const post = async (body, path = "/merchant/catalog/products") => {
      const response = await fetcher(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          "X-BOP-CSRF": productCreationFixtureCsrf,
          "X-BOP-Catalog-Scope": Buffer.from(JSON.stringify(expectedScope)).toString("base64url"),
        },
      });
      return { status: response.status, body: await response.json() };
    };
    await work(post, fetcher, productCreationFixtureCsrf);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
