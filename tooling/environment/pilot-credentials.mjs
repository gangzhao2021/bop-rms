import process from "node:process";
import { Buffer } from "node:buffer";
import { readFile, open, lstat, realpath } from "node:fs/promises";
import { randomBytes, hkdfSync } from "node:crypto";
import { dirname } from "node:path";
import {
  createArgon2idStaffPinKdf,
  createGuestSessionCredentialProvider,
  createGuestBindingCredentialProvider,
  createStoreDeviceSecretHasher,
  createStaffPinChoiceTokens,
} from "../../packages/bop/identity/src/index.ts";
import { createPickupCredentialProvider } from "../../packages/rms/fulfillment/src/index.ts";
import { isPilotStore } from "./pilot-environment.mjs";
import {
  createMerchantEnvelopeCrypto,
  createSelectorHasher,
  loadPilotManagedSecrets,
} from "./pilot-secrets.mjs";
const highest = (versions) => Math.max(...versions.keys());
const wipe = (...items) => {
  for (const item of items)
    if (item instanceof Map) for (const key of item.values()) key.fill(0);
    else item.fill(0);
};
/**
 * InternalTest: the generated local key file `internal-test-keys.json`. Pilot (DEC-PILOT-SECRETS):
 * the hosting's managed secret files named by `<runtime>/hosting.json`, read through the same
 * functions, so every consumer is unchanged. The runtime directory is the key file's directory.
 */
export function createInternalCredentialLoaders({ file, loadProfile, expectedDatabaseName }) {
  const managed = () => loadPilotManagedSecrets(dirname(file));
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
    if (isPilotStore()) {
      const secrets = await managed(),
        session = secrets.key("guest-session-key"),
        binding = secrets.key("guest-binding-key"),
        derivation = secrets.versions("pickup-derivation-key"),
        selector = secrets.versions("pickup-selector-key");
      try {
        const sessions = createGuestSessionCredentialProvider(session);
        return Object.freeze({
          sessions,
          binding: createGuestBindingCredentialProvider(binding),
          // Every version verifies codes already handed out; the newest issues new ones.
          pickup: createPickupCredentialProvider(
            [...derivation.keys()].map((version) => ({
              version,
              derivationKey: derivation.get(version),
              selectorKey: selector.get(version),
            })),
          ),
          reference: () => String(sessions.generateSessionReference()),
        });
      } finally {
        wipe(session, binding, derivation, selector);
      }
    }
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
    if (isPilotStore()) return (await managed()).key("catalog-cursor-key");
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
    if (isPilotStore()) {
      const secrets = await managed(),
        keys = secrets.versions("merchant-encryption-key");
      // The schema's envelope labels are SYNTHETIC_AES_256_GCM and KMS_AES_256_GCM; a locally held
      // managed AES key keeps the first label with a Pilot key reference (DEC-PILOT-SECRETS 3).
      return {
        hasher: createSelectorHasher(secrets.key("merchant-selector-key")),
        envelopes: createMerchantEnvelopeCrypto({
          keys,
          current: { version: highest(keys), prefix: "pilot-merchant-v" },
          algorithm: "SYNTHETIC_AES_256_GCM",
        }),
      };
    }
    const saved = await load();
    return {
      hasher: createSelectorHasher(Buffer.from(saved.keys.merchantSelector, "hex")),
      envelopes: createMerchantEnvelopeCrypto({
        keys: new Map([[1, Buffer.from(saved.keys.merchantEncryption, "hex")]]),
        current: { version: 1, prefix: "internal-test-merchant-v" },
        algorithm: "SYNTHETIC_AES_256_GCM",
      }),
    };
  }
  /**
   * WP-2423 Q18 option A: the staff PIN pepper, the shared-tablet secret key and the lock-screen
   * choice key, each derived for
   * its own purpose from the existing workforce selector key (no new key file entry). TEST-ONLY:
   * a live store keeps both in the managed secret store (capability gap "Secrets").
   */
  async function createInternalStaffPinCredentials() {
    if (isPilotStore()) {
      const secrets = await managed(),
        peppers = secrets.versions("staff-pin-pepper"),
        device = secrets.key("store-device-key"),
        choice = secrets.key("staff-pin-choice-key");
      try {
        return Object.freeze({
          kdf: createArgon2idStaffPinKdf({ peppers, currentPepperVersion: highest(peppers) }),
          deviceHasher: createStoreDeviceSecretHasher(device),
          choiceTokens: createStaffPinChoiceTokens(choice),
        });
      } finally {
        wipe(peppers, device, choice);
      }
    }
    const saved = await load(),
      root = Buffer.from(saved.keys.merchantSelector, "hex");
    const derive = (purpose) =>
      Buffer.from(
        hkdfSync(
          "sha256",
          root,
          Buffer.from(expectedDatabaseName, "utf8"),
          Buffer.from(purpose, "utf8"),
          32,
        ),
      );
    try {
      const pepper = derive("bop-rms/internal-test/staff-pin-pepper/v1"),
        device = derive("bop-rms/internal-test/store-device-selector/v1"),
        choice = derive("bop-rms/internal-test/staff-pin-choice/v1");
      try {
        return Object.freeze({
          kdf: createArgon2idStaffPinKdf({
            peppers: new Map([[1, pepper]]),
            currentPepperVersion: 1,
          }),
          deviceHasher: createStoreDeviceSecretHasher(device),
          choiceTokens: createStaffPinChoiceTokens(choice),
        });
      } finally {
        pepper.fill(0);
        device.fill(0);
        choice.fill(0);
      }
    } finally {
      root.fill(0);
    }
  }
  /**
   * DEC-PILOT-NOTIFICATIONS R1: the order recovery token pepper (version 1) and the recovery abuse
   * key, each derived for its own purpose from the Guest Session key (no new key file entry).
   * TEST-ONLY: a live store keeps them in the managed secret store (capability gap "Secrets").
   */
  async function createInternalOrderRecoveryKeys() {
    const saved = await load(),
      root = Buffer.from(saved.keys.guestSession, "hex");
    const derive = (purpose) =>
      Buffer.from(
        hkdfSync(
          "sha256",
          root,
          Buffer.from(expectedDatabaseName, "utf8"),
          Buffer.from(purpose, "utf8"),
          32,
        ),
      );
    try {
      return Object.freeze({
        peppers: Object.freeze([
          { version: 1, key: derive("bop-rms/internal-test/order-recovery-pepper/v1") },
        ]),
        abuse: derive("bop-rms/internal-test/order-recovery-abuse/v1"),
      });
    } finally {
      root.fill(0);
    }
  }
  return {
    createInternalOrderRecoveryKeys,
    provisionInternalTestCredentials,
    createInternalTestCredentials,
    createInternalMerchantCredentials,
    createInternalCatalogCursorKey,
    createInternalStaffPinCredentials,
  };
}
