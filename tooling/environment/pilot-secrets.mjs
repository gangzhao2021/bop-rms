// WP-2423 (DEC-PILOT-SECRETS): the managed secret source of a Pilot (real Store) installation.
//
// The hosting delivers each secret as its own file in one directory (`secretsDirectory` in
// `<runtime>/hosting.json`): AWS Secrets Manager / SSM Parameter Store values written by the host
// agent or orchestrator (ECS/Kubernetes secret volume, systemd LoadCredential, a deploy script),
// owner-only (0400/0600), one value per file. This module is the only reader. It never logs,
// returns in errors or caches a value; every composition reads the current files, so a rotation
// takes effect at the next service restart.
//
//   node tooling/environment/pilot-secrets.mjs check <runtime>        names missing/invalid files
//   node tooling/environment/pilot-secrets.mjs generate <directory>   creates missing values (0400)
//
// InternalTest never uses this module's values: it keeps its generated local key files.
import { Buffer } from "node:buffer";
import console from "node:console";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

/** Hex keys of 32 bytes. `versioned`: `<name>-v<N>` files; the highest N is current, all verify. */
export const MANAGED_SECRET_KEYS = Object.freeze([
  Object.freeze({ name: "guest-session-key", purpose: "guest session cookies" }),
  Object.freeze({ name: "guest-binding-key", purpose: "guest table binding" }),
  Object.freeze({ name: "guest-abuse-pepper", purpose: "guest request limits" }),
  Object.freeze({ name: "pickup-derivation-key", purpose: "pickup codes", versioned: true }),
  Object.freeze({ name: "pickup-selector-key", purpose: "pickup codes", versioned: true }),
  Object.freeze({
    name: "merchant-encryption-key",
    purpose: "staff session encryption",
    versioned: true,
  }),
  Object.freeze({ name: "merchant-selector-key", purpose: "staff session lookup" }),
  Object.freeze({ name: "catalog-cursor-key", purpose: "product list paging" }),
  Object.freeze({ name: "staff-pin-pepper", purpose: "staff PINs", versioned: true }),
  Object.freeze({ name: "store-device-key", purpose: "registered store tablets" }),
  Object.freeze({ name: "staff-pin-choice-key", purpose: "tablet lock screen" }),
  Object.freeze({ name: "dining-key", purpose: "table join codes" }),
]);
/** Table QR signing: current private key and kid, optional previous public key (Overlap). */
export const QR_SECRET_FILES = Object.freeze({
  key: "qr-signing-key",
  kid: "qr-signing-kid",
  previousKey: "qr-previous-public-key",
  previousKid: "qr-previous-kid",
  previousCompromisedAt: "qr-previous-compromised-at",
});
const MAX_BYTES = 16 * 1024;
const NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const HEX = /^[0-9a-f]{64}$/u;

const unavailable = (missing = [], invalid = []) => {
  throw Object.assign(Error("PILOT_SECRETS_UNAVAILABLE"), {
    missing: Object.freeze([...missing]),
    invalid: Object.freeze([...invalid]),
  });
};

/**
 * Reads the directory listing and each named value. A file must be a regular owner-only file of
 * this user (a link is followed only when it stays inside the directory, as orchestrator secret
 * volumes use), at most 16 KB, without NUL. One trailing newline is ignored.
 */
export function createManagedSecretSource(secretsDirectory) {
  async function root() {
    if (!path.isAbsolute(secretsDirectory)) return unavailable([], ["secretsDirectory"]);
    let real, stat;
    try {
      real = await fs.realpath(secretsDirectory);
      stat = await fs.stat(real);
    } catch {
      return unavailable(["secretsDirectory"]);
    }
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0)
      return unavailable([], ["secretsDirectory"]);
    return real;
  }
  async function readOne(real, name) {
    if (!NAME.test(name)) return { state: "invalid" };
    let file;
    try {
      file = await fs.realpath(path.join(real, name));
    } catch (error) {
      return { state: error?.code === "ENOENT" ? "missing" : "invalid" };
    }
    if (path.dirname(file) !== real && !file.startsWith(real + path.sep))
      return { state: "invalid" };
    let handle;
    try {
      handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch {
      return { state: "invalid" };
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
        stat.size === 0 ||
        stat.size > MAX_BYTES
      )
        return { state: "invalid" };
      let value = await handle.readFile("utf8");
      if (value.endsWith("\n")) value = value.slice(0, -1);
      if (value.endsWith("\r")) value = value.slice(0, -1);
      if (value.length === 0 || value.includes("\0")) return { state: "invalid" };
      return { state: "present", value };
    } finally {
      await handle.close();
    }
  }
  return Object.freeze({
    async names() {
      return (await fs.readdir(await root())).filter((name) => NAME.test(name));
    },
    /** `{ values: Map, missing: [], invalid: [] }` for exactly the requested names. */
    async read(names) {
      const real = await root();
      const values = new Map(),
        missing = [],
        invalid = [];
      for (const name of names) {
        const result = await readOne(real, name);
        if (result.state === "present") values.set(name, result.value);
        else (result.state === "missing" ? missing : invalid).push(name);
      }
      return { values, missing, invalid };
    },
  });
}

/** Every value a Pilot process needs, validated together; throws naming files only. */
export async function loadManagedSecrets(source) {
  const listed = await source.names();
  const wanted = [],
    versions = new Map();
  for (const entry of MANAGED_SECRET_KEYS) {
    if (!entry.versioned) {
      wanted.push(entry.name);
      continue;
    }
    const pattern = new RegExp(`^${entry.name}-v([1-9][0-9]{0,8})$`, "u");
    const found = listed
      .map((name) => pattern.exec(name)?.[1])
      .filter((version) => version !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    versions.set(entry.name, found);
    if (found.length === 0) wanted.push(`${entry.name}-v1`);
    else wanted.push(...found.map((version) => `${entry.name}-v${version}`));
  }
  const optionalQr = [
    QR_SECRET_FILES.previousKey,
    QR_SECRET_FILES.previousKid,
    QR_SECRET_FILES.previousCompromisedAt,
  ].filter((name) => listed.includes(name));
  wanted.push(QR_SECRET_FILES.key, QR_SECRET_FILES.kid, ...optionalQr);
  const read = await source.read(wanted);
  const { values } = read,
    missing = [...read.missing],
    bad = new Set(read.invalid);
  const hex = (name) => {
    const value = values.get(name);
    if (value === undefined) return null;
    if (!HEX.test(value)) {
      bad.add(name);
      return null;
    }
    return Buffer.from(value, "hex");
  };
  const keys = new Map();
  for (const entry of MANAGED_SECRET_KEYS)
    if (entry.versioned) {
      const found = versions.get(entry.name);
      keys.set(
        entry.name,
        new Map(
          (found.length === 0 ? [] : found).map((version) => [
            version,
            hex(`${entry.name}-v${version}`),
          ]),
        ),
      );
    } else keys.set(entry.name, hex(entry.name));
  // Pickup derivation and selector keys rotate together (one pepper version, both keys).
  const pickupD = versions.get("pickup-derivation-key"),
    pickupS = versions.get("pickup-selector-key");
  for (const version of new Set([...pickupD, ...pickupS]))
    if (!pickupD.includes(version) || !pickupS.includes(version))
      missing.push(
        `pickup-${pickupD.includes(version) ? "selector" : "derivation"}-key-v${version}`,
      );
  // No two purposes may share a value (a copy-paste mistake would silently link them).
  const seen = new Map();
  for (const name of wanted) {
    const value = values.get(name);
    if (value === undefined || !HEX.test(value)) continue;
    if (seen.has(value)) bad.add(name);
    else seen.set(value, name);
  }
  let qr = null;
  try {
    const privateKey = createPrivateKey(values.get(QR_SECRET_FILES.key) ?? "");
    if (
      privateKey.asymmetricKeyType !== "ec" ||
      privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw Error("curve");
    qr = { privateKey };
  } catch {
    if (values.has(QR_SECRET_FILES.key)) bad.add(QR_SECRET_FILES.key);
  }
  const kid = values.get(QR_SECRET_FILES.kid);
  if (kid !== undefined && !KID.test(kid)) bad.add(QR_SECRET_FILES.kid);
  let previous = null;
  if (optionalQr.length > 0) {
    const previousKid = values.get(QR_SECRET_FILES.previousKid);
    const compromised = values.get(QR_SECRET_FILES.previousCompromisedAt);
    let publicKey = null;
    try {
      publicKey = createPublicKey(values.get(QR_SECRET_FILES.previousKey) ?? "");
      if (publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw Error("curve");
    } catch {
      bad.add(QR_SECRET_FILES.previousKey);
    }
    if (previousKid === undefined || !KID.test(previousKid) || previousKid === kid)
      bad.add(QR_SECRET_FILES.previousKid);
    if (
      compromised !== undefined &&
      (Number.isNaN(Date.parse(compromised)) ||
        new Date(Date.parse(compromised)).toISOString() !== compromised)
    )
      bad.add(QR_SECRET_FILES.previousCompromisedAt);
    previous = { kid: previousKid, publicKey, compromisedAt: compromised ?? null };
  }
  if (missing.length > 0 || bad.size > 0) unavailable([...new Set(missing)], [...bad]);
  return Object.freeze({
    key: (name) => Buffer.from(keys.get(name)),
    versions: (name) =>
      new Map([...keys.get(name)].map(([version, key]) => [version, Buffer.from(key)])),
    qr: Object.freeze({ kid, privateKey: qr.privateKey, previous }),
  });
}

/** The managed secrets named by `<runtime>/hosting.json` (Pilot only). */
export async function loadPilotManagedSecrets(runtimeDirectory) {
  const { loadPilotHosting } = await import("./pilot-hosting.mjs");
  const hosting = await loadPilotHosting(runtimeDirectory);
  if (hosting.secretsDirectory === null) return unavailable(["secretsDirectory"]);
  return loadManagedSecrets(createManagedSecretSource(hosting.secretsDirectory));
}

/** Names only: what the operator must still provide (never values). */
export async function checkManagedSecrets(secretsDirectory) {
  try {
    await loadManagedSecrets(createManagedSecretSource(secretsDirectory));
    return { missing: [], invalid: [] };
  } catch (error) {
    if (error?.message !== "PILOT_SECRETS_UNAVAILABLE") return { missing: [], invalid: ["read"] };
    return { missing: [...error.missing], invalid: [...error.invalid] };
  }
}

/** AES-256-GCM envelopes for staff session data; the highest key version encrypts, every version decrypts. */
export function createMerchantEnvelopeCrypto({ keys, current, algorithm }) {
  const reference = (version) => current.prefix + version;
  const encryptionKey = keys.get(current.version);
  if (encryptionKey === undefined) throw Error("PILOT_SECRETS_UNAVAILABLE");
  return {
    async encrypt(plaintext, encryptionContext) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(Buffer.from(encryptionContext));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        algorithm,
        keyReference: reference(current.version),
        encryptionContext,
        ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url"),
      };
    },
    async decrypt(envelope, expected) {
      const version = [...keys.keys()].find((v) => reference(v) === envelope.keyReference);
      if (
        envelope.algorithm !== algorithm ||
        version === undefined ||
        envelope.encryptionContext !== expected
      )
        throw new Error("INTERNAL_SESSION_DENIED");
      const raw = Buffer.from(envelope.ciphertext, "base64url");
      if (raw.length < 29 || raw.length > 32768) throw new Error("INTERNAL_SESSION_DENIED");
      const decipher = createDecipheriv("aes-256-gcm", keys.get(version), raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(expected));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
export function createSelectorHasher(pepper) {
  return {
    hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
    equals: (a, b) =>
      typeof a === "string" &&
      typeof b === "string" &&
      /^[a-f0-9]{64}$/.test(a) &&
      /^[a-f0-9]{64}$/.test(b) &&
      timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
  };
}

/**
 * Creates every missing value in `directory` (0700, created when absent): random 32-byte hex keys
 * (`-v1` for versioned ones), a P-256 QR signing key and its kid. Never overwrites a file and never
 * prints a value. Use it to seed the managed store (upload each file as its own secret) or, on a
 * self-hosted machine, as the mounted directory itself.
 */
export async function generateManagedSecrets(directory, { now = new Date() } = {}) {
  if (!path.isAbsolute(directory)) throw Error("PILOT_SECRETS_DIRECTORY_INVALID");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw Error("PILOT_SECRETS_DIRECTORY_INVALID");
  const existing = new Set(await fs.readdir(directory));
  const created = [];
  const write = async (name, value) => {
    if (existing.has(name)) return;
    await fs.writeFile(path.join(directory, name), value + "\n", { mode: 0o400, flag: "wx" });
    created.push(name);
  };
  for (const entry of MANAGED_SECRET_KEYS) {
    const hasVersion = [...existing].some((name) => name.startsWith(entry.name + "-v"));
    if (entry.versioned && hasVersion) continue;
    await write(entry.versioned ? `${entry.name}-v1` : entry.name, randomBytes(32).toString("hex"));
  }
  if (!existing.has(QR_SECRET_FILES.key)) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await write(
      QR_SECRET_FILES.key,
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).trim(),
    );
    // A new kid names this key on every printed code (the date keeps rotations readable).
    await write(
      QR_SECRET_FILES.kid,
      "store-qr-" + now.toISOString().slice(0, 10).replaceAll("-", ""),
    );
  }
  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, target, ...rest] = process.argv.slice(2);
  try {
    if (rest.length !== 0 || typeof target !== "string")
      throw Error("PILOT_SECRETS_ARGUMENT_INVALID");
    if (command === "generate") {
      const created = await generateManagedSecrets(path.resolve(target));
      console.log(
        created.length === 0
          ? "PILOT_SECRETS_COMPLETE (nothing created)"
          : `PILOT_SECRETS_CREATED ${created.join(", ")} (values not shown; copy each file into the managed secret store, then delete this folder unless it is the mounted one)`,
      );
    } else if (command === "check") {
      const { loadPilotHosting } = await import("./pilot-hosting.mjs");
      const { parsePilotRuntimeDirectory } = await import("./pilot-service.mjs");
      const runtime = path.join(
        fileURLToPath(new URL("../../", import.meta.url)),
        parsePilotRuntimeDirectory(target),
      );
      const hosting = await loadPilotHosting(runtime);
      if (hosting.secretsDirectory === null) {
        console.log("PILOT_SECRETS_NOT_CONFIGURED (InternalTest keeps its local test keys)");
      } else {
        const result = await checkManagedSecrets(hosting.secretsDirectory);
        if (result.missing.length === 0 && result.invalid.length === 0)
          console.log("PILOT_SECRETS_COMPLETE");
        else {
          console.error(describeSecretProblems(result));
          process.exitCode = 1;
        }
      }
    } else throw Error("PILOT_SECRETS_ARGUMENT_INVALID");
  } catch (error) {
    console.error(
      /^PILOT_[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "PILOT_SECRETS_UNAVAILABLE",
    );
    process.exitCode = 1;
  }
}

/** One plain operator line naming files only. */
export function describeSecretProblems({ missing, invalid }) {
  const parts = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
  if (invalid.length > 0) parts.push(`unusable: ${invalid.join(", ")}`);
  return (
    "PILOT_SECRETS_UNAVAILABLE " +
    parts.join("; ") +
    " — put each value in its own owner-only file (0400) in the secrets folder named in hosting.json; see docs/runbooks/key-secret-rotation.md (Pilot secret files)"
  );
}
