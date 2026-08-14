import type { NotificationChannel, NotificationReference } from "./notification.js";
import type {
  CommunicationClass,
  CommunicationTemplate,
} from "../domain/communication-governance.js";
export interface CommunicationHistoryQuery {
  readonly brandReference: NotificationReference;
  readonly actorReference: NotificationReference;
  readonly purpose: "CommunicationSupport";
  readonly permission: "notification.history.read";
  readonly sourceReference: NotificationReference | null;
  readonly recipientReference: NotificationReference | null;
  readonly classification: CommunicationClass | "All";
  readonly channel: NotificationChannel | "All";
  readonly state: "All" | "NotAttempted" | "Delivered" | "Unknown" | "Rejected" | "DeadLettered";
  readonly fromUtc: string | null;
}
export interface CommunicationHistoryProjection {
  readonly projectionName: "notification_communication_history_v1";
  readonly projectionVersion: 1;
  readonly brandReference: NotificationReference;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayResendOperational: boolean;
    readonly mayManageSuppression: boolean;
  };
  readonly rows: readonly {
    readonly requestReference: NotificationReference;
    readonly sourceReference: NotificationReference;
    readonly classification: CommunicationClass;
    readonly recipientMasked: string;
    readonly templateReference: NotificationReference;
    readonly templateVersion: number;
    readonly channel: NotificationChannel;
    readonly providerState: "NotAttempted" | "Delivered" | "Unknown" | "Rejected" | "DeadLettered";
    readonly suppressed: boolean;
    readonly attemptedAt: string | null;
  }[];
}
export interface CommunicationTemplateQuery {
  readonly brandReference: NotificationReference;
  readonly actorReference: NotificationReference;
  readonly purpose: "TemplateAdministration";
  readonly permission: "notification.template.read";
  readonly templateReference: NotificationReference | null;
}
export interface CommunicationTemplateProjection {
  readonly projectionName: "notification_template_admin_v1";
  readonly projectionVersion: 1;
  readonly brandReference: NotificationReference;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayEdit: boolean;
    readonly mayApprove: boolean;
    readonly mayTest: boolean;
  };
  readonly templates: readonly CommunicationTemplate[];
}
