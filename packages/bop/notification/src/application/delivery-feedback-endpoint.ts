import {
  SesSnsEventError,
  createSesSnsEventService,
  type SesSnsEventPorts,
} from "./ses-sns-event-service.js";

export interface DeliveryFeedbackHttpResult {
  readonly status: 200 | 400 | 403 | 413 | 503;
  readonly body: { readonly outcome: string };
}

/**
 * DEC-PILOT-NOTIFICATIONS: the SNS HTTPS subscription endpoint for SES feedback, independent of the
 * HTTP framework. The body is authenticated (SNS signature version 2, exact topic) and stored once
 * before any 2xx; a storage failure answers 503 so SNS redelivers. The response never echoes the
 * payload, and nothing from it is logged.
 */
export function createDeliveryFeedbackEndpoint(
  config: { readonly topicArn: string; readonly retentionPolicyReference: string },
  ports: SesSnsEventPorts,
  clock: { now(): string },
) {
  const service = createSesSnsEventService(config, ports);
  const answer = (status: DeliveryFeedbackHttpResult["status"], outcome: string) =>
    Object.freeze({ status, body: Object.freeze({ outcome }) });
  return Object.freeze({
    async handle(input: {
      readonly body: string;
      readonly messageTypeHeader: string | null;
    }): Promise<DeliveryFeedbackHttpResult> {
      if (input.body.length > 131_072) return answer(413, "rejected");
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.body);
      } catch {
        return answer(400, "rejected");
      }
      if (
        input.messageTypeHeader !== null &&
        (parsed === null ||
          typeof parsed !== "object" ||
          (parsed as Record<string, unknown>).Type !== input.messageTypeHeader)
      )
        return answer(400, "rejected");
      try {
        const result = await service.accept(parsed, clock.now());
        return answer(200, result.outcome);
      } catch (error) {
        if (!(error instanceof SesSnsEventError)) return answer(503, "retry");
        switch (error.code) {
          case "SES_SNS_SIGNATURE_INVALID":
          case "SES_SNS_TOPIC_DENIED":
            return answer(403, "rejected");
          case "SES_SNS_RECIPIENT_DENIED":
            // Feedback for a message this Store did not send: acknowledged, nothing stored.
            return answer(200, "Ignored");
          case "SES_SNS_COMMIT_FAILED":
            return answer(503, "retry");
          default:
            return answer(400, "rejected");
        }
      }
    },
  });
}
