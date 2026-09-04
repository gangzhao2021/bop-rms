import {
  GuestSessionService,
  parseCanonicalInstant,
  parseGuestAdmissionEvidence,
  parseGuestEntryRequestReference,
  parseGuestOperationReference,
  type GuestAdmissionEvidence,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  createQrTableContextService,
  parseQrTableContextEvidence,
  type QrTableContext,
  type QrTableContextEvidence,
  type QrTableContextPorts,
} from "@rms/dining";
import {
  createPublicStoreProfileService,
  createStoreOperatingStatusService,
  type PublicStoreProfilePorts,
  type StoreOperatingStatusPorts,
} from "@rms/store";
import type { CustomerEntryPort, CustomerEntryPortInput } from "./customer-entry.js";

export interface CustomerEntryAdmissionInput extends Omit<CustomerEntryPortInput, "qrToken"> {
  readonly context: QrTableContext;
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
}

export interface CustomerEntryCompositionOptions {
  readonly qr: QrTableContextPorts;
  readonly profile: PublicStoreProfilePorts;
  readonly operating: StoreOperatingStatusPorts;
  // The environment must atomically consume this request's proof and apply its abuse policy.
  readonly admission: {
    consume(input: CustomerEntryAdmissionInput): Promise<GuestAdmissionEvidence | null>;
  };
  readonly session: Pick<GuestSessionServiceOptions, "binding" | "store" | "credentials">;
}

const unavailable = Object.freeze({ status: "EntryUnavailable" } as const);

export function createCustomerEntryComposition(
  options: CustomerEntryCompositionOptions,
): CustomerEntryPort {
  return Object.freeze({
    async establish(input: CustomerEntryPortInput) {
      try {
        const entryRequestReference = parseGuestEntryRequestReference(input.entryRequestReference);
        const operationReference = parseGuestOperationReference(input.operationReference);
        const requestedAt = parseCanonicalInstant(input.requestedAt);
        if (String(entryRequestReference) === String(operationReference)) return unavailable;

        // Capture only within this invocation, then let Dining validate the complete QR context.
        const captured: { evidence: QrTableContextEvidence | null } = { evidence: null };
        const qrService = createQrTableContextService({
          ...options.qr,
          contexts: {
            async resolve(payload) {
              const raw = await options.qr.contexts.resolve(payload);
              if (raw === null) return null;
              captured.evidence = parseQrTableContextEvidence(raw);
              return captured.evidence;
            },
          },
        });
        const qr = await qrService.resolveQrTableContext({
          qrToken: input.qrToken,
          evaluatedAt: requestedAt,
          purpose: "CustomerEntry",
        });
        if (qr.status !== "Verified" || captured.evidence === null) return unavailable;
        const evidence = captured.evidence;
        const scope = Object.freeze({
          brandReference: String(evidence.brandReference),
          storeReference: String(evidence.storeReference),
        });
        const sameScope = (value: { brandReference: string; storeReference: string }) =>
          value.brandReference === scope.brandReference &&
          value.storeReference === scope.storeReference;
        const query = {
          publicStoreReference: qr.context.publicStoreReference,
          evaluatedAt: requestedAt,
          purpose: "CustomerEntry" as const,
        };
        const profile = await createPublicStoreProfileService({
          ...options.profile,
          resolution: {
            async resolve(request) {
              const resolved = await options.profile.resolution.resolve(request);
              return resolved !== null && sameScope(resolved) ? resolved : null;
            },
          },
        }).getPublicStore({ ...query, requestedLocale: qr.context.locale });
        if (profile.status !== "Available") return unavailable;
        const operating = await createStoreOperatingStatusService({
          ...options.operating,
          resolution: {
            async resolve(request) {
              const resolved = await options.operating.resolution.resolve(request);
              return resolved !== null && sameScope(resolved) ? resolved : null;
            },
          },
        }).getStoreOperatingStatus(query);
        if (
          operating.status !== "Available" ||
          operating.operatingStatus.state !== "Open" ||
          !operating.operatingStatus.availableServiceModes.includes(qr.context.channel)
        )
          return unavailable;

        const admitted = parseGuestAdmissionEvidence(
          await options.admission.consume(
            Object.freeze({
              entryRequestReference,
              operationReference,
              requestedAt,
              context: qr.context,
              scope,
            }),
          ),
        );
        if (
          admitted.entryRequestReference !== entryRequestReference ||
          !sameScope(admitted) ||
          String(admitted.publicStoreReference) !== String(qr.context.publicStoreReference) ||
          String(admitted.publicTableReference) !== String(qr.context.publicTableReference) ||
          admitted.channel !== qr.context.channel ||
          String(admitted.locale) !== String(qr.context.locale) ||
          String(admitted.qrReference) !== String(qr.context.qrReference) ||
          admitted.qrRevocationVersion !== qr.context.revocationVersion ||
          Date.parse(admitted.evaluatedAt) > Date.parse(requestedAt) ||
          Date.parse(admitted.validUntil) <= Date.parse(requestedAt)
        )
          return unavailable;

        let consumed = false;
        const session = await new GuestSessionService({
          ...options.session,
          admission: {
            async consume(command) {
              if (
                consumed ||
                command.entryRequestReference !== entryRequestReference ||
                command.operationReference !== operationReference ||
                command.requestedAt !== requestedAt
              )
                return null;
              consumed = true;
              return admitted;
            },
          },
        }).create({ entryRequestReference, operationReference, requestedAt });
        if (session.status !== "Issued") return unavailable;
        const contextExpiresAt = new Date(
          Math.min(
            Date.parse(qr.context.expiresAt),
            Date.parse(evidence.validUntil),
            Date.parse(admitted.validUntil),
            Date.parse(session.session.idleExpiresAt),
            Date.parse(session.session.absoluteExpiresAt),
          ),
        ).toISOString();
        return Object.freeze({
          status: "Established" as const,
          brandDisplayName: profile.profile.brandDisplayName,
          storeDisplayName: profile.profile.storeDisplayName,
          publicStoreReference: String(qr.context.publicStoreReference),
          publicTableReference: qr.context.publicTableReference,
          channel: qr.context.channel,
          operatingState: operating.operatingStatus.state,
          availableServiceModes: operating.operatingStatus.availableServiceModes,
          locale: String(qr.context.locale),
          contextExpiresAt,
          sessionCredential: session.sessionCredential,
          csrfCredential: session.csrfCredential,
          cookie: session.cookie,
        });
      } catch {
        return unavailable;
      }
    },
  });
}
