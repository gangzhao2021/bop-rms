import {
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  appendAuditRecordInTransaction,
  type AuditTransaction,
} from "@bop/audit";
import { FeatureControlAdministrationServiceError } from "../../application/feature-control-administration-service.js";
import type { FeatureControlAdministrationPorts } from "../../application/ports/feature-control-administration-ports.js";
import { parseBrandReference, parseStoreReference } from "@bop/tenant";
import {
  createFeatureControlAdministrationDefinition,
  type FeatureControlAdministrationDefinition,
} from "../../contracts/feature-control-administration.js";
import {
  parseFeatureControlInstant,
  parseFeatureControlKey,
  parseFeatureControlPurposeCode,
  parseFeatureControlReference,
} from "../../contracts/feature-control.js";
import type { KillSwitchQueryTransactionRunner } from "./kill-switch-query-store.js";

export class FeatureControlAdministrationQueryError extends Error {
  readonly code = "FEATURE_CONTROL_SOURCE_UNAVAILABLE";
  constructor() {
    super("Feature Control configuration source is unavailable");
    this.name = "FeatureControlAdministrationQueryError";
  }
}
export interface FeatureControlAdministrationQueryRequest {
  readonly actorReference: string;
  readonly purposeCode: string;
  readonly key: string;
  readonly observedAt: string;
}
export interface FeatureControlAdministrationQueryAuthorization {
  /** Verify actual Tenant/session/Actor/purpose and restricted fields; hold through read COMMIT. */
  withAuthorizedDefinitionsScope<T>(
    input: FeatureControlAdministrationQueryRequest & {
      readonly brandReference: string;
      readonly storeReference: string | null;
      readonly access: "AdministrationDefinitions";
    },
    work: () => Promise<T>,
  ): Promise<T>;
}
const fail = (): never => {
  throw new FeatureControlAdministrationQueryError();
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    found = Reflect.ownKeys(value);
  if (
    found.length !== keys.length ||
    found.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return fail();
      return [key, descriptor.value];
    }),
  );
}
/** Copy descriptors before the existing closed contract parser; never evaluate driver getters. */
function safeCopy(value: unknown): unknown {
  let remaining = 1_000_000;
  function copy(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 10) return fail();
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item === "string") {
      if (item.length > 4096) return fail();
      return item;
    }
    if (!item || typeof item !== "object") return fail();
    const keys = Reflect.ownKeys(item),
      descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        item.length > 256 ||
        keys.length !== item.length + 1
      )
        return fail();
      return Array.from({ length: item.length }, (_, i) => {
        const descriptor = descriptors[String(i)];
        if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
        return copy(descriptor.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(item) !== Object.prototype || keys.length > 32) return fail();
    return Object.fromEntries(
      keys.map((key) => {
        if (typeof key !== "string") return fail();
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) return fail();
        return [key, copy(descriptor.value, depth + 1)];
      }),
    );
  }
  return copy(value, 0);
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const select = `SELECT ${utc("v.created_at")} AS "recordedAt",jsonb_build_object(
 'controlId',v.control_id,'key',v.control_key,'description',v.description,'version',v.control_version,
 'ownerReference',v.owner_reference,'purposeCode',v.purpose_code,
 'scope',jsonb_build_object('kind',CASE WHEN v.store_id IS NULL THEN 'Brand' ELSE 'Store' END,'brandReference',v.brand_id,'storeReference',v.store_id),
 'source',v.source,'defaultValue',v.default_value,'configuredValue',v.configured_value,'lifecycle',v.lifecycle,'temporary',v.temporary,
 'effectiveFrom',${utc("v.effective_from")},'effectiveUntil',${utc("v.effective_until")},'reviewAt',${utc("v.review_at")},'expiresAt',${utc("v.expires_at")},
 'dependencies','[]'::jsonb,'authoredByReference',v.authored_by_reference,'approvedByReference',v.approved_by_reference,
 'approvalEvidenceReference',v.approval_evidence_reference,'publicationReference',v.publication_reference) AS definition,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('storeReference',d.store_id,'definition',jsonb_build_object(
 'dependencyId',d.dependency_id,'kind',d.dependency_kind,'targetKey',d.target_key,'minimumCompatibleVersion',d.minimum_compatible_version,
 'status',d.dependency_status,'evidenceReference',d.evidence_reference,'evidenceVersion',d.evidence_version)) ORDER BY d.dependency_id)
 FROM (SELECT * FROM bop_feature_control.control_dependency WHERE brand_id=v.brand_id AND control_id=v.control_id AND control_version=v.control_version ORDER BY dependency_id LIMIT 257) d),'[]'::jsonb) AS dependencies
 FROM bop_feature_control.control_version v WHERE v.brand_id=$1 AND (v.store_id IS NULL OR v.store_id=$2) AND v.control_key=$3
 ORDER BY v.store_id NULLS FIRST,v.control_id,v.control_version LIMIT 257`;
export interface FeatureControlAdministrationSource {
  readonly brandReference: string;
  readonly storeReference: string | null;
  readonly key: string;
  readonly observedAt: string;
  readonly dependencyCoverage: "Unconfirmed" | "Complete";
  readonly definitions: readonly FeatureControlAdministrationDefinition[];
}
/** Historical load does not grant phase authority. Current callback additionally
 * requires the validated exact-scope FK, RC isolation and owner source barrier.
 * All supported administration writers must take the same Brand barrier exclusive.
 * Authority holds scope/fields through the callback and transaction COMMIT. */
export function createPostgresFeatureControlAdministrationQueryStore(
  runner: KillSwitchQueryTransactionRunner,
  scope: { readonly brandReference: string; readonly storeReference: string | null },
  authorization: FeatureControlAdministrationQueryAuthorization,
) {
  const brand = parseBrandReference(scope.brandReference),
    store = scope.storeReference === null ? null : parseStoreReference(scope.storeReference);
  async function read<T>(
    value: unknown,
    current: boolean,
    work: (source: FeatureControlAdministrationSource) => Promise<T>,
  ): Promise<T> {
    try {
      const raw = record(value, ["actorReference", "purposeCode", "key", "observedAt"]);
      const request = Object.freeze({
        actorReference: parseFeatureControlReference(raw.actorReference),
        purposeCode: parseFeatureControlPurposeCode(raw.purposeCode),
        key: parseFeatureControlKey(raw.key),
        observedAt: parseFeatureControlInstant(raw.observedAt),
        brandReference: brand,
        storeReference: store,
        access: "AdministrationDefinitions" as const,
      });
      let authorityCalls = 0,
        transactionCalls = 0;
      let completed: { readonly value: T } | undefined;
      const result = await authorization.withAuthorizedDefinitionsScope(request, async () => {
        if (++authorityCalls !== 1) return fail();
        const returned = await runner.run(async (tx) => {
          if (++transactionCalls !== 1) return fail();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [brand, store ?? ""],
          );
          if (current) {
            const proof = await tx.query(
              "SELECT current_setting('transaction_isolation')='read committed' AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='bop_feature_control.control_dependency'::regclass AND conname='feature_control_dependency_exact_scope_fkey' AND contype='f' AND convalidated) AS complete",
              [],
            );
            const rows = Object.getOwnPropertyDescriptor(proof, "rows")?.value;
            if (
              !Array.isArray(rows) ||
              rows.length !== 1 ||
              Object.getOwnPropertyDescriptor(rows[0], "complete")?.value !== true
            )
              return fail();
            await tx.query(
              "SELECT pg_advisory_xact_lock_shared(hashtextextended('bop.feature-control:' || $1,0))",
              [brand],
            );
          }
          const queryResult = await tx.query(select, [brand, store, request.key]);
          const rowsDescriptor =
            queryResult && typeof queryResult === "object"
              ? Object.getOwnPropertyDescriptor(queryResult, "rows")
              : undefined;
          if (!rowsDescriptor || !("value" in rowsDescriptor)) return fail();
          const rows = safeCopy(rowsDescriptor.value);
          if (!Array.isArray(rows)) return fail();
          const versions = new Set<string>();
          const definitions = Object.freeze(
            rows.map((item) => {
              const row = record(item, ["definition", "recordedAt", "dependencies"]);
              if (parseFeatureControlInstant(row.recordedAt) > request.observedAt) return fail();
              const definition = createFeatureControlAdministrationDefinition(row.definition);
              if (
                definition.key !== request.key ||
                definition.scope.brandReference !== brand ||
                (definition.scope.storeReference !== null &&
                  definition.scope.storeReference !== store) ||
                !Array.isArray(row.dependencies) ||
                definition.dependencies.length !== 0
              )
                return fail();
              const dependencies = row.dependencies.map((item) => {
                const dep = record(item, ["storeReference", "definition"]);
                if (dep.storeReference !== definition.scope.storeReference) return fail();
                return dep.definition;
              });
              const decoded = createFeatureControlAdministrationDefinition({
                ...definition,
                dependencies,
              });
              const key = `${decoded.controlId}:${decoded.version}`;
              if (versions.has(key)) return fail();
              versions.add(key);
              return decoded;
            }),
          );
          const source = Object.freeze({
            brandReference: brand,
            storeReference: store,
            key: request.key,
            observedAt: request.observedAt,
            dependencyCoverage: current ? ("Complete" as const) : ("Unconfirmed" as const),
            definitions,
          });
          completed = Object.freeze({ value: await work(source) });
          return completed;
        });
        if (!completed || returned !== completed) return fail();
        return returned;
      });
      if (authorityCalls !== 1 || transactionCalls !== 1 || !completed || result !== completed)
        return fail();
      return completed.value;
    } catch {
      return fail();
    }
  }
  return Object.freeze({
    load(value: unknown): Promise<FeatureControlAdministrationSource> {
      return read(value, false, async (source) => source);
    },
    withCurrentDefinitions<T>(
      value: unknown,
      work: (source: FeatureControlAdministrationSource) => Promise<T>,
    ): Promise<T> {
      return read(value, true, work);
    },
  });
}

function queryRows(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d)) return fail();
  const rows = safeCopy(d.value);
  if (!Array.isArray(rows)) return fail();
  return rows;
}
export interface FeatureControlAdministrationMutationOptions {
  readonly brandReference: string;
  readonly storeReference: string | null;
  readonly actorReference: string;
  readonly clock: { now(): string };
  /** Stable server mapping for the service's opaque idempotency key; UUID intents need no mapping. */
  readonly operationReference?: (idempotencyKey: string) => string;
  readonly transactions: { run<T>(work: (tx: AuditTransaction) => Promise<T>): Promise<T> };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: AuditTransaction,
      input: {
        readonly operation: string;
        readonly actorReference: string;
        readonly brandReference: string;
        readonly storeReference: string | null;
        readonly current: FeatureControlAdministrationDefinition;
        readonly next: FeatureControlAdministrationDefinition;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly dependencies: {
    withHeldCurrentPublicationEvidence<T>(
      tx: AuditTransaction,
      input: {
        readonly current: FeatureControlAdministrationDefinition;
        readonly next: FeatureControlAdministrationDefinition;
        readonly observedAt: string;
      },
      work: () => Promise<T>,
    ): Promise<T>;
  };
}
/** Existing approved administration service owns transition intent. This owning
 * writer repeats current authority, exact persisted expected version and atomic
 * append/Audit/replay safeguards. Missing actual approval/dependency leases refuse.
 * Initial definition creation is deliberately a separately authorized command. */
export function createPostgresFeatureControlAdministrationMutationStore(
  options: FeatureControlAdministrationMutationOptions,
): FeatureControlAdministrationPorts["unitOfWork"] {
  const brand = parseBrandReference(options.brandReference),
    store = options.storeReference === null ? null : parseStoreReference(options.storeReference),
    actor = parseFeatureControlReference(options.actorReference);
  return Object.freeze({
    async commit(input) {
      try {
        const current = createFeatureControlAdministrationDefinition(safeCopy(input.current)),
          next = createFeatureControlAdministrationDefinition(safeCopy(input.next));
        const operationReference = parseFeatureControlReference(
            options.operationReference?.(input.idempotencyKey) ?? input.idempotencyKey,
          ),
          now = parseFeatureControlInstant(options.clock.now());
        const audit = validateAuditRecord(safeCopy(input.audit), Date.parse(now));
        const operations: Record<string, string> = {
          "Draft:Draft": "SaveDraft",
          "Draft:PendingApproval": "Submit",
          "PendingApproval:Approved": "Approve",
          "Approved:Published": next.effectiveFrom > now ? "Schedule" : "Publish",
          "Published:Disabled": "Disable",
        };
        const operation = operations[`${current.lifecycle}:${next.lifecycle}`];
        if (
          !operation ||
          current.version !== input.expectedVersion ||
          next.version !== current.version + 1 ||
          current.controlId !== next.controlId ||
          current.key !== next.key ||
          current.scope.brandReference !== brand ||
          next.scope.brandReference !== brand ||
          current.scope.storeReference !== store ||
          next.scope.storeReference !== store ||
          audit.brandId !== brand ||
          (audit.storeId ?? null) !== store ||
          audit.actor.type !== "User" ||
          audit.actor.reference !== actor ||
          audit.targetType !== "FeatureControl" ||
          audit.targetId !== current.controlId ||
          audit.actionCode !== `FEATURE_CONTROL_${operation.toUpperCase()}`
        )
          return fail();
        if (
          current.authoredByReference !== next.authoredByReference ||
          (operation === "Approve" && next.approvedByReference !== actor) ||
          (["Publish", "Schedule", "Disable"].includes(operation) &&
            (current.approvedByReference !== next.approvedByReference ||
              current.approvalEvidenceReference !== next.approvalEvidenceReference))
        )
          return fail();
        const digest =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              operationReference,
              originalIdempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              current,
              next,
              actor,
              auditReference: audit.auditId,
              correlationReference: audit.correlationId,
              reasonCode: audit.reasonCode,
            }),
          );
        let calls = 0;
        let completed: object | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(tx, {
              operation,
              actorReference: actor,
              brandReference: brand,
              storeReference: store,
              current,
              next,
              observedAt: parseFeatureControlInstant(options.clock.now()),
            });
          await authorize();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [brand, store ?? ""],
          );
          const mode = await tx.query("SHOW transaction_isolation", []);
          const modeRows = queryRows(mode);
          if (
            modeRows.length !== 1 ||
            record(modeRows[0], ["transaction_isolation"]).transaction_isolation !==
              "read committed"
          )
            return fail();
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('bop.feature-control:' || $1,0))",
            [brand],
          );
          const prior = await tx.query(
            "SELECT intent_digest,resulting_version FROM bop_feature_control.control_operation WHERE brand_id=$1 AND operation_id=$2",
            [brand, operationReference],
          );
          const priorRows = queryRows(prior);
          if (priorRows.length > 1) return fail();
          if (priorRows.length === 1) {
            const row = record(priorRows[0], ["intent_digest", "resulting_version"]);
            if (
              row.intent_digest !== digest ||
              String(row.resulting_version) !== String(next.version)
            )
              return fail();
            await authorize();
            completed = Object.freeze({});
            return completed;
          }
          const loaded = await tx.query(
            select
              .replace("AND v.control_key=$3", "AND v.control_key=$3 AND v.control_id=$4")
              .replace(
                "ORDER BY v.store_id NULLS FIRST,v.control_id,v.control_version LIMIT 257",
                "ORDER BY v.control_version DESC LIMIT 1",
              ),
            [brand, store, current.key, current.controlId],
          );
          const rows = queryRows(loaded);
          if (!Array.isArray(rows) || rows.length !== 1) return fail();
          const row = record(rows[0], ["definition", "recordedAt", "dependencies"]);
          const dependencies = (row.dependencies as unknown[]).map((v) => {
            const d = record(v, ["storeReference", "definition"]);
            if (d.storeReference !== store) return fail();
            return d.definition;
          });
          const actual = createFeatureControlAdministrationDefinition({
            ...record(row.definition, Object.keys(current)),
            dependencies,
          });
          if (canonicalizeRfc8785(actual) !== canonicalizeRfc8785(current)) return fail();
          let evidenceCalls = 0;
          let appended: object | undefined;
          const append = async () => {
            if (++evidenceCalls !== 1) return fail();
            const priorDependencies = queryRows(
              await tx.query(
                "SELECT DISTINCT control_id FROM bop_feature_control.control_dependency WHERE brand_id=$1 AND dependency_id=ANY($2::uuid[])",
                [brand, next.dependencies.map((d) => d.dependencyId)],
              ),
            );
            if (
              priorDependencies.some((v) => record(v, ["control_id"]).control_id !== next.controlId)
            )
              return fail();
            const insert = async (sql: string, values: readonly unknown[]) => {
              const result = await tx.query(sql, values);
              if (
                !result ||
                typeof result !== "object" ||
                Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1
              )
                return fail();
            };
            await insert(
              "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'ConfigurationMetadata')",
              [
                next.controlId,
                brand,
                store,
                next.key,
                next.version,
                next.description,
                next.ownerReference,
                next.purposeCode,
                next.source,
                next.defaultValue,
                next.configuredValue,
                next.lifecycle,
                next.temporary,
                next.effectiveFrom,
                next.effectiveUntil,
                next.reviewAt,
                next.expiresAt,
                next.authoredByReference,
                next.approvedByReference,
                next.approvalEvidenceReference,
                next.publicationReference,
                now,
              ],
            );
            for (const d of next.dependencies)
              await insert(
                "INSERT INTO bop_feature_control.control_dependency(dependency_id,brand_id,store_id,control_id,control_version,dependency_kind,target_key,minimum_compatible_version,dependency_status,evidence_reference,evidence_version,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ConfigurationMetadata')",
                [
                  d.dependencyId,
                  brand,
                  store,
                  next.controlId,
                  next.version,
                  d.kind,
                  d.targetKey,
                  d.minimumCompatibleVersion,
                  d.status,
                  d.evidenceReference,
                  d.evidenceVersion,
                ],
              );
            const at = parseFeatureControlInstant(options.clock.now());
            if (at < now || Date.parse(at) - Date.parse(now) > 5000) return fail();
            await appendAuditRecordInTransaction(tx, audit);
            await insert(
              "INSERT INTO bop_feature_control.control_operation(operation_id,brand_id,store_id,control_id,command_type,expected_version,resulting_version,intent_digest,actor_reference,purpose_code,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ConfigurationMetadata')",
              [
                operationReference,
                brand,
                store,
                next.controlId,
                operation,
                current.version,
                next.version,
                digest,
                actor,
                next.purposeCode,
                audit.auditId,
                now,
              ],
            );
            await authorize();
            appended = Object.freeze({});
            return appended;
          };
          completed = await options.dependencies.withHeldCurrentPublicationEvidence(
            tx,
            { current, next, observedAt: now },
            append,
          );
          if (evidenceCalls !== 1 || !completed || completed !== appended) return fail();
          await authorize();
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
      } catch {
        throw new FeatureControlAdministrationServiceError("FEATURE_CONTROL_ADMIN_COMMIT_FAILED");
      }
    },
  });
}

export interface FeatureControlInitialDraftOptions {
  readonly brandReference: string;
  readonly storeReference: string | null;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: FeatureControlAdministrationMutationOptions["transactions"];
  readonly authority: {
    /** Resolve actual Tenant/session/Store membership, current action and restricted
     * fields; retain the authority/source fence through the caller transaction. */
    holdUntilTransactionCompletes(
      tx: AuditTransaction,
      input: {
        readonly operation: "CreateDraft";
        readonly action: "feature.control.change";
        readonly actorReference: string;
        readonly brandReference: string;
        readonly storeReference: string | null;
        readonly definition: FeatureControlAdministrationDefinition;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
/** Initial creation is distinct from an existing-version SaveDraft transition.
 * The existing immutable journal records SaveDraft/0/1. This writer creates no
 * approval or dependency evidence and grants no effective capability. */
export function createPostgresFeatureControlInitialDraftStore(
  options: FeatureControlInitialDraftOptions,
) {
  const brand = parseBrandReference(options.brandReference),
    store = options.storeReference === null ? null : parseStoreReference(options.storeReference),
    actor = parseFeatureControlReference(options.actorReference);
  return Object.freeze({
    async createDraft(value: unknown): Promise<FeatureControlAdministrationDefinition> {
      try {
        const input = record(safeCopy(value), ["definition", "idempotencyKey", "audit"]),
          parsed = createFeatureControlAdministrationDefinition(input.definition),
          definition = createFeatureControlAdministrationDefinition({
            ...parsed,
            dependencies: [...parsed.dependencies].sort((a, b) =>
              a.dependencyId < b.dependencyId ? -1 : a.dependencyId > b.dependencyId ? 1 : 0,
            ),
          }),
          operation = parseFeatureControlReference(input.idempotencyKey),
          observedAt = parseFeatureControlInstant(options.clock.now()),
          audit = validateAuditRecord(input.audit, Date.parse(observedAt));
        if (
          definition.version !== 1 ||
          definition.lifecycle !== "Draft" ||
          definition.defaultValue !== "Disabled" ||
          definition.scope.brandReference !== brand ||
          definition.scope.storeReference !== store ||
          definition.authoredByReference !== actor ||
          definition.dependencies.some((d) => d.status !== "Unsatisfied") ||
          audit.brandId !== brand ||
          (audit.storeId ?? null) !== store ||
          audit.actor.type !== "User" ||
          audit.actor.reference !== actor ||
          audit.targetType !== "FeatureControl" ||
          audit.targetId !== definition.controlId ||
          audit.actionCode !== "FEATURE_CONTROL_SAVEDRAFT" ||
          audit.reasonCode !== definition.purposeCode
        )
          return fail();
        const digest =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              operation: "CreateDraft",
              operationId: operation,
              definition,
              audit,
            }),
          );
        let calls = 0;
        let completed: FeatureControlAdministrationDefinition | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const fresh = () => {
            const at = parseFeatureControlInstant(options.clock.now());
            if (at < observedAt || Date.parse(at) - Date.parse(observedAt) >= 5000) return fail();
            return at;
          };
          const authorize = async () => {
            await options.authority.holdUntilTransactionCompletes(tx, {
              operation: "CreateDraft",
              action: "feature.control.change",
              actorReference: actor,
              brandReference: brand,
              storeReference: store,
              definition,
              observedAt: fresh(),
            });
            fresh();
          };
          await authorize();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [brand, store ?? ""],
          );
          const mode = queryRows(await tx.query("SHOW transaction_isolation", []));
          if (
            mode.length !== 1 ||
            record(mode[0], ["transaction_isolation"]).transaction_isolation !== "read committed"
          )
            return fail();
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('bop.feature-control:' || $1,0))",
            [brand],
          );
          const prior = queryRows(
            await tx.query(
              "SELECT intent_digest,resulting_version FROM bop_feature_control.control_operation WHERE brand_id=$1 AND operation_id=$2",
              [brand, operation],
            ),
          );
          if (prior.length > 1) return fail();
          if (prior.length === 1) {
            const row = record(prior[0], ["intent_digest", "resulting_version"]);
            if (row.intent_digest !== digest || String(row.resulting_version) !== "1")
              return fail();
            const rows = queryRows(
              await tx.query(
                select.replace(
                  "AND v.control_key=$3",
                  "AND v.control_key=$3 AND v.control_id=$4 AND v.control_version=1",
                ),
                [brand, store, definition.key, definition.controlId],
              ),
            );
            if (rows.length !== 1) return fail();
            const original = record(rows[0], ["definition", "recordedAt", "dependencies"]);
            if (!Array.isArray(original.dependencies)) return fail();
            const dependencies = original.dependencies.map((v) => {
              const d = record(v, ["storeReference", "definition"]);
              if (d.storeReference !== store) return fail();
              return d.definition;
            });
            const recovered = createFeatureControlAdministrationDefinition({
              ...record(original.definition, Object.keys(definition)),
              dependencies,
            });
            if (canonicalizeRfc8785(recovered) !== canonicalizeRfc8785(definition)) return fail();
            await authorize();
            completed = recovered;
            return completed;
          }
          const existing = queryRows(
            await tx.query(
              "SELECT control_id FROM bop_feature_control.control_version WHERE brand_id=$1 AND (control_id=$2 OR (store_id IS NOT DISTINCT FROM $3::uuid AND control_key=$4)) LIMIT 1",
              [brand, definition.controlId, store, definition.key],
            ),
          );
          if (existing.length !== 0) return fail();
          const dependencyOwners = queryRows(
            await tx.query(
              "SELECT DISTINCT control_id FROM bop_feature_control.control_dependency WHERE brand_id=$1 AND dependency_id=ANY($2::uuid[])",
              [brand, definition.dependencies.map((d) => d.dependencyId)],
            ),
          );
          if (dependencyOwners.length !== 0) return fail();
          await authorize();
          const insert = async (sql: string, values: readonly unknown[]) => {
            const result = await tx.query(sql, values);
            if (
              !result ||
              typeof result !== "object" ||
              Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1
            )
              return fail();
          };
          await insert(
            "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'Disabled',$9,'Draft',$10,$11,$12,$13,$14,$15,NULL,NULL,NULL,$16,'ConfigurationMetadata')",
            [
              definition.controlId,
              brand,
              store,
              definition.key,
              definition.description,
              definition.ownerReference,
              definition.purposeCode,
              definition.source,
              definition.configuredValue,
              definition.temporary,
              definition.effectiveFrom,
              definition.effectiveUntil,
              definition.reviewAt,
              definition.expiresAt,
              actor,
              observedAt,
            ],
          );
          for (const d of definition.dependencies)
            await insert(
              "INSERT INTO bop_feature_control.control_dependency(dependency_id,brand_id,store_id,control_id,control_version,dependency_kind,target_key,minimum_compatible_version,dependency_status,evidence_reference,evidence_version,data_classification) VALUES($1,$2,$3,$4,1,$5,$6,$7,'Unsatisfied',NULL,NULL,'ConfigurationMetadata')",
              [
                d.dependencyId,
                brand,
                store,
                definition.controlId,
                d.kind,
                d.targetKey,
                d.minimumCompatibleVersion,
              ],
            );
          await appendAuditRecordInTransaction(tx, audit);
          await insert(
            "INSERT INTO bop_feature_control.control_operation(operation_id,brand_id,store_id,control_id,command_type,expected_version,resulting_version,intent_digest,actor_reference,purpose_code,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,'SaveDraft',0,1,$5,$6,$7,$8,$9,'ConfigurationMetadata')",
            [
              operation,
              brand,
              store,
              definition.controlId,
              digest,
              actor,
              definition.purposeCode,
              audit.auditId,
              observedAt,
            ],
          );
          await authorize();
          completed = definition;
          return completed;
        });
        if (calls !== 1 || !completed || !Object.is(result, completed)) return fail();
        return completed;
      } catch {
        throw new FeatureControlAdministrationServiceError("FEATURE_CONTROL_ADMIN_COMMIT_FAILED");
      }
    },
  });
}
