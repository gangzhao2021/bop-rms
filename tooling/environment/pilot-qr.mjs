import process from "node:process";
import { Buffer } from "node:buffer";
import { readFile, open, lstat, realpath } from "node:fs/promises";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  createQrSignatureVerifier,
  parseQrVerificationKeySetEvidence,
  parseQrSignedPayload,
} from "../../packages/rms/dining/src/index.ts";
export function createInternalQrLoaders({ file, loadProfile, expectedDatabaseName }) {
  const id = (n) => "0190fa21-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  async function privateKey() {
    const s = await lstat(file);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      (s.mode & 0o777) !== 0o600 ||
      s.uid !== process.getuid() ||
      (await realpath(file)) !== file
    )
      throw new Error("INTERNAL_QR_KEY_UNAVAILABLE");
    return createPrivateKey(await readFile(file));
  }
  async function provisionInternalQr() {
    if (!["development", "test"].includes(process.env.NODE_ENV ?? "development"))
      throw new Error("INTERNAL_QR_UNAVAILABLE");
    const profile = await loadProfile();
    if (profile.environment !== "InternalTest") throw new Error("INTERNAL_QR_UNAVAILABLE");
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (error) {
      // Keep filesystem details outside the public error boundary.
      if (error.code !== "EEXIST") return unavailable();
      await privateKey();
      return;
    }
    try {
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      await handle.writeFile(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async function loadInternalPickupQr(profile) {
    if (
      !["development", "test"].includes(process.env.NODE_ENV ?? "development") ||
      profile.environment !== "InternalTest"
    )
      throw new Error("INTERNAL_QR_UNAVAILABLE");
    const key = await privateKey(),
      publicKey = createPublicKey(key),
      kid = "internal-test-v1";
    const payload = parseQrSignedPayload(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          qrReference: id(1),
          publicStoreReference: profile.binding.publicStoreReference,
          publicTableReference: null,
          channel: "Pickup",
          locale: "en-CA",
          issuedAt: profile.createdAt,
          expiresAt: profile.binding.validUntil,
          revocationVersion: 1,
        }),
      ).toString("base64url"),
    );
    const evidence = parseQrVerificationKeySetEvidence({
      registryVersion: 1,
      registryEvidenceReference: id(2),
      validUntil: profile.binding.validUntil,
      keys: [
        {
          kid,
          algorithm: "ES256",
          state: "Current",
          publicKeyReference: id(3),
          validFrom: profile.createdAt,
          validUntil: profile.binding.validUntil,
          compromisedAt: null,
        },
      ],
    });
    return Object.freeze({
      registration: {
        payload,
        state: "Enabled",
        contextEvidenceReference: id(4),
        validFrom: profile.createdAt,
        validUntil: profile.binding.validUntil,
      },
      keys: { load: async () => evidence },
      verifier: createQrSignatureVerifier(async (reference) =>
        String(reference) === id(3) ? publicKey : null,
      ),
      telemetry: { record: () => undefined },
      token() {
        const input = [{ alg: "ES256", kid, typ: "BOP-QR" }, payload]
          .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
          .join(".");
        return (
          input +
          "." +
          sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString(
            "base64url",
          )
        );
      },
    });
  }

  async function loadInternalDiningQr(profile, table) {
    if (
      !["development", "test"].includes(process.env.NODE_ENV ?? "development") ||
      profile.environment !== "InternalTest"
    )
      throw new Error("INTERNAL_QR_UNAVAILABLE");
    if (
      table.environment !== "InternalTest" ||
      table.database !== expectedDatabaseName ||
      table.scope.storeReference !== profile.binding.storeReference ||
      table.qrVersion !== 1
    )
      throw new Error("INTERNAL_DINING_QR_UNAVAILABLE");
    const id = (n) =>
      (table.qrNamespace ?? "0190fa50") + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
    const key = await privateKey(),
      publicKey = createPublicKey(key),
      kid = "internal-test-v1";
    const payload = parseQrSignedPayload(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          qrReference: id(1),
          publicStoreReference: profile.binding.publicStoreReference,
          publicTableReference: table.publicTableReference,
          channel: "DineIn",
          locale: "en-CA",
          issuedAt: profile.createdAt,
          expiresAt: profile.binding.validUntil,
          revocationVersion: 1,
        }),
      ).toString("base64url"),
    );
    const evidence = parseQrVerificationKeySetEvidence({
      registryVersion: 1,
      registryEvidenceReference: id(2),
      validUntil: profile.binding.validUntil,
      keys: [
        {
          kid,
          algorithm: "ES256",
          state: "Current",
          publicKeyReference: id(3),
          validFrom: profile.createdAt,
          validUntil: profile.binding.validUntil,
          compromisedAt: null,
        },
      ],
    });
    return Object.freeze({
      registration: {
        payload,
        tableReference: table.tableReference,
        state: "Enabled",
        contextEvidenceReference: id(4),
        validFrom: profile.createdAt,
        validUntil: profile.binding.validUntil,
      },
      keys: { load: async () => evidence },
      verifier: createQrSignatureVerifier(async (reference) =>
        String(reference) === id(3) ? publicKey : null,
      ),
      telemetry: { record: () => undefined },
      token() {
        const input = [{ alg: "ES256", kid, typ: "BOP-QR" }, payload]
          .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
          .join(".");
        return (
          input +
          "." +
          sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString(
            "base64url",
          )
        );
      },
    });
  }
  return { provisionInternalQr, loadInternalPickupQr, loadInternalDiningQr };
}

function unavailable() {
  throw new Error("INTERNAL_QR_UNAVAILABLE");
}
