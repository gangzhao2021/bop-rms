/// <reference lib="webworker" />

import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { setCacheNameDetails, type WorkboxPlugin } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { registerRoute, setCatchHandler, setDefaultHandler } from "workbox-routing";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";
import {
  isPrivatePath,
  isPublicMenuCacheCandidate,
  isPublicShellNavigation,
  isSafeUpdatePath,
} from "./pwa/service-worker-policy.js";

declare const __BOP_DEPLOYMENT_ID__: string;
declare const self: ServiceWorkerGlobalScope & { readonly __WB_MANIFEST: readonly unknown[] };

const cacheSchema = "v1";
const cacheScope = `${__BOP_DEPLOYMENT_ID__}-${cacheSchema}`;
setCacheNameDetails({ prefix: "bop-customer", suffix: cacheScope });
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const safeDocumentPlugin: WorkboxPlugin = {
  cacheWillUpdate: async ({ response }) =>
    response.status === 200 && response.type === "basic" && !response.redirected ? response : null,
};

const publicResponsePlugin: WorkboxPlugin = {
  cacheWillUpdate: async ({ response }) =>
    response.status === 200 &&
    response.type === "basic" &&
    !response.redirected &&
    response.headers.get("X-BOP-Cache-Class") === "public"
      ? response
      : null,
};

const networkOnly = new NetworkOnly();

registerRoute(
  ({ request, url }) => request.mode === "navigate" && isPrivatePath(url.pathname),
  networkOnly,
);

registerRoute(
  ({ request, url }) =>
    request.mode === "navigate" && isPublicShellNavigation(url.href, self.location.origin),
  new NetworkFirst({
    cacheName: `bop-customer-shell-${cacheScope}`,
    networkTimeoutSeconds: 3,
    plugins: [safeDocumentPlugin, new ExpirationPlugin({ maxEntries: 12, maxAgeSeconds: 300 })],
  }),
);

registerRoute(
  ({ request, url }) =>
    isPublicMenuCacheCandidate({
      url: url.href,
      origin: self.location.origin,
      method: request.method,
      credentials: request.credentials,
    }),
  new NetworkFirst({
    cacheName: `bop-customer-public-menu-${cacheScope}`,
    networkTimeoutSeconds: 3,
    plugins: [
      publicResponsePlugin,
      new CacheableResponsePlugin({ statuses: [200], headers: { "X-BOP-Cache-Class": "public" } }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 300, purgeOnQuotaError: false }),
    ],
  }),
);

setDefaultHandler(networkOnly);
registerRoute(({ request }) => request.method === "POST", networkOnly, "POST");
registerRoute(({ request }) => request.method === "PUT", networkOnly, "PUT");
registerRoute(({ request }) => request.method === "PATCH", networkOnly, "PATCH");
registerRoute(({ request }) => request.method === "DELETE", networkOnly, "DELETE");

setCatchHandler(async ({ request }) => {
  if (request.mode === "navigate") {
    const fallback = await matchPrecache("/offline.html");
    if (fallback) return fallback;
  }
  return Response.error();
});

self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Reflect.ownKeys(data).length !== 1 ||
    Object.getOwnPropertyDescriptor(data, "type")?.value !== "SKIP_WAITING"
  )
    return;
  event.waitUntil(
    (async () => {
      const source = event.source;
      if (!source || !("url" in source)) return;
      try {
        const url = new URL(source.url);
        if (url.origin === self.location.origin && isSafeUpdatePath(url.pathname))
          await self.skipWaiting();
      } catch {
        return;
      }
    })(),
  );
});
