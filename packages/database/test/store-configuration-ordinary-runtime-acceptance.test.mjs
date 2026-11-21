import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("composes ordinary Store configuration review, independent approval, publication and durable originals with actual Session/IAM and controlled business qualifications", async () => {
  await withIsolatedDatabase({ root, caseId: "store_ordinary_http" }, (context) =>
    exerciseStoreSetupRuntimeHttp({ ...context, ordinaryConfigurationProof: true }),
  );
}, 120000);
