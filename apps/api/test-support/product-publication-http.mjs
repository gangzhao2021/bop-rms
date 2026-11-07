import { Buffer } from "node:buffer";
import express from "express";
import { request as httpRequest } from "node:http";
import { createMerchantBffRouter } from "../src/merchant-bff.ts";

/** Actual BFF/HTTP; caller supplies the isolated encrypted session and real
 * normal command factory. No login, permission, validation or phase is supplied
 * by this transport fixture. Credentials never enter outputs or artifacts. */
export async function withProductPublicationHttp(
  command,
  session,
  scope,
  work,
  signals = {},
  routerFactory = createMerchantBffRouter,
) {
  const app = express();
  app.use(
    "/merchant",
    routerFactory({
      service: {},
      productPublication: command,
      ...signals,
      acceptedHost: "merchant.invalid",
      exactOrigin: "https://merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("isolated listener unavailable");
    const post = (body, overrides = {}, path = "/merchant/catalog/products/publication") =>
      new Promise((resolve, reject) => {
        const serialized = JSON.stringify(body),
          request = httpRequest(
            {
              host: "127.0.0.1",
              port: address.port,
              path,
              method: "POST",
              headers: {
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-merchant=" + session.sessionCookie,
                "x-bop-csrf": session.csrf,
                "x-bop-catalog-scope": Buffer.from(JSON.stringify(scope)).toString("base64url"),
                "content-type": "application/json",
                "content-length": Buffer.byteLength(serialized),
                ...overrides,
              },
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.once("error", reject);
              response.once("end", () => {
                try {
                  resolve({
                    status: response.statusCode,
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                    cacheControl: response.headers["cache-control"],
                    contentType: response.headers["content-type"],
                  });
                } catch {
                  // Never print or fabricate an unexpected native response body.
                  reject(new Error("isolated native HTTP response unavailable"));
                }
              });
            },
          );
        request.once("error", reject);
        request.end(serialized);
      });
    return await work(post);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
