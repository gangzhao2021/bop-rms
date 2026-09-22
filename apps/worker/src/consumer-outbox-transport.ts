import type { ConsumerOutcome, OutboxTransportAdapter } from "@bop/eventing";
import type { ConsumerDeliveryWorker } from "./consumer-delivery.js";

/** Local durable delivery: acknowledge only after every configured Inbox has committed. */
export function createConsumerOutboxTransport(options: {
  readonly delivery: Pick<ConsumerDeliveryWorker, "deliver">;
  readonly subscriptions: readonly {
    readonly eventType: string;
    readonly consumerNames: readonly string[];
  }[];
}): OutboxTransportAdapter {
  const routes = new Map<string, readonly string[]>();
  for (const subscription of options.subscriptions) {
    if (
      !/^[A-Z][A-Za-z0-9]{0,127}$/u.test(subscription.eventType) ||
      routes.has(subscription.eventType) ||
      subscription.consumerNames.length === 0 ||
      new Set(subscription.consumerNames).size !== subscription.consumerNames.length ||
      subscription.consumerNames.some(
        (name) => !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/u.test(name),
      )
    )
      throw new TypeError("OUTBOX_CONSUMER_SUBSCRIPTIONS_INVALID");
    routes.set(subscription.eventType, Object.freeze([...subscription.consumerNames]));
  }
  return Object.freeze<OutboxTransportAdapter>({
    async publish(envelope, context) {
      const names = routes.get(envelope.eventType);
      if (!names) return { status: "failed", errorCode: "TRANSPORT_REJECTED" };
      let failure: "TRANSPORT_UNAVAILABLE" | "TRANSPORT_REJECTED" | undefined;
      for (const name of names) {
        let outcome: ConsumerOutcome;
        try {
          outcome = await options.delivery.deliver(name, envelope, context.attemptCount);
        } catch {
          failure ??= "TRANSPORT_UNAVAILABLE";
          continue;
        }
        if (outcome.status === "rejected") failure = "TRANSPORT_REJECTED";
        else if (outcome.status !== "processed" && outcome.status !== "duplicate_completed")
          failure ??= "TRANSPORT_UNAVAILABLE";
      }
      return failure === undefined
        ? { status: "acknowledged" }
        : { status: "failed", errorCode: failure };
    },
  });
}
