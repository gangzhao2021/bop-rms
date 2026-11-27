import type { CustomerOrderMessagingConfiguration } from "../../contracts/customer-order-message.js";
import { NotificationContractError } from "../../contracts/notification.js";
import {
  createAwsSesV2SendPort,
  createSesEmailAdapter,
  parseSesEmailAdapterConfiguration,
  type SesEmailAdapterConfiguration,
  type SesV2SendPort,
} from "./ses-email-adapter.js";
import {
  createAwsSnsPort,
  createSnsSmsAdapter,
  parseSnsSmsAdapterConfiguration,
  type SnsPort,
  type SnsSmsAdapterConfiguration,
} from "./sns-sms-adapter.js";

export interface ProviderCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * DEC-PILOT-NOTIFICATIONS: which provider sends each channel. `disabled` (the default and the
 * pilot's current state) means the channel is absent: nothing is sent or recorded and the customer
 * never sees an option that depends on it. Secret values are referenced by file name only.
 */
export interface CustomerOrderMessagingSettings {
  readonly email:
    | { readonly provider: "disabled" }
    | (SesEmailAdapterConfiguration & {
        readonly provider: "ses";
        /** SNS topic that receives the configuration set's Bounce/Complaint/Delivery events. */
        readonly feedbackTopicArn: string;
        readonly accessKeyIdFile: string | null;
        readonly secretAccessKeyFile: string | null;
      });
  readonly sms:
    | { readonly provider: "disabled" }
    | (SnsSmsAdapterConfiguration & {
        readonly provider: "sns";
        readonly accessKeyIdFile: string | null;
        readonly secretAccessKeyFile: string | null;
      });
  /** Customer origin for the one-time order link (`https://<host>/resume#t=…`). */
  readonly customerOrigin: string | null;
  /** Secret file with the hex key for suppression-list digests (required when any channel sends). */
  readonly contactDigestKeyFile: string | null;
}

const disabled = Object.freeze({ provider: "disabled" as const });
export const disabledCustomerOrderMessagingSettings: CustomerOrderMessagingSettings = Object.freeze(
  {
    email: disabled,
    sms: disabled,
    customerOrigin: null,
    contactDigestKeyFile: null,
  },
);

const fail = (): never => {
  throw new NotificationContractError("NOTIFICATION_INPUT_INVALID");
};
const fileName = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const topicArn = /^arn:aws:sns:ca-central-1:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/u;
const origin = /^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u;

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const optionalFile = (value: unknown): string | null =>
  value === undefined || value === null
    ? null
    : typeof value === "string" && fileName.test(value)
      ? value
      : fail();

/** Parses `notification.json`. An absent file means everything disabled. */
export function parseCustomerOrderMessagingSettings(
  value: unknown,
): CustomerOrderMessagingSettings {
  if (value === undefined || value === null) return disabledCustomerOrderMessagingSettings;
  const raw = object(value, [
    "schemaVersion",
    "email",
    "sms",
    "customerOrigin",
    "contactDigestKeyFile",
  ]);
  if (raw.schemaVersion !== 1) return fail();
  const emailRaw = object(raw.email ?? disabled, [
    "provider",
    "region",
    "fromAddress",
    "fromDisplayName",
    "configurationSetName",
    "feedbackTopicArn",
    "accessKeyIdFile",
    "secretAccessKeyFile",
  ]);
  const smsRaw = object(raw.sms ?? disabled, [
    "provider",
    "region",
    "originationNumber",
    "accessKeyIdFile",
    "secretAccessKeyFile",
  ]);
  let email: CustomerOrderMessagingSettings["email"];
  if (emailRaw.provider === "disabled") {
    if (Object.keys(emailRaw).length !== 1) return fail();
    email = disabled;
  } else if (emailRaw.provider === "ses") {
    const adapter = parseSesEmailAdapterConfiguration({
      region: emailRaw.region as "ca-central-1",
      fromAddress: emailRaw.fromAddress as string,
      fromDisplayName: emailRaw.fromDisplayName as string,
      configurationSetName: emailRaw.configurationSetName as string,
    });
    if (typeof emailRaw.feedbackTopicArn !== "string" || !topicArn.test(emailRaw.feedbackTopicArn))
      return fail();
    email = Object.freeze({
      provider: "ses" as const,
      ...adapter,
      feedbackTopicArn: emailRaw.feedbackTopicArn,
      accessKeyIdFile: optionalFile(emailRaw.accessKeyIdFile),
      secretAccessKeyFile: optionalFile(emailRaw.secretAccessKeyFile),
    });
  } else return fail();
  let sms: CustomerOrderMessagingSettings["sms"];
  if (smsRaw.provider === "disabled") {
    if (Object.keys(smsRaw).length !== 1) return fail();
    sms = disabled;
  } else if (smsRaw.provider === "sns") {
    const adapter = parseSnsSmsAdapterConfiguration({
      region: smsRaw.region as "ca-central-1",
      originationNumber: smsRaw.originationNumber as string,
    });
    sms = Object.freeze({
      provider: "sns" as const,
      ...adapter,
      accessKeyIdFile: optionalFile(smsRaw.accessKeyIdFile),
      secretAccessKeyFile: optionalFile(smsRaw.secretAccessKeyFile),
    });
  } else return fail();
  for (const channel of [email, sms])
    if (
      channel.provider !== "disabled" &&
      (channel.accessKeyIdFile === null) !== (channel.secretAccessKeyFile === null)
    )
      return fail();
  const customerOrigin =
    raw.customerOrigin === undefined || raw.customerOrigin === null
      ? null
      : typeof raw.customerOrigin === "string" && origin.test(raw.customerOrigin)
        ? raw.customerOrigin
        : fail();
  const contactDigestKeyFile = optionalFile(raw.contactDigestKeyFile);
  const sending = email.provider !== "disabled" || sms.provider !== "disabled";
  if (sending && contactDigestKeyFile === null) return fail();
  return Object.freeze({ email, sms, customerOrigin, contactDigestKeyFile });
}

/** Reads a secret by file name from the runtime directory (owner-only file; never logged). */
export type ReadProviderSecret = (fileName: string) => string;

function credentials(
  channel: { readonly accessKeyIdFile: string | null; readonly secretAccessKeyFile: string | null },
  readSecret: ReadProviderSecret,
): ProviderCredentials | null {
  if (channel.accessKeyIdFile === null || channel.secretAccessKeyFile === null) return null;
  const accessKeyId = readSecret(channel.accessKeyIdFile);
  const secretAccessKey = readSecret(channel.secretAccessKeyFile);
  if (
    !/^[A-Z0-9]{16,128}$/u.test(accessKeyId) ||
    !/^[A-Za-z0-9/+=]{20,128}$/u.test(secretAccessKey)
  )
    return fail();
  return Object.freeze({ accessKeyId, secretAccessKey });
}

/**
 * Builds the provider ports from the settings. Credentials are optional: without them the AWS SDK
 * default chain (instance/task role) is used. Tests pass local fakes through `transports`.
 */
export function createCustomerOrderMessaging(
  settings: CustomerOrderMessagingSettings,
  options: {
    readonly readSecret: ReadProviderSecret;
    readonly requestTimeoutMs?: number;
    readonly transports?: { readonly ses?: SesV2SendPort; readonly sns?: SnsPort };
  },
): CustomerOrderMessagingConfiguration & { readonly snsPort: SnsPort | null } {
  const timeout = options.requestTimeoutMs ?? 10_000;
  const email =
    settings.email.provider === "ses"
      ? createSesEmailAdapter(
          settings.email,
          options.transports?.ses ??
            createAwsSesV2SendPort({
              region: settings.email.region,
              credentials: credentials(settings.email, options.readSecret),
              requestTimeoutMs: timeout,
            }),
        )
      : null;
  const snsCredentialsOwner =
    settings.sms.provider === "sns"
      ? settings.sms
      : settings.email.provider === "ses"
        ? settings.email
        : null;
  const snsPort =
    snsCredentialsOwner === null
      ? null
      : (options.transports?.sns ??
        createAwsSnsPort({
          region: "ca-central-1",
          credentials: credentials(snsCredentialsOwner, options.readSecret),
          requestTimeoutMs: timeout,
        }));
  const sms =
    settings.sms.provider === "sns" && snsPort !== null
      ? createSnsSmsAdapter(settings.sms, snsPort)
      : null;
  return Object.freeze({ email, sms, snsPort });
}

/** Contact-digest key: one line `v<N>:<64+ hex>` (newest) — older versions may follow after `,`. */
export function parseContactDigestKeys(secret: string) {
  const keys = secret.split(",").map((part) => {
    const match = /^v([1-9][0-9]{0,5}):([0-9a-f]{64,128})$/u.exec(part.trim());
    if (!match) return fail();
    return Object.freeze({
      version: Number(match[1]),
      key: Uint8Array.from(Buffer.from(match[2] as string, "hex")),
    });
  });
  return Object.freeze(keys);
}
