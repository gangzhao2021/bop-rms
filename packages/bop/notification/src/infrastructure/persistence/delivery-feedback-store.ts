import { createHmac } from "node:crypto";
import type { CustomerOrderMessageChannel } from "../../contracts/customer-order-message.js";
import {
  NotificationContractError,
  parseNotificationInstant,
  parseNotificationReference,
  type NotificationReference,
} from "../../contracts/notification.js";
import type { NormalizedSesEvent } from "../../application/ses-sns-event-service.js";

interface Transaction {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}
const fail = (): never => {
  throw new NotificationContractError("NOTIFICATION_INPUT_INVALID");
};
const rows = (value: unknown): readonly Record<string, unknown>[] => {
  const found: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")?.value
      : undefined;
  return Array.isArray(found) ? (found as Record<string, unknown>[]) : fail();
};
const rowCount = (value: unknown): number => {
  const count: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rowCount")?.value
      : undefined;
  return typeof count === "number" ? count : fail();
};

/** One versioned, purpose-separated key for contact digests (held in a secret file, never in SQL). */
export interface ContactDigestKey {
  readonly version: number;
  readonly key: Uint8Array;
}

/**
 * Keyed digest of a destination for the suppression list. The newest key writes; every listed key
 * is checked on read so a key rotation never silently forgets a suppression.
 */
export function createContactDigester(keys: readonly ContactDigestKey[]) {
  if (
    keys.length < 1 ||
    keys.some((k) => !Number.isSafeInteger(k.version) || k.version < 1 || k.key.byteLength < 32) ||
    new Set(keys.map((k) => k.version)).size !== keys.length
  )
    return fail();
  const ordered = [...keys].sort((a, b) => b.version - a.version);
  const normalize = (channel: CustomerOrderMessageChannel, destination: string) =>
    channel === "Email" ? destination.trim().toLowerCase() : destination.trim();
  const digest = (key: ContactDigestKey, channel: CustomerOrderMessageChannel, value: string) =>
    `hmac-sha256:v${key.version}:${createHmac("sha256", key.key)
      .update(`bop-notification-suppression\u0000${channel}\u0000${normalize(channel, value)}`)
      .digest("hex")}`;
  return Object.freeze({
    current: (channel: CustomerOrderMessageChannel, destination: string) =>
      digest(ordered[0] as ContactDigestKey, channel, destination),
    all: (channel: CustomerOrderMessageChannel, destination: string) =>
      ordered.map((key) => digest(key, channel, destination)),
  });
}
export type ContactDigester = ReturnType<typeof createContactDigester>;

/**
 * DEC-PILOT-NOTIFICATIONS: Inbox, suppression list and delivery issues for one Store scope. The
 * provider event is stored once; a duplicate delivery from SNS is acknowledged without new effects.
 */
export function createPostgresDeliveryFeedbackStore(
  runner: { run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> },
  scope: { readonly brandReference: string; readonly storeReference: string },
  options: {
    readonly digester: ContactDigester;
    readonly references: { generate(): string };
    readonly clock: { now(): string };
  },
) {
  const brand = parseNotificationReference(scope.brandReference),
    store = parseNotificationReference(scope.storeReference);
  const scoped = (tx: Transaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  return Object.freeze({
    /** SES feedback names the address and SES message id; only an email we sent resolves. */
    async resolveTransactional(input: {
      readonly destination: string;
      readonly providerMessageId: string;
    }): Promise<{
      readonly recipientReference: NotificationReference;
      readonly purpose: "Transactional";
      readonly suppressionDigest: string;
    } | null> {
      const found = await runner.run(async (tx) => {
        await scoped(tx);
        return rows(
          await tx.query(
            "SELECT o.notification_id::text AS id FROM bop_notification.customer_order_notification_outcome o " +
              "JOIN bop_notification.customer_order_notification_attempt a USING (notification_id,brand_id,store_id) " +
              "WHERE o.brand_id=$1 AND o.store_id=$2 AND o.provider_message_reference=$3 AND a.channel='Email' LIMIT 1",
            [brand, store, input.providerMessageId],
          ),
        );
      });
      const id = found[0]?.id;
      if (typeof id !== "string") return null;
      return Object.freeze({
        recipientReference: parseNotificationReference(id),
        purpose: "Transactional" as const,
        suppressionDigest: options.digester.current("Email", input.destination),
      });
    },
    async acceptAndApply(input: {
      readonly event: NormalizedSesEvent;
      readonly suppression: "None" | "Immediate";
      readonly createOperationalCase: boolean;
      readonly suppressionDigest?: string;
    }): Promise<"Accepted" | "Duplicate"> {
      const event = input.event;
      const immediate = input.suppression === "Immediate";
      if (immediate && input.suppressionDigest === undefined) return fail();
      return runner.run(async (tx) => {
        await scoped(tx);
        const inserted = await tx.query(
          "INSERT INTO bop_notification.delivery_provider_event " +
            "(provider_event_id,brand_id,store_id,notification_id,provider_message_reference,event_type,occurred_at,accepted_at) " +
            "VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz) ON CONFLICT (provider_event_id) DO NOTHING",
          [
            event.providerEventId,
            brand,
            store,
            event.recipientReference,
            event.providerMessageId,
            event.eventType,
            event.occurredAt,
            event.acceptedAt,
          ],
        );
        if (rowCount(inserted) === 0) return "Duplicate" as const;
        const at = parseNotificationInstant(options.clock.now());
        if (immediate && (event.eventType === "HardBounce" || event.eventType === "Complaint")) {
          await tx.query(
            "INSERT INTO bop_notification.contact_suppression " +
              "(suppression_id,brand_id,store_id,channel,destination_digest,reason,provider_event_id,created_at) " +
              "VALUES ($1,$2,$3,'Email',$4,$5,$6::uuid,$7::timestamptz) ON CONFLICT ON CONSTRAINT contact_suppression_once DO NOTHING",
            [
              parseNotificationReference(options.references.generate()),
              brand,
              store,
              input.suppressionDigest,
              event.eventType,
              event.providerEventId,
              at,
            ],
          );
        }
        if (
          input.createOperationalCase &&
          (event.eventType === "HardBounce" || event.eventType === "Complaint")
        )
          await tx.query(
            "INSERT INTO bop_notification.delivery_issue_case (case_id,brand_id,store_id,provider_event_id,kind,opened_at) " +
              "VALUES ($1,$2,$3,$4::uuid,$5,$6::timestamptz)",
            [
              parseNotificationReference(options.references.generate()),
              brand,
              store,
              event.providerEventId,
              event.eventType,
              at,
            ],
          );
        return "Accepted" as const;
      });
    },
    /** True when the address (any key version) is on this Store's suppression list. */
    async isSuppressed(channel: CustomerOrderMessageChannel, destination: string) {
      const digests = options.digester.all(channel, destination);
      const found = await runner.run(async (tx) => {
        await scoped(tx);
        return rows(
          await tx.query(
            "SELECT 1 FROM bop_notification.contact_suppression WHERE brand_id=$1 AND store_id=$2 AND channel=$3 " +
              "AND destination_digest = ANY($4::text[]) LIMIT 1",
            [brand, store, channel, digests],
          ),
        );
      });
      return found.length > 0;
    },
  });
}
