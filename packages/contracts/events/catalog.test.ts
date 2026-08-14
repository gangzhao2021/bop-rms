import { Parser } from "@asyncapi/parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import metricsConfiguration from "./asyncapi-metrics-disabled.json" with { type: "json" };

import {
  defineEventCatalog,
  eventCatalog,
  InvalidEventCatalogError,
  payloadJsonSchema,
  registeredEventMetricLabels,
  type EventCatalogRegistration,
} from "./catalog.ts";
import {
  assertEventCatalogBackwardCompatible,
  createEventCatalogSnapshot,
  EventCatalogCompatibilityError,
} from "./compatibility.ts";
import {
  assertEventConsumerCompatibility,
  defineEventConsumerContracts,
  EventConsumerCompatibilityError,
  eventConsumerContracts,
} from "./consumer-compatibility.ts";
import { renderCatalogArtifacts } from "./render.ts";

const registration = (
  payloadSchema: EventCatalogRegistration["payloadSchema"],
  overrides: Partial<EventCatalogRegistration> = {},
): EventCatalogRegistration => ({
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  ownerModule: "@bop/eventing",
  producerModule: "@bop/eventing",
  stability: "experimental",
  consumers: ["synthetic.projection:v1"],
  tenantScope: "brand",
  dataClassification: "none",
  compatibility: "additive",
  retentionCategory: "operational_short",
  replaySemantics: "idempotent",
  deprecated: false,
  replacement: null,
  payloadSchema,
  ...overrides,
});

describe("Event Catalog source", () => {
  it("registers the authoritative bounded Event facts and metric labels", () => {
    expect(eventCatalog).toHaveLength(66);
    const byType = new Map(eventCatalog.map((entry) => [entry.eventType, entry]));
    expect(byType.get("FulfillmentCompleted")).toMatchObject({
      eventType: "FulfillmentCompleted",
      schemaVersion: 1,
      ownerModule: "@rms/fulfillment",
      producerModule: "@rms/fulfillment",
      consumers: ["ordering.fulfillment-completed:v1"],
      tenantScope: "store",
      dataClassification: "indirect_identifier",
      replaySemantics: "idempotent",
    });
    expect(byType.get("KitchenWorkCreated")).toMatchObject({
      eventType: "KitchenWorkCreated",
      schemaVersion: 1,
      ownerModule: "@rms/kitchen",
      producerModule: "@rms/kitchen",
      stability: "stable",
      consumers: ["kitchen.queue-projection:v1"],
      tenantScope: "store",
      dataClassification: "indirect_identifier",
      compatibility: "additive",
      retentionCategory: "business_record",
      replaySemantics: "idempotent",
      deprecated: false,
      replacement: null,
    });
    for (const [eventType, consumer] of [
      ["KitchenItemCompleted", "kitchen.queue-item-completed-projection:v1"],
      ["KitchenItemProgressRecorded", "kitchen.queue-item-progress-projection:v1"],
      ["KitchenWorkAccepted", "kitchen.queue-work-accepted-projection:v1"],
      ["KitchenWorkStarted", "kitchen.queue-work-started-projection:v1"],
    ] as const) {
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/kitchen",
        producerModule: "@rms/kitchen",
        stability: "stable",
        consumers: [consumer],
        tenantScope: "store",
        dataClassification: "personal",
        compatibility: "additive",
        retentionCategory: "business_record",
        replaySemantics: "idempotent",
        deprecated: false,
        replacement: null,
      });
    }
    for (const [eventType, consumer] of [
      ["KitchenItemReady", "fulfillment.kitchen-item-ready:v1"],
      ["KitchenOrderReady", "fulfillment.kitchen-order-ready:v1"],
    ] as const) {
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/kitchen",
        producerModule: "@rms/kitchen",
        stability: "stable",
        consumers: [consumer],
        tenantScope: "store",
        dataClassification: "indirect_identifier",
        compatibility: "additive",
        retentionCategory: "business_record",
        replaySemantics: "idempotent",
        deprecated: false,
        replacement: null,
      });
    }
    expect(byType.get("MenuPublished")).toMatchObject({
      eventType: "MenuPublished",
      schemaVersion: 1,
      ownerModule: "@rms/catalog",
      consumers: ["catalog.published-menu-projection:v1"],
      tenantScope: "brand",
      replaySemantics: "idempotent",
    });
    for (const eventType of [
      "DataQualityIssueDetected",
      "DataQualityIssueResolved",
      "MetricArchived",
      "MetricCertified",
      "MetricDefinitionDraftRecorded",
      "MetricDefinitionPublished",
      "MetricDefinitionReviewSubmitted",
      "MetricDeprecated",
      "ReconciliationDifferenceDetected",
      "ReportDefinitionArchived",
      "ReportDefinitionDraftCreated",
      "ReportDefinitionDraftReplaced",
      "ReportDefinitionPublished",
      "ReportDefinitionReviewSubmitted",
      "ReportArtifactRevisionRecorded",
      "ReportArtifactRevoked",
      "ReportRunQueued",
      "ReportRunStateRecorded",
      "ReportScheduleVersionRecorded",
    ])
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/business-intelligence",
        tenantScope: "brand",
        dataClassification: "indirect_identifier",
        replaySemantics: "idempotent",
      });
    for (const eventType of [
      "AvailabilityRuleCreated",
      "AvailabilityRuleLifecycleChanged",
      "AvailabilityRuleReplaced",
      "BundleDraftCreated",
      "BundleDraftReplaced",
      "BundleLifecycleChanged",
      "BundleVersionPublished",
    ])
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/catalog",
        tenantScope: "brand",
        dataClassification: "none",
        replaySemantics: "idempotent",
      });
    for (const eventType of [
      "TaxConfigDraftCreated",
      "TaxConfigDraftReplaced",
      "TaxConfigPublished",
    ])
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/pricing",
        tenantScope: "store",
        dataClassification: "none",
        replaySemantics: "idempotent",
      });
    for (const eventType of [
      "PriceBookArchived",
      "PriceBookDraftCreated",
      "PriceBookDraftReplaced",
      "PriceBookVersionPublished",
    ])
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/pricing",
        tenantScope: "brand",
        dataClassification: "none",
        replaySemantics: "idempotent",
      });
    for (const eventType of [
      "PromotionArchived",
      "PromotionDraftCreated",
      "PromotionDraftReplaced",
      "PromotionPaused",
      "PromotionPublished",
    ])
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/pricing",
        tenantScope: "brand",
        dataClassification: "none",
        replaySemantics: "idempotent",
      });
    for (const eventType of [
      "RecipeArchived",
      "RecipeDraftCreated",
      "RecipeDraftReplaced",
      "RecipeInvalidated",
      "RecipePublished",
    ])
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/recipe",
        tenantScope: "brand",
        dataClassification: "none",
        replaySemantics: "idempotent",
      });
    expect(byType.get("OrderConfirmed")).toMatchObject({
      eventType: "OrderConfirmed",
      schemaVersion: 1,
      ownerModule: "@rms/ordering",
      producerModule: "@rms/ordering",
      stability: "stable",
      consumers: ["fulfillment.confirmed-order:v1", "kitchen.confirmed-order:v1"],
      tenantScope: "store",
      dataClassification: "indirect_identifier",
      compatibility: "additive",
      retentionCategory: "business_record",
      replaySemantics: "idempotent",
      deprecated: false,
      replacement: null,
    });
    expect(byType.get("OrderAmended")).toMatchObject({
      eventType: "OrderAmended",
      schemaVersion: 1,
      ownerModule: "@rms/ordering",
      tenantScope: "store",
      dataClassification: "indirect_identifier",
      replaySemantics: "idempotent",
    });
    for (const eventType of [
      "ProductionBatchPlanned",
      "ProductionBatchStarted",
      "ProductionBatchObservationRecorded",
      "ProductionBatchCompleted",
      "ProductionBatchQuarantined",
    ])
      expect(byType.get(eventType)).toMatchObject({
        eventType,
        schemaVersion: 1,
        ownerModule: "@rms/kitchen",
        producerModule: "@rms/kitchen",
        tenantScope: "store",
        dataClassification: "indirect_identifier",
        replaySemantics: "idempotent",
      });
    expect(byType.get("OrderCreated")).toMatchObject({
      eventType: "OrderCreated",
      schemaVersion: 1,
      ownerModule: "@rms/ordering",
      consumers: ["ordering.order-status-projection:v1"],
      tenantScope: "store",
      dataClassification: "indirect_identifier",
      replaySemantics: "idempotent",
    });
    expect(byType.get("PaymentFailed")).toMatchObject({
      eventType: "PaymentFailed",
      ownerModule: "@rms/payment",
      tenantScope: "store",
      dataClassification: "payment",
    });
    expect(byType.get("PaymentRefunded")).toMatchObject({
      eventType: "PaymentRefunded",
      schemaVersion: 1,
      ownerModule: "@rms/payment",
      producerModule: "@rms/payment",
      stability: "stable",
      consumers: ["operations.order-exception:v1", "payment.status-projection:v1"],
      tenantScope: "store",
      dataClassification: "payment",
      compatibility: "additive",
      retentionCategory: "business_record",
      replaySemantics: "idempotent",
      deprecated: false,
      replacement: null,
    });
    expect(byType.get("PaymentSucceeded")).toMatchObject({
      eventType: "PaymentSucceeded",
      ownerModule: "@rms/payment",
      tenantScope: "store",
      dataClassification: "payment",
    });
    expect(registeredEventMetricLabels(eventCatalog)).toEqual([
      "AnalyticsBackfillCompleted:v1",
      "AnalyticsLoadCompleted:v1",
      "AnalyticsLoadFailed:v1",
      "AvailabilityRuleCreated:v1",
      "AvailabilityRuleLifecycleChanged:v1",
      "AvailabilityRuleReplaced:v1",
      "BundleDraftCreated:v1",
      "BundleDraftReplaced:v1",
      "BundleLifecycleChanged:v1",
      "BundleVersionPublished:v1",
      "DataQualityIssueDetected:v1",
      "DataQualityIssueResolved:v1",
      "FulfillmentCompleted:v1",
      "KitchenItemCompleted:v1",
      "KitchenItemProgressRecorded:v1",
      "KitchenItemReady:v1",
      "KitchenOrderReady:v1",
      "KitchenWorkAccepted:v1",
      "KitchenWorkCreated:v1",
      "KitchenWorkStarted:v1",
      "MenuPublished:v1",
      "MetricArchived:v1",
      "MetricCertified:v1",
      "MetricDefinitionDraftRecorded:v1",
      "MetricDefinitionPublished:v1",
      "MetricDefinitionReviewSubmitted:v1",
      "MetricDeprecated:v1",
      "OrderAmended:v1",
      "OrderConfirmed:v1",
      "OrderCreated:v1",
      "PaymentFailed:v1",
      "PaymentRefunded:v1",
      "PaymentSucceeded:v1",
      "PriceBookArchived:v1",
      "PriceBookDraftCreated:v1",
      "PriceBookDraftReplaced:v1",
      "PriceBookVersionPublished:v1",
      "ProductionBatchCompleted:v1",
      "ProductionBatchObservationRecorded:v1",
      "ProductionBatchPlanned:v1",
      "ProductionBatchQuarantined:v1",
      "ProductionBatchStarted:v1",
      "PromotionArchived:v1",
      "PromotionDraftCreated:v1",
      "PromotionDraftReplaced:v1",
      "PromotionPaused:v1",
      "PromotionPublished:v1",
      "RecipeArchived:v1",
      "RecipeDraftCreated:v1",
      "RecipeDraftReplaced:v1",
      "RecipeInvalidated:v1",
      "RecipePublished:v1",
      "ReconciliationDifferenceDetected:v1",
      "ReportArtifactRevisionRecorded:v1",
      "ReportArtifactRevoked:v1",
      "ReportDefinitionArchived:v1",
      "ReportDefinitionDraftCreated:v1",
      "ReportDefinitionDraftReplaced:v1",
      "ReportDefinitionPublished:v1",
      "ReportDefinitionReviewSubmitted:v1",
      "ReportRunQueued:v1",
      "ReportRunStateRecorded:v1",
      "ReportScheduleVersionRecorded:v1",
      "TaxConfigDraftCreated:v1",
      "TaxConfigDraftReplaced:v1",
      "TaxConfigPublished:v1",
    ]);
  });

  it("keeps Data Quality and Reconciliation events minimal and closed", () => {
    const dataQuality = eventCatalog.find(
      (entry) => entry.eventType === "DataQualityIssueDetected",
    );
    const reconciliation = eventCatalog.find(
      (entry) => entry.eventType === "ReconciliationDifferenceDetected",
    );
    if (dataQuality === undefined || reconciliation === undefined)
      throw new Error("EVENT_CATALOG_REGISTRATION_MISSING");
    const detected = {
      resultReference: "018f9910-0000-7000-8000-000000000001",
      checkReference: "018f9910-0000-7000-8000-000000000002",
      checkVersionReference: "018f9910-0000-7000-8000-000000000003",
      datasetVersionReference: "018f9910-0000-7000-8000-000000000004",
      partitionCode: "BUSINESS_DATE_2026_08_14",
      severity: "Critical",
      publicationDisposition: "BlockFormalReporting",
      detectedAt: "2026-08-14T18:00:00.000Z",
    };
    expect(dataQuality.payloadSchema.safeParse(detected).success).toBe(true);
    expect(
      dataQuality.payloadSchema.safeParse({ ...detected, sql: "select private_data" }).success,
    ).toBe(false);
    expect(
      reconciliation.payloadSchema.safeParse({
        exceptionReference: "018f9910-0000-7000-8000-000000000005",
        runReference: "018f9910-0000-7000-8000-000000000006",
        control: "PaymentLedger",
        periodFrom: "2026-08-14T17:00:00.000Z",
        periodUntil: "2026-08-14T18:00:00.000Z",
        unitCode: "CAD",
        detectedAt: "2026-08-14T18:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("keeps lifecycle payloads truthful, minimal and closed", () => {
    const schemaFor = (eventType: string) => {
      const entry = eventCatalog.find((candidate) => candidate.eventType === eventType);
      if (entry === undefined) throw new Error("EVENT_CATALOG_REGISTRATION_MISSING");
      return payloadJsonSchema(entry.payloadSchema);
    };
    const expected = {
      KitchenWorkAccepted: [
        "kitchenTicketReference",
        "kitchenWorkItemReference",
        "orderItemReference",
        "ticketVersion",
        "workItemVersion",
        "workItemStatus",
        "acceptedAt",
      ],
      KitchenWorkStarted: [
        "kitchenTicketReference",
        "kitchenWorkItemReference",
        "orderItemReference",
        "ticketVersion",
        "workItemVersion",
        "fromStatus",
        "toStatus",
        "startedAt",
      ],
      KitchenItemProgressRecorded: [
        "kitchenTicketReference",
        "kitchenWorkItemReference",
        "orderItemReference",
        "ticketVersion",
        "workItemVersion",
        "quantityDelta",
        "completedQuantity",
        "requiredQuantity",
        "fromStatus",
        "toStatus",
        "recordedAt",
      ],
      KitchenItemCompleted: [
        "kitchenTicketReference",
        "kitchenWorkItemReference",
        "orderItemReference",
        "ticketVersion",
        "workItemVersion",
        "quantityDelta",
        "completedQuantity",
        "requiredQuantity",
        "fromStatus",
        "toStatus",
        "completedAt",
      ],
    } as const;
    for (const [eventType, fields] of Object.entries(expected)) {
      const schema = schemaFor(eventType);
      expect(schema).toMatchObject({ additionalProperties: false, type: "object" });
      expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual(
        [...fields].sort(),
      );
      expect([...(schema.required as string[])].sort()).toEqual([...fields].sort());
      expect(JSON.stringify(schema)).not.toMatch(
        /actor|customer|note|health|allergen|admission|expo/iu,
      );
      expect(schema).toMatchObject({
        properties: {
          kitchenTicketReference: {
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            type: "string",
          },
          kitchenWorkItemReference: {
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            type: "string",
          },
          orderItemReference: {
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            type: "string",
          },
        },
      });
    }
    expect(schemaFor("KitchenItemProgressRecorded")).toMatchObject({
      properties: {
        completedQuantity: { maximum: 998, minimum: 1, type: "integer" },
        fromStatus: { const: "In Progress", type: "string" },
        toStatus: { const: "In Progress", type: "string" },
      },
    });
    expect(schemaFor("KitchenItemCompleted")).toMatchObject({
      properties: {
        fromStatus: { const: "In Progress", type: "string" },
        toStatus: { const: "Completed", type: "string" },
      },
    });

    const progress = eventCatalog.find(
      (entry) => entry.eventType === "KitchenItemProgressRecorded",
    );
    const completed = eventCatalog.find((entry) => entry.eventType === "KitchenItemCompleted");
    if (progress === undefined || completed === undefined)
      throw new Error("EVENT_CATALOG_REGISTRATION_MISSING");
    const common = {
      kitchenTicketReference: "018f3000-0000-7000-8000-000000000001",
      kitchenWorkItemReference: "018f3000-0000-7000-8000-000000000002",
      orderItemReference: "018f3000-0000-7000-8000-000000000003",
      ticketVersion: "4",
      workItemVersion: "4",
      quantityDelta: 1,
      completedQuantity: 1,
      requiredQuantity: 2,
      fromStatus: "In Progress",
    } as const;
    expect(
      progress.payloadSchema.safeParse({
        ...common,
        toStatus: "In Progress",
        recordedAt: "2026-08-08T16:00:04.000Z",
      }).success,
    ).toBe(true);
    expect(
      progress.payloadSchema.safeParse({
        ...common,
        kitchenTicketReference: "018f3000-0000-4000-8000-000000000001",
        toStatus: "In Progress",
        recordedAt: "2026-08-08T16:00:04.000Z",
      }).success,
    ).toBe(false);
    expect(
      progress.payloadSchema.safeParse({
        ...common,
        quantityDelta: 2,
        toStatus: "In Progress",
        recordedAt: "2026-08-08T16:00:04.000Z",
      }).success,
    ).toBe(false);
    expect(
      completed.payloadSchema.safeParse({
        ...common,
        completedQuantity: 2,
        toStatus: "Completed",
        completedAt: "2026-08-08T16:00:05.000Z",
      }).success,
    ).toBe(true);
    expect(
      completed.payloadSchema.safeParse({
        ...common,
        toStatus: "Completed",
        completedAt: "2026-08-08T16:00:05.000Z",
      }).success,
    ).toBe(false);
  });

  it("keeps KitchenWorkCreated, OrderConfirmed and PaymentRefunded payloads exact and closed", () => {
    const kitchenWorkCreated = eventCatalog.find(
      (entry) => entry.eventType === "KitchenWorkCreated",
    );
    const orderConfirmed = eventCatalog.find((entry) => entry.eventType === "OrderConfirmed");
    const paymentRefunded = eventCatalog.find((entry) => entry.eventType === "PaymentRefunded");
    if (
      kitchenWorkCreated === undefined ||
      orderConfirmed === undefined ||
      paymentRefunded === undefined
    )
      throw new Error("EVENT_CATALOG_REGISTRATION_MISSING");

    const kitchenWorkCreatedSchema = payloadJsonSchema(kitchenWorkCreated.payloadSchema);
    const orderConfirmedSchema = payloadJsonSchema(orderConfirmed.payloadSchema);
    const paymentRefundedSchema = payloadJsonSchema(paymentRefunded.payloadSchema);

    expect(kitchenWorkCreatedSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        kitchenTicketReference: { format: "uuid", type: "string" },
        orderReference: { format: "uuid", type: "string" },
        orderBatchReference: { format: "uuid", type: "string" },
        confirmationReference: { format: "uuid", type: "string" },
        workItemCount: { maximum: 100, minimum: 1, type: "integer" },
        aggregateVersion: { const: 1, type: "number" },
        createdAt: { format: "date-time", type: "string" },
      },
      required: [
        "kitchenTicketReference",
        "orderReference",
        "orderBatchReference",
        "confirmationReference",
        "workItemCount",
        "aggregateVersion",
        "createdAt",
      ],
      type: "object",
    });
    expect(
      Object.keys(kitchenWorkCreatedSchema.properties as Record<string, unknown>).sort(),
    ).toEqual(
      [
        "kitchenTicketReference",
        "orderReference",
        "orderBatchReference",
        "confirmationReference",
        "workItemCount",
        "aggregateVersion",
        "createdAt",
      ].sort(),
    );

    expect(orderConfirmedSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        confirmationReference: { format: "uuid", type: "string" },
        orderReference: { format: "uuid", type: "string" },
        orderBatchReference: { format: "uuid", type: "string" },
        sourceSnapshotDigest: { pattern: "^sha256:[0-9a-f]{64}$", type: "string" },
        confirmedAt: { format: "date-time", type: "string" },
      },
      required: [
        "confirmationReference",
        "orderReference",
        "orderBatchReference",
        "sourceSnapshotDigest",
        "confirmedAt",
      ],
      type: "object",
    });
    expect(Object.keys(orderConfirmedSchema.properties as Record<string, unknown>).sort()).toEqual(
      [
        "confirmationReference",
        "orderReference",
        "orderBatchReference",
        "sourceSnapshotDigest",
        "confirmedAt",
      ].sort(),
    );

    expect(paymentRefundedSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        refundReference: { format: "uuid", type: "string" },
        compensationCaseReference: { format: "uuid", type: "string" },
        paymentTransactionReference: { format: "uuid", type: "string" },
        paymentIntentReference: { format: "uuid", type: "string" },
        paymentAttemptReference: { format: "uuid", type: "string" },
        orderReference: { format: "uuid", type: "string" },
        amountMinor: { pattern: "^[1-9][0-9]*$", type: "string" },
        currencyCode: { const: "CAD", type: "string" },
        refundKind: { const: "PaidWithoutFulfillableOrderCompensation", type: "string" },
        providerConfirmedAt: { format: "date-time", type: "string" },
      },
      required: [
        "refundReference",
        "compensationCaseReference",
        "paymentTransactionReference",
        "paymentIntentReference",
        "paymentAttemptReference",
        "orderReference",
        "amountMinor",
        "currencyCode",
        "refundKind",
        "providerConfirmedAt",
      ],
      type: "object",
    });
    expect(Object.keys(paymentRefundedSchema.properties as Record<string, unknown>).sort()).toEqual(
      [
        "refundReference",
        "compensationCaseReference",
        "paymentTransactionReference",
        "paymentIntentReference",
        "paymentAttemptReference",
        "orderReference",
        "amountMinor",
        "currencyCode",
        "refundKind",
        "providerConfirmedAt",
      ].sort(),
    );
  });

  it("accepts one exact synthetic registration and returns a bounded label", () => {
    const catalog = defineEventCatalog([registration(z.strictObject({ aggregateId: z.uuid() }))]);
    expect(registeredEventMetricLabels(catalog)).toEqual(["SyntheticChanged:v1"]);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it("fails closed on invalid and duplicate declarations without echoing values", () => {
    const unsafe = "unsafe-event-value";
    expect(() =>
      defineEventCatalog([
        registration(z.strictObject({ aggregateId: z.uuid() }), { eventType: unsafe }),
      ]),
    ).toThrow(InvalidEventCatalogError);
    try {
      defineEventCatalog([
        registration(z.strictObject({ aggregateId: z.uuid() }), { eventType: unsafe }),
      ]);
    } catch (error) {
      expect(String(error)).not.toContain(unsafe);
    }
    expect(() =>
      defineEventCatalog([
        registration(z.strictObject({ aggregateId: z.uuid() })),
        registration(z.strictObject({ aggregateId: z.uuid() })),
      ]),
    ).toThrow("EVENT_CATALOG_DUPLICATE");
  });

  it("rejects examples/defaults/descriptions and remote references in payload schemas", () => {
    expect(() =>
      defineEventCatalog([
        registration(z.strictObject({ token: z.string().default("synthetic-default") })),
      ]),
    ).toThrow("EVENT_CATALOG_SCHEMA_UNSAFE");
    expect(() =>
      defineEventCatalog([
        registration(z.strictObject({ note: z.string().describe("free text") })),
      ]),
    ).toThrow("EVENT_CATALOG_SCHEMA_UNSAFE");
  });
});

describe("Event Catalog compatibility", () => {
  const original = defineEventCatalog([registration(z.strictObject({ aggregateId: z.uuid() }))]);

  it("allows a new optional field or a new Event version", () => {
    const optional = defineEventCatalog([
      registration(z.strictObject({ aggregateId: z.uuid(), sequence: z.int().optional() })),
    ]);
    expect(() =>
      assertEventCatalogBackwardCompatible(
        createEventCatalogSnapshot(original),
        createEventCatalogSnapshot(optional),
      ),
    ).not.toThrow();
    const newVersion = defineEventCatalog([
      ...original,
      registration(z.strictObject({ aggregateId: z.uuid(), sequence: z.int() }), {
        schemaVersion: 2,
      }),
    ]);
    expect(() =>
      assertEventCatalogBackwardCompatible(
        createEventCatalogSnapshot(original),
        createEventCatalogSnapshot(newVersion),
      ),
    ).not.toThrow();
  });

  it.each([
    ["removal", defineEventCatalog([]), "EVENT_REMOVED"],
    [
      "new required field",
      defineEventCatalog([
        registration(z.strictObject({ aggregateId: z.uuid(), sequence: z.int() })),
      ]),
      "NEW_REQUIRED_FIELD",
    ],
    [
      "changed field",
      defineEventCatalog([registration(z.strictObject({ aggregateId: z.string() }))]),
      "FIELD_CHANGED",
    ],
    [
      "changed scope",
      defineEventCatalog([
        registration(z.strictObject({ aggregateId: z.uuid() }), { tenantScope: "store" }),
      ]),
      "METADATA_CHANGED",
    ],
    [
      "removed consumer",
      defineEventCatalog([
        registration(z.strictObject({ aggregateId: z.uuid() }), {
          consumers: ["another.consumer:v1"],
        }),
      ]),
      "METADATA_CHANGED",
    ],
  ])("blocks %s", (_label, next, code) => {
    expect(() =>
      assertEventCatalogBackwardCompatible(
        createEventCatalogSnapshot(original),
        createEventCatalogSnapshot(next),
      ),
    ).toThrow(EventCatalogCompatibilityError);
    expect(() =>
      assertEventCatalogBackwardCompatible(
        createEventCatalogSnapshot(original),
        createEventCatalogSnapshot(next),
      ),
    ).toThrow(code);
  });
});

describe("Event consumer compatibility", () => {
  const firstConsumer = eventConsumerContracts[0];
  if (firstConsumer === undefined) throw new Error("EVENT_CONSUMER_FIXTURE_MISSING");

  it("covers every accepted producer-to-consumer relation exactly", () => {
    expect(eventConsumerContracts).toHaveLength(75);
    expect(() =>
      assertEventConsumerCompatibility(eventCatalog, eventConsumerContracts),
    ).not.toThrow();
  });

  it.each([
    [
      "missing registration",
      eventConsumerContracts.filter(
        (contract) =>
          contract.consumerName !== "ordering.order-status-projection:v1" ||
          contract.eventType !== "OrderCreated",
      ),
      "CONSUMER_CONTRACT_MISSING",
    ],
    [
      "unsupported schema version",
      eventConsumerContracts.map((contract) =>
        contract.consumerName === "ordering.order-status-projection:v1"
          ? { ...contract, schemaVersions: [2] }
          : contract,
      ),
      "CONSUMER_EVENT_INCOMPATIBLE",
    ],
    [
      "scope mismatch",
      eventConsumerContracts.map((contract) =>
        contract.consumerName === "catalog.published-menu-projection:v1"
          ? { ...contract, tenantScope: "store" as const }
          : contract,
      ),
      "CONSUMER_EVENT_INCOMPATIBLE",
    ],
    [
      "unsafe replay declaration",
      eventConsumerContracts.map((contract) =>
        contract.consumerName === "fulfillment.confirmed-order:v1"
          ? { ...contract, replaySafe: false }
          : contract,
      ),
      "CONSUMER_EVENT_INCOMPATIBLE",
    ],
  ])("blocks %s", (_label, contracts, code) => {
    expect(() => assertEventConsumerCompatibility(eventCatalog, contracts)).toThrow(
      EventConsumerCompatibilityError,
    );
    expect(() => assertEventConsumerCompatibility(eventCatalog, contracts)).toThrow(code);
  });

  it("rejects invalid, duplicate and orphaned declarations", () => {
    expect(() =>
      defineEventConsumerContracts([{ ...firstConsumer, consumerName: "catalog.projection" }]),
    ).toThrow("CONSUMER_CONTRACT_INVALID");
    expect(() => defineEventConsumerContracts([firstConsumer, firstConsumer])).toThrow(
      "CONSUMER_CONTRACT_DUPLICATE",
    );
    const orphan = defineEventConsumerContracts([
      ...eventConsumerContracts,
      {
        ...firstConsumer,
        consumerName: "catalog.synthetic-projection:v1",
        eventType: "SyntheticChanged",
      },
    ]);
    expect(() => assertEventConsumerCompatibility(eventCatalog, orphan)).toThrow(
      "CONSUMER_CONTRACT_ORPHANED",
    );
  });
});

describe("Event Catalog generation", () => {
  it("keeps AsyncAPI CLI analytics disabled in repository-owned configuration", () => {
    expect(metricsConfiguration).toEqual({
      analyticsEnabled: "false",
      infoMessageShown: "true",
      userID: "disabled",
    });
  });

  it("is deterministic and contains no host, generation timestamp or transport", async () => {
    const first = renderCatalogArtifacts(eventCatalog);
    const second = renderCatalogArtifacts(eventCatalog);
    expect(first).toEqual(second);
    expect(first.asyncApi).toContain('"asyncapi": "3.0.0"');
    expect(first.asyncApi).not.toMatch(/server|broker|2026-|SyntheticChanged/u);
    expect(first.asyncApi).toContain("KitchenItemCompleted");
    expect(first.asyncApi).toContain("KitchenItemProgressRecorded");
    expect(first.asyncApi).toContain("KitchenWorkAccepted");
    expect(first.asyncApi).toContain("KitchenWorkCreated");
    expect(first.asyncApi).toContain("KitchenWorkStarted");
    expect(first.asyncApi).toContain("MenuPublished");
    expect(first.asyncApi).toContain("OrderConfirmed");
    expect(first.asyncApi).toContain("OrderCreated");
    expect(first.asyncApi).toContain("PaymentFailed");
    expect(first.asyncApi).toContain("PaymentRefunded");
    expect(first.asyncApi).toContain("PaymentSucceeded");
    expect(first.markdown).toContain("KitchenWorkCreated");
    expect(first.markdown).toContain("KitchenItemCompleted");
    expect(first.markdown).toContain("KitchenItemProgressRecorded");
    expect(first.markdown).toContain("KitchenWorkAccepted");
    expect(first.markdown).toContain("KitchenWorkStarted");
    expect(first.markdown).toContain("MenuPublished");
    expect(first.markdown).toContain("OrderConfirmed");
    expect(first.markdown).toContain("OrderCreated");
    expect(first.markdown).toContain("PaymentFailed");
    expect(first.markdown).toContain("PaymentRefunded");
    expect(first.markdown).toContain("PaymentSucceeded");
  });

  it("passes the official parser with no error diagnostics", async () => {
    const parser = new Parser();
    const { document, diagnostics } = await parser.parse(
      renderCatalogArtifacts(eventCatalog).asyncApi,
    );
    expect(document).toBeDefined();
    expect(diagnostics.filter(({ severity }) => severity === 0)).toEqual([]);
  }, 15_000);
});
