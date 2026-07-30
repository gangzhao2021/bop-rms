import type {
  GetStoreOperatingStatusRequest,
  StoreOperatingStatusResolutionEvidence,
} from "../../contracts/store-operating-status.js";

export interface StoreOperatingStatusResolutionPort {
  resolve(
    request: Readonly<
      Pick<GetStoreOperatingStatusRequest, "publicStoreReference" | "evaluatedAt" | "purpose">
    >,
  ): Promise<StoreOperatingStatusResolutionEvidence | null>;
}

export interface StoreOperatingConfigurationReadPort {
  loadCandidates(input: {
    readonly brandReference: string;
    readonly storeReference: string;
  }): Promise<unknown>;
}

export const storeOperatingTelemetryOutcomes = [
  "AVAILABLE",
  "INVALID_REQUEST",
  "STORE_UNAVAILABLE",
] as const;
export type StoreOperatingTelemetryOutcome = (typeof storeOperatingTelemetryOutcomes)[number];

export const storeOperatingTelemetryReasons = [
  "STATUS_AVAILABLE",
  "REQUEST_INVALID",
  "SCOPE_UNAVAILABLE",
  "CONFIGURATION_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
] as const;
export type StoreOperatingTelemetryReason = (typeof storeOperatingTelemetryReasons)[number];

export interface StoreOperatingTelemetryPort {
  record(labels: {
    readonly operation: "GetStoreOperatingStatus";
    readonly outcome: StoreOperatingTelemetryOutcome;
    readonly reason: StoreOperatingTelemetryReason;
  }): void;
}

export interface StoreOperatingStatusPorts {
  readonly resolution: StoreOperatingStatusResolutionPort;
  readonly configurations: StoreOperatingConfigurationReadPort;
  readonly telemetry: StoreOperatingTelemetryPort;
}
