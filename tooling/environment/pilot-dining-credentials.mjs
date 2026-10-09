import process from "node:process";
import { Buffer } from "node:buffer";
import { createGuestDiningBindingCredentialProvider } from "../../packages/bop/identity/src/index.ts";
import { readFile, open, lstat, realpath } from "node:fs/promises";
import { randomBytes, randomInt, createHmac, timingSafeEqual, createHash } from "node:crypto";
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalDiningCredentialLoaders({ path }) {
  async function load() {
    const stat = await lstat(path);
    if (
      !isPilotRuntime() ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid() ||
      (await realpath(path)) !== path
    )
      throw new Error("INTERNAL_DINING_KEY_UNAVAILABLE");
    const raw = await readFile(path, "utf8");
    if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error("INTERNAL_DINING_KEY_UNAVAILABLE");
    return Buffer.from(raw, "hex");
  }
  async function provisionInternalDiningCredentials() {
    if (!isPilotRuntime()) throw new Error("INTERNAL_DINING_ONLY");
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const key = await load();
      key.fill(0);
      return;
    }
    try {
      await file.writeFile(randomBytes(32).toString("hex"));
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async function createInternalDiningCredentials(resources) {
    const key = await load();
    return Object.freeze({
      bindingRecovery: createGuestDiningBindingCredentialProvider(
        createHmac("sha256", key).update("bop-rms:internal-dining-binding-key:v1").digest(),
      ),
      generateReference: () => resources.credentials.reference(),
      generateJoinCredential: (kind) => {
        if (kind === "Invitation") return randomBytes(16).toString("base64url");
        if (kind === "HumanCode") return String(randomInt(0, 1000000)).padStart(6, "0");
        throw new Error("INTERNAL_DINING_KIND_INVALID");
      },
      hashJoinCredential: (kind, value) => {
        if (
          !["Invitation", "HumanCode"].includes(kind) ||
          typeof value !== "string" ||
          value.length > 22
        )
          throw new Error("INTERNAL_DINING_KIND_INVALID");
        return createHmac("sha256", key)
          .update("bop-rms:internal-dining-join:v1:" + kind + ":" + value)
          .digest("hex");
      },
      hashJoinBudget: (value) =>
        createHmac("sha256", key)
          .update("bop-rms:internal-dining-budget:v1:" + value)
          .digest(),
      hashOperationIntent: (value) => createHash("sha256").update(value).digest("hex"),
      equals: (a, b) =>
        typeof a === "string" &&
        typeof b === "string" &&
        /^[a-f0-9]{64}$/.test(a) &&
        /^[a-f0-9]{64}$/.test(b) &&
        timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
    });
  }
  return { provisionInternalDiningCredentials, createInternalDiningCredentials };
}
