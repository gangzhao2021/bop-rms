import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export * from "../domain/published-menu-projection.js";

export interface MenuPublishedPayload extends JsonObject {
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly releaseReference: string;
  readonly snapshotDigest: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly timeZone: string;
}

export type MenuPublishedEnvelope = DomainEventEnvelope<MenuPublishedPayload>;
