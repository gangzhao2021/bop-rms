import path from "node:path";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import {
  NotificationContractError,
  ReceiptEmailTemplateError,
  createContactDigester,
  createCustomerOrderMessaging,
  createCustomerOrderNotificationService,
  createDeliveryFeedbackEndpoint,
  createHttpsSnsCertificateFetch,
  createPostgresCustomerOrderNotificationRecords,
  createPostgresDeliveryFeedbackStore,
  createSnsSignatureVerifier,
  parseContactDigestKeys,
  parseCustomerOrderMessagingSettings,
} from "../../packages/bop/notification/src/index.ts";
import {
  buildOrderRecoveryLink,
  createOrderRecoveryAbuseKey,
  createOrderRecoveryService,
  createOrderRecoveryTokenHasher,
  createPostgresOrderRecoveryStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  loadOrderGuestSession,
  loadOrderReceiptEmail,
} from "../../packages/rms/ordering/src/index.ts";
import { parsePaymentSucceededEnvelope } from "../../packages/rms/payment/src/index.ts";
import { parseKitchenReadyEnvelope } from "../../packages/rms/kitchen/src/index.ts";
import { createAbuseBudgetConsumer } from "../../packages/database/src/index.ts";
import { readPilotSecret } from "./pilot-ops-config.mjs";
import { readPrivateJson } from "./pilot-ops-files.mjs";
import { isPilotRuntime } from "./pilot-environment.mjs";

/** Runtime-directory file selecting the order-message providers; absent = everything disabled. */
export const NOTIFICATION_CONFIG_FILE = "notification.json";
/** Opaque retention-policy reference for provider feedback evidence (transactional, v1). */
const feedbackRetentionPolicyReference = "0192a000-2423-7000-8000-000000000001";

/**
 * DEC-PILOT-NOTIFICATIONS (2026-10-20): composes customer order messages for one pilot Store.
 * Shared by the API (options, one-time order link, SES feedback endpoint) and the business worker
 * (OrderPlaced/PickupReady consumers). With `notification.json` absent or both channels
 * `disabled` (today), nothing is offered, minted, sent or recorded.
 */
export async function createPilotOrderMessaging({
  resources,
  directory,
  loadRecoveryKeys,
  readSecret = readPilotSecret,
  transports,
  fetchCertificate = createHttpsSnsCertificateFetch(),
}) {
  const settings = parseCustomerOrderMessagingSettings(
    await readPrivateJson(path.join(directory, NOTIFICATION_CONFIG_FILE)),
  );
  // Secrets are read once (owner-only files) and handed to the adapters; never logged.
  const secretNames = [
    settings.contactDigestKeyFile,
    ...[settings.email, settings.sms].flatMap((channel) =>
      channel.provider === "disabled" ? [] : [channel.accessKeyIdFile, channel.secretAccessKeyFile],
    ),
  ].filter((name) => name !== null);
  const secrets = new Map();
  for (const name of new Set(secretNames)) secrets.set(name, await readSecret(directory, name));
  const readLoaded = (name) => {
    const value = secrets.get(name);
    if (value === undefined) throw new Error("PILOT_NOTIFICATION_SECRET_UNAVAILABLE");
    return value;
  };
  const messaging = createCustomerOrderMessaging(settings, {
    readSecret: readLoaded,
    ...(transports === undefined ? {} : { transports }),
  });
  const availability = () =>
    Object.freeze({ sms: messaging.sms !== null, email: messaging.email !== null });
  const sending = messaging.sms !== null || messaging.email !== null;
  const digester =
    settings.contactDigestKeyFile === null
      ? null
      : createContactDigester(parseContactDigestKeys(readLoaded(settings.contactDigestKeyFile)));
  const reference = () => resources.credentials.reference();
  const feedbackStore =
    digester === null
      ? null
      : createPostgresDeliveryFeedbackStore(resources.transactions, resources.scope, {
          digester,
          references: { generate: reference },
          clock: { now: resources.now },
        });

  // R1: Identity-owned one-time order recovery.
  const keys = await loadRecoveryKeys();
  const recovery = createOrderRecoveryService({
    hasher: createOrderRecoveryTokenHasher(keys.peppers),
    store: createPostgresOrderRecoveryStore(resources.transactions, resources.scope),
    budget: {
      async consume({ orderReference, peerAddress, observedAt }) {
        const key = createOrderRecoveryAbuseKey(keys.abuse)(orderReference, peerAddress);
        const result = await createAbuseBudgetConsumer({
          bucketClass: "ORDER_RESUME",
          windowSeconds: 3600,
          limitCount: 5,
          now: () => observedAt,
          query: async (sql, values) => {
            const connection = await resources.database.acquire();
            try {
              return await connection.query(sql, [...values]);
            } finally {
              connection.release();
            }
          },
        }).consume(key);
        return result.allowed
          ? { status: "Allowed" }
          : { status: "RateLimited", retryAfterSeconds: result.retry_after_seconds };
      },
    },
    credentials: resources.credentials.sessions,
    references: { generate: reference },
    clock: { now: resources.now },
  });
  const mintOrderLink = async ({ orderReference, attemptReference }) => {
    if (settings.customerOrigin === null) return null;
    const session = await resources.transactions.run((tx) =>
      loadOrderGuestSession(tx, resources.scope, orderReference),
    );
    if (session === null) return null;
    const minted = await recovery.mint({
      orderReference,
      guestSessionReference: session,
      notificationAttemptReference: attemptReference,
    });
    return minted === null ? null : buildOrderRecoveryLink(settings.customerOrigin, minted.token);
  };

  const feedback =
    settings.email.provider === "ses" && feedbackStore !== null && messaging.snsPort !== null
      ? createDeliveryFeedbackEndpoint(
          {
            topicArn: settings.email.feedbackTopicArn,
            retentionPolicyReference: feedbackRetentionPolicyReference,
          },
          {
            signatures: createSnsSignatureVerifier({
              fetchCertificate,
              clock: { now: resources.now },
            }),
            recipients: {
              resolveTransactional: (input) => feedbackStore.resolveTransactional(input),
            },
            inbox: { acceptAndApply: (input) => feedbackStore.acceptAndApply(input) },
            subscriptions: {
              confirmExactTopic: async ({ topicArn, token }) => {
                await messaging.snsPort.confirmSubscription({
                  TopicArn: topicArn,
                  Token: token,
                  AuthenticateOnUnsubscribe: "true",
                });
              },
            },
          },
          { now: resources.now },
        )
      : undefined;

  const notification = createCustomerOrderNotificationService({
    messaging,
    records: createPostgresCustomerOrderNotificationRecords(
      resources.transactions,
      resources.scope,
    ),
    clock: { now: resources.now },
    references: { generateNotification: reference },
    ...(feedbackStore === null
      ? {}
      : {
          suppression: {
            isSuppressed: (channel, destination) =>
              feedbackStore.isSuppressed(channel, destination),
          },
        }),
  });

  return Object.freeze({
    settings,
    sending,
    availability,
    recovery: (input) => recovery.consume(input),
    mintOrderLink,
    feedback,
    notification: Object.freeze({
      availability,
      notify: (input) => notification.notify(input),
    }),
    /** "Email my receipt": the original receipt, once per Order, when email can send. */
    async sendReceiptEmail(orderReference) {
      const found = await resources.transactions.run((tx) =>
        loadOrderReceiptEmail(tx, resources.scope, orderReference),
      );
      if (found.status === "NotRequested" || found.status === "Removed")
        return { status: "Skipped" };
      // The receipt consumer issues it from the same event; retry until it exists.
      if (found.status === "ReceiptPending") throw new Error("RECEIPT_EMAIL_RECEIPT_PENDING");
      return notification.sendReceiptEmail({
        brandReference: resources.scope.brandReference,
        storeReference: resources.scope.storeReference,
        orderReference,
        email: found.email,
        contactDetailsReference: found.detailsReference,
        contactDetailsVersion: found.detailsVersion,
        receipt: receiptEmailInput(found.receipt),
      });
    },
  });
}

/** Maps the issued receipt snapshot to the owned email template's typed input (CAD only). */
export function receiptEmailInput(snapshot) {
  const cad = (money) => {
    if (money.currencyCode !== "CAD")
      throw new NotificationContractError("NOTIFICATION_INPUT_INVALID");
    return money.amountMinor;
  };
  return {
    locale: snapshot.locale === "fr-CA" ? "fr-CA" : "en-CA",
    storeDisplayName: snapshot.storeDisplayName,
    orderNumber: snapshot.orderNumber,
    issuedAt: snapshot.issuedAt,
    lines: snapshot.lines.map((line) => ({
      displayName: line.displayName,
      quantity: line.quantity,
      amountMinor: cad(line.lineSubtotal ?? line.lineTotal),
      currencyCode: "CAD",
    })),
    ...(snapshot.adjustments === undefined
      ? {}
      : {
          adjustments: {
            discountMinor: cad(snapshot.adjustments.discount),
            feeMinor: cad(snapshot.adjustments.fee),
          },
        }),
    subtotalMinor: cad(snapshot.subtotal),
    taxMinor: cad(snapshot.tax),
    tipMinor: cad(snapshot.tip),
    totalMinor: cad(snapshot.total),
    currencyCode: "CAD",
  };
}

/**
 * Business-worker consumers: `PaymentSucceeded` → "we have your order", `KitchenOrderReady` →
 * "your order is ready". Registered only when a channel can send. Each send is once per Order and
 * purpose (append-only attempt), so a redelivered or replayed event never messages twice.
 */
export function createInternalCustomerOrderMessageConsumers(
  resources,
  { orderMessaging, createTrigger },
) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_NOTIFICATION_ONLY");
  if (!orderMessaging.sending) return [];
  const trigger = createTrigger({
    scope: resources.scope,
    transactions: resources.transactions,
    storeDisplayName: async () => {
      const result = await resources.stores.getPublicStore({
        publicStoreReference: resources.publicProfile.binding.publicStoreReference,
        evaluatedAt: resources.now(),
        purpose: "CustomerEntry",
        requestedLocale: "en-CA",
      });
      return result.status === "Available" && typeof result.profile?.storeDisplayName === "string"
        ? result.profile.storeDisplayName
        : resources.store.displayName;
    },
    notification: orderMessaging.notification,
    orderLink: orderMessaging.mintOrderLink,
  });
  const authorized = (event) => {
    if (
      event.tenantId !== resources.scope.brandReference ||
      event.storeId !== resources.scope.storeReference ||
      resources.now() >= resources.publicProfile.binding.validUntil
    )
      throw new Error("INTERNAL_NOTIFICATION_SCOPE_DENIED");
    return event;
  };
  const consumer = (eventType, consumerName, parse, send) => {
    const registration = Object.freeze({
      consumerName,
      consumerVersion: 1,
      eventType,
      schemaVersions: [1],
      ownerModule: "@bop/notification",
      tenantScope: "store",
      ordering: "none",
      sideEffect: "send_customer_order_message",
      replaySafe: true,
      handler: async ({ envelope }) => {
        const event = authorized(parse(envelope));
        if (event.eventType !== eventType) throw new Error("INTERNAL_NOTIFICATION_SCOPE_DENIED");
        try {
          await send({ orderReference: String(event.payload.orderReference) });
        } catch (error) {
          // A contact that can never be messaged (malformed) is not retried; anything else is.
          if (
            error instanceof NotificationContractError ||
            error instanceof ReceiptEmailTemplateError
          )
            return { status: "completed" };
          throw error;
        }
        return { status: "completed" };
      },
    });
    return {
      registration,
      consume: (transaction, value) =>
        consumeEventInTransaction(transaction, registration, authorized(parse(value))),
    };
  };
  return [
    ...(orderMessaging.availability().email
      ? [
          consumer(
            "PaymentSucceeded",
            "notification.customer-receipt-email:v1",
            parsePaymentSucceededEnvelope,
            ({ orderReference }) => orderMessaging.sendReceiptEmail(orderReference),
          ),
        ]
      : []),
    consumer(
      "PaymentSucceeded",
      "notification.customer-order-placed:v1",
      parsePaymentSucceededEnvelope,
      trigger.onPaymentSucceeded,
    ),
    consumer(
      "KitchenOrderReady",
      "notification.customer-order-ready:v1",
      parseKitchenReadyEnvelope,
      trigger.onKitchenOrderReady,
    ),
  ];
}
