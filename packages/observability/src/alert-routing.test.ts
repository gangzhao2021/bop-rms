import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ALERT_ROUTING_REGISTRY,
  ALERT_ROUTING_RUNBOOK_ID,
  ALERT_ROUTING_SERVICES,
  planAlertRoute,
  type AlertCode,
} from "./index.js";

const observedAt = "2026-07-28T09:30:00.000Z";

function plan(alertCode: AlertCode) {
  return planAlertRoute({
    alertCode,
    environment: "staging",
    observedAt,
    service: "bop-rms-api",
  });
}

describe("WP-0045 alert routing", () => {
  it("publishes the exact closed registry and role escalation", () => {
    expect(ALERT_ROUTING_REGISTRY).toEqual([
      {
        alertCode: "SERVICE_NOT_READY",
        destinations: ["on_call_primary", "on_call_backup"],
        resultCode: "NOT_READY",
        runbookAnchor: "service-not-ready",
        severity: "critical",
      },
      {
        alertCode: "CORE_ERROR_RATE_HIGH",
        destinations: ["on_call_primary", "on_call_backup"],
        resultCode: "THRESHOLD_EXCEEDED",
        runbookAnchor: "core-error-rate-high",
        severity: "critical",
      },
      {
        alertCode: "CORE_OPERATION_LATENCY_HIGH",
        destinations: ["on_call_primary"],
        resultCode: "THRESHOLD_EXCEEDED",
        runbookAnchor: "core-operation-latency-high",
        severity: "warning",
      },
      {
        alertCode: "TELEMETRY_PIPELINE_FAILED",
        destinations: ["on_call_primary"],
        errorCode: "TELEMETRY_WRITE_FAILED",
        resultCode: "FAILED",
        runbookAnchor: "telemetry-pipeline-failed",
        severity: "warning",
      },
      {
        alertCode: "OBSERVABILITY_REDACTION_FAILED",
        destinations: ["on_call_primary", "on_call_backup", "security_on_call"],
        errorCode: "LOG_REDACTION_FAILED",
        resultCode: "FAILED",
        runbookAnchor: "observability-redaction-failed",
        severity: "critical",
      },
    ]);
    expect(Object.isFrozen(ALERT_ROUTING_REGISTRY)).toBe(true);
    expect(ALERT_ROUTING_SERVICES).toEqual(["bop-rms-api", "bop-rms-worker"]);
    expect(Object.isFrozen(ALERT_ROUTING_SERVICES)).toBe(true);
    expect(ALERT_ROUTING_REGISTRY.every(Object.isFrozen)).toBe(true);
    expect(ALERT_ROUTING_REGISTRY.every((item) => Object.isFrozen(item.destinations))).toBe(true);
  });

  it.each(ALERT_ROUTING_REGISTRY)(
    "plans a deterministic synthetic route for $alertCode without claiming delivery",
    (expected) => {
      const first = plan(expected.alertCode);
      const second = plan(expected.alertCode);

      expect(first).toEqual(second);
      expect(first).toEqual({
        ok: true,
        plan: {
          alertCode: expected.alertCode,
          destinations: expected.destinations,
          environment: "staging",
          ...(expected.errorCode === undefined ? {} : { errorCode: expected.errorCode }),
          groupingKey: `bop:staging:bop-rms-api:${expected.alertCode}`,
          observedAt,
          resultCode: expected.resultCode,
          runbookAnchor: expected.runbookAnchor,
          runbookId: ALERT_ROUTING_RUNBOOK_ID,
          service: "bop-rms-api",
          severity: expected.severity,
        },
      });
      if (first.ok) {
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.plan)).toBe(true);
        expect(Object.keys(first.plan).sort()).toEqual(
          [
            "alertCode",
            "destinations",
            "environment",
            ...(expected.errorCode === undefined ? [] : ["errorCode"]),
            "groupingKey",
            "observedAt",
            "resultCode",
            "runbookAnchor",
            "runbookId",
            "service",
            "severity",
          ].sort(),
        );
      }
    },
  );

  it("keeps Security exclusive to the explicit redaction/privacy failure", () => {
    for (const item of ALERT_ROUTING_REGISTRY) {
      expect(item.destinations.includes("security_on_call")).toBe(
        item.alertCode === "OBSERVABILITY_REDACTION_FAILED",
      );
    }
  });

  it.each([
    null,
    [],
    "CORE_ERROR_RATE_HIGH",
    {},
    {
      alertCode: "UNKNOWN_ALERT",
      environment: "staging",
      observedAt,
      service: "bop-rms-api",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      destination: "person@example.test",
      environment: "staging",
      observedAt,
      service: "bop-rms-api",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      observedAt,
      service: "bop-rms-api",
      severity: "warning",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      observedAt,
      service: "bop-rms-api",
      tenantId: "018f1f48-7b5d-7aa5-8a1b-123456789abc",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "preview",
      observedAt,
      service: "bop-rms-api",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      observedAt: "2026-07-28T09:30:00Z",
      service: "bop-rms-api",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      observedAt: "2026-02-31T09:30:00.000Z",
      service: "bop-rms-api",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      observedAt,
      service: "bop-rms-future",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      errorCode: "customer@example.test",
      observedAt,
      service: "bop-rms-api",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      observedAt,
      resultCode: "Bearer secret",
      service: "bop-rms-api",
    },
    {
      alertCode: "CORE_ERROR_RATE_HIGH",
      environment: "staging",
      observedAt,
      service: "Tenant-123",
    },
    Object.assign(
      {
        alertCode: "CORE_ERROR_RATE_HIGH",
        environment: "staging",
        observedAt,
        service: "bop-rms-api",
      },
      { [Symbol("unsafe")]: "secret" },
    ),
  ])("rejects unsafe or caller-controlled alert input %#", (input) => {
    const output = planAlertRoute(input);
    expect(output).toEqual({
      code: "ALERT_ROUTING_INPUT_REJECTED",
      ok: false,
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toMatch(/person@example|018f1f48|Bearer|secret|Tenant-123/iu);
  });

  it("isolates hostile accessors and proxy traps from caller control flow", () => {
    const accessor = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperty(accessor, "alertCode", {
      enumerable: true,
      get() {
        throw new Error("synthetic secret must not escape");
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("synthetic token must not escape");
        },
      },
    );

    expect(() => planAlertRoute(accessor)).not.toThrow();
    expect(() => planAlertRoute(proxy)).not.toThrow();
    expect(planAlertRoute(accessor)).toEqual({
      code: "ALERT_ROUTING_INPUT_REJECTED",
      ok: false,
    });
    expect(planAlertRoute(proxy)).toEqual({
      code: "ALERT_ROUTING_INPUT_REJECTED",
      ok: false,
    });
  });

  it("links every alert exactly once to the versioned basic runbook", async () => {
    const runbook = await readFile(
      new URL("../../../docs/runbooks/observability-alert-routing.md", import.meta.url),
      "utf8",
    );

    for (const heading of [
      "## Scope、authority and hard stops",
      "## Severity and role routing",
      "## Safe alert envelope",
      "## Detection and read-only corroboration",
      "## Containment、recovery and closure",
      "## Provider-route failure",
      "## Evidence and external gates",
    ])
      expect(runbook).toContain(heading);

    for (const item of ALERT_ROUTING_REGISTRY) {
      const anchor = `<a id="${item.runbookAnchor}"></a>`;
      expect(runbook.split(anchor)).toHaveLength(2);
      expect(runbook).toContain(`\`${item.alertCode}\``);
    }
  });
});
