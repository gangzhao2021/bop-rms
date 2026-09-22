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
  return Object.freeze({
    deriveOpaque: derive,
    hashCredential,
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
