const exactUtcInstant =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

export const ALERT_ROUTING_RUNBOOK_ID = "observability-alert-routing";
export const ALERT_ROUTING_SERVICES = Object.freeze(["bop-rms-api", "bop-rms-worker"] as const);

export type AlertCode =
  | "CORE_ERROR_RATE_HIGH"
  | "CORE_OPERATION_LATENCY_HIGH"
  | "OBSERVABILITY_REDACTION_FAILED"
  | "SERVICE_NOT_READY"
  | "TELEMETRY_PIPELINE_FAILED";
export type AlertDestinationRole = "on_call_backup" | "on_call_primary" | "security_on_call";
export type AlertService = (typeof ALERT_ROUTING_SERVICES)[number];
export type AlertSeverity = "critical" | "warning";

export interface AlertRoutingRule {
  readonly alertCode: AlertCode;
  readonly destinations: readonly AlertDestinationRole[];
  readonly errorCode?: "LOG_REDACTION_FAILED" | "TELEMETRY_WRITE_FAILED";
  readonly resultCode: "FAILED" | "NOT_READY" | "THRESHOLD_EXCEEDED";
  readonly runbookAnchor: string;
  readonly severity: AlertSeverity;
}

function rule(
  alertCode: AlertCode,
  severity: AlertSeverity,
  destinations: readonly AlertDestinationRole[],
  runbookAnchor: string,
  resultCode: AlertRoutingRule["resultCode"],
  errorCode?: AlertRoutingRule["errorCode"],
): AlertRoutingRule {
  return Object.freeze({
    alertCode,
    destinations: Object.freeze([...destinations]),
    ...(errorCode === undefined ? {} : { errorCode }),
    resultCode,
    runbookAnchor,
    severity,
  });
}

export const ALERT_ROUTING_REGISTRY: readonly AlertRoutingRule[] = Object.freeze([
  rule(
    "SERVICE_NOT_READY",
    "critical",
    ["on_call_primary", "on_call_backup"],
    "service-not-ready",
    "NOT_READY",
  ),
  rule(
    "CORE_ERROR_RATE_HIGH",
    "critical",
    ["on_call_primary", "on_call_backup"],
    "core-error-rate-high",
    "THRESHOLD_EXCEEDED",
  ),
  rule(
    "CORE_OPERATION_LATENCY_HIGH",
    "warning",
    ["on_call_primary"],
    "core-operation-latency-high",
    "THRESHOLD_EXCEEDED",
  ),
  rule(
    "TELEMETRY_PIPELINE_FAILED",
    "warning",
    ["on_call_primary"],
    "telemetry-pipeline-failed",
    "FAILED",
    "TELEMETRY_WRITE_FAILED",
  ),
  rule(
    "OBSERVABILITY_REDACTION_FAILED",
    "critical",
    ["on_call_primary", "on_call_backup", "security_on_call"],
    "observability-redaction-failed",
    "FAILED",
    "LOG_REDACTION_FAILED",
  ),
]);

const registry = new Map(ALERT_ROUTING_REGISTRY.map((item) => [item.alertCode, item]));
const services = new Set<AlertService>(ALERT_ROUTING_SERVICES);

export type AlertEnvironment = "development" | "production" | "staging" | "test";

export interface AlertRoutePlanningInput {
  readonly alertCode: AlertCode;
  readonly environment: AlertEnvironment;
  readonly observedAt: string;
  readonly service: AlertService;
}

export interface AlertRoutePlan {
  readonly alertCode: AlertCode;
  readonly destinations: readonly AlertDestinationRole[];
  readonly environment: AlertEnvironment;
  readonly errorCode?: AlertRoutingRule["errorCode"];
  readonly groupingKey: string;
  readonly observedAt: string;
  readonly resultCode: AlertRoutingRule["resultCode"];
  readonly runbookAnchor: string;
  readonly runbookId: typeof ALERT_ROUTING_RUNBOOK_ID;
  readonly service: AlertService;
  readonly severity: AlertSeverity;
}

export interface AlertRoutePlanningFailure {
  readonly code: "ALERT_ROUTING_INPUT_REJECTED";
  readonly ok: false;
}

export type AlertRoutePlanningResult =
  Readonly<{ readonly ok: true; readonly plan: AlertRoutePlan }> | AlertRoutePlanningFailure;

const rejected: AlertRoutePlanningFailure = Object.freeze({
  code: "ALERT_ROUTING_INPUT_REJECTED",
  ok: false,
});

function isExactUtcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !exactUtcInstant.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function planAlertRoute(input: unknown): AlertRoutePlanningResult {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(
        (field) =>
          typeof field !== "string" ||
          !["alertCode", "environment", "observedAt", "service"].includes(field),
      )
    )
      return rejected;

    const candidate = input as Record<string, unknown>;
    const alertCode = candidate.alertCode;
    const environment = candidate.environment;
    const observedAt = candidate.observedAt;
    const service = candidate.service;
    const selectedRule =
      typeof alertCode === "string" ? registry.get(alertCode as AlertCode) : undefined;

    if (
      selectedRule === undefined ||
      typeof environment !== "string" ||
      !["development", "production", "staging", "test"].includes(environment) ||
      !isExactUtcInstant(observedAt) ||
      typeof service !== "string" ||
      !services.has(service as AlertService)
    )
      return rejected;

    const plan = Object.freeze({
      alertCode: selectedRule.alertCode,
      destinations: selectedRule.destinations,
      environment: environment as AlertEnvironment,
      ...(selectedRule.errorCode === undefined ? {} : { errorCode: selectedRule.errorCode }),
      groupingKey: `bop:${environment}:${service}:${selectedRule.alertCode}`,
      observedAt,
      resultCode: selectedRule.resultCode,
      runbookAnchor: selectedRule.runbookAnchor,
      runbookId: ALERT_ROUTING_RUNBOOK_ID,
      service: service as AlertService,
      severity: selectedRule.severity,
    });
    return Object.freeze({ ok: true, plan });
  } catch {
    return rejected;
  }
}
