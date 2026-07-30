import type {
  GetPublicStoreRequest,
  PublicStoreResolutionEvidence,
} from "../../contracts/public-store-profile.js";

export interface PublicStoreResolutionPort {
  resolve(
    request: Readonly<
      Pick<GetPublicStoreRequest, "publicStoreReference" | "evaluatedAt" | "purpose">
    >,
  ): Promise<PublicStoreResolutionEvidence | null>;
}

export interface PublicStoreProfileReadPort {
  loadCandidates(input: {
    readonly brandReference: string;
    readonly storeReference: string;
  }): Promise<unknown>;
}

export const publicStoreTelemetryOutcomes = [
  "AVAILABLE",
  "INVALID_REQUEST",
  "STORE_UNAVAILABLE",
] as const;
export type PublicStoreTelemetryOutcome = (typeof publicStoreTelemetryOutcomes)[number];
export const publicStoreTelemetryReasons = [
  "PROFILE_AVAILABLE",
  "REQUEST_INVALID",
  "SCOPE_UNAVAILABLE",
  "PROFILE_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
] as const;
export type PublicStoreTelemetryReason = (typeof publicStoreTelemetryReasons)[number];

export interface PublicStoreTelemetryPort {
  record(labels: {
    readonly operation: "GetPublicStore";
    readonly outcome: PublicStoreTelemetryOutcome;
    readonly reason: PublicStoreTelemetryReason;
  }): void;
}

export interface PublicStoreProfilePorts {
  readonly resolution: PublicStoreResolutionPort;
  readonly profiles: PublicStoreProfileReadPort;
  readonly telemetry: PublicStoreTelemetryPort;
}
