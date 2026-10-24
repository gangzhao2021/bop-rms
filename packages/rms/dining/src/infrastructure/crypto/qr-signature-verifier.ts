import { KeyObject, verify } from "node:crypto";
import type { QrSignatureVerifierPort } from "../../application/ports/qr-table-context-ports.js";
import type { PublicKeyReference } from "../../contracts/qr-table-context.js";

/** Resolves server-owned public keys only; registry authorization and revocation
 * remain the responsibility of the QR service. Never cache across registry reads.
 */
export function createQrSignatureVerifier(
  loadPublicKey: (reference: PublicKeyReference) => Promise<KeyObject | null>,
): QrSignatureVerifierPort {
  return Object.freeze({
    async verify(input: Parameters<QrSignatureVerifierPort["verify"]>[0]) {
      try {
        const { algorithm, publicKeyReference, signingInput } = input;
        if (
          algorithm !== "ES256" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            publicKeyReference,
          ) ||
          typeof signingInput !== "string" ||
          signingInput.length > 1961 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(signingInput) ||
          !(input.signature instanceof Uint8Array) ||
          input.signature.byteLength !== 64
        )
          return "Invalid";
        const signature = Buffer.from(input.signature);
        const key = await loadPublicKey(publicKeyReference);
        if (
          !(key instanceof KeyObject) ||
          key.type !== "public" ||
          key.asymmetricKeyType !== "ec" ||
          key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
        )
          return "Unavailable";
        return verify(
          "sha256",
          Buffer.from(signingInput, "ascii"),
          { key, dsaEncoding: "ieee-p1363" },
          signature,
        )
          ? "Verified"
          : "Invalid";
      } catch {
        return "Unavailable";
      }
    },
  });
}
