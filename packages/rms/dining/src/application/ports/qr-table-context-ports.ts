import type {
  PublicKeyReference,
  QrSignedPayload,
  QrTableContextEvidence,
  QrVerificationKeySetEvidence,
} from "../../contracts/qr-table-context.js";

export interface QrKeyRegistryPort {
  load(): Promise<QrVerificationKeySetEvidence>;
}
export interface QrSignatureVerifierPort {
  verify(input: {
    readonly algorithm: "ES256";
    readonly publicKeyReference: PublicKeyReference;
    readonly signingInput: string;
    readonly signature: Uint8Array;
  }): Promise<"Verified" | "Invalid" | "Unavailable">;
}
export interface QrTableContextReadPort {
  resolve(payload: QrSignedPayload): Promise<QrTableContextEvidence | null>;
}
export type QrTelemetryReason =
  "CONTEXT_VERIFIED" | "REQUEST_INVALID" | "QR_UNAVAILABLE" | "DEPENDENCY_UNAVAILABLE";
export interface QrTelemetryPort {
  record(labels: {
    readonly operation: "ResolveQrTableContext";
    readonly outcome: "VERIFIED" | "INVALID_REQUEST" | "QR_UNAVAILABLE";
    readonly reason: QrTelemetryReason;
  }): void;
}
export interface QrTableContextPorts {
  readonly keys: QrKeyRegistryPort;
  readonly verifier: QrSignatureVerifierPort;
  readonly contexts: QrTableContextReadPort;
  readonly telemetry: QrTelemetryPort;
}
