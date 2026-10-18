import { createHash } from "node:crypto";
import { ConsumerRegistry } from "../../contracts/consumer-registry.js";
import type { ConsumerRegistration, ConsumerTransaction } from "../../contracts/consumer-inbox.js";
import type { DomainEventEnvelope } from "../../contracts/domain-event-envelope.js";
import { validateDomainEventEnvelope } from "../../contracts/validate-envelope.js";
/** Freeze registration metadata used by both recovery transport and receipt verification. */
export function createManualOutboxRecoveryRegistry(values: readonly ConsumerRegistration[]) {
  if (values.length === 0 || values.length > 1000)
    throw new Error("MANUAL_RECOVERY_REGISTRY_INVALID");
  const registrations = Object.freeze(
    values
      .map((value) =>
        Object.freeze({
          ...value,
          schemaVersions: Object.freeze([...value.schemaVersions].sort((a, b) => a - b)),
        }),
      )
      .sort((a, b) =>
        a.consumerName < b.consumerName
          ? -1
          : a.consumerName > b.consumerName
            ? 1
            : a.eventType < b.eventType
              ? -1
              : a.eventType > b.eventType
                ? 1
                : 0,
      ),
  );
  new ConsumerRegistry(registrations);
  if (registrations.some((value) => !value.replaySafe))
    throw new Error("MANUAL_RECOVERY_REGISTRY_INVALID");
  const digest =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify(
          registrations.map((value) => [
            value.consumerName,
            value.consumerVersion,
            value.eventType,
            value.schemaVersions,
            value.ownerModule,
            value.tenantScope,
            value.ordering,
            value.sideEffect,
            value.replaySafe,
          ]),
        ),
      )
      .digest("hex");
  const consumersFor = (envelope: DomainEventEnvelope) => {
    validateDomainEventEnvelope(envelope);
    const matches = registrations.filter((value) => value.eventType === envelope.eventType);
    if (
      matches.length === 0 ||
      matches.length > 256 ||
      matches.some(
        (value) =>
          !value.schemaVersions.includes(envelope.schemaVersion) ||
          (value.tenantScope === "store" && envelope.storeId === undefined),
      )
    )
      throw new Error("MANUAL_RECOVERY_REGISTRY_UNAVAILABLE");
    return Object.freeze(matches.map((value) => value.consumerName));
  };
  return Object.freeze({
    digest,
    registrations,
    consumersFor,
    async acknowledged(tx: ConsumerTransaction, envelope: DomainEventEnvelope) {
      const names = consumersFor(envelope);
      const found = await tx.query<{ consumer_name: string }>(
        `SELECT consumer_name FROM platform_eventing.consumer_inbox WHERE event_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND event_type=$4 AND schema_version=$5 AND correlation_id=$6 AND status='completed' AND processed_at IS NOT NULL AND last_error_code IS NULL AND consumer_name=ANY($7::text[])`,
        [
          envelope.eventId,
          envelope.tenantId,
          envelope.storeId ?? null,
          envelope.eventType,
          envelope.schemaVersion,
          envelope.correlationId,
          names,
        ],
      );
      return (
        found.rows.length === names.length &&
        new Set(found.rows.map((row) => row.consumer_name)).size === names.length &&
        found.rows.every((row) => names.includes(row.consumer_name))
      );
    },
  });
}
