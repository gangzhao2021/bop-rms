import process from "node:process";
import { Buffer } from "node:buffer";
import { readFile, open, lstat, realpath } from "node:fs/promises";
import {
  randomBytes,
  createHmac,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";
import {
  createGuestSessionCredentialProvider,
  createGuestBindingCredentialProvider,
} from "../../packages/bop/identity/src/index.ts";
import { createPickupCredentialProvider } from "../../packages/rms/fulfillment/src/index.ts";
export function createInternalCredentialLoaders({ file, loadProfile, expectedDatabaseName }) {
  const names = [
    "guestSession",
    "guestBinding",
    "pickupDerivation",
    "pickupSelector",
    "merchantEncryption",
    "merchantSelector",
  ];
  function unavailable() {
    throw new Error("INTERNAL_TEST_CREDENTIALS_UNAVAILABLE");
  }
  async function load() {
    if (!["development", "test"].includes(process.env.NODE_ENV ?? "development"))
      return unavailable();
    const state = await lstat(file);
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      (state.mode & 0o777) !== 0o600 ||
      state.uid !== process.getuid() ||
      (await realpath(file)) !== file
    )
      return unavailable();
    const data = JSON.parse(await readFile(file, "utf8"));
    if (
      data.environment !== "InternalTest" ||
      data.version !== 1 ||
      Object.keys(data).length !== 3 ||
      !data.keys ||
      Object.keys(data.keys).length !== names.length ||
      names.some(
        (name) => typeof data.keys[name] !== "string" || !/^[a-f0-9]{64}$/.test(data.keys[name]),
      ) ||
      new Set(Object.values(data.keys)).size !== names.length
    )
      return unavailable();
    return data;
  }
  async function provisionInternalTestCredentials() {
    if (!["development", "test"].includes(process.env.NODE_ENV ?? "development"))
      return unavailable();
    const profile = await loadProfile();
    if (profile.environment !== "InternalTest" || profile.database !== expectedDatabaseName)
      return unavailable();
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") return unavailable();
      await load();
      return "Retained";
    }
    try {
      const keys = Object.fromEntries(names.map((name) => [name, randomBytes(32).toString("hex")]));
      await handle.writeFile(JSON.stringify({ environment: "InternalTest", version: 1, keys }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await load();
    return "Created";
  }
  /** Runtime only reads; missing or invalid key files never cause implicit replacement. */
  async function createInternalTestCredentials() {
    const saved = await load(),
      keys = Object.fromEntries(names.map((name) => [name, Buffer.from(saved.keys[name], "hex")]));
    try {
      const sessions = createGuestSessionCredentialProvider(keys.guestSession);
      const binding = createGuestBindingCredentialProvider(keys.guestBinding);
      const pickup = createPickupCredentialProvider([
        { version: 1, derivationKey: keys.pickupDerivation, selectorKey: keys.pickupSelector },
      ]);
      return Object.freeze({
        sessions,
        binding,
        pickup,
        reference: () => String(sessions.generateSessionReference()),
      });
    } finally {
      for (const key of Object.values(keys)) key.fill(0);
    }
  }

  /** Purpose-separated stable cursor key; startup never creates or rotates keys. */
  async function createInternalCatalogCursorKey() {
    const saved = await load();
    return Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(saved.keys.merchantEncryption, "hex"),
        Buffer.from(expectedDatabaseName, "utf8"),
        Buffer.from("bop-rms/internal-test/catalog-product-cursor/v1", "utf8"),
        32,
      ),
    );
  }

  /** Stable InternalTest workforce crypto. Never substitutes for external authentication. */
  async function createInternalMerchantCredentials() {
    const saved = await load(),
      key = Buffer.from(saved.keys.merchantEncryption, "hex"),
      pepper = Buffer.from(saved.keys.merchantSelector, "hex");
    const keyReference = "internal-test-merchant-v1";
    return {
      hasher: {
        hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
        equals: (a, b) =>
          typeof a === "string" &&
          typeof b === "string" &&
          /^[a-f0-9]{64}$/.test(a) &&
          /^[a-f0-9]{64}$/.test(b) &&
          timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
      },
      envelopes: {
        async encrypt(plaintext, encryptionContext) {
          const nonce = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", key, nonce);
          cipher.setAAD(Buffer.from(encryptionContext));
          const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          return {
            algorithm: "SYNTHETIC_AES_256_GCM",
            keyReference,
            encryptionContext,
            ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
              "base64url",
            ),
          };
        },
        async decrypt(envelope, expected) {
          if (
            envelope.algorithm !== "SYNTHETIC_AES_256_GCM" ||
            envelope.keyReference !== keyReference ||
            envelope.encryptionContext !== expected
          )
            throw new Error("INTERNAL_SESSION_DENIED");
          const raw = Buffer.from(envelope.ciphertext, "base64url");
          if (raw.length < 29 || raw.length > 32768) throw new Error("INTERNAL_SESSION_DENIED");
          const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
          decipher.setAAD(Buffer.from(expected));
          decipher.setAuthTag(raw.subarray(12, 28));
          return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
            "utf8",
          );
        },
      },
    };
  }
  return {
    provisionInternalTestCredentials,
    createInternalTestCredentials,
    createInternalMerchantCredentials,
    createInternalCatalogCursorKey,
  };
}
