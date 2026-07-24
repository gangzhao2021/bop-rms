const databaseAccessManifestInput = {
  version: 1,
  module: {
    moduleName: "eventing",
    packageName: "@bop/eventing",
    layer: "BOP",
  },
  tables: [],
  accesses: [
    {
      id: "coordinate-consumer-inbox",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "consumer_inbox",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/consume-event-in-transaction.ts",
    },
    {
      id: "append-outbox-event",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "outbox_event",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/append-event-in-transaction.ts",
    },
    {
      id: "claim-outbox-batch",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "outbox_event",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/dispatch-outbox.ts",
    },
    {
      id: "complete-outbox-delivery",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "outbox_event",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/dispatch-outbox.ts",
    },
    {
      id: "record-delivery-attempt",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "delivery_attempt",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/retry-dead-letter.ts",
    },
    {
      id: "schedule-parked-outbox-retry",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "outbox_event",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/retry-dead-letter.ts",
    },
    {
      id: "coordinate-consumer-retry",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "consumer_retry_schedule",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/retry-dead-letter.ts",
    },
    {
      id: "coordinate-dead-letter-item",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "dead_letter_item",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/retry-dead-letter.ts",
    },
    {
      id: "append-dead-letter-action",
      operation: "write",
      mechanism: "raw-sql",
      target: {
        schema: "platform_eventing",
        table: "dead_letter_action",
      },
      principal: {
        kind: "shared-infrastructure",
        id: "eventing-infrastructure",
      },
      readPattern: null,
      source: "packages/bop/eventing/src/infrastructure/messaging/retry-dead-letter.ts",
    },
  ],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
