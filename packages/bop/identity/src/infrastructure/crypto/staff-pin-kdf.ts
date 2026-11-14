import { Buffer } from "node:buffer";
import { argon2, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * WP-2423 Q18 option A: the staff PIN key derivation. Argon2id (RFC 9106; Node's built-in
 * `crypto.argon2`, no added dependency) with a 16-byte random salt per PIN, the OWASP minimum
 * cost (19 MiB memory, 2 passes, 1 lane), a server-held pepper passed as the Argon2 secret (kept
 * outside the database, versioned), and the Brand/Store/staff binding as associated data so a
 * stored hash cannot be copied onto another person or Store. Six digits are only a million
 * values, so the pepper, not the hash cost, is what protects a stolen table; online guessing is
 * bounded by the lockout and the tablet limit.
 */
export interface StaffPinKdfParameters {
  readonly algorithm: "argon2id";
  readonly memoryKib: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly pepperVersion: number;
}
export interface StaffPinKdf {
  /** Parameters a newly set PIN is hashed with. */
  readonly current: StaffPinKdfParameters;
  derive(input: {
    readonly pin: string;
    readonly salt: Buffer;
    readonly binding: string;
    readonly parameters: StaffPinKdfParameters;
  }): Promise<Buffer>;
  newSalt(): Buffer;
}
export const staffPinKdfMinimum = Object.freeze({ memoryKib: 19_456, passes: 2, parallelism: 1 });

const unavailable = (): never => {
  throw new Error("STAFF_PIN_KDF_UNAVAILABLE");
};

function checkParameters(parameters: StaffPinKdfParameters): StaffPinKdfParameters {
  if (
    parameters.algorithm !== "argon2id" ||
    !Number.isSafeInteger(parameters.memoryKib) ||
    parameters.memoryKib < staffPinKdfMinimum.memoryKib ||
    parameters.memoryKib > 1_048_576 ||
    !Number.isSafeInteger(parameters.passes) ||
    parameters.passes < staffPinKdfMinimum.passes ||
    parameters.passes > 16 ||
    !Number.isSafeInteger(parameters.parallelism) ||
    parameters.parallelism < 1 ||
    parameters.parallelism > 8 ||
    !Number.isSafeInteger(parameters.pepperVersion) ||
    parameters.pepperVersion < 1
  )
    return unavailable();
  return parameters;
}

/** `peppers` maps each pepper version to its 32-byte key; `currentPepperVersion` hashes new PINs. */
export function createArgon2idStaffPinKdf(options: {
  readonly peppers: ReadonlyMap<number, Uint8Array>;
  readonly currentPepperVersion: number;
  readonly memoryKib?: number;
  readonly passes?: number;
  readonly parallelism?: number;
}): StaffPinKdf {
  const peppers = new Map<number, Buffer>();
  for (const [version, key] of options.peppers) {
    if (!Number.isSafeInteger(version) || version < 1 || key.byteLength !== 32) unavailable();
    peppers.set(version, Buffer.from(key));
  }
  const current = Object.freeze(
    checkParameters({
      algorithm: "argon2id",
      memoryKib: options.memoryKib ?? staffPinKdfMinimum.memoryKib,
      passes: options.passes ?? staffPinKdfMinimum.passes,
      parallelism: options.parallelism ?? staffPinKdfMinimum.parallelism,
      pepperVersion: options.currentPepperVersion,
    }),
  );
  if (!peppers.has(current.pepperVersion)) unavailable();
  return Object.freeze({
    current,
    newSalt: () => randomBytes(16),
    derive: async (input: {
      readonly pin: string;
      readonly salt: Buffer;
      readonly binding: string;
      readonly parameters: StaffPinKdfParameters;
    }) => {
      const parameters = checkParameters(input.parameters);
      const pepper = peppers.get(parameters.pepperVersion);
      if (
        pepper === undefined ||
        !/^[0-9]{6}$/u.test(input.pin) ||
        input.salt.byteLength !== 16 ||
        input.binding.length < 1 ||
        input.binding.length > 256
      )
        return unavailable();
      return new Promise<Buffer>((resolve, reject) => {
        argon2(
          "argon2id",
          {
            message: Buffer.from(input.pin, "utf8"),
            nonce: input.salt,
            secret: pepper,
            associatedData: Buffer.from(input.binding, "utf8"),
            parallelism: parameters.parallelism,
            tagLength: 32,
            memory: parameters.memoryKib,
            passes: parameters.passes,
          },
          (error, key) => (error ? reject(new Error("STAFF_PIN_KDF_UNAVAILABLE")) : resolve(key)),
        );
      });
    },
  });
}

/** The Argon2 associated data binding a PIN hash to one staff member at one Store. */
export function staffPinBinding(scope: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}): string {
  return (
    "bop-rms/staff-pin/v1:" +
    scope.brandReference +
    ":" +
    scope.storeReference +
    ":" +
    scope.actorReference
  );
}

export function staffPinHashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === 32 &&
    right.byteLength === 32 &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

/**
 * The registered tablet's secret: 32 random bytes in an HttpOnly cookie. Only its keyed hash
 * (HMAC-SHA256 under a purpose-separated server key) is stored, so a database copy cannot be
 * turned back into a working tablet cookie.
 */
export interface StoreDeviceSecretHasher {
  hash(secret: string): string;
}
export function createStoreDeviceSecretHasher(key: Uint8Array): StoreDeviceSecretHasher {
  if (key.byteLength !== 32) unavailable();
  const held = Buffer.from(key);
  return Object.freeze({
    hash(secret: string) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) return unavailable();
      return createHmac("sha256", held)
        .update("bop-rms/store-device/v1:" + secret, "utf8")
        .digest("hex");
    },
  });
}
export function generateStoreDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * How the tablet lock screen names each person without sending their actor reference to the
 * browser: HMAC-SHA256, under a purpose-separated server key, of the registered tablet (Brand,
 * Store, tablet registration) and the person. The token is stable for that tablet registration,
 * so a list shown a while ago still works, but it cannot be made without the key, names nobody on
 * another tablet or after the tablet is registered again, and reveals nothing about the person.
 * The server maps it back by recomputing it for the Store's members.
 */
export interface StaffPinChoiceScope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly deviceReference: string;
}
export interface StaffPinChoiceTokens {
  issue(scope: StaffPinChoiceScope, actorReference: string): string;
  /** The candidate the token names on this tablet, or null. */
  resolve(scope: StaffPinChoiceScope, token: unknown, candidates: readonly string[]): string | null;
}
const CHOICE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export function createStaffPinChoiceTokens(key: Uint8Array): StaffPinChoiceTokens {
  if (key.byteLength !== 32) unavailable();
  const held = Buffer.from(key);
  const mac = (scope: StaffPinChoiceScope, actorReference: string) =>
    createHmac("sha256", held)
      .update(
        "bop-rms/staff-pin-choice/v1:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          scope.deviceReference +
          ":" +
          actorReference,
        "utf8",
      )
      .digest();
  return Object.freeze({
    issue: (scope: StaffPinChoiceScope, actorReference: string) =>
      mac(scope, actorReference).toString("base64url"),
    resolve(scope: StaffPinChoiceScope, token: unknown, candidates: readonly string[]) {
      if (typeof token !== "string" || !CHOICE_TOKEN.test(token)) return null;
      const submitted = Buffer.from(token, "base64url");
      if (submitted.byteLength !== 32 || submitted.toString("base64url") !== token) return null;
      let found: string | null = null;
      // Every candidate is compared, so the time taken does not depend on who is named.
      for (const candidate of candidates)
        if (timingSafeEqual(mac(scope, candidate), submitted) && found === null) found = candidate;
      return found;
    },
  });
}
