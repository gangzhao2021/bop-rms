export type PaymentMode = "handoff" | "result";

export type PaymentObservation =
  | Readonly<{
      schemaVersion: 1;
      operationReference: string;
      status: "Pending";
    }>
  | Readonly<{
      schemaVersion: 1;
      operationReference: string;
      status: "Unknown";
    }>
  | Readonly<{
      schemaVersion: 1;
      operationReference: string;
      status: "Failed";
      safeReasonCode: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      operationReference: string;
      status: "Succeeded";
      orderReference: string;
    }>;

export type PaymentState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "provider-unavailable" }>
  | Readonly<{ status: "context-missing" }>
  | Readonly<{ status: "offline" }>
  | Readonly<{ status: "pending"; operationReference: string }>
  | Readonly<{
      status: "failed";
      operationReference: string;
      safeReasonCode: string;
    }>
  | Readonly<{
      status: "unknown";
      operationReference: string;
      canRetrySameOperation: true;
    }>
  | Readonly<{
      status: "succeeded";
      operationReference: string;
      orderReference: string;
    }>;
