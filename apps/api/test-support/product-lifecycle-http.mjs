import express from "express";
import { request as httpRequest } from "node:http";
import { createMerchantBffRouter } from "../src/merchant-bff.ts";

// Real HTTP/BFF/controller; authentication authority remains the caller's test adapter.
export async function withProductLifecycleHttp(command, work) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: {},
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      productLifecycle: command,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("synthetic HTTP startup");
    const post = (body) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/merchant/catalog/products/lifecycle",
            method: "POST",
            headers: {
              Host: "merchant.invalid",
              Origin: "https://merchant.invalid",
              "Sec-Fetch-Site": "same-origin",
              "Content-Type": "application/json",
              Cookie: "__Host-bop-merchant=synthetic-cookie",
              "X-BOP-CSRF": "synthetic-csrf",
            },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (text += chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode, body: JSON.parse(text) }),
            );
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      });
    await work(post);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
