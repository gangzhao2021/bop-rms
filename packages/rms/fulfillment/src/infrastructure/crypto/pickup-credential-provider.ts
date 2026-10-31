import { Buffer } from "node:buffer";
import { createHmac, createSecretKey, timingSafeEqual, type KeyObject } from "node:crypto";
import { parsePickupProofCapability } from "@bop/public-capability";
import {
  parsePickupProofReference,
  parsePickupProofInstant,
  PickupProofError,
} from "../../contracts/pickup-proof.js";
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly fulfillmentReference: string;
}
interface Derivation extends Scope {
  readonly capabilityReference: string;
  readonly generation: number;
  readonly pepperVersion: number;
}
function invalid(): never {
  throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
}
function scope(input: Scope) {
  return [
    parsePickupProofReference(input.brandReference),
    parsePickupProofReference(input.storeReference),
    parsePickupProofReference(input.fulfillmentReference),
  ];
}
/** No storage or authorization: callers must establish current Guest/Order and Ready authority. */
export function createPickupCredentialProvider(
  versions: readonly {
    readonly version: number;
    readonly derivationKey: Uint8Array;
    readonly selectorKey: Uint8Array;
  }[],
) {
  const keys = new Map<number, { derivation: KeyObject; selector: KeyObject }>();
  if (!Array.isArray(versions) || versions.length < 1 || versions.length > 32) return invalid();
  for (const entry of versions) {
    if (
      !Number.isSafeInteger(entry.version) ||
      entry.version < 1 ||
      entry.version > 2147483647 ||
      keys.has(entry.version) ||
      !(entry.derivationKey instanceof Uint8Array) ||
      entry.derivationKey.byteLength !== 32 ||
      !(entry.selectorKey instanceof Uint8Array) ||
      entry.selectorKey.byteLength !== 32 ||
      timingSafeEqual(entry.derivationKey, entry.selectorKey)
    )
      return invalid();
    const d = Buffer.from(entry.derivationKey),
      s = Buffer.from(entry.selectorKey);
    keys.set(entry.version, { derivation: createSecretKey(d), selector: createSecretKey(s) });
    d.fill(0);
    s.fill(0);
  }
  const key = (version: number) => {
    const result = keys.get(version);
    if (!result) return invalid();
    return result;
  };
  const derive = (input: Derivation): string => {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.generation > 2147483647
    )
      return invalid();
    const message = JSON.stringify([
      "bop-rms:pickup-credential:v1:opaque",
      input.pepperVersion,
      ...scope(input),
      parsePickupProofReference(input.capabilityReference),
      input.generation,
    ]);
    const digest = createHmac("sha256", key(input.pepperVersion).derivation)
      .update(message, "utf8")
      .digest();
    const result = digest.subarray(0, 16).toString("base64url");
    digest.fill(0);
    return result;
  };
  const hashCredential = (
    input: Scope & {
      purpose: "PickupHandoff";
      kind: "Opaque" | "HumanCode";
      pepperVersion: number;
      credential: string;
    },
  ): string => {
    if (
      input.purpose !== "PickupHandoff" ||
      typeof input.credential !== "string" ||
      (input.kind === "Opaque"
        ? !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(input.credential)
        : input.kind === "HumanCode"
          ? !/^[0-9]{6}$/.test(input.credential)
          : true)
    )
      return invalid();
    return createHmac("sha256", key(input.pepperVersion).selector)
      .update(
        JSON.stringify([
          "bop-rms:pickup-credential:v1:selector",
          input.purpose,
          input.kind,
          input.pepperVersion,
          ...scope(input),
          input.credential,
        ]),
        "utf8",
      )
      .digest("hex");
  };
  /**
   * WP-2423 (DEC-PICKUP-COUNTER-CODE): the six-digit code a guest reads to staff. Derived from the
   * same versioned key as the long code, bound to one proof generation; `index` picks the next
   * candidate when a code is still valid for another order at the Store.
   */
  const deriveCounterCode = (input: Derivation & { readonly index: number }): string => {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.generation > 2147483647 ||
      !Number.isSafeInteger(input.index) ||
      input.index < 0 ||
      input.index > 15
    )
      return invalid();
    const digest = createHmac("sha256", key(input.pepperVersion).derivation)
      .update(
        JSON.stringify([
          "bop-rms:pickup-credential:v1:counter-code",
          input.pepperVersion,
          ...scope(input),
          parsePickupProofReference(input.capabilityReference),
          input.generation,
          input.index,
        ]),
        "utf8",
      )
      .digest();
    // 64 bits reduced to six digits: the bias is below 1e-13.
    const value = digest.readBigUInt64BE(0) % 1_000_000n;
    digest.fill(0);
    return value.toString().padStart(6, "0");
  };
  /** The code bound to the Store only, so two orders whose pickup windows overlap never share it. */
  const counterCodeLookupHash = (input: {
    brandReference: string;
    storeReference: string;
    pepperVersion: number;
    credential: string;
  }): string => {
    if (typeof input.credential !== "string" || !/^[0-9]{6}$/.test(input.credential))
      return invalid();
    return createHmac("sha256", key(input.pepperVersion).selector)
      .update(
        JSON.stringify([
          "bop-rms:pickup-credential:v1:counter-code-lookup",
          input.pepperVersion,
          parsePickupProofReference(input.brandReference),
          parsePickupProofReference(input.storeReference),
          input.credential,
        ]),
        "utf8",
      )
      .digest("hex");
  };
  return Object.freeze({
    deriveOpaque: derive,
    deriveCounterCode,
    counterCodeLookupHash,
    hashCredential,
    /** Re-derives the saved short code of a current proof and checks it against its saved hash. */
    recoverCounterCode(input: {
      brandReference: string;
      capability: unknown;
      counterCode: { readonly derivationIndex: number; readonly selectorHash: string };
      observedAt: string;
    }): string {
      try {
        const capability = parsePickupProofCapability(input.capability),
          at = parsePickupProofInstant(input.observedAt);
        if (
          capability.status !== "Active" ||
          Date.parse(at) < Date.parse(capability.readyAt) ||
          Date.parse(at) >= Date.parse(capability.expiresAt)
        )
          return invalid();
        const selected = {
          brandReference: input.brandReference,
          storeReference: capability.storeReference,
          fulfillmentReference: capability.fulfillmentReference,
          pepperVersion: capability.pepperVersion,
        };
        const credential = deriveCounterCode({
          ...selected,
          capabilityReference: capability.capabilityReference,
          generation: capability.generation,
          index: input.counterCode.derivationIndex,
        });
        const hash = hashCredential({
          ...selected,
          purpose: "PickupHandoff",
          kind: "HumanCode",
          credential,
        });
        if (
          typeof input.counterCode.selectorHash !== "string" ||
          input.counterCode.selectorHash.length !== hash.length ||
          !timingSafeEqual(
            Buffer.from(hash, "utf8"),
            Buffer.from(input.counterCode.selectorHash, "utf8"),
          )
        )
          return invalid();
        return credential;
      } catch {
        return invalid();
      }
    },
    recoverOpaque(input: {
      brandReference: string;
      capability: unknown;
      observedAt: string;
    }): string {
      try {
        const capability = parsePickupProofCapability(input.capability),
          at = parsePickupProofInstant(input.observedAt);
        if (
          capability.kind !== "Opaque" ||
          capability.status !== "Active" ||
          Date.parse(at) < Date.parse(capability.readyAt) ||
          Date.parse(at) >= Date.parse(capability.expiresAt)
        )
          return invalid();
        const selected = {
          brandReference: input.brandReference,
          storeReference: capability.storeReference,
          fulfillmentReference: capability.fulfillmentReference,
          pepperVersion: capability.pepperVersion,
        };
        const credential = derive({
          ...selected,
          capabilityReference: capability.capabilityReference,
          generation: capability.generation,
        });
        const hash = hashCredential({
          ...selected,
          purpose: "PickupHandoff",
          kind: "Opaque",
          credential,
        });
        if (
          !timingSafeEqual(Buffer.from(hash, "utf8"), Buffer.from(capability.selectorHash, "utf8"))
        )
          return invalid();
        return credential;
      } catch {
        return invalid();
      }
    },
  });
}
