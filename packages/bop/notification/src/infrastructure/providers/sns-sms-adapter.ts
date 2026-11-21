import {
  ConfirmSubscriptionCommand,
  PublishCommand,
  SNSClient,
  type PublishCommandInput,
} from "@aws-sdk/client-sns";
import type {
  CustomerOrderMessage,
  CustomerOrderMessageProviderPort,
} from "../../contracts/customer-order-message.js";
import { NotificationContractError } from "../../contracts/notification.js";
import { isDefinitiveProviderRefusal, providerMessageId } from "./provider-errors.js";
import type { ProviderCredentials } from "./provider-configuration.js";

/** The SNS calls the notification module makes; tests inject a local fake. */
export interface SnsPort {
  publish(input: PublishCommandInput): Promise<{ readonly MessageId?: string | undefined }>;
  confirmSubscription(input: {
    readonly TopicArn: string;
    readonly Token: string;
    readonly AuthenticateOnUnsubscribe: "true";
  }): Promise<unknown>;
}

export interface SnsSmsAdapterConfiguration {
  readonly region: "ca-central-1";
  /**
   * The registered origination number (E.164) the store's texts come from — in Canada a toll-free
   * or short code registered in AWS End User Messaging SMS (see the runbook).
   */
  readonly originationNumber: string;
  /** Maximum USD the account may spend per month is set on the AWS account, not here. */
}

const e164 = /^\+[1-9][0-9]{6,14}$/u;
const nanpa = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
const snsRefusals = new Set([
  "InvalidParameterException",
  "InvalidParameterValueException",
  "AuthorizationErrorException",
  "OptedOutException",
  "ThrottledException",
  "KMSAccessDeniedException",
  "EndpointDisabledException",
  "ValidationException",
]);
const fail = (): never => {
  throw new NotificationContractError("NOTIFICATION_INPUT_INVALID");
};

export function parseSnsSmsAdapterConfiguration(value: SnsSmsAdapterConfiguration) {
  if (value.region !== "ca-central-1" || !e164.test(value.originationNumber)) return fail();
  return Object.freeze({ ...value });
}

/** Real SNS transport: one attempt only (no SDK retry after an ambiguous failure), bounded time. */
export function createAwsSnsPort(options: {
  readonly region: "ca-central-1";
  readonly credentials: ProviderCredentials | null;
  readonly requestTimeoutMs: number;
}): SnsPort {
  const client = new SNSClient({
    region: options.region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: Math.min(options.requestTimeoutMs, 5_000),
      requestTimeout: options.requestTimeoutMs,
    },
    ...(options.credentials === null ? {} : { credentials: options.credentials }),
  });
  return Object.freeze({
    publish: (input: PublishCommandInput) => client.send(new PublishCommand(input)),
    confirmSubscription: (input: {
      readonly TopicArn: string;
      readonly Token: string;
      readonly AuthenticateOnUnsubscribe: "true";
    }) => client.send(new ConfirmSubscriptionCommand({ ...input })),
  });
}

/**
 * Amazon SNS SMS adapter (transactional texts in Canada/US numbers only, the pilot's market). The
 * message is plain text; the carrier opt-out (STOP) list is enforced by AWS. An explicit refusal is
 * `Rejected`; anything ambiguous is thrown so the attempt is recorded `Unknown`.
 */
export function createSnsSmsAdapter(
  configuration: SnsSmsAdapterConfiguration,
  transport: SnsPort,
): CustomerOrderMessageProviderPort {
  const config = parseSnsSmsAdapterConfiguration(configuration);
  return Object.freeze({
    channel: "Sms" as const,
    async send(message: CustomerOrderMessage) {
      if (
        message.channel !== "Sms" ||
        !nanpa.test(message.destination) ||
        message.text.length < 1 ||
        message.text.length > 640
      )
        return fail();
      let result;
      try {
        result = await transport.publish({
          PhoneNumber: message.destination,
          Message: message.text,
          MessageAttributes: {
            "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
            "AWS.MM.SMS.OriginationNumber": {
              DataType: "String",
              StringValue: config.originationNumber,
            },
          },
        });
      } catch (error) {
        if (isDefinitiveProviderRefusal(error, snsRefusals))
          return Object.freeze({ outcome: "Rejected" as const });
        throw new Error("SNS_SMS_OUTCOME_UNKNOWN", { cause: error });
      }
      const id = providerMessageId(result.MessageId);
      if (id === null) throw new Error("SNS_SMS_OUTCOME_UNKNOWN");
      return Object.freeze({ outcome: "Accepted" as const, providerMessageReference: id });
    },
  });
}
