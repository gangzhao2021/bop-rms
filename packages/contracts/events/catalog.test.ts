import { Parser } from "@asyncapi/parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import metricsConfiguration from "./asyncapi-metrics-disabled.json" with { type: "json" };

import {
  defineEventCatalog,
  eventCatalog,
  InvalidEventCatalogError,
  registeredEventMetricLabels,
  type EventCatalogRegistration,
} from "./catalog.ts";
import {
  assertEventCatalogBackwardCompatible,
  createEventCatalogSnapshot,
  EventCatalogCompatibilityError,
} from "./compatibility.ts";
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
    expect(eventCatalog).toHaveLength(2);
    expect(eventCatalog[0]).toMatchObject({
      eventType: "MenuPublished",
      schemaVersion: 1,
      ownerModule: "@rms/catalog",
      consumers: ["catalog.published-menu-projection:v1"],
      tenantScope: "brand",
      replaySemantics: "idempotent",
    });
    expect(eventCatalog[1]).toMatchObject({
      eventType: "OrderCreated",
      schemaVersion: 1,
      ownerModule: "@rms/ordering",
      consumers: ["ordering.order-status-projection:v1"],
      tenantScope: "store",
      dataClassification: "indirect_identifier",
      replaySemantics: "idempotent",
    });
    expect(registeredEventMetricLabels(eventCatalog)).toEqual([
      "MenuPublished:v1",
      "OrderCreated:v1",
    ]);
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
    expect(first.asyncApi).toContain("MenuPublished");
    expect(first.asyncApi).toContain("OrderCreated");
    expect(first.markdown).toContain("MenuPublished");
    expect(first.markdown).toContain("OrderCreated");
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
