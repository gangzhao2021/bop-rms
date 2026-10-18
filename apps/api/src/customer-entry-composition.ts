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
  type StoreOperatingStatus,
} from "@rms/store";
import type { CustomerEntryPort, CustomerEntryPortInput } from "./customer-entry.js";

export interface CustomerEntryAdmissionInput extends Omit<CustomerEntryPortInput, "qrToken"> {
  readonly context: QrTableContext;
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
}

export interface CustomerEntryOperatingReader {
  readCurrent(input: {
    brandReference: string;
    storeReference: string;
    publicStoreReference: string;
    evaluatedAt: string;
  }): Promise<
    | (Pick<StoreOperatingStatus, "state" | "availableServiceModes"> & {
        brandReference: string;
        storeReference: string;
        evaluatedAt: string;
        /** WP-2423 Q4: today's published hours, when the reader provides them. */
        todayHours?: readonly {
          startLocalTime: string;
          endLocalTime: string;
          endsNextDay: boolean;
        }[];
      })
    | null
  >;
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
  options:
    | CustomerEntryCompositionOptions
    | (Omit<CustomerEntryCompositionOptions, "operating"> & {
        operatingReader: CustomerEntryOperatingReader;
      }),
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
        let operatingStatus: Pick<StoreOperatingStatus, "state" | "availableServiceModes">;
        let todayHours: readonly {
          startLocalTime: string;
          endLocalTime: string;
          endsNextDay: boolean;
        }[] = [];
        if ("operatingReader" in options) {
          const current = await options.operatingReader.readCurrent({
            ...scope,
            publicStoreReference: query.publicStoreReference,
            evaluatedAt: requestedAt,
          });
          if (!current || !sameScope(current) || current.evaluatedAt !== requestedAt)
            return unavailable;
          operatingStatus = current;
          todayHours = current.todayHours ?? [];
        } else {
          const operating = await createStoreOperatingStatusService({
            ...options.operating,
            resolution: {
              async resolve(request) {
                const resolved = await options.operating.resolution.resolve(request);
                return resolved !== null && sameScope(resolved) ? resolved : null;
              },
            },
          }).getStoreOperatingStatus(query);
          if (operating.status !== "Available") return unavailable;
          operatingStatus = operating.operatingStatus;
        }
        if (
          operatingStatus.state !== "Open" ||
          !operatingStatus.availableServiceModes.includes(qr.context.channel)
        )
          return Object.freeze({
            status: "NotAccepting" as const,
            storeDisplayName: profile.profile.storeDisplayName,
            operatingState: operatingStatus.state,
            todayHours,
          });

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
          operatingState: operatingStatus.state,
          availableServiceModes: operatingStatus.availableServiceModes,
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
