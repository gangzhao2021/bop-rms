# `@bop-rms/observability`

Private WP-0040 technical workspace for centralized Pino `10.3.1` Structured JSON Logging.

Production composition roots call `createStructuredLogger` without a destination, which writes JSON to stdout. The destination and failure callback options exist only for synthetic/local/CI evidence. No transport、pretty-printer、file、network or external sink is configured.

The logger exposes a closed record schema rather than raw Pino. It accepts no free-form message、Tenant、Store、Actor、Session、contact、payload、header、SQL or arbitrary metadata field. Correlation/Causation values may only be passed as an already validated WP-0034 trusted in-process context；this package never reads raw transport input or generates context.

WP-0041 HTTP completion records add only a server-generated UUIDv7 `requestId`、an integer `durationMs` from `0` through `86,400,000`、an HTTP `statusCode` from `100` through `599`、a closed event and a stable result code. URL、method、query、headers、IP、Session、Token、Tenant、Store、Actor、object identifiers、free text、body、payload、SQL and bind values are not accepted fields. Raw inbound request/correlation headers never reach the logger boundary.

Errors require a stable safe code. The centralized serializer discards raw messages、paths and function text, then emits only bounded sanitized stack-frame positions. Schema/redaction failure disables the logger path and attempts one constant safe failure signal. Logger output failure never escapes into business control flow.

WP-0044 extends this package with a closed operational telemetry registry. It exposes only operation count、operation duration and error count through exact service/module/operation/result/registered-route allowlists. These are service-runtime metrics, not Section 38 business Metric Definitions or KPIs. Tenant、Store、Actor、Customer、Order、Session、Token、IP、raw URL/query/header/body、SQL、Provider payload and free text are prohibited dimensions and span attributes.

The runtime uses OpenTelemetry API `1.9.1` and Node SDK `0.220.0`. Development and test do not export by default. Staging/production requires explicitly validated OTLP-to-ADOT configuration; application code never embeds or logs an endpoint、header or credential and never calls CloudWatch/X-Ray directly. Real Collector、CloudWatch/X-Ray、sampling、retention、cost and staging continuity remain External Evidence.

WP-0045 adds a transport-neutral alert route planner. It accepts only five already-classified technical alert codes and the exact `bop-rms-api` / `bop-rms-worker` service registry，then returns a frozen plan containing registry-owned result/error code、severity、role destinations、safe grouping key and runbook linkage. Callers cannot supply result/error code、severity、destination、arbitrary labels、free text or Tenant/Brand/Store/Actor/object identifiers. Only the explicit observability redaction failure reaches the Security role.

The planner does not define numeric SLO/provider thresholds、send notifications、persist incidents、acknowledge alerts or configure AWS. Real CloudWatch alarms、encrypted SNS topics、least-privilege publication、verified subscriptions、actual contacts、staging delivery and acknowledgement are external evidence owned by later deployment composition.
