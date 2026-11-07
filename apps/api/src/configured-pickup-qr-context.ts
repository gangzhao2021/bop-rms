import {
  parseQrSignedPayload,
  parseQrTableContextEvidence,
  type QrSignedPayload,
  type QrTableContextReadPort,
} from "@rms/dining";
import { parseCanonicalInstant } from "@bop/tenant";
import { parseGetPublicStoreRequest } from "@rms/store";
import { createConfiguredPublicStoreResolution } from "./public-store-resolution.js";
type ResolutionOptions = Parameters<typeof createConfiguredPublicStoreResolution>[0];
export interface ConfiguredPickupQrRegistration {
  readonly payload: QrSignedPayload;
  readonly state: "Enabled" | "Revoked";
  readonly contextEvidenceReference: string;
  readonly validFrom: string;
  readonly validUntil: string;
}
function payload(value: QrSignedPayload) {
  return parseQrSignedPayload(Buffer.from(JSON.stringify(value)).toString("base64url"));
}
/** A configured registration is not approval evidence by itself. The caller must
 * fence current registration authorization and Tenant association in this transaction.
 * Signature/key validation is still performed independently by Dining's QR service.
 */
export function createConfiguredPickupQrContext(
  options: ResolutionOptions & {
    evaluatedAt: string;
    purpose?: "CustomerEntry" | "CustomerCart";
    registration: ConfiguredPickupQrRegistration;
    authorizeRegistration(
      tx: ResolutionOptions["transaction"],
      registration: ConfiguredPickupQrRegistration,
      at: string,
    ): Promise<boolean>;
  },
): QrTableContextReadPort {
  const at = parseCanonicalInstant(options.evaluatedAt);
  const expected = payload(options.registration.payload);
  const validFrom = parseCanonicalInstant(options.registration.validFrom);
  const validUntil = parseCanonicalInstant(options.registration.validUntil);
  const shape = parseQrTableContextEvidence({
    publicStoreReference: options.binding.publicStoreReference,
    publicTableReference: null,
    brandReference: options.binding.brandReference,
    storeReference: options.binding.storeReference,
    tableReference: null,
    brandLifecycle: "Draft",
    storeLifecycle: "Draft",
    tableLifecycle: null,
    assignmentState: null,
    channel: "Pickup",
    qrState: options.registration.state,
    revocationVersion: expected.revocationVersion,
    contextEvidenceReference: options.registration.contextEvidenceReference,
    validUntil,
  });
  if (
    expected.channel !== "Pickup" ||
    expected.publicTableReference !== null ||
    expected.publicStoreReference !== shape.publicStoreReference ||
    validFrom >= validUntil
  )
    throw new Error("PICKUP_QR_REGISTRATION_INVALID");
  const registration = Object.freeze({
    payload: expected,
    state: shape.qrState,
    contextEvidenceReference: shape.contextEvidenceReference,
    validFrom,
    validUntil,
  });
  const resolver = createConfiguredPublicStoreResolution(options);
  const authorize = options.authorizeRegistration;
  const tx = options.transaction;
  return Object.freeze({
    async resolve(input: QrSignedPayload) {
      try {
        if (
          registration.state !== "Enabled" ||
          at < validFrom ||
          at >= validUntil ||
          expected.issuedAt > at ||
          at >= expected.expiresAt ||
          JSON.stringify(payload(input)) !== JSON.stringify(expected)
        )
          return null;
        if ((await authorize(tx, registration, at)) !== true) return null;
        const request = parseGetPublicStoreRequest({
          publicStoreReference: expected.publicStoreReference,
          requestedLocale: expected.locale,
          evaluatedAt: at,
          purpose: options.purpose ?? "CustomerEntry",
        });
        const resolved = await resolver.resolve({
          publicStoreReference: request.publicStoreReference,
          evaluatedAt: request.evaluatedAt,
          purpose: request.purpose,
        });
        if (!resolved || (await authorize(tx, registration, at)) !== true) return null;
        const until = [validUntil, resolved.validUntil, expected.expiresAt].sort()[0];
        return parseQrTableContextEvidence({
          ...shape,
          brandLifecycle: resolved.brandLifecycle,
          storeLifecycle: resolved.storeLifecycle,
          validUntil: until,
        });
      } catch {
        return null;
      }
    },
  });
}
