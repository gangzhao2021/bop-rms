import { describe, expect, it } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";

import {
  CatalogError,
  buildPublishedMenuProjection,
  createMenuPublishedEnvelope,
  createPublishedMenuProjectionService,
  type MenuPublishedEnvelope,
  type PublishedMenuProjection,
  type PublishedMenuProjectionPorts,
  type PublishedMenuSnapshot,
} from "../index.js";

const id = (n: number) => `018f7300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const at = "2026-08-02T16:00:00.000Z";
function envelope(version = 4n): MenuPublishedEnvelope {
  return {
    eventId: id(1),
    eventType: "MenuPublished",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/catalog",
    tenantId: id(2),
    aggregateType: "Menu",
    aggregateId: id(3),
    aggregateVersion: version,
    correlationId: id(4),
    causationId: id(5),
    actor: { type: "Actor", actorId: id(6) },
    payload: {
      menuReference: id(3),
      menuVersionReference: id(7),
      releaseReference: id(8),
      snapshotDigest: digest,
      effectiveFrom: at,
      effectiveUntil: null,
      timeZone: "UTC",
    },
    redactionClassification: "none",
    replayMetadata: { replaySafe: true },
  };
}
function snapshot(): PublishedMenuSnapshot {
  return {
    brandReference: id(2) as never,
    menuReference: id(3) as never,
    menuVersionReference: id(7) as never,
    releaseReference: id(8) as never,
    snapshotDigest: digest as never,
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "All Day" },
    storeReferences: [id(9) as never],
    channelCodes: ["DINE_IN" as never],
    orderTypeCodes: ["TABLE_SERVICE" as never],
    timeZone: "UTC",
    effectiveFrom: at as never,
    effectiveUntil: null,
    sections: [
      {
        sectionReference: id(10) as never,
        internalCode: "DRINKS" as never,
        localizedNames: { "en-CA": "Drinks" },
        sortOrder: 0,
        sellables: [
          {
            placementReference: id(11) as never,
            sellableReference: id(12) as never,
            productVersionReference: id(13) as never,
            localizedNames: { "en-CA": "Latte" },
            presentationRole: "Standard",
            sortOrder: 0,
            pinned: false,
            configuredAvailability: "Available",
            allergenDisclosure: {
              registryVersionReference: id(19) as never,
              items: [
                {
                  allergenReference: id(20) as never,
                  code: "MILK" as never,
                  localizedNames: { "en-CA": "Milk" },
                  classification: "Contains",
                },
              ],
              allergenFreeClaim: false,
              assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
            },
            optionRules: [
              {
                bindingReference: id(14) as never,
                optionSetVersionReference: id(15) as never,
                minimumSelections: 0,
                maximumSelections: 1,
                enabledOptionReferences: [id(16) as never],
                defaultOptionReferences: [],
                options: [
                  {
                    optionReference: id(16) as never,
                    localizedNames: { "en-CA": "Oat beverage" },
                    maximumQuantity: 1,
                    conflictOptionReferences: [],
                    selectedByDefault: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
function transaction() {
  const completed = new Set<string>();
  const value: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[]) {
      if (text.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
        const key = `${values[0]}:${values[1]}`;
        if (completed.has(key)) return { rowCount: 0, rows: [] as Row[] };
        return { rowCount: 1, rows: [{} as Row] };
      }
      if (text.startsWith("SELECT event_type")) {
        return {
          rowCount: 1,
          rows: [
            {
              event_type: "MenuPublished",
              schema_version: 1,
              brand_id: id(2),
              store_id: null,
              status: "completed",
            } as Row,
          ],
        };
      }
      if (text.startsWith("UPDATE platform_eventing.consumer_inbox")) {
        completed.add(`${values[0]}:${values[1]}`);
        return { rowCount: 1, rows: [] as Row[] };
      }
      throw new Error("unexpected transaction query");
    },
  };
  return value;
}
function fixture(current: PublishedMenuProjection | null = null) {
  let projection = current;
  let replacements = 0;
  const ports: PublishedMenuProjectionPorts = {
    snapshots: {
      async loadExact() {
        return snapshot();
      },
    },
    projections: {
      async load() {
        return projection;
      },
      async replace(input) {
        replacements += 1;
        projection = input.projection;
        return input.projection;
      },
    },
    references: {
      generateGeneration: () => id(17),
      now: () => at as never,
    },
  };
  return {
    service: createPublishedMenuProjectionService(ports),
    projection: () => projection,
    replacements: () => replacements,
  };
}

describe("Published Menu Projection", () => {
  it("builds the exact immutable Menu snapshot with freshness checkpoint", () => {
    expect(
      buildPublishedMenuProjection({
        envelope: envelope(),
        snapshot: snapshot(),
        generationReference: id(17),
        projectedAt: at,
      }),
    ).toMatchObject({
      projectionName: "catalog_published_menu_v1",
      sourceAggregateVersion: 4,
      freshnessStatus: "Fresh",
      snapshot: { menuVersionReference: id(7), sections: [{ sellables: [{ optionRules: [{}] }] }] },
    });
  });

  it("fails closed when the Event does not bind the exact public snapshot", () => {
    expect(() =>
      buildPublishedMenuProjection({
        envelope: {
          ...envelope(),
          payload: { ...envelope().payload, snapshotDigest: `sha256:${"b".repeat(64)}` },
        },
        snapshot: snapshot(),
        generationReference: id(17),
        projectedAt: at,
      }),
    ).toThrowError(CatalogError);
  });

  it("consumes idempotently and never replaces a newer projection", async () => {
    const state = fixture();
    const tx = transaction();
    await expect(state.service.consume(tx, envelope())).resolves.toEqual({ status: "processed" });
    await expect(state.service.consume(tx, envelope())).resolves.toEqual({
      status: "duplicate_completed",
    });
    expect(state.replacements()).toBe(1);
    const newer = state.projection();
    if (newer === null) throw new Error("projection missing");
    const stale = fixture({ ...newer, sourceAggregateVersion: 5 });
    await expect(stale.service.consume(transaction(), envelope(4n))).resolves.toEqual({
      status: "processed",
    });
    expect(stale.replacements()).toBe(0);
  });

  it("creates the canonical minimal publish envelope from the accepted release", () => {
    const record = {
      lifecycle: {
        lifecycleId: id(20),
        familyReference: id(3),
        configurationType: "MENU",
        purposeCode: "CUSTOMER_ORDERING",
        snapshotReference: id(7),
        snapshotDigest: digest,
        scope: { kind: "Brand", brandReference: id(2), storeReference: null },
        version: 4,
        state: "Published",
        validationEvidenceReference: id(21),
        approvalEvidenceReference: id(22),
        createdAt: at,
        changedAt: at,
      },
      release: {
        releaseId: id(8),
        familyReference: id(3),
        configurationType: "MENU",
        purposeCode: "CUSTOMER_ORDERING",
        snapshotReference: id(7),
        snapshotDigest: digest,
        scope: { kind: "Brand", brandReference: id(2), storeReference: null },
        sequence: 1,
        sourceLifecycleId: id(20),
        kind: "Publish",
        previousReleaseId: null,
        createdAt: at,
      },
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: at,
          localDateTime: "2026-08-02T16:00:00.000",
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
    } as never;
    expect(
      createMenuPublishedEnvelope({
        eventReference: id(1),
        operationReference: id(5),
        correlationReference: id(4),
        actorReference: id(6),
        menuReference: id(3),
        brandReference: id(2),
        record,
      }),
    ).toMatchObject({
      eventType: "MenuPublished",
      schemaVersion: 1,
      payload: { releaseReference: id(8) },
    });
  });
});
