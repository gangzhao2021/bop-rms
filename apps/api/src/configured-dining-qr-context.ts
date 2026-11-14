import {
  createPostgresDiningPublicTableReader,
  parseDiningReference,
  parseQrSignedPayload,
  parseQrTableContextEvidence,
  type QrSignedPayload,
  type QrTableContextReadPort,
} from "@rms/dining";
import { parseCanonicalInstant } from "@bop/tenant";
import { parseGetPublicStoreRequest } from "@rms/store";
import { createConfiguredPublicStoreResolution } from "./public-store-resolution.js";
export type ConfiguredDiningQrPurpose =
  "CustomerEntry" | "GuestSessionBinding" | "DiningJoin" | "DiningAdmission";
type ResolutionOptions = Parameters<typeof createConfiguredPublicStoreResolution>[0];
export interface ConfiguredDiningQrRegistration {
  readonly payload: QrSignedPayload;
  readonly tableReference: string;
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
 * Public table mapping is server-owned and must have current explicit approval.
 * Signature/key validation is still performed independently by Dining's QR service.
 */
export function createConfiguredDiningQrContext(
  options: ResolutionOptions & {
    evaluatedAt: string;
    purpose?: ConfiguredDiningQrPurpose;

    registration: ConfiguredDiningQrRegistration;
    authorizeRegistration(
      tx: ResolutionOptions["transaction"],
      registration: ConfiguredDiningQrRegistration,
      at: string,
      purpose: ConfiguredDiningQrPurpose,
    ): Promise<boolean>;
  },
): QrTableContextReadPort {
  const at = parseCanonicalInstant(options.evaluatedAt);
  const purpose = options.purpose ?? "CustomerEntry";
  const expected = payload(options.registration.payload);
  const validFrom = parseCanonicalInstant(options.registration.validFrom);
  const validUntil = parseCanonicalInstant(options.registration.validUntil);
  const shape = parseQrTableContextEvidence({
    publicStoreReference: options.binding.publicStoreReference,
    publicTableReference: expected.publicTableReference,
    brandReference: options.binding.brandReference,
    storeReference: options.binding.storeReference,
    tableReference: parseDiningReference(options.registration.tableReference),
    brandLifecycle: "Draft",
    storeLifecycle: "Draft",
    tableLifecycle: "Active",
    assignmentState: "Active",
    channel: "DineIn",
    qrState: options.registration.state,
    revocationVersion: expected.revocationVersion,
    contextEvidenceReference: options.registration.contextEvidenceReference,
    validUntil,
  });
  if (
    expected.channel !== "DineIn" ||
    expected.publicTableReference === null ||
    expected.publicStoreReference !== shape.publicStoreReference ||
    validFrom >= validUntil
  )
    throw new Error("DINING_QR_REGISTRATION_INVALID");
  const registration = Object.freeze({
    payload: expected,
    tableReference: String(shape.tableReference),
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
        if ((await authorize(tx, registration, at, purpose)) !== true) return null;
        const request = parseGetPublicStoreRequest({
          publicStoreReference: expected.publicStoreReference,
          requestedLocale: expected.locale,
          evaluatedAt: at,
          purpose: purpose === "CustomerEntry" ? "CustomerEntry" : "CustomerCart",
        });
        const resolved = await resolver.resolve({
          publicStoreReference: request.publicStoreReference,
          evaluatedAt: request.evaluatedAt,
          purpose: request.purpose,
        });
        if (!resolved || (await authorize(tx, registration, at, purpose)) !== true) return null;
        const table = await createPostgresDiningPublicTableReader({
          transaction: tx,
          scope: {
            tenantReference: options.binding.tenantReference,
            brandReference: options.binding.brandReference,
            storeReference: options.binding.storeReference,
          },
          authorize: async (transaction, request) =>
            request.tableReference === registration.tableReference &&
            (await authorize(transaction, registration, at, purpose)) === true,
        }).read({
          tableReference: registration.tableReference,
          purpose,
          observedAt: at,
        });
        if (
          table === null ||
          table.qrVersion !== expected.revocationVersion ||
          String(table.tableReference) !== registration.tableReference ||
          String(table.brandReference) !== String(shape.brandReference) ||
          String(table.storeReference) !== String(shape.storeReference) ||
          (await authorize(tx, registration, at, purpose)) !== true
        )
          return null;
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
