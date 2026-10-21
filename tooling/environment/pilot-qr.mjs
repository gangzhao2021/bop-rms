import process from "node:process";
import { Buffer } from "node:buffer";
import { readFile, open, lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  createQrSignatureVerifier,
  parseQrVerificationKeySetEvidence,
  parseQrSignedPayload,
} from "../../packages/rms/dining/src/index.ts";
import { isPilotRuntime, isPilotStore, matchesPilotEnvironment } from "./pilot-environment.mjs";
import { loadPilotManagedSecrets } from "./pilot-secrets.mjs";
const INTERNAL_KID = "internal-test-v1";
const runtime = { test: true, unset: "development" };
/**
 * Signing keys of the Store's QR codes. InternalTest: the locally generated TEST-ONLY key file
 * (`kid=internal-test-v1`). Pilot (DEC-PILOT-SECRETS): the hosting's managed `qr-signing-key` with
 * its `qr-signing-kid`, plus an optional previous public key that keeps verifying the codes it
 * signed (`Overlap`) until they are reprinted, or stops them at `qr-previous-compromised-at`.
 * Private keys never leave this process and are never logged.
 */
export function createInternalQrLoaders({ file, loadProfile, expectedDatabaseName }) {
  const id = (n) => "0190fa21-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  async function internalPrivateKey() {
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
  async function signingKeys() {
    if (isPilotStore()) return (await loadPilotManagedSecrets(dirname(file))).qr;
    return { kid: INTERNAL_KID, privateKey: await internalPrivateKey(), previous: null };
  }
  /** Allowed only when the process and the Store profile are the same pilot environment. */
  function admitted(profile) {
    if (!isPilotRuntime(runtime) || !matchesPilotEnvironment(profile.environment, runtime))
      throw new Error("INTERNAL_QR_UNAVAILABLE");
  }
  /** The verification key set: Current, plus the previous key as Overlap (sorted by kid). */
  function keySet(keys, { reference, registryValidUntil, validFrom, validUntil }) {
    const entries = [
      {
        kid: keys.kid,
        state: "Current",
        publicKeyReference: reference(3),
        compromisedAt: null,
        publicKey: createPublicKey(keys.privateKey),
      },
      ...(keys.previous === null
        ? []
        : [
            {
              kid: keys.previous.kid,
              state: "Overlap",
              publicKeyReference: reference(5),
              compromisedAt: keys.previous.compromisedAt,
              publicKey: keys.previous.publicKey,
            },
          ]),
    ].sort((a, b) => (a.kid < b.kid ? -1 : 1));
    const evidence = () =>
      parseQrVerificationKeySetEvidence({
        registryVersion: 1,
        registryEvidenceReference: reference(2),
        validUntil: registryValidUntil(),
        keys: entries.map(({ kid, state, publicKeyReference, compromisedAt }) => ({
          kid,
          algorithm: "ES256",
          state,
          publicKeyReference,
          validFrom,
          validUntil,
          compromisedAt,
        })),
      });
    return {
      evidence,
      verifier: createQrSignatureVerifier(
        async (ref) =>
          entries.find((entry) => entry.publicKeyReference === String(ref))?.publicKey ?? null,
      ),
    };
  }
  const compact = (keys, payload) => {
    const input = [{ alg: "ES256", kid: keys.kid, typ: "BOP-QR" }, payload]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return (
      input +
      "." +
      sign("sha256", Buffer.from(input), {
        key: keys.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url")
    );
  };
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
      await internalPrivateKey();
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
    admitted(profile);
    const keys = await signingKeys();
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
    const set = keySet(keys, {
      reference: id,
      registryValidUntil: () => profile.binding.validUntil,
      validFrom: profile.createdAt,
      validUntil: profile.binding.validUntil,
    });
    const evidence = set.evidence();
    return Object.freeze({
      registration: {
        payload,
        state: "Enabled",
        contextEvidenceReference: id(4),
        validFrom: profile.createdAt,
        validUntil: profile.binding.validUntil,
      },
      keys: { load: async () => evidence },
      verifier: set.verifier,
      telemetry: { record: () => undefined },
      token: () => compact(keys, payload),
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
    const keys = await signingKeys();
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
    const set = keySet(keys, {
      reference: id,
      registryValidUntil: () => profile.binding.validUntil,
      validFrom: profile.createdAt,
      validUntil: profile.binding.validUntil,
    });
    const evidence = set.evidence();
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
      verifier: set.verifier,
      telemetry: { record: () => undefined },
      token: () => compact(keys, payload),
    });
  }
  /**
   * WP-2423 Q11 (DEC-TABLE-QR-ISSUANCE): signing and verification for the table codes staff issue
   * from DIN-TABLE-LIST. A key change keeps stored codes' format: the new kid signs as Current, the
   * previous one verifies as Overlap until its codes are reprinted (or is stopped as compromised).
   */
  async function loadIssuedTableQrKeys(profile) {
    admitted(profile);
    const keys = await signingKeys();
    const validFrom = profile.createdAt;
    const validUntil = new Date(
      Date.parse(validFrom) + 2 * 366 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const set = keySet(keys, {
      reference: id,
      registryValidUntil: () => new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      validFrom,
      validUntil,
    });
    return Object.freeze({
      keys: { load: async () => set.evidence() },
      verifier: set.verifier,
      telemetry: { record: () => undefined },
      signer: {
        async sign(payload) {
          return { keyId: keys.kid, token: compact(keys, payload) };
        },
      },
    });
  }
  return { provisionInternalQr, loadInternalPickupQr, loadInternalDiningQr, loadIssuedTableQrKeys };
}

function unavailable() {
  throw new Error("INTERNAL_QR_UNAVAILABLE");
}
