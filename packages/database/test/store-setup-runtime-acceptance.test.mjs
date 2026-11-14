import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("composes ordinary Store Setup partial drafts, Address/Contact sources and durable originals with encrypted Session and current IAM", async () => {
  await withIsolatedDatabase({ root, caseId: "store_setup_http" }, exerciseStoreSetupRuntimeHttp);
}, 120000);
