import { z } from "zod";

import {
  eventCatalogMetadataSchema,
  payloadJsonSchema,
  type EventCatalogRegistration,
} from "./catalog.ts";

export interface CatalogArtifacts {
  readonly asyncApi: string;
  readonly catalogEntrySchema: string;
  readonly markdown: string;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sorted(child)]),
    );
  return value;
}

function prettyJson(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => item === null || typeof item !== "object")) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (depth * 2 + inline.length <= 100) return inline;
    }
    const indentation = "  ".repeat(depth + 1);
    return `[\n${value
      .map((item) => `${indentation}${prettyJson(item, depth + 1)}`)
      .join(",\n")}\n${"  ".repeat(depth)}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const indentation = "  ".repeat(depth + 1);
    return `{\n${entries
      .map(
        ([key, child]) => `${indentation}${JSON.stringify(key)}: ${prettyJson(child, depth + 1)}`,
      )
      .join(",\n")}\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(value);
}

function json(value: unknown): string {
  return `${prettyJson(sorted(value))}\n`;
}

function messageName(entry: EventCatalogRegistration): string {
  return `${entry.eventType}V${entry.schemaVersion}`;
}

export function renderCatalogArtifacts(
  catalog: readonly EventCatalogRegistration[],
): CatalogArtifacts {
  const messages = Object.fromEntries(
    catalog.map((entry) => [
      messageName(entry),
      {
        name: messageName(entry),
        title: `${entry.eventType} v${entry.schemaVersion}`,
        contentType: "application/json",
        payload: payloadJsonSchema(entry.payloadSchema),
        "x-bop-event-type": entry.eventType,
        "x-bop-schema-version": entry.schemaVersion,
        "x-bop-owner-module": entry.ownerModule,
        "x-bop-producer-module": entry.producerModule,
        "x-bop-consumers": entry.consumers,
        "x-bop-tenant-scope": entry.tenantScope,
        "x-bop-data-classification": entry.dataClassification,
        "x-bop-compatibility": entry.compatibility,
        "x-bop-retention-category": entry.retentionCategory,
        "x-bop-replay-semantics": entry.replaySemantics,
        deprecated: entry.deprecated,
        ...(entry.replacement === null ? {} : { "x-bop-replacement": entry.replacement }),
      },
    ]),
  );
  const asyncApi = {
    asyncapi: "3.0.0",
    info: {
      title: "BOP-RMS Event Catalog",
      version: "0.1.0",
    },
    defaultContentType: "application/json",
    channels: {},
    components: {
      messages,
    },
  };
  const entrySchema = z.toJSONSchema(eventCatalogMetadataSchema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  });
  const registrations = catalog.map(
    (entry) =>
      `- \`${entry.eventType}:v${entry.schemaVersion}\` — owner \`${entry.ownerModule}\`; ${entry.stability}; ${entry.tenantScope}; ${entry.dataClassification}`,
  );
  const markdown = `# BOP-RMS Event Catalog

This file is generated from the Zod-first source in \`packages/contracts/events/catalog.ts\`.
Do not edit it directly. The catalog contains only Owner-approved concrete registrations.

## Registered Events

${registrations.length === 0 ? "_No concrete Events registered._" : registrations.join("\n")}

Registered Event identities are the only bounded Event-type metric label candidates.
An empty catalog therefore enables no Event-type production metric label.
`;
  return {
    asyncApi: json(asyncApi),
    catalogEntrySchema: json(entrySchema),
    markdown,
  };
}
