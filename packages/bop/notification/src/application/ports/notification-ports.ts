import type {
  NotificationChannel,
  NotificationDeliveryAttempt,
  NotificationPreferenceEvidence,
  NotificationReference,
  NotificationRequest,
  NotificationSuppressionEvidence,
} from "../../contracts/notification.js";
import type { SesEnvironment, SesReadinessEvidence } from "../../contracts/ses-readiness.js";

export interface RegisterNotificationRequestInput {
  readonly idempotencyKey: NotificationReference;
  readonly request: NotificationRequest;
  readonly preferenceEvidenceReference: NotificationReference;
  readonly suppressionEvidenceReferences: readonly NotificationReference[];
}

export interface AppendNotificationAttemptInput {
  readonly idempotencyKey: NotificationReference;
  readonly request: NotificationRequest;
  readonly previousAttempt: NotificationDeliveryAttempt | null;
  readonly attempt: NotificationDeliveryAttempt;
}

export interface NotificationUnitOfWorkPort {
  /**
   * Atomically enforces idempotency and the exact scope + source Event + notification code +
   * recipient + purpose logical deduplication key before storing the immutable request and evidence
   * references. A duplicate logical request returns its original result; conflicting replay fails.
   */
  registerRequest(input: RegisterNotificationRequestInput): Promise<void>;

  /**
   * Atomically enforces idempotency and the next attempt sequence, then appends the immutable
   * attempt. It never edits a previous attempt and never mutates the source business fact.
   */
  appendAttempt(input: AppendNotificationAttemptInput): Promise<void>;
}

export interface ResolveNotificationDestinationInput {
  readonly recipientReference: NotificationReference;
  readonly requestReference: NotificationReference;
  readonly channel: NotificationChannel;
  readonly evaluatedAt: string;
}

export type NotificationDestinationResolution =
  | {
      readonly outcome: "Resolved";
      readonly destinationReference: NotificationReference;
    }
  | {
      readonly outcome: "Unavailable";
      readonly reason: "DESTINATION_UNAVAILABLE" | "DESTINATION_SUPPRESSED";
    };

export interface NotificationDestinationPort {
  resolve(input: ResolveNotificationDestinationInput): Promise<NotificationDestinationResolution>;
}

export interface DeliverNotificationAdapterInput {
  readonly requestReference: NotificationReference;
  readonly attemptReference: NotificationReference;
  readonly channel: NotificationChannel;
  readonly destinationReference: NotificationReference;
  readonly templateReference: string;
  readonly templateVersion: number;
  readonly contentReference: string;
  readonly contentDigest: string;
  readonly locale: string;
  readonly idempotencyKey: NotificationReference;
}

export type DeliverNotificationAdapterResult =
  | {
      readonly outcome: "Accepted";
      readonly providerAttemptReference: NotificationReference;
    }
  | {
      readonly outcome: "Rejected" | "Unknown";
      readonly providerAttemptReference: null;
    };

export interface NotificationDeliveryAdapter {
  deliver(input: DeliverNotificationAdapterInput): Promise<DeliverNotificationAdapterResult>;
}

export interface NotificationPorts {
  readonly unitOfWork: NotificationUnitOfWorkPort;
  readonly destinations: NotificationDestinationPort;
  readonly adapters: Readonly<Record<NotificationChannel, NotificationDeliveryAdapter>>;
  readonly providerReadiness: {
    readonly environment: SesEnvironment;
    loadSesEvidence(): Promise<SesReadinessEvidence | null>;
  };
}

export interface NotificationEvidenceBundle {
  readonly preference: NotificationPreferenceEvidence;
  readonly suppressions: readonly NotificationSuppressionEvidence[];
}
