import type { DomainEventEnvelope } from "./domain-event-envelope.js";
import type { ConsumerRegistration } from "./consumer-inbox.js";

const name = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/u;
const event = /^[A-Z][A-Za-z0-9]{0,127}$/u;
export class InvalidConsumerRegistryError extends Error {
  constructor(readonly code: "CONSUMER_REGISTRY_INVALID" | "CONSUMER_REGISTRY_DUPLICATE") {
    super(code);
    this.name = "InvalidConsumerRegistryError";
  }
}
export class ConsumerRegistry {
  readonly #items = new Map<string, Map<string, ConsumerRegistration>>();
  constructor(registrations: readonly ConsumerRegistration[]) {
    for (const item of registrations) {
      if (
        typeof item.consumerName !== "string" ||
        !name.test(item.consumerName) ||
        !Number.isInteger(item.consumerVersion) ||
        item.consumerVersion < 1 ||
        !item.consumerName.endsWith(`:v${item.consumerVersion}`) ||
        typeof item.eventType !== "string" ||
        !event.test(item.eventType) ||
        !Array.isArray(item.schemaVersions) ||
        typeof item.ownerModule !== "string" ||
        !/^@(bop|rms)\/[a-z][a-z0-9-]*$/u.test(item.ownerModule) ||
        (item.tenantScope !== "brand" && item.tenantScope !== "store") ||
        (item.ordering !== "aggregate" && item.ordering !== "none") ||
        typeof item.sideEffect !== "string" ||
        !/^[a-z][a-z0-9._-]{0,63}$/u.test(item.sideEffect) ||
        typeof item.replaySafe !== "boolean" ||
        typeof item.handler !== "function" ||
        item.schemaVersions.length === 0 ||
        item.schemaVersions.some((version) => !Number.isInteger(version) || version < 1) ||
        new Set(item.schemaVersions).size !== item.schemaVersions.length
      )
        throw new InvalidConsumerRegistryError("CONSUMER_REGISTRY_INVALID");
      const variants =
        this.#items.get(item.consumerName) ?? new Map<string, ConsumerRegistration>();
      if (variants.has(item.eventType))
        throw new InvalidConsumerRegistryError("CONSUMER_REGISTRY_DUPLICATE");
      const existing = variants.values().next().value as ConsumerRegistration | undefined;
      if (
        existing &&
        (existing.ownerModule !== item.ownerModule ||
          existing.consumerVersion !== item.consumerVersion ||
          existing.tenantScope !== item.tenantScope ||
          existing.ordering !== item.ordering ||
          existing.replaySafe !== item.replaySafe)
      )
        throw new InvalidConsumerRegistryError("CONSUMER_REGISTRY_INVALID");
      variants.set(item.eventType, Object.freeze({ ...item }));
      this.#items.set(item.consumerName, variants);
    }
  }
  resolve(consumerName: string, envelope: DomainEventEnvelope) {
    const variants = this.#items.get(consumerName);
    if (!variants) return { errorCode: "CONSUMER_UNKNOWN" as const };
    const registration = variants.get(envelope.eventType);
    if (!registration) return { errorCode: "EVENT_TYPE_UNSUPPORTED" as const };
    if (!registration.schemaVersions.includes(envelope.schemaVersion))
      return { errorCode: "EVENT_SCHEMA_VERSION_UNSUPPORTED" as const };
    return { registration };
  }
}
