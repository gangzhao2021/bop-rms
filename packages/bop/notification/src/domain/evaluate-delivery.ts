export const notificationChannels = ["Email", "SMS", "Push"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];
export type NotificationPurpose = "Transactional" | "Marketing";

export interface RouteSuppressionValue {
  readonly channel: NotificationChannel;
  readonly decision: "Clear" | "Suppressed";
}

export interface NotificationRouteInput {
  readonly purpose: NotificationPurpose;
  readonly requestedChannels: readonly NotificationChannel[];
  readonly preferenceDecision: "Allow" | "Deny";
  readonly preferredChannels: readonly NotificationChannel[];
  readonly suppressions: readonly RouteSuppressionValue[];
}

export type NotificationRouteResult =
  | { readonly outcome: "Accepted"; readonly channels: readonly NotificationChannel[] }
  | {
      readonly outcome: "Suppressed";
      readonly channels: readonly NotificationChannel[];
      readonly reason:
        | "MARKETING_DISABLED"
        | "PREFERENCE_DENIED"
        | "CHANNEL_DISABLED"
        | "CHANNEL_SUPPRESSED"
        | "NO_ELIGIBLE_CHANNEL";
    };

export function evaluateNotificationRoute(input: NotificationRouteInput): NotificationRouteResult {
  if (input.purpose === "Marketing")
    return Object.freeze({
      outcome: "Suppressed",
      channels: Object.freeze([]),
      reason: "MARKETING_DISABLED",
    });
  if (input.preferenceDecision === "Deny")
    return Object.freeze({
      outcome: "Suppressed",
      channels: Object.freeze([]),
      reason: "PREFERENCE_DENIED",
    });
  const requestedAndPreferred = input.requestedChannels.filter((channel) =>
    input.preferredChannels.includes(channel),
  );
  const pilotEnabled = requestedAndPreferred.filter((channel) => channel === "Email");
  if (pilotEnabled.length === 0)
    return Object.freeze({
      outcome: "Suppressed",
      channels: Object.freeze([]),
      reason: requestedAndPreferred.length === 0 ? "NO_ELIGIBLE_CHANNEL" : "CHANNEL_DISABLED",
    });
  const allowed = pilotEnabled.filter(
    (channel) =>
      input.suppressions.find((suppression) => suppression.channel === channel)?.decision ===
      "Clear",
  );
  if (allowed.length === 0)
    return Object.freeze({
      outcome: "Suppressed",
      channels: Object.freeze([]),
      reason: "CHANNEL_SUPPRESSED",
    });
  return Object.freeze({ outcome: "Accepted", channels: Object.freeze(allowed) });
}

export type DeliveryQueryStatus = "NotAttempted" | "AdapterAccepted" | "Rejected" | "Unknown";

export function queryDeliveryStatus(
  attempts: readonly {
    readonly sequence: number;
    readonly outcome: "Accepted" | "Rejected" | "Unknown";
  }[],
): DeliveryQueryStatus {
  if (attempts.length === 0) return "NotAttempted";
  const latest = [...attempts].sort((left, right) => right.sequence - left.sequence).at(0);
  if (latest?.outcome === "Accepted") return "AdapterAccepted";
  if (latest?.outcome === "Rejected") return "Rejected";
  return "Unknown";
}
