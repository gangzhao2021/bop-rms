# Observability Alert Routing Runbook

## Scope、authority and hard stops

This is the WP-0045 basic operator contract for the closed BOP-RMS technical alert registry. It supports safe triage and escalation without creating a CloudWatch alarm、SNS topic、subscription、credential、contact or incident record.

The alert route plan is not proof that a provider delivered or a person acknowledged an alert. WP-2065/deployment composition owns provider mapping、encrypted topics、least-privilege publish、verified subscriptions、actual primary/backup/security assignments、staging fault injection and acknowledgement evidence.

Stop and escalate through the approved incident process when:

- the alert code、environment、service、UTC observation or route plan is missing/invalid;
- an alert contains Tenant、Brand、Store、Actor、Session、Customer、Order、object ID、URL/query/header/body、IP、SQL、credential、payment、health/allergy、free text or unrestricted Provider data;
- the route requests a personal destination instead of a closed on-call role;
- diagnosis would require cross-Tenant/Store access、private Domain tables、production mutation、permission expansion、data deletion/restore or credential rotation;
- the evidence store、operator authority、staging/production identity or exact resource target is ambiguous;
- a privacy/redaction failure may still be emitting sensitive data.

Opening this runbook is not authorization for production/staging mutation、cloud-resource creation、customer/regulator notification、data deletion/restore、credential rotation or cost acceptance.

## Severity and role routing

| Alert code                       | Severity | Role destinations                                       | Runbook anchor                   |
| -------------------------------- | -------- | ------------------------------------------------------- | -------------------------------- |
| `SERVICE_NOT_READY`              | critical | `on_call_primary`、`on_call_backup`                     | `service-not-ready`              |
| `CORE_ERROR_RATE_HIGH`           | critical | `on_call_primary`、`on_call_backup`                     | `core-error-rate-high`           |
| `CORE_OPERATION_LATENCY_HIGH`    | warning  | `on_call_primary`                                       | `core-operation-latency-high`    |
| `TELEMETRY_PIPELINE_FAILED`      | warning  | `on_call_primary`                                       | `telemetry-pipeline-failed`      |
| `OBSERVABILITY_REDACTION_FAILED` | critical | `on_call_primary`、`on_call_backup`、`security_on_call` | `observability-redaction-failed` |

The registry fixes severity and roles. Provider/SLO composition supplies separately reviewed numeric thresholds and windows; an operator or caller must not reinterpret a provider payload into a different alert code、severity or destination.

## Safe alert envelope

Input fields are alert code、environment、exact closed service (`bop-rms-api` or `bop-rms-worker`) and exact UTC observation. The registry, never caller input, supplies stable result/error code、severity、role destinations and runbook linkage.

The grouping key contains only the closed environment/service/alert-code tuple. It never includes time、identity、request/correlation/causation ID or raw Provider data.

Never copy unrestricted logs、traces、screenshots、request payloads or alarm-provider payloads into an alert. The alert path must contain no contact detail、account/resource identifier、Tenant/Brand/Store/Actor、Customer/Employee、Order、Session/Token、IP、URL/query/header/body、SQL/bind value、payment、health/allergy or arbitrary label/free text.

## Detection and read-only corroboration

1. Confirm that the received alert code exists in the table above and that its route plan uses the expected severity、roles and anchor.
2. Confirm the environment/service through the approved deployment inventory. Do not infer an account、Region、cluster or resource from a display name or grouping key.
3. Check `/health` and `/ready` through the approved internal path. Treat liveness、readiness and drain state separately.
4. Corroborate with the closed WP-0044 instruments: `bop.operation.count`、`bop.operation.duration` and `bop.error.count`.
5. Use only bounded service/module/operation/result/registered-route dimensions and stable error codes. Never pivot on Tenant/Store/Actor/object IDs or raw URLs.
6. Use trusted correlation/trace references only inside the approved restricted operational system. They are diagnostic lineage, never authorization inputs or alert dimensions.
7. Record safe UTC timestamps、stable codes、role actions and a restricted evidence reference. Do not paste unrestricted telemetry into Git、chat or a ticket.

<a id="service-not-ready"></a>

### `SERVICE_NOT_READY`

Confirm whether the runtime is starting、accepting intake、draining or blocked on its required database/configuration check. Compare `/health` with `/ready`; do not restart repeatedly or treat a draining instance as a database failure. Check the deployment's owning health alarm and recent immutable artifact/change reference. If all healthy peers are unavailable, preserve evidence and use the approved deployment rollback/containment authority.

<a id="core-error-rate-high"></a>

### `CORE_ERROR_RATE_HIGH`

Confirm that `bop.error.count` changed for a finite service/module/operation/result tuple and that operation count provides a valid denominator in the owning provider rule. Review stable application error codes and the related deployment/change window. Do not inspect raw exception messages or customer payload. Contain only through an approved feature/deployment/provider action owned by the affected capability.

<a id="core-operation-latency-high"></a>

### `CORE_OPERATION_LATENCY_HIGH`

Confirm the provider's reviewed window/percentile and the bounded `bop.operation.duration` series. Compare operation count、error count、readiness and known deployment activity. Do not infer Customer behavior from service latency. Escalate to critical through the incident authority only when an accepted rule or observed service impact requires it; the caller cannot rewrite this route.

<a id="telemetry-pipeline-failed"></a>

### `TELEMETRY_PIPELINE_FAILED`

Confirm application health independently from telemetry delivery. Inspect bounded SDK/Collector health and stable `TELEMETRY_WRITE_FAILED` or equivalent provider status without capturing endpoint、header、credential or unrestricted error text. Business processing must continue when safe. Do not add an unreviewed exporter、disable backpressure bounds or route directly to CloudWatch/X-Ray from application code.

<a id="observability-redaction-failed"></a>

### `OBSERVABILITY_REDACTION_FAILED`

Treat this as a Security escalation. Confirm that the owning logger/exporter path failed closed and disable/quarantine any path that may still leak through an already authorized mechanism. Preserve restricted evidence without reproducing the suspected value. Security decides containment and whether Privacy/professional guidance is required. Never copy the value into an alert、log、chat、ticket、fixture or Git.

## Containment、recovery and closure

Use read-only verification first. Any containment must preserve Tenant/Store isolation、least privilege、append-only transaction/Audit/Event/evidence history and the ownership boundary of the affected Domain.

Permitted by this runbook alone:

- stop further diagnostic copying;
- escalate to the closed role route;
- mark a runtime not ready or pause intake only through an already authorized operational control;
- preserve safe evidence references;
- recommend the owning rollback/feature/provider procedure.

Not permitted by this runbook alone:

- mutate production/staging data or configuration;
- delete/restore data、truncate history or rewrite Audit/Event/evidence;
- create/rotate credentials or expand a role/grant;
- create/delete cloud resources or change subscriptions;
- contact Customers、employees、regulators or authorities;
- hardcode a legal/privacy notification conclusion or deadline.

Recovery requires the original alert condition to clear under the same reviewed provider rule、service readiness to be truthful、business processing to be verified through bounded evidence and any temporary authorized containment to be reconciled. Close only after primary/backup responsibilities、safe evidence reference、impact classification、recovery UTC time and follow-up owner role are recorded in the approved incident system.

## Provider-route failure

If a provider route、subscription or acknowledgement path fails, do not retry from the application transaction path and do not add a personal endpoint. Use the separately approved fallback/on-call mechanism、record the safe route failure and escalate the provider configuration to WP-2065/deployment ownership.

Observability failure must never change a completed business result. A missing verified subscription or failed staging delivery leaves External Evidence blocked; it is not converted into a synthetic pass.

## Evidence and external gates

Repository/CI evidence proves only closed classification、deterministic route planning、privacy rejection、runbook parity and failure isolation.

The following must live in the approved restricted evidence system and remain blocked until actually observed:

- exact AWS account/Region and deployed ADOT/CloudWatch/X-Ray identity;
- encrypted SNS topic and least-privilege publish review;
- verified primary/backup/security subscriptions and current role assignment;
- approved staging fault injected、provider alarm entered the expected state、all required routes received it and a human acknowledged it;
- bounded delivery/acknowledgement/recovery UTC measurements;
- exact cleanup/result and reviewer decision.

An incident record must include severity、on-call owner role、evidence preservation、containment、credential-rotation decision、customer/regulator decision and post-incident actions. Legal/privacy/regulatory decisions use current professional guidance and are never inferred from this runbook.
