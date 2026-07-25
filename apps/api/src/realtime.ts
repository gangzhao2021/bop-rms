import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const HINT_TYPE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const RESOURCE_TYPE = /^[a-z][A-Za-z0-9]{0,63}$/;
const PERMISSION = "realtime:subscribe";

export type RealtimeSessionKind = "merchant" | "guest";

export interface RealtimeSession {
  active: boolean;
  brandId: string;
  kind: RealtimeSessionKind;
  permissions: readonly string[];
  revision: string;
  sessionKey: string;
  storeId?: string;
}

export type RealtimeAuthorization =
  | { outcome: "authorized"; session: RealtimeSession }
  | { outcome: "unauthenticated" | "forbidden" };

export interface RealtimeAuthorizer {
  authorize(request: Request): Promise<RealtimeAuthorization>;
  revalidate(session: Readonly<RealtimeSession>): Promise<RealtimeAuthorization>;
  subscribeToScopeChanges?(session: Readonly<RealtimeSession>, onChange: () => void): () => void;
}

export interface RealtimeConnectionLease {
  connectionId: string;
  release(): void | Promise<void>;
}

export interface RealtimeConnectionRegistry {
  acquire(input: {
    kind: RealtimeSessionKind;
    limit: number;
    sessionKey: string;
  }): Promise<RealtimeConnectionLease | undefined>;
}

export interface RealtimeMetric {
  operation: "admission" | "delivery" | "lifecycle";
  result:
    | "accepted"
    | "denied"
    | "limited"
    | "unavailable"
    | "delivered"
    | "rejected"
    | "revoked"
    | "expired"
    | "aborted"
    | "drained";
  sessionKind?: RealtimeSessionKind;
}

export interface RealtimeHint {
  messageId: string;
  occurredAt: string;
  projectionVersion: number;
  resource: {
    id: string;
    type: string;
  };
  scope: {
    brandId: string;
    storeId?: string;
  };
  type: string;
  version: number;
}

export interface RealtimeTransportOptions {
  authorizer: RealtimeAuthorizer;
  connectionRegistry: RealtimeConnectionRegistry;
  expectedOrigin: string;
  heartbeatMs?: number;
  lifetimeMs?: number;
  merchantConnectionLimit?: number;
  metrics?: (metric: RealtimeMetric) => void;
  revalidateMs?: number;
  guestConnectionLimit?: number;
}

interface ActiveStream {
  closed: boolean;
  heartbeat: ReturnType<typeof setInterval>;
  lease: RealtimeConnectionLease;
  lifetime: ReturnType<typeof setTimeout>;
  onClose: () => void;
  response: Response;
  revalidation: ReturnType<typeof setInterval>;
  session: RealtimeSession;
  unsubscribe?: () => void;
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isUtcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isSafeSession(session: RealtimeSession): boolean {
  return (
    session.active === true &&
    (session.kind === "merchant" || session.kind === "guest") &&
    OPAQUE_KEY.test(session.sessionKey) &&
    OPAQUE_KEY.test(session.revision) &&
    isUuidV7(session.brandId) &&
    (session.storeId === undefined || isUuidV7(session.storeId)) &&
    Array.isArray(session.permissions) &&
    session.permissions.length <= 32 &&
    session.permissions.every(
      (permission) => typeof permission === "string" && OPAQUE_KEY.test(permission),
    )
  );
}

function immutableSessionSnapshot(session: RealtimeSession): RealtimeSession {
  return Object.freeze({
    active: true,
    brandId: session.brandId,
    kind: session.kind,
    permissions: Object.freeze([...session.permissions]),
    revision: session.revision,
    sessionKey: session.sessionKey,
    ...(session.storeId === undefined ? {} : { storeId: session.storeId }),
  });
}

function isSafeHint(hint: RealtimeHint): boolean {
  return (
    isUuidV7(hint.messageId) &&
    HINT_TYPE.test(hint.type) &&
    !hint.type.startsWith("system.") &&
    isPositiveInteger(hint.version) &&
    isUtcInstant(hint.occurredAt) &&
    isUuidV7(hint.scope.brandId) &&
    (hint.scope.storeId === undefined || isUuidV7(hint.scope.storeId)) &&
    RESOURCE_TYPE.test(hint.resource.type) &&
    isUuidV7(hint.resource.id) &&
    isPositiveInteger(hint.projectionVersion)
  );
}

function sameAuthorization(left: RealtimeSession, right: RealtimeSession): boolean {
  return (
    isSafeSession(right) &&
    right.kind === left.kind &&
    right.sessionKey === left.sessionKey &&
    right.brandId === left.brandId &&
    right.storeId === left.storeId &&
    right.revision === left.revision &&
    right.permissions.includes(PERMISSION)
  );
}

function safeJsonError(
  response: Response,
  status: 400 | 401 | 403 | 429 | 503,
  code: string,
): void {
  if (status === 429) response.setHeader("Retry-After", "1");
  response.status(status).json({
    error: {
      code,
      message: status === 429 ? "The stream limit was reached." : "The stream is unavailable.",
    },
  });
}

function controlFrame(type: "system.reconnect" | "system.refresh", reason: string): string {
  return `event: ${type}\ndata: ${JSON.stringify({ reason })}\n\n`;
}

function hintFrame(hint: RealtimeHint): string {
  return `id: ${hint.messageId}\nevent: ${hint.type}\ndata: ${JSON.stringify(hint)}\n\n`;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum)
    throw new Error("Realtime timing and limits must be bounded positive integers");
  return resolved;
}

export class InMemoryRealtimeConnectionRegistry implements RealtimeConnectionRegistry {
  readonly #connections = new Map<string, Set<string>>();
  readonly #idFactory: () => string;

  constructor(idFactory: () => string = randomUUID) {
    this.#idFactory = idFactory;
  }

  async acquire({
    limit,
    sessionKey,
  }: {
    kind: RealtimeSessionKind;
    limit: number;
    sessionKey: string;
  }): Promise<RealtimeConnectionLease | undefined> {
    const current = this.#connections.get(sessionKey) ?? new Set<string>();
    if (current.size >= limit) return undefined;
    const connectionId = this.#idFactory();
    current.add(connectionId);
    this.#connections.set(sessionKey, current);
    let released = false;
    return {
      connectionId,
      release: () => {
        if (released) return;
        released = true;
        current.delete(connectionId);
        if (current.size === 0) this.#connections.delete(sessionKey);
      },
    };
  }

  activeCount(): number {
    return [...this.#connections.values()].reduce((total, connections) => {
      return total + connections.size;
    }, 0);
  }
}

export class RealtimeTransport {
  readonly #active = new Map<string, ActiveStream>();
  readonly #authorizer: RealtimeAuthorizer;
  readonly #expectedOrigin: string;
  readonly #guestConnectionLimit: number;
  readonly #heartbeatMs: number;
  readonly #lifetimeMs: number;
  readonly #merchantConnectionLimit: number;
  readonly #metrics: ((metric: RealtimeMetric) => void) | undefined;
  readonly #registry: RealtimeConnectionRegistry;
  readonly #revalidateMs: number;
  #draining = false;

  constructor(options: RealtimeTransportOptions) {
    const origin = new URL(options.expectedOrigin);
    if (origin.origin !== options.expectedOrigin || !["http:", "https:"].includes(origin.protocol))
      throw new Error("expectedOrigin must be an exact HTTP(S) origin");
    this.#expectedOrigin = options.expectedOrigin;
    this.#authorizer = options.authorizer;
    this.#registry = options.connectionRegistry;
    this.#metrics = options.metrics;
    this.#heartbeatMs = boundedPositiveInteger(options.heartbeatMs, 15_000, 15_000);
    this.#revalidateMs = boundedPositiveInteger(options.revalidateMs, 60_000, 60_000);
    this.#lifetimeMs = boundedPositiveInteger(options.lifetimeMs, 7_200_000, 7_200_000);
    this.#merchantConnectionLimit = boundedPositiveInteger(options.merchantConnectionLimit, 3, 3);
    this.#guestConnectionLimit = boundedPositiveInteger(options.guestConnectionLimit, 2, 2);
  }

  handler(): RequestHandler {
    return (request, response) => {
      void this.#admit(request, response);
    };
  }

  isReady(): boolean {
    return !this.#draining;
  }

  resourceSnapshot(): { activeStreams: number; draining: boolean; ownedTimers: number } {
    return {
      activeStreams: this.#active.size,
      draining: this.#draining,
      ownedTimers: this.#active.size * 3,
    };
  }

  publish(hint: RealtimeHint): number {
    if (!isSafeHint(hint)) {
      this.#metric({ operation: "delivery", result: "rejected" });
      return 0;
    }
    let delivered = 0;
    for (const stream of this.#active.values()) {
      if (
        !stream.closed &&
        stream.session.brandId === hint.scope.brandId &&
        stream.session.storeId === hint.scope.storeId
      ) {
        try {
          stream.response.write(hintFrame(hint));
          delivered += 1;
        } catch {
          void this.#close(stream, "aborted");
        }
      }
    }
    this.#metric({ operation: "delivery", result: delivered > 0 ? "delivered" : "rejected" });
    return delivered;
  }

  async beginDrain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    await Promise.all(
      [...this.#active.values()].map(async (stream) => {
        if (!stream.closed && !stream.response.destroyed) {
          stream.response.write(controlFrame("system.reconnect", "deployment"));
        }
        await this.#close(stream, "drained");
      }),
    );
  }

  async #admit(request: Request, response: Response): Promise<void> {
    if (this.#draining) {
      this.#metric({ operation: "admission", result: "unavailable" });
      safeJsonError(response, 503, "realtime_draining");
      return;
    }
    if (
      request.get("origin") !== this.#expectedOrigin ||
      request.get("sec-fetch-site") !== "same-origin" ||
      request.get("sec-fetch-mode") !== "cors"
    ) {
      this.#metric({ operation: "admission", result: "denied" });
      safeJsonError(response, 403, "realtime_origin_denied");
      return;
    }
    const keys = Object.keys(request.query);
    if (keys.some((key) => key !== "storeId") || keys.length > 1) {
      this.#metric({ operation: "admission", result: "denied" });
      safeJsonError(response, 400, "realtime_query_denied");
      return;
    }
    const lastEventId = request.get("last-event-id");
    if (
      lastEventId !== undefined &&
      (lastEventId.length > 128 || hasControlCharacter(lastEventId))
    ) {
      this.#metric({ operation: "admission", result: "denied" });
      safeJsonError(response, 400, "realtime_cursor_invalid");
      return;
    }

    let authorization: RealtimeAuthorization;
    try {
      authorization = await this.#authorizer.authorize(request);
    } catch {
      this.#metric({ operation: "admission", result: "unavailable" });
      safeJsonError(response, 503, "realtime_authorizer_unavailable");
      return;
    }
    if (authorization.outcome !== "authorized") {
      this.#metric({ operation: "admission", result: "denied" });
      safeJsonError(
        response,
        authorization.outcome === "unauthenticated" ? 401 : 403,
        authorization.outcome === "unauthenticated"
          ? "realtime_unauthenticated"
          : "realtime_forbidden",
      );
      return;
    }
    const candidateSession = authorization.session;
    if (
      !isSafeSession(candidateSession) ||
      candidateSession.kind !== "merchant" ||
      !candidateSession.permissions.includes(PERMISSION)
    ) {
      this.#metric({ operation: "admission", result: "denied" });
      safeJsonError(response, 403, "realtime_forbidden");
      return;
    }
    const session = immutableSessionSnapshot(candidateSession);
    const requestedStore = request.query.storeId;
    if (
      requestedStore !== undefined &&
      (typeof requestedStore !== "string" ||
        !isUuidV7(requestedStore) ||
        session.storeId === undefined ||
        requestedStore !== session.storeId)
    ) {
      this.#metric({ operation: "admission", result: "denied" });
      safeJsonError(response, 403, "realtime_scope_denied");
      return;
    }

    const limit =
      session.kind === "merchant" ? this.#merchantConnectionLimit : this.#guestConnectionLimit;
    let lease: RealtimeConnectionLease | undefined;
    try {
      lease = await this.#registry.acquire({
        kind: session.kind,
        limit,
        sessionKey: session.sessionKey,
      });
    } catch {
      this.#metric({ operation: "admission", result: "unavailable" });
      safeJsonError(response, 503, "realtime_registry_unavailable");
      return;
    }
    if (!lease) {
      this.#metric({ operation: "admission", result: "limited", sessionKind: session.kind });
      safeJsonError(response, 429, "realtime_connection_limit");
      return;
    }
    if (!OPAQUE_KEY.test(lease.connectionId) || this.#active.has(lease.connectionId)) {
      try {
        await lease.release();
      } catch {
        // Admission still fails closed when a registry cannot release an invalid lease.
      }
      this.#metric({ operation: "admission", result: "unavailable" });
      safeJsonError(response, 503, "realtime_registry_unavailable");
      return;
    }
    if (this.#draining) {
      await lease.release();
      this.#metric({ operation: "admission", result: "unavailable" });
      safeJsonError(response, 503, "realtime_draining");
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    response.write(controlFrame("system.refresh", "connected"));

    const stream = {} as ActiveStream;
    stream.closed = false;
    stream.lease = lease;
    stream.response = response;
    stream.session = session;
    stream.heartbeat = setInterval(() => {
      if (!stream.closed) response.write(": heartbeat\n\n");
    }, this.#heartbeatMs);
    stream.revalidation = setInterval(() => {
      void this.#revalidate(stream);
    }, this.#revalidateMs);
    stream.lifetime = setTimeout(() => {
      if (!stream.closed && !stream.response.destroyed) {
        stream.response.write(controlFrame("system.reconnect", "lifetime"));
      }
      void this.#close(stream, "expired");
    }, this.#lifetimeMs);
    stream.onClose = () => {
      void this.#close(stream, "aborted");
    };
    this.#active.set(lease.connectionId, stream);
    response.once("close", stream.onClose);
    try {
      if (this.#authorizer.subscribeToScopeChanges) {
        stream.unsubscribe = this.#authorizer.subscribeToScopeChanges(session, () => {
          void this.#revalidate(stream);
        });
      }
    } catch {
      await this.#close(stream, "revoked");
      return;
    }
    if (response.destroyed || response.writableEnded) {
      await this.#close(stream, "aborted");
      return;
    }
    this.#metric({ operation: "admission", result: "accepted", sessionKind: session.kind });
  }

  async #revalidate(stream: ActiveStream): Promise<void> {
    if (stream.closed) return;
    let authorization: RealtimeAuthorization;
    try {
      authorization = await this.#authorizer.revalidate(stream.session);
    } catch {
      await this.#close(stream, "revoked");
      return;
    }
    if (
      authorization.outcome !== "authorized" ||
      !sameAuthorization(stream.session, authorization.session)
    ) {
      await this.#close(stream, "revoked");
    }
  }

  async #close(
    stream: ActiveStream,
    result: "aborted" | "drained" | "expired" | "revoked",
  ): Promise<void> {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.heartbeat);
    clearInterval(stream.revalidation);
    clearTimeout(stream.lifetime);
    stream.unsubscribe?.();
    stream.response.off("close", stream.onClose);
    this.#active.delete(stream.lease.connectionId);
    try {
      await stream.lease.release();
    } finally {
      if (!stream.response.writableEnded) stream.response.end();
      this.#metric({
        operation: "lifecycle",
        result,
        sessionKind: stream.session.kind,
      });
    }
  }

  #metric(metric: RealtimeMetric): void {
    try {
      this.#metrics?.(metric);
    } catch {
      // Telemetry cannot alter authorization or stream lifecycle.
    }
  }
}

export interface ReconnectPolicy {
  nextDelayMs(): number;
  reset(): void;
}

export function createReconnectPolicy(random: () => number = Math.random): ReconnectPolicy {
  let attempt = 0;
  return {
    nextDelayMs() {
      const cap = Math.min(30_000, 1_000 * 2 ** attempt);
      attempt += 1;
      const unit = Math.min(Math.max(random(), 0), 0.999_999_999);
      return 1_000 + Math.floor(unit * (cap - 999));
    },
    reset() {
      attempt = 0;
    },
  };
}

export function recoveryActionFor(reason: "hint" | "open" | "reconnect"): {
  refreshCanonicalQuery: true;
  replayCommand: false;
  reason: typeof reason;
} {
  return { refreshCanonicalQuery: true, replayCommand: false, reason };
}

export const unavailableRealtimeHandler: RequestHandler = (_request, response) => {
  safeJsonError(response, 503, "realtime_not_configured");
};
