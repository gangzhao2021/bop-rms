import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MANAGED_SECRET_KEYS,
  QR_SECRET_FILES,
  checkManagedSecrets,
  createManagedSecretSource,
  describeSecretProblems,
  generateManagedSecrets,
  loadManagedSecrets,
} from "./pilot-secrets.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { createInternalQrLoaders } from "./pilot-qr.mjs";
import { createInternalDiningCredentialLoaders } from "./pilot-dining-credentials.mjs";

let root, secrets, runtime;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pilot-secrets-")));
  secrets = path.join(root, "secrets");
  runtime = path.join(root, "runtime");
  await fs.mkdir(runtime, { mode: 0o700 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const pilot = () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
};
const hosting = () =>
  fs.writeFile(
    path.join(runtime, "hosting.json"),
    JSON.stringify({
      schemaVersion: 1,
      environment: "Pilot",
      customerOrigin: "https://order.store-pilot.ca",
      secretsDirectory: secrets,
      tls: { mode: "proxy" },
    }),
    { mode: 0o600 },
  );
const replace = async (name, value) => {
  await fs.rm(path.join(secrets, name), { force: true });
  await fs.writeFile(path.join(secrets, name), value + "\n", { mode: 0o400 });
};

it("DEC-PILOT-SECRETS: generate creates every managed value once (0400) and check finds them complete", async () => {
  const created = await generateManagedSecrets(secrets, { now: new Date("2026-10-20T12:00:00Z") });
  expect(created).toContain("guest-session-key");
  expect(created).toContain("staff-pin-pepper-v1");
  expect(created).toContain(QR_SECRET_FILES.key);
  expect((await fs.readFile(path.join(secrets, QR_SECRET_FILES.kid), "utf8")).trim()).toBe(
    "store-qr-20261020",
  );
  for (const name of created)
    expect((await fs.stat(path.join(secrets, name))).mode & 0o777).toBe(0o400);
  expect(await generateManagedSecrets(secrets)).toEqual([]);
  expect(await checkManagedSecrets(secrets)).toEqual({ missing: [], invalid: [] });
});

it("DEC-PILOT-SECRETS: names every missing or unusable file and never a value", async () => {
  await generateManagedSecrets(secrets);
  const leaked = "a".repeat(64);
  await fs.rm(path.join(secrets, "guest-session-key"));
  await fs.chmod(path.join(secrets, "dining-key"), 0o644);
  await replace("catalog-cursor-key", "not-hex");
  // A copy of another purpose's value is refused, so two purposes can never share a key.
  await replace("store-device-key", leaked);
  await replace("staff-pin-choice-key", leaked);
  await fs.rm(path.join(secrets, "pickup-selector-key-v1"));
  const result = await checkManagedSecrets(secrets);
  expect(result.missing.sort()).toEqual(["guest-session-key", "pickup-selector-key-v1"]);
  expect(result.invalid.sort()).toEqual([
    "catalog-cursor-key",
    "dining-key",
    "staff-pin-choice-key",
  ]);
  const line = describeSecretProblems(result);
  expect(line).toContain("guest-session-key");
  expect(line).not.toContain(leaked);
  expect(await checkManagedSecrets(path.join(root, "absent"))).toEqual({
    missing: ["secretsDirectory"],
    invalid: [],
  });
});

it("DEC-PILOT-SECRETS: follows orchestrator links only inside the folder", async () => {
  await generateManagedSecrets(secrets);
  const outside = path.join(root, "outside-key");
  await fs.writeFile(outside, randomBytes(32).toString("hex"), { mode: 0o400 });
  await fs.rm(path.join(secrets, "dining-key"));
  await fs.symlink(outside, path.join(secrets, "dining-key"));
  expect((await checkManagedSecrets(secrets)).invalid).toEqual(["dining-key"]);
  const data = path.join(secrets, "..data");
  await fs.mkdir(data, { mode: 0o700 });
  await fs.rename(outside, path.join(data, "dining-key"));
  await fs.rm(path.join(secrets, "dining-key"));
  await fs.symlink(path.join(data, "dining-key"), path.join(secrets, "dining-key"));
  expect(await checkManagedSecrets(secrets)).toEqual({ missing: [], invalid: [] });
});

it("DEC-PILOT-SECRETS: a Pilot process reads every consumer's keys from the managed files; rotation keeps old versions readable", async () => {
  await generateManagedSecrets(secrets);
  await hosting();
  pilot();
  const loaders = createInternalCredentialLoaders({
    file: path.join(runtime, "internal-test-keys.json"),
    loadProfile: async () => ({ environment: "Pilot" }),
    expectedDatabaseName: "pilot_db",
  });
  const generators = await loaders.createInternalTestCredentials();
  expect(typeof generators.reference()).toBe("string");
  expect(generators.pickup).toBeTruthy();
  expect((await loaders.createInternalCatalogCursorKey()).toString("hex")).toBe(
    (await fs.readFile(path.join(secrets, "catalog-cursor-key"), "utf8")).trim(),
  );
  const v1 = await loaders.createInternalMerchantCredentials();
  const envelope = await v1.envelopes.encrypt("staff session", "context");
  expect(envelope.keyReference).toBe("pilot-merchant-v1");
  expect(JSON.stringify(envelope)).not.toContain("staff session");
  // Rotation: a new version encrypts, the old one still decrypts until it is removed.
  await fs.writeFile(
    path.join(secrets, "merchant-encryption-key-v2"),
    randomBytes(32).toString("hex"),
    { mode: 0o400 },
  );
  const v2 = await loaders.createInternalMerchantCredentials();
  expect((await v2.envelopes.encrypt("x", "context")).keyReference).toBe("pilot-merchant-v2");
  expect(await v2.envelopes.decrypt(envelope, "context")).toBe("staff session");
  await expect(v2.envelopes.decrypt(envelope, "other")).rejects.toThrow("INTERNAL_SESSION_DENIED");
  const pin = await loaders.createInternalStaffPinCredentials();
  expect(Object.keys(pin).sort()).toEqual(["choiceTokens", "deviceHasher", "kdf"]);
  const dining = createInternalDiningCredentialLoaders({
    path: path.join(runtime, "internal-test-dining-key"),
  });
  const join = await dining.createInternalDiningCredentials({
    credentials: { reference: () => "r" },
  });
  expect(join.hashJoinCredential("HumanCode", "123456")).toMatch(/^[a-f0-9]{64}$/u);
  await expect(dining.provisionInternalDiningCredentials()).rejects.toThrow("INTERNAL_DINING_ONLY");
  // InternalTest provisioning is refused in a Pilot process.
  await expect(loaders.provisionInternalTestCredentials()).rejects.toThrow(
    "INTERNAL_TEST_CREDENTIALS_UNAVAILABLE",
  );
});

it("DEC-PILOT-SECRETS: a Pilot process fails closed when a managed file is missing", async () => {
  await generateManagedSecrets(secrets);
  await fs.rm(path.join(secrets, "guest-binding-key"));
  await hosting();
  pilot();
  const loaders = createInternalCredentialLoaders({
    file: path.join(runtime, "internal-test-keys.json"),
    loadProfile: async () => ({ environment: "Pilot" }),
    expectedDatabaseName: "pilot_db",
  });
  const error = await loaders.createInternalTestCredentials().catch((e) => e);
  expect(error.message).toBe("PILOT_SECRETS_UNAVAILABLE");
  expect(error.missing).toEqual(["guest-binding-key"]);
});

it("DEC-PILOT-SECRETS: table QR codes sign with the managed kid; the previous key verifies as Overlap until compromised", async () => {
  await generateManagedSecrets(secrets);
  const previous = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await replace(
    QR_SECRET_FILES.previousKey,
    previous.publicKey.export({ type: "spki", format: "pem" }).trim(),
  );
  await replace(QR_SECRET_FILES.previousKid, "internal-test-v1");
  await hosting();
  pilot();
  const kid = (await fs.readFile(path.join(secrets, QR_SECRET_FILES.kid), "utf8")).trim();
  const qr = createInternalQrLoaders({
    file: path.join(runtime, "internal-test-qr-key.pem"),
    loadProfile: async () => ({}),
    expectedDatabaseName: "pilot_db",
  });
  const profile = { environment: "Pilot", createdAt: "2026-10-01T00:00:00.000Z" };
  const keys = await qr.loadIssuedTableQrKeys(profile);
  const set = await keys.keys.load();
  expect(set.keys.map((key) => [key.kid, key.state, key.compromisedAt])).toEqual(
    [
      [kid, "Current", null],
      ["internal-test-v1", "Overlap", null],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
  const signed = await keys.signer.sign({ schemaVersion: 1 });
  expect(signed.keyId).toBe(kid);
  const [header, payload, signature] = signed.token.split(".");
  const current = set.keys.find((key) => key.kid === kid);
  expect(
    await keys.verifier.verify({
      algorithm: "ES256",
      publicKeyReference: current.publicKeyReference,
      signingInput: header + "." + payload,
      signature: new Uint8Array(Buffer.from(signature, "base64url")),
    }),
  ).toBe("Verified");
  expect(JSON.parse(Buffer.from(header, "base64url").toString()).kid).toBe(kid);
  await replace(QR_SECRET_FILES.previousCompromisedAt, "2026-10-20T00:00:00.000Z");
  const compromised = await (await qr.loadIssuedTableQrKeys(profile)).keys.load();
  expect(compromised.keys.find((key) => key.kid === "internal-test-v1").compromisedAt).toBe(
    "2026-10-20T00:00:00.000Z",
  );
  // A Store profile of another environment never gets keys.
  await expect(
    qr.loadIssuedTableQrKeys({ ...profile, environment: "InternalTest" }),
  ).rejects.toThrow("INTERNAL_QR_UNAVAILABLE");
});

it("DEC-PILOT-SECRETS: the catalog covers every key the internal test key file and runtime peppers provide", () => {
  expect(MANAGED_SECRET_KEYS.map((entry) => entry.name).sort()).toEqual(
    [
      "catalog-cursor-key",
      "dining-key",
      "guest-abuse-pepper",
      "guest-binding-key",
      "guest-session-key",
      "merchant-encryption-key",
      "merchant-selector-key",
      "pickup-derivation-key",
      "pickup-selector-key",
      "staff-pin-choice-key",
      "staff-pin-pepper",
      "store-device-key",
    ].sort(),
  );
});

it("DEC-PILOT-SECRETS: the source rejects a group- or world-writable folder", async () => {
  await generateManagedSecrets(secrets);
  await fs.chmod(secrets, 0o777);
  await expect(loadManagedSecrets(createManagedSecretSource(secrets))).rejects.toMatchObject({
    message: "PILOT_SECRETS_UNAVAILABLE",
    invalid: ["secretsDirectory"],
  });
});
