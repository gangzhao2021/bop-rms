import {
  parsePlatformTenantReference,
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
} from "@bop/tenant";
import {
  createStoreConfigurationAdministrationService,
  StoreConfigurationAdministrationServiceError,
} from "../../application/store-configuration-administration-service.js";
import type {
  StoreConfigurationAdministrationPorts,
  StoreConfigurationOperation,
} from "../../application/ports/store-configuration-administration-ports.js";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
  type StoreConfigurationVersion,
} from "../../contracts/store-configuration-administration.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Commit = Parameters<StoreConfigurationAdministrationPorts["repository"]["commit"]>[0];
const unavailable = (): never => {
  throw new StoreConfigurationAdministrationServiceError(
    "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  );
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    return unavailable();
  return descriptor.value;
}
function parsedOperation(row: Record<string, unknown>): StoreConfigurationOperation {
  const configuration = createStoreConfigurationVersion(row.configuration_json);
  if (
    !["SaveDraft", "Validate", "Submit", "Approve", "Publish"].includes(String(row.command_type)) ||
    typeof row.intent_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.intent_digest)
  )
    return unavailable();
  return Object.freeze({
    command: row.command_type as StoreConfigurationOperation["command"],
    operationReference: parseStoreAdministrationReference(row.operation_id),
    brandReference: configuration.brandReference,
    storeReference: configuration.storeReference,
    intentDigest: row.intent_digest,
    resultingVersion: configuration.configurationVersion,
    configuration,
  });
}
/** One transaction and authoring fence cover all owner validation, history and Audit.
 * Public-owner policy/publication callbacks must fence their current sources in tx.
 */
export function createPostgresStoreConfigurationAdministration(options: {
  brandReference: string;
  storeReference: string;
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  ports(tx: Transaction): Omit<StoreConfigurationAdministrationPorts, "repository">;
  publishedBaseline(tx: Transaction): Promise<StoreConfigurationVersion | null>;
  appendAudit(tx: Transaction, input: Commit): Promise<void>;
  materializePublication(tx: Transaction, input: Commit): Promise<void>;
}) {
  const brand = parseBrandReference(options.brandReference),
    store = parseStoreReference(options.storeReference);
  const execute = (
    method: keyof ReturnType<typeof createStoreConfigurationAdministrationService>,
    raw: unknown,
  ) =>
    options.run(async (tx) => {
      const ports = options.ports(tx);
      let locked = false,
        sequence = 0;
      let current: StoreConfigurationVersion | null = null;
      async function fence() {
        if (locked) return;
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        await tx.query(
          "LOCK TABLE rms_store.store_configuration_authoring_operation IN SHARE ROW EXCLUSIVE MODE",
          [],
        );
        locked = true;
      }
      const authorization: StoreConfigurationAdministrationPorts["authorization"] = {
        authorize: async (input) =>
          input.brandReference === brand &&
          input.storeReference === store &&
          (await ports.authorization.authorize(input)) === true,
      };
      const service = createStoreConfigurationAdministrationService({
        ...ports,
        authorization,
        repository: {
          async resolveOperation(reference) {
            await fence();
            const found = rows(
              await tx.query(
                "SELECT operation_id,command_type,intent_digest,configuration_json FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
                [brand, store, reference],
              ),
            );
            if (found.length > 1) return unavailable();
            return found[0] ? parsedOperation(found[0]) : null;
          },
          async loadLatest(requestedBrand, requestedStore) {
            if (requestedBrand !== brand || requestedStore !== store) return unavailable();
            await fence();
            const latest = rows(
              await tx.query(
                "SELECT sequence_number,configuration_json FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 ORDER BY sequence_number DESC LIMIT 1",
                [brand, store],
              ),
            )[0];
            if (latest) {
              if (
                typeof latest.sequence_number !== "string" ||
                !/^[1-9][0-9]*$/u.test(latest.sequence_number)
              )
                return unavailable();
              sequence = Number(latest.sequence_number);
              if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER)
                return unavailable();
              current = createStoreConfigurationVersion(latest.configuration_json);
            } else {
              const baseline = await options.publishedBaseline(tx);
              current = baseline === null ? null : createStoreConfigurationVersion(baseline);
              if (current !== null && current.lifecycle !== "Published") return unavailable();
            }
            if (
              current !== null &&
              (current.brandReference !== brand || current.storeReference !== store)
            )
              return unavailable();
            return current;
          },
          async commit(input) {
            const op = input.operation,
              config = op.configuration;
            if (
              !locked ||
              op.brandReference !== brand ||
              op.storeReference !== store ||
              config.brandReference !== brand ||
              config.storeReference !== store ||
              (current?.configurationVersion ?? 0) !== input.expectedVersion
            )
              return unavailable();
            if (
              !(await authorization.authorize({
                command: op.command,
                brandReference: brand,
                storeReference: store,
                actorReference: input.audit.actorReference,
                purposeCode: input.audit.purposeCode,
                observedAt: input.audit.occurredAt,
              }))
            )
              throw new StoreConfigurationAdministrationServiceError(
                "STORE_CONFIGURATION_PERMISSION_DENIED",
              );
            await tx.query(
              "INSERT INTO rms_store.store_configuration_authoring_operation VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,'ConfigurationMetadata')",
              [
                op.operationReference,
                brand,
                store,
                sequence + 1,
                config.configurationReference,
                config.configurationVersion,
                op.command,
                config.lifecycle,
                input.expectedVersion,
                op.intentDigest,
                JSON.stringify(config),
                input.audit.actorReference,
                input.audit.purposeCode,
                input.audit.auditReference,
                input.audit.occurredAt,
              ],
            );
            if (op.command === "Publish") await options.materializePublication(tx, input);
            await options.appendAudit(tx, input);
            return op;
          },
        },
      });
      return service[method](raw);
    });
  return Object.freeze({
    saveDraft: (raw: unknown) => execute("saveDraft", raw),
    validate: (raw: unknown) => execute("validate", raw),
    submit: (raw: unknown) => execute("submit", raw),
    approve: (raw: unknown) => execute("approve", raw),
    publish: (raw: unknown) => execute("publish", raw),
  });
}

/** Latest administration state, not proof of effective published configuration.
 * Caller must retain transaction and current authorization fence while composing
 * this with the independently verified current publication.
 */
export function createPostgresStoreConfigurationAuthoringSource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly mode?: "Read" | "Write";
  authorize(tx: Transaction, observedAt: string): Promise<boolean>;
}) {
  const readMode = () => {
    const descriptor = Object.getOwnPropertyDescriptor(options, "mode");
    if (descriptor && (!("value" in descriptor) || !descriptor.enumerable)) return unavailable();
    const value = descriptor?.value ?? "Read";
    if (value !== "Read" && value !== "Write") return unavailable();
    return value;
  };
  const mode = readMode();
  const brand = parseBrandReference(options.brandReference),
    store = parseStoreReference(options.storeReference);
  return async (tx: Transaction, now: string): Promise<StoreConfigurationVersion | null> => {
    try {
      const at = parseCanonicalInstant(now);
      if (readMode() !== mode) return unavailable();
      if ((await options.authorize(tx, at)) !== true || readMode() !== mode) return unavailable();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query(
        mode === "Write"
          ? "LOCK TABLE rms_store.store_configuration_authoring_operation IN SHARE ROW EXCLUSIVE MODE"
          : "LOCK TABLE rms_store.store_configuration_authoring_operation IN SHARE MODE",
        [],
      );
      const result = rows(
        await tx.query(
          "SELECT sequence_number,configuration_json,occurred_at FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 ORDER BY sequence_number DESC LIMIT 1",
          [brand, store],
        ),
      );
      if (result.length > 1) return unavailable();
      let configuration: StoreConfigurationVersion | null = null;
      const latest = result[0];
      if (latest) {
        if (
          typeof latest.sequence_number !== "string" ||
          !/^[1-9][0-9]*$/u.test(latest.sequence_number) ||
          !Number.isSafeInteger(Number(latest.sequence_number)) ||
          !(latest.occurred_at instanceof Date) ||
          !Number.isFinite(latest.occurred_at.getTime()) ||
          latest.occurred_at.toISOString() > at
        )
          return unavailable();
        configuration = createStoreConfigurationVersion(latest.configuration_json);
        if (
          configuration.brandReference !== brand ||
          configuration.storeReference !== store ||
          configuration.createdAt > at ||
          configuration.updatedAt > at
        )
          return unavailable();
      }
      if ((await options.authorize(tx, at)) !== true || readMode() !== mode) return unavailable();
      return configuration;
    } catch {
      return unavailable();
    }
  };
}

export const storeConfigurationHistoryRequiredFields = Object.freeze([
  "sequenceNumber",
  "operationReference",
  "command",
  "configuration",
  "intentDigest",
  "actorReference",
  "purposeCode",
  "auditReference",
  "occurredAt",
  "expectedVersion",
] as const);
export interface StoreConfigurationHistoryEntry {
  readonly sequenceNumber: number;
  readonly operationReference: string;
  readonly command: StoreConfigurationOperation["command"];
  readonly configuration: StoreConfigurationVersion;
  /** The stored legacy digest. This reader does not reconstruct its preimage. */
  readonly intentDigest: string;
  readonly actorReference: string;
  readonly purposeCode: string;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly expectedVersion: number;
}
export interface StoreConfigurationHistoryPage {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly readerActorReference: string;
  readonly beforeSequence: number | null;
  readonly entries: readonly StoreConfigurationHistoryEntry[];
  readonly nextBeforeSequence: number | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface StoreConfigurationHistorySourceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly readerActorReference: string;
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly canonicalize: (value: unknown) => string;
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => void | Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: Transaction,
      request: Readonly<{
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
        permission: "store.service.read";
        purposeCode: "STORE_CONFIGURATION_HISTORY";
        requiredFields: typeof storeConfigurationHistoryRequiredFields;
        observedAt: string;
        validUntil: string;
      }>,
    ): Promise<{ readonly validUntil: string }>;
  };
}
/** Two complete immutable configurations per page; the third row is only a
 * pagination probe. The current reader is independent of each original author.
 * The caller's real transaction runner owns COMMIT and rollback. */
export function createPostgresStoreConfigurationHistorySource(
  options: StoreConfigurationHistorySourceOptions,
) {
  const own = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length
    )
      return unavailable();
    const result: Record<string, unknown> = {};
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
      result[key] = descriptor.value;
    }
    return result;
  };
  const scalar = (key: keyof StoreConfigurationHistorySourceOptions) => {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
    return descriptor.value;
  };
  const fixed = Object.freeze({
    tenantReference: parsePlatformTenantReference(scalar("tenantReference")),
    brandReference: parseBrandReference(scalar("brandReference")),
    storeReference: parseStoreReference(scalar("storeReference")),
    readerActorReference: parseStoreAdministrationReference(scalar("readerActorReference")),
  });
  const tx: Transaction = scalar("transaction"),
    clock: StoreConfigurationHistorySourceOptions["clock"] = scalar("clock"),
    authority: StoreConfigurationHistorySourceOptions["authority"] = scalar("authority"),
    register: StoreConfigurationHistorySourceOptions["registerBeforeCommit"] =
      scalar("registerBeforeCommit"),
    canonicalize: StoreConfigurationHistorySourceOptions["canonicalize"] = scalar("canonicalize");
  const now = Object.getOwnPropertyDescriptor(clock, "now")?.value,
    hold = Object.getOwnPropertyDescriptor(authority, "holdUntilTransactionCompletes")?.value,
    query = Object.getOwnPropertyDescriptor(tx, "query")?.value;
  if (
    typeof now !== "function" ||
    typeof hold !== "function" ||
    typeof query !== "function" ||
    typeof register !== "function" ||
    typeof canonicalize !== "function"
  )
    return unavailable();
  const origin = parseCanonicalInstant(scalar("originalObservedAt")),
    originalDeadline = parseCanonicalInstant(scalar("originalValidUntil"));
  if (originalDeadline <= origin || Date.parse(originalDeadline) - Date.parse(origin) > 5000)
    return unavailable();
  let deadline: string = originalDeadline,
    last: string = origin,
    active = false,
    failed = false,
    registered = false,
    guarded = false,
    finalized = false;
  let selector: number | null | undefined, stable: string | undefined;
  const captured = () => {
    if (
      scalar("transaction") !== tx ||
      scalar("clock") !== clock ||
      scalar("authority") !== authority ||
      scalar("registerBeforeCommit") !== register ||
      scalar("canonicalize") !== canonicalize ||
      scalar("originalObservedAt") !== origin ||
      scalar("originalValidUntil") !== originalDeadline ||
      Object.getOwnPropertyDescriptor(clock, "now")?.value !== now ||
      Object.getOwnPropertyDescriptor(authority, "holdUntilTransactionCompletes")?.value !== hold ||
      Object.getOwnPropertyDescriptor(tx, "query")?.value !== query ||
      Object.entries(fixed).some(
        ([key, value]) => Object.getOwnPropertyDescriptor(options, key)?.value !== value,
      )
    )
      return unavailable();
  };
  const check = () => {
    captured();
    if (failed) return unavailable();
    const at = parseCanonicalInstant(now.call(clock));
    if (at < last || at >= deadline) return unavailable();
    last = at;
    return at;
  };
  const sql = async (text: string, values: readonly unknown[]) => {
    check();
    const value = await query.call(tx, text, values);
    check();
    return value;
  };
  const holdCurrent = async () => {
    const observedAt = check(),
      packet = await hold.call(
        authority,
        tx,
        Object.freeze({
          tenantReference: fixed.tenantReference,
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          actorReference: fixed.readerActorReference,
          permission: "store.service.read",
          purposeCode: "STORE_CONFIGURATION_HISTORY",
          requiredFields: storeConfigurationHistoryRequiredFields,
          observedAt,
          validUntil: deadline,
        }),
      );
    check();
    const parsed = own(packet, ["validUntil"]),
      until = parseCanonicalInstant(parsed.validUntil);
    if (until > deadline || until <= last) return unavailable();
    deadline = until;
    check();
  };
  const number = (value: unknown, zero = false) => {
    if (
      typeof value !== "string" ||
      !(zero ? /^(0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u).test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      return unavailable();
    return Number(value);
  };
  const columns = [
    "sequence_number",
    "operation_id",
    "command_type",
    "configuration_json",
    "intent_digest",
    "actor_reference",
    "purpose_code",
    "audit_reference",
    "occurred_at",
    "expected_version",
    "configuration_id",
    "configuration_version",
    "lifecycle",
    "data_classification",
  ];
  const entry = (raw: unknown, observedAt: string): StoreConfigurationHistoryEntry => {
    const row = own(raw, columns),
      configuration = createStoreConfigurationVersion(row.configuration_json),
      command = row.command_type;
    if (
      command !== "SaveDraft" &&
      command !== "Validate" &&
      command !== "Submit" &&
      command !== "Approve" &&
      command !== "Publish"
    )
      return unavailable();
    const version = number(row.configuration_version),
      expectedVersion = number(row.expected_version, true),
      at = (() => {
        try {
          return parseCanonicalInstant(row.occurred_at);
        } catch {
          return unavailable();
        }
      })(),
      actor = parseStoreAdministrationReference(row.actor_reference);
    if (
      configuration.brandReference !== fixed.brandReference ||
      configuration.storeReference !== fixed.storeReference ||
      configuration.configurationReference !== row.configuration_id ||
      configuration.configurationVersion !== version ||
      expectedVersion !== version - (command === "SaveDraft" ? 1 : 0) ||
      configuration.lifecycle !== row.lifecycle ||
      row.data_classification !== "ConfigurationMetadata" ||
      configuration.updatedAt > at ||
      configuration.createdAt > at ||
      at > observedAt ||
      (configuration.setupBasis?.tenantReference !== undefined &&
        configuration.setupBasis.tenantReference !== fixed.tenantReference) ||
      typeof row.intent_digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(row.intent_digest) ||
      typeof row.purpose_code !== "string" ||
      !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(row.purpose_code)
    )
      return unavailable();
    const lifecycle =
      command === "SaveDraft" || command === "Validate"
        ? "Draft"
        : command === "Submit"
          ? "PendingApproval"
          : command === "Approve"
            ? "Approved"
            : "Published";
    if (configuration.lifecycle !== lifecycle) return unavailable();
    return Object.freeze({
      sequenceNumber: number(row.sequence_number),
      operationReference: parseStoreAdministrationReference(row.operation_id),
      command,
      configuration,
      intentDigest: row.intent_digest,
      actorReference: actor,
      purposeCode: row.purpose_code,
      auditReference: parseStoreAdministrationReference(row.audit_reference),
      occurredAt: at,
      expectedVersion,
    });
  };
  const load = async () => {
    await holdCurrent();
    await sql(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [fixed.tenantReference, fixed.brandReference, fixed.storeReference],
    );
    await sql("LOCK TABLE rms_store.store_configuration_authoring_operation IN SHARE MODE", []);
    const observedAt = check();
    const result = rows(
      await sql(
        "SELECT sequence_number::text sequence_number,operation_id,command_type,configuration_json,intent_digest,actor_reference,purpose_code,audit_reference,CASE WHEN occurred_at=date_trunc('milliseconds',occurred_at) THEN to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') ELSE NULL END occurred_at,expected_version::text expected_version,configuration_id,configuration_version::text configuration_version,lifecycle,data_classification FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 AND ($3::bigint IS NULL OR sequence_number<$3) ORDER BY sequence_number DESC LIMIT 3",
        [fixed.brandReference, fixed.storeReference, selector],
      ),
    );
    if (result.length > 3 || Reflect.ownKeys(result).length !== result.length + 1)
      return unavailable();
    const parsed: StoreConfigurationHistoryEntry[] = [];
    for (let i = 0; i < result.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(result, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
      parsed.push(entry(descriptor.value, observedAt));
    }
    for (let i = 0; i < parsed.length; i++) {
      const current = parsed[i],
        previous = parsed[i - 1];
      if (
        !current ||
        current.sequenceNumber >=
          (previous?.sequenceNumber ?? selector ?? Number.MAX_SAFE_INTEGER + 1)
      )
        return unavailable();
    }
    const entries = Object.freeze(parsed.slice(0, 2)),
      nextBeforeSequence =
        parsed.length === 3 ? (entries[1]?.sequenceNumber ?? unavailable()) : null;
    const identity = canonicalize.call(options, { entries, nextBeforeSequence });
    check();
    if (typeof identity !== "string" || new TextEncoder().encode(identity).byteLength > 8388608)
      return unavailable();
    return {
      identity,
      page: Object.freeze({
        ...fixed,
        beforeSequence: selector ?? null,
        entries,
        nextBeforeSequence,
        observedAt,
        validUntil: deadline,
      }),
    };
  };
  const protect = async <T>(work: () => Promise<T>) => {
    try {
      if (active || guarded || failed) return unavailable();
      active = true;
      return await work();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    readPage: (value: unknown) =>
      protect(async () => {
        const request = own(value, ["beforeSequence"]),
          before = request.beforeSequence;
        if (
          before !== null &&
          (typeof before !== "number" || !Number.isSafeInteger(before) || before < 1)
        )
          return unavailable();
        if (selector !== undefined && selector !== before) return unavailable();
        selector = before;
        if (!registered) {
          registered = true;
          const returned = await register.call(
            options,
            tx,
            async () => {
              try {
                if (active || failed || guarded) return unavailable();
                const fresh = await load();
                if (fresh.identity !== stable) return unavailable();
                guarded = true;
              } catch (error) {
                failed = true;
                throw error;
              }
            },
            () => {
              try {
                if (!guarded || failed || finalized) return unavailable();
                check();
                finalized = true;
              } catch (error) {
                failed = true;
                throw error;
              }
            },
          );
          if (returned !== undefined) return unavailable();
        }
        const loaded = await load();
        if (stable !== undefined && loaded.identity !== stable) return unavailable();
        stable = loaded.identity;
        return loaded.page;
      }),
    assertFinalized(actual: Transaction) {
      try {
        if (actual !== tx || !registered || !guarded || !finalized || active || failed)
          return unavailable();
        check();
        return deadline;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  });
}
