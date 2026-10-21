import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import type {
  CustomerOrderMessage,
  CustomerOrderMessageProviderPort,
} from "../../contracts/customer-order-message.js";
import { NotificationContractError } from "../../contracts/notification.js";
import { headerSafe, isDefinitiveProviderRefusal, providerMessageId } from "./provider-errors.js";
import type { ProviderCredentials } from "./provider-configuration.js";

/** The one SESv2 call the adapter makes; tests inject a local fake. */
export interface SesV2SendPort {
  sendEmail(input: SendEmailCommandInput): Promise<{ readonly MessageId?: string | undefined }>;
}

export interface SesEmailAdapterConfiguration {
  readonly region: "ca-central-1";
  /** Verified sender address on the authenticated domain (DKIM/SPF/DMARC, see the runbook). */
  readonly fromAddress: string;
  /** Shown as the sender name, e.g. the Store's public name. */
  readonly fromDisplayName: string;
  /**
   * SES configuration set that publishes Bounce/Complaint (and Delivery) events to the SNS topic.
   * It must have open/click tracking disabled (IDR-0027 revision 1).
   */
  readonly configurationSetName: string;
}

// SES v2 refusals: the request reached SES and it declined; nothing was queued for delivery.
const sesRefusals = new Set([
  "MessageRejected",
  "BadRequestException",
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "NotFoundException",
  "LimitExceededException",
  "TooManyRequestsException",
]);
const emailAddress = /^[^\s@"<>,;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/u;
const configurationSet = /^[A-Za-z0-9_-]{1,64}$/u;
const fail = (): never => {
  throw new NotificationContractError("NOTIFICATION_INPUT_INVALID");
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Accessible HTML alternative of the plain text: escaped, inline, no images, scripts or tracking. */
export function renderCustomerOrderEmailHtml(text: string): string {
  return (
    '<!doctype html><html lang="en-CA"><head><meta charset="utf-8"></head>' +
    '<body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111111">' +
    `<p>${escapeHtml(text)}</p></body></html>`
  );
}

export function parseSesEmailAdapterConfiguration(value: SesEmailAdapterConfiguration) {
  if (
    value.region !== "ca-central-1" ||
    !emailAddress.test(value.fromAddress) ||
    !headerSafe(value.fromDisplayName, 80) ||
    /["\\<>]/u.test(value.fromDisplayName) ||
    !configurationSet.test(value.configurationSetName)
  )
    return fail();
  return Object.freeze({ ...value });
}

/** Real SESv2 transport: one attempt only (no SDK retry after an ambiguous failure), bounded time. */
export function createAwsSesV2SendPort(options: {
  readonly region: "ca-central-1";
  readonly credentials: ProviderCredentials | null;
  readonly requestTimeoutMs: number;
}): SesV2SendPort {
  const client = new SESv2Client({
    region: options.region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: Math.min(options.requestTimeoutMs, 5_000),
      requestTimeout: options.requestTimeoutMs,
    },
    ...(options.credentials === null ? {} : { credentials: options.credentials }),
  });
  return Object.freeze({
    sendEmail: (input: SendEmailCommandInput) => client.send(new SendEmailCommand(input)),
  });
}

/**
 * Amazon SES v2 adapter for customer order email (transactional only). One recipient per send, a
 * non-sensitive subject, plain text plus an escaped HTML alternative, no tracking. The idempotency
 * key travels as a message tag so a provider event can be matched to the attempt without the
 * address. An explicit refusal is `Rejected`; anything ambiguous is thrown (`Unknown`).
 */
export function createSesEmailAdapter(
  configuration: SesEmailAdapterConfiguration,
  transport: SesV2SendPort,
): CustomerOrderMessageProviderPort {
  const config = parseSesEmailAdapterConfiguration(configuration);
  return Object.freeze({
    channel: "Email" as const,
    async send(message: CustomerOrderMessage) {
      if (
        message.channel !== "Email" ||
        !emailAddress.test(message.destination) ||
        message.subject === null ||
        !headerSafe(message.subject, 160) ||
        message.text.length < 1 ||
        message.text.length > 20_000 ||
        (message.html !== undefined && message.html !== null && message.html.length > 100_000)
      )
        return fail();
      let result;
      try {
        result = await transport.sendEmail({
          FromEmailAddress: `"${config.fromDisplayName}" <${config.fromAddress}>`,
          Destination: { ToAddresses: [message.destination] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: message.text, Charset: "UTF-8" },
                Html: {
                  Data: message.html ?? renderCustomerOrderEmailHtml(message.text),
                  Charset: "UTF-8",
                },
              },
            },
          },
          ConfigurationSetName: config.configurationSetName,
          EmailTags: [
            { Name: "purpose", Value: "customer-order" },
            { Name: "notification", Value: message.idempotencyKey },
          ],
        });
      } catch (error) {
        if (isDefinitiveProviderRefusal(error, sesRefusals))
          return Object.freeze({ outcome: "Rejected" as const });
        throw new Error("SES_SEND_OUTCOME_UNKNOWN", { cause: error });
      }
      const id = providerMessageId(result.MessageId);
      if (id === null) throw new Error("SES_SEND_OUTCOME_UNKNOWN");
      return Object.freeze({ outcome: "Accepted" as const, providerMessageReference: id });
    },
  });
}
