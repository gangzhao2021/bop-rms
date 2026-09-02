import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { URL } from "node:url";
import { stdout } from "node:process";

const distDirectory = new URL("../dist/", import.meta.url);
const worker = await readFile(new URL("service-worker.js", distDirectory), "utf8");
const offline = await readFile(new URL("offline.html", distDirectory), "utf8");

for (const token of [
  "bop-customer-shell-",
  "bop-customer-public-menu-",
  "X-BOP-Cache-Class",
  "offline.html",
  "SKIP_WAITING",
  "skipWaiting",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]) {
  if (!worker.includes(token)) throw new Error(`Generated Service Worker is missing ${token}`);
}

for (const forbidden of [
  "BackgroundSyncPlugin",
  "workbox-background-sync",
  "queueName",
  "requestsWillReplay",
]) {
  if (worker.includes(forbidden))
    throw new Error(`Generated Service Worker unexpectedly contains ${forbidden}`);
}

for (const forbidden of ["orderReference", "pickupCode", "paymentIntent", "accessToken"]) {
  if (offline.includes(forbidden)) throw new Error(`Offline fallback contains ${forbidden}`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(relative(new URL("..", distDirectory).pathname, path));
  }
  return files;
}

const generatedFiles = await listFiles(distDirectory.pathname);
for (const forbiddenPath of ["/orders/", "/cart/", "/checkout/", "/payment/"]) {
  if (generatedFiles.some((file) => file.includes(forbiddenPath)))
    throw new Error(`Generated output unexpectedly contains a private route: ${forbiddenPath}`);
}

stdout.write("Generated Service Worker policy verified.\n");
