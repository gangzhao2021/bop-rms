import type { DomainEventEnvelope } from "./domain-event-envelope.js";

export const outboxDispatchErrorCodes = [
  "INVALID_ENVELOPE",
  "TRANSPORT_REJECTED",
  "TRANSPORT_TIMEOUT",
  "TRANSPORT_UNAVAILABLE",
] as const;

export type OutboxDispatchErrorCode = (typeof outboxDispatchErrorCodes)[number];

export interface ClaimedOutboxEvent {
  readonly envelope: DomainEventEnvelope;
  readonly attemptCount: number;
  readonly leaseExpiresAt: string;
  readonly leaseToken: string;
}

export interface OutboxDispatchContext {
  readonly attemptCount: number;
}

export type TransportPublishResult =
  | { readonly status: "acknowledged" }
  | { readonly status: "failed"; readonly errorCode: OutboxDispatchErrorCode };

export interface OutboxTransportAdapter {
  publish(
    envelope: DomainEventEnvelope,
    context: OutboxDispatchContext,
  ): Promise<TransportPublishResult>;
}

export type OutboxCompletionResult = "completed" | "lost_lease";
