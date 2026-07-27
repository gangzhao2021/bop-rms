import { describe, expect, it } from "vitest";
import {
  createStructuredLogger,
  type StructuredLogDestination,
  type StructuredLogFailure,
} from "./index.js";

class MemoryDestination implements StructuredLogDestination {
  readonly records: string[] = [];

  write(message: string): void {
    this.records.push(String(message));
  }

  json(): Record<string, unknown>[] {
    return this.records.flatMap((chunk) =>
      chunk
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  }
}

const config = {
  allowedEvents: ["operation_completed", "operation_failed"] as const,
  environment: "test" as const,
  module: "acceptance",
  service: "bop-rms-test",
};

describe("WP-0040 structured logger", () => {
  it("emits only the closed Structured JSON schema", () => {
    const destination = new MemoryDestination();
    const logger = createStructuredLogger(config, { destination });

    logger.info({
      durationMs: 27,
      event: "operation_completed",
      port: 3100,
      requestId: "018f1f48-7b5d-7aa5-8a1b-123456789abc",
      resultCode: "SUCCESS",
      signal: "SIGTERM",
      statusCode: 202,
      trustedContext: {
        correlationId: "018f1f48-7b5d-7aa6-8a1b-123456789abc",
        causationId: "018f1f48-7b5d-7aa7-8a1b-123456789abc",
      },
    });

    const [record] = destination.json();
    expect(record).toMatchObject({
      causationId: "018f1f48-7b5d-7aa7-8a1b-123456789abc",
      correlationId: "018f1f48-7b5d-7aa6-8a1b-123456789abc",
      durationMs: 27,
      environment: "test",
      event: "operation_completed",
      module: "acceptance",
      port: 3100,
      requestId: "018f1f48-7b5d-7aa5-8a1b-123456789abc",
      resultCode: "SUCCESS",
      service: "bop-rms-test",
      signal: "SIGTERM",
      statusCode: 202,
    });
    expect(Object.keys(record ?? {}).sort()).toEqual(
      [
        "causationId",
        "correlationId",
        "durationMs",
        "environment",
        "event",
        "level",
        "module",
        "port",
        "requestId",
        "resultCode",
        "service",
        "signal",
        "statusCode",
        "time",
      ].sort(),
    );
  });

  it("centralizes Restricted stack serialization and removes sensitive canaries", () => {
    const destination = new MemoryDestination();
    const logger = createStructuredLogger(config, { destination });
    const error = new Error(
      "Bearer token-value Cookie=session email person@example.test card 4242424242424242",
    );
    error.stack = [
      "Error: SELECT * FROM customer WHERE allergy = $1 payload secret-token",
      "    at person@example.test (/Users/person/private/payment.ts:42:9)",
      "    at Authorization=Bearer-token (/srv/request-body.ts:7:3)",
    ].join("\n");

    logger.error({
      error: { code: "SAFE_OPERATION_FAILED", value: error },
      event: "operation_failed",
      resultCode: "SAFE_OPERATION_FAILED",
    });

    const serialized = destination.records.join("");
    for (const canary of [
      "Bearer",
      "Cookie",
      "person@example.test",
      "4242424242424242",
      "SELECT",
      "allergy",
      "$1",
      "payload",
      "secret-token",
      "/Users/person",
      "Authorization",
      "request-body",
    ])
      expect(serialized).not.toContain(canary);
    expect(destination.json()[0]).toMatchObject({
      error: {
        code: "SAFE_OPERATION_FAILED",
        stack: "Error\n    at [REDACTED_FRAME]:42:9\n    at [REDACTED_FRAME]:7:3",
      },
    });
  });

  it("fails closed on schema/context input and disables the leaking path", () => {
    const destination = new MemoryDestination();
    const failures: StructuredLogFailure[] = [];
    const logger = createStructuredLogger(config, {
      destination,
      onSafeFailure: (failure) => failures.push(failure),
    });

    logger.info({
      event: "operation_completed",
      trustedContext: {
        correlationId: "raw-header-value",
        token: "must-never-log",
      },
    } as never);
    logger.info({ event: "operation_completed", resultCode: "SUCCESS" });

    expect(failures).toEqual(["LOG_REDACTION_FAILED"]);
    expect(destination.json()).toEqual([
      expect.objectContaining({
        event: "observability_redaction_failed",
        resultCode: "LOG_REDACTION_FAILED",
      }),
    ]);
    expect(destination.records.join("")).not.toContain("raw-header-value");
    expect(destination.records.join("")).not.toContain("must-never-log");
  });

  it.each([
    { durationMs: -1 },
    { durationMs: 86_400_001 },
    { durationMs: 1.5 },
    { requestId: "raw-header-value" },
    { statusCode: 99 },
    { statusCode: 600 },
  ])("fails closed for an invalid bounded HTTP field %#", (unsafeField) => {
    const destination = new MemoryDestination();
    const failures: StructuredLogFailure[] = [];
    const logger = createStructuredLogger(config, {
      destination,
      onSafeFailure: (failure) => failures.push(failure),
    });

    logger.info({ event: "operation_completed", ...unsafeField } as never);

    expect(failures).toEqual(["LOG_REDACTION_FAILED"]);
    expect(destination.records.join("")).not.toContain("raw-header-value");
  });

  it("isolates a redaction accessor failure without exposing the value", () => {
    const destination = new MemoryDestination();
    const failures: StructuredLogFailure[] = [];
    const unsafe = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperty(unsafe, "stack", {
      get() {
        throw new Error("synthetic secret must not escape");
      },
    });
    const logger = createStructuredLogger(config, {
      destination,
      onSafeFailure: (failure) => failures.push(failure),
    });

    expect(() =>
      logger.error({
        error: { code: "SAFE_OPERATION_FAILED", value: unsafe },
        event: "operation_failed",
      }),
    ).not.toThrow();
    expect(failures).toEqual(["LOG_REDACTION_FAILED"]);
    expect(destination.records.join("")).not.toContain("synthetic secret");
  });

  it("isolates destination failure from caller control flow", () => {
    const failures: StructuredLogFailure[] = [];
    const destination: StructuredLogDestination = {
      write() {
        throw new Error("sink unavailable with secret");
      },
    };
    const logger = createStructuredLogger(config, {
      destination,
      onSafeFailure: (failure) => failures.push(failure),
    });

    expect(() =>
      logger.info({ event: "operation_completed", resultCode: "SUCCESS" }),
    ).not.toThrow();
    expect(failures).toEqual(["LOG_WRITE_FAILED"]);
  });

  it("fails startup closed for invalid configuration", () => {
    expect(() =>
      createStructuredLogger({
        ...config,
        allowedEvents: ["operation_completed", "operation_completed"],
      }),
    ).toThrow("invalid structured logger event allowlist");
    expect(() =>
      createStructuredLogger({
        ...config,
        environment: "unknown" as "test",
      }),
    ).toThrow("invalid structured logger configuration");
    expect(() =>
      createStructuredLogger(
        { ...config, environment: "production" },
        { destination: new MemoryDestination() },
      ),
    ).toThrow("invalid structured logger test options");
  });
});
