import { parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
} from "../../contracts/store-configuration-administration.js";
import {
  StoreConfigurationOriginalError,
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
  parseStoreConfigurationOrdinaryReceipt,
  type StoreConfigurationOrdinaryCommand,
  type StoreConfigurationOrdinaryResolve,
  type StoreConfigurationOrdinaryReceipt,
  type StoreConfigurationOriginalScope,
} from "../../contracts/store-configuration-original.js";
import type { StoreConfigurationFreshPreparationInput } from "../../application/ports/store-configuration-administration-ports.js";
export interface StoreConfigurationOriginalTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Mode = "ReadOriginal" | "RecordCommitted" | "Resolve";
export const storeConfigurationOriginalRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "operationReference",
  "action",
  "expectedHead",
  "setupSelector",
  "reasonCode",
  "intentDigest",
  "outcome",
  "operation",
  "auditReference",
  "occurredAt",
  "dataClassification",
] as const);
export interface StoreConfigurationOriginalStoreOptions extends StoreConfigurationOriginalScope {
  readonly transaction: StoreConfigurationOriginalTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: StoreConfigurationOriginalTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => void | Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: StoreConfigurationOriginalTransaction,
      input: Readonly<
        StoreConfigurationOriginalScope & {
          mode: Mode;
          action: StoreConfigurationOrdinaryCommand["action"];
          purposeCode: "STORE_CONFIGURATION";
          requiredFields: typeof storeConfigurationOriginalRequiredFields;
          command: StoreConfigurationOrdinaryCommand;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{ readonly validUntil: string }>;
  };
  readonly references: {
    canonicalize(value: unknown): string;
    hashIntent(text: string): string;
    nextReference(kind: "Audit"): string;
  };
  readonly appendAbandonedAudit: (
    tx: StoreConfigurationOriginalTransaction,
    input: Readonly<
      StoreConfigurationOriginalScope & {
        operationReference: string;
        action: StoreConfigurationOrdinaryCommand["action"];
        intentDigest: string;
        auditReference: string;
        occurredAt: string;
        purposeCode: "STORE_CONFIGURATION";
        dataClassification: "ConfigurationMetadata";
      }
    >,
  ) => Promise<void>;
}
const columns =
  "operation_id,tenant_id,brand_id,store_id,actor_id,action_code,intent_digest,command_json,outcome,committed_operation_id,legacy_input_json,legacy_intent_digest,receipt_json,receipt_digest,audit_reference,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') occurred_at,data_classification";
const legacyColumns =
  "operation_id,command_type,intent_digest,configuration_json,actor_reference,purpose_code,audit_reference,expected_version::text expected_version,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') occurred_at";
/** Borrowed transaction, immutable originals only. Actual scope association and
 * fine permission come from the held authority. This is not review qualification. */
export function createPostgresStoreConfigurationOriginalStore(
  options: StoreConfigurationOriginalStoreOptions,
) {
  const tx = options.transaction,
    query = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.holdUntilTransactionCompletes,
    refs = options.references,
    canonicalize = refs.canonicalize,
    hashIntent = refs.hashIntent,
    nextReference = refs.nextReference,
    register = options.registerBeforeCommit,
    appendAudit = options.appendAbandonedAudit;
  const fixed = Object.freeze({
    tenantReference: options.tenantReference,
    brandReference: options.brandReference,
    storeReference: options.storeReference,
    actorReference: options.actorReference,
  });
  const origin = parseCanonicalInstant(options.originalObservedAt),
    originalUntil = parseCanonicalInstant(options.originalValidUntil);
  let deadline: string = originalUntil,
    last: string = origin,
    failed = false,
    active = false,
    registered = false,
    guardDone = false,
    finalDone = false;
  let phase: "Work" | "Checks" | "Final" = "Work",
    command: StoreConfigurationOrdinaryCommand | null = null;
  let observed: StoreConfigurationOrdinaryReceipt | null | undefined,
    written = false;
  const modes = new Set<Mode>();
  const fail = (
    code: StoreConfigurationOriginalError["code"] = "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new StoreConfigurationOriginalError(code);
  };
  if (
    Date.parse(originalUntil) - Date.parse(origin) > 5000 ||
    originalUntil <= origin ||
    ![query, now, hold, canonicalize, hashIntent, nextReference, register, appendAudit].every(
      (p) => typeof p === "function",
    )
  )
    return fail();
  const check = () => {
    if (
      failed ||
      options.transaction !== tx ||
      tx.query !== query ||
      options.clock !== clock ||
      clock.now !== now ||
      options.authority !== authority ||
      authority.holdUntilTransactionCompletes !== hold ||
      options.references !== refs ||
      refs.canonicalize !== canonicalize ||
      refs.hashIntent !== hashIntent ||
      refs.nextReference !== nextReference ||
      options.registerBeforeCommit !== register ||
      options.appendAbandonedAudit !== appendAudit ||
      Object.entries(fixed).some(
        ([k, v]) => Object.getOwnPropertyDescriptor(options, k)?.value !== v,
      ) ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil
    )
      return fail();
    const at = parseCanonicalInstant(now.call(clock));
    if (at < last || at >= deadline) return fail();
    last = at;
    return at;
  };
  const canonical = (v: unknown) => {
    check();
    const text = canonicalize.call(refs, v);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 2101248) return fail();
    check();
    return text;
  };
  const digestText = (text: string) => {
    check();
    const value = hashIntent.call(refs, text);
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail();
    check();
    return value;
  };
  const digest = (v: unknown) => digestText(canonical(v));
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const sql = async (text: string, values: readonly unknown[] = []) => {
    check();
    const result = await query.call(tx, text, values);
    check();
    return result;
  };
  const rows = (v: unknown): readonly Record<string, unknown>[] => {
    if (!v || typeof v !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(v, "rows");
    if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1) return fail();
    return Array.from({ length: d.value.length }, (_, i) => {
      const member = Object.getOwnPropertyDescriptor(d.value, String(i));
      if (
        !member?.enumerable ||
        !("value" in member) ||
        !member.value ||
        typeof member.value !== "object" ||
        Object.getPrototypeOf(member.value) !== Object.prototype
      )
        return fail();
      const row: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(member.value)) {
        if (typeof key !== "string") return fail();
        const field = Object.getOwnPropertyDescriptor(member.value, key);
        if (!field?.enumerable || !("value" in field)) return fail();
        row[key] = field.value;
      }
      return row;
    });
  };
  const restore = async () => {
    await sql(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [fixed.tenantReference, fixed.brandReference, fixed.storeReference],
    );
    const remaining = Math.floor(Date.parse(deadline) - Date.parse(check()));
    if (remaining < 1) return fail();
    await sql("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [
      remaining + "ms",
    ]);
  };
  const current = async (mode: Mode) => {
    if (!command) return fail();
    const at = check();
    const packet = await hold.call(
      authority,
      tx,
      Object.freeze({
        ...fixed,
        mode,
        action: command.action,
        purposeCode: "STORE_CONFIGURATION",
        requiredFields: storeConfigurationOriginalRequiredFields,
        command,
        observedAt: at,
        validUntil: deadline,
      }),
    );
    check();
    const d = packet && Object.getOwnPropertyDescriptor(packet, "validUntil");
    if (!packet || Reflect.ownKeys(packet).length !== 1 || !d?.enumerable || !("value" in d))
      return fail();
    const until = parseCanonicalInstant(d.value);
    if (until > deadline || until <= last) return fail();
    deadline = until;
    check();
  };
  const fence = async () => {
    if (!command) return fail();
    await restore();
    await sql("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "StoreConfigurationOriginal:" + command.operationReference,
    ]);
  };
  const actualLegacy = async () => {
    if (!command) return fail();
    await restore();
    return (
      rows(
        await sql(
          `SELECT ${legacyColumns} FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`,
          [fixed.brandReference, fixed.storeReference, command.operationReference],
        ),
      )[0] ?? null
    );
  };
  const parseLegacyPreimage = (value: unknown) => {
    const fields = [
      "command",
      "operationReference",
      "actorReference",
      "purposeCode",
      "auditReference",
      "expectedVersion",
      "configuration",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length
    )
      return fail();
    const p: Record<string, unknown> = {};
    for (const key of fields) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      p[key] = d.value;
    }
    const selected = p.command;
    if (
      selected !== "SaveDraft" &&
      selected !== "Validate" &&
      selected !== "Submit" &&
      selected !== "Approve" &&
      selected !== "Publish"
    )
      return fail();
    if (
      p.purposeCode !== "STORE_CONFIGURATION" ||
      typeof p.expectedVersion !== "number" ||
      !Number.isSafeInteger(p.expectedVersion) ||
      p.expectedVersion < 0
    )
      return fail();
    return Object.freeze({
      command: selected,
      operationReference: parseStoreAdministrationReference(p.operationReference),
      actorReference: parseStoreAdministrationReference(p.actorReference),
      purposeCode: p.purposeCode,
      auditReference: parseStoreAdministrationReference(p.auditReference),
      expectedVersion: p.expectedVersion,
      configuration: createStoreConfigurationVersion(p.configuration),
    });
  };
  const legacyPreimage = (
    original: StoreConfigurationFreshPreparationInput,
    action: StoreConfigurationOrdinaryCommand["action"],
  ) => {
    const fields = [
      "operationReference",
      "actorReference",
      "purposeCode",
      "auditReference",
      "expectedVersion",
      "occurredAt",
      "configuration",
    ];
    if (
      !original ||
      Object.getPrototypeOf(original) !== Object.prototype ||
      Reflect.ownKeys(original).length !== fields.length ||
      fields.some((k) => {
        const d = Object.getOwnPropertyDescriptor(original, k);
        return !d?.enumerable || !("value" in d);
      })
    )
      return fail();
    const at = parseCanonicalInstant(original.occurredAt);
    if (at < origin || at > check()) return fail();
    return parseLegacyPreimage({
      command: action === "Materialize" ? "SaveDraft" : action,
      operationReference: original.operationReference,
      actorReference: original.actorReference,
      purposeCode: original.purposeCode,
      auditReference: original.auditReference,
      expectedVersion: original.expectedVersion,
      configuration: original.configuration,
    });
  };
  const verifyLegacy = async (
    receipt: StoreConfigurationOrdinaryReceipt,
    preimage: unknown,
    legacyDigest: unknown,
  ) => {
    const row = await actualLegacy();
    if (
      !row ||
      !receipt.operation ||
      !preimage ||
      typeof preimage !== "object" ||
      Reflect.ownKeys(preimage).length !== 7
    )
      return fail();
    // Legacy fixed JSON property order is intentionally distinct from RFC8785.
    const original = parseLegacyPreimage(preimage);
    const oldDigest = digestText(JSON.stringify(original));
    if (
      row.operation_id !== receipt.operationReference ||
      row.actor_reference !== fixed.actorReference ||
      row.command_type !== original.command ||
      row.purpose_code !== "STORE_CONFIGURATION" ||
      row.audit_reference !== receipt.auditReference ||
      row.occurred_at !== receipt.occurredAt ||
      String(original.expectedVersion) !== row.expected_version ||
      original.operationReference !== receipt.operationReference ||
      original.actorReference !== fixed.actorReference ||
      original.auditReference !== receipt.auditReference ||
      original.purposeCode !== "STORE_CONFIGURATION" ||
      original.expectedVersion !== receipt.expectedHead.configurationVersion ||
      oldDigest !== legacyDigest ||
      oldDigest !== row.intent_digest ||
      oldDigest !== receipt.operation.intentDigest ||
      !same(
        createStoreConfigurationVersion(row.configuration_json),
        receipt.operation.configuration,
      )
    )
      return fail();
  };
  const lookup = async () => {
    if (!command) return fail();
    await restore();
    const row = rows(
      await sql(
        `SELECT ${columns} FROM rms_store.store_configuration_original_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4`,
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          command.operationReference,
        ],
      ),
    )[0];
    if (!row) return null;
    if (row.actor_id !== fixed.actorReference)
      return fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
    const receipt = parseStoreConfigurationOrdinaryReceipt(row.receipt_json);
    const body = { ...receipt, profile: "StoreConfigurationOrdinaryCommandV1" };
    for (const key of [
      "intentDigest",
      "outcome",
      "operation",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ])
      Reflect.deleteProperty(body, key);
    if (
      !same(parseStoreConfigurationOrdinaryCommand(body), command) ||
      receipt.intentDigest !== digest(command) ||
      row.intent_digest !== receipt.intentDigest ||
      row.receipt_digest !== digest(receipt) ||
      !same(row.command_json, command) ||
      row.outcome !== receipt.outcome ||
      row.operation_id !== receipt.operationReference ||
      row.action_code !== receipt.action ||
      row.tenant_id !== fixed.tenantReference ||
      row.brand_id !== fixed.brandReference ||
      row.store_id !== fixed.storeReference ||
      row.audit_reference !== receipt.auditReference ||
      row.occurred_at !== receipt.occurredAt ||
      row.data_classification !== "ConfigurationMetadata" ||
      receipt.occurredAt > check() ||
      !same(
        { ...fixed },
        {
          tenantReference: receipt.tenantReference,
          brandReference: receipt.brandReference,
          storeReference: receipt.storeReference,
          actorReference: receipt.actorReference,
        },
      )
    )
      return fail("STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT");
    if (receipt.outcome === "Committed") {
      if (row.committed_operation_id !== receipt.operationReference) return fail();
      await verifyLegacy(receipt, row.legacy_input_json, row.legacy_intent_digest);
    } else if (
      row.committed_operation_id !== null ||
      row.legacy_input_json !== null ||
      row.legacy_intent_digest !== null ||
      (await actualLegacy())
    )
      return fail();
    return receipt;
  };
  const insert = async (receipt: StoreConfigurationOrdinaryReceipt, preimage: unknown | null) => {
    if (!command) return fail();
    await restore();
    const result = await sql(
      "INSERT INTO rms_store.store_configuration_original_operation(operation_id,tenant_id,brand_id,store_id,actor_id,action_code,intent_digest,command_json,outcome,committed_operation_id,legacy_input_json,legacy_intent_digest,receipt_json,receipt_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,'ConfigurationMetadata')",
      [
        receipt.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.storeReference,
        fixed.actorReference,
        receipt.action,
        receipt.intentDigest,
        canonical(command),
        receipt.outcome,
        receipt.outcome === "Committed" ? receipt.operationReference : null,
        preimage === null ? null : JSON.stringify(preimage),
        receipt.operation?.intentDigest ?? null,
        canonical(receipt),
        digest(receipt),
        receipt.auditReference,
        receipt.occurredAt,
      ],
    );
    const count =
      result && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rowCount")
        : null;
    if (count?.value !== 1) return fail();
    written = true;
    observed = receipt;
    if (!same(await lookup(), receipt)) return fail();
  };
  const admit = async (raw: StoreConfigurationOrdinaryCommand, mode: Mode) => {
    if (active || phase !== "Work") return fail();
    active = true;
    if (
      Object.entries(fixed).some(
        ([key, v]) => Object.getOwnPropertyDescriptor(raw, key)?.value !== v,
      )
    )
      return fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
    if (command && !same(command, raw))
      return fail("STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT");
    command = raw;
    modes.add(mode);
    if (!registered) {
      registered = true;
      const returned = await register.call(
        options,
        tx,
        async () => {
          try {
            if (active || phase !== "Work" || guardDone) return fail();
            phase = "Checks";
            for (const m of modes) await current(m);
            await fence();
            if (observed !== undefined && !same(await lookup(), observed)) return fail();
            if (observed === null && (await actualLegacy())) return fail();
            check();
            guardDone = true;
          } catch (error) {
            failed = true;
            throw error;
          }
        },
        () => {
          if (active || phase !== "Checks" || !guardDone || finalDone) return fail();
          check();
          finalDone = true;
          phase = "Final";
        },
      );
      if (returned !== undefined) return fail();
    }
    await current(mode);
    await restore();
    const isolation = rows(
      await sql("SELECT current_setting('transaction_isolation') isolation"),
    )[0];
    if (isolation?.isolation !== "read committed") return fail();
    await fence();
  };
  const protect = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failed = true;
      if (error instanceof StoreConfigurationOriginalError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  const fromResolve = (r: StoreConfigurationOrdinaryResolve) => {
    const body = { ...r, profile: "StoreConfigurationOrdinaryCommandV1" };
    Reflect.deleteProperty(body, "intentDigest");
    const c = parseStoreConfigurationOrdinaryCommand(body);
    if (digest(c) !== r.intentDigest)
      return fail("STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT");
    return c;
  };
  return Object.freeze({
    readOriginal: (value: unknown) =>
      protect(async () => {
        const descriptor =
          value && typeof value === "object"
            ? Object.getOwnPropertyDescriptor(value, "profile")
            : null;
        const c =
          descriptor?.value === "StoreConfigurationOrdinaryResolveV1"
            ? fromResolve(parseStoreConfigurationOrdinaryResolve(value))
            : parseStoreConfigurationOrdinaryCommand(value);
        await admit(c, "ReadOriginal");
        const old = await lookup();
        if (!old && (await actualLegacy()))
          return fail("STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT");
        observed = old;
        return old;
      }),
    recordCommitted: (value: unknown, originalInput: StoreConfigurationFreshPreparationInput) =>
      protect(async () => {
        const c = parseStoreConfigurationOrdinaryCommand(value);
        await admit(c, "RecordCommitted");
        const old = await lookup();
        if (old) {
          observed = old;
          return old;
        }
        const row = await actualLegacy();
        if (!row) return fail();
        const configuration = createStoreConfigurationVersion(row.configuration_json),
          preimage = legacyPreimage(originalInput, c.action);
        if (originalInput.occurredAt !== row.occurred_at) return fail();
        const receipt = parseStoreConfigurationOrdinaryReceipt({
          ...c,
          profile: "StoreConfigurationOrdinaryReceiptV1",
          intentDigest: digest(c),
          outcome: "Committed",
          operation: {
            command: row.command_type,
            operationReference: row.operation_id,
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            intentDigest: row.intent_digest,
            resultingVersion: configuration.configurationVersion,
            configuration,
          },
          auditReference: row.audit_reference,
          occurredAt: row.occurred_at,
          dataClassification: "ConfigurationMetadata",
        });
        await verifyLegacy(receipt, preimage, row.intent_digest);
        await current("RecordCommitted");
        await insert(receipt, preimage);
        return receipt;
      }),
    resolve: (value: unknown) =>
      protect(async () => {
        const resolve = parseStoreConfigurationOrdinaryResolve(value),
          c = fromResolve(resolve);
        await admit(c, "Resolve");
        const old = await lookup();
        if (old) {
          observed = old;
          return old;
        }
        if (await actualLegacy()) return fail("STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT");
        const receipt = parseStoreConfigurationOrdinaryReceipt({
          ...c,
          profile: "StoreConfigurationOrdinaryReceiptV1",
          intentDigest: resolve.intentDigest,
          outcome: "Abandoned",
          operation: null,
          auditReference: nextReference.call(refs, "Audit"),
          occurredAt: check(),
          dataClassification: "ConfigurationMetadata",
        });
        const returned = await appendAudit.call(
          options,
          tx,
          Object.freeze({
            ...fixed,
            operationReference: c.operationReference,
            action: c.action,
            intentDigest: resolve.intentDigest,
            auditReference: receipt.auditReference,
            occurredAt: receipt.occurredAt,
            purposeCode: "STORE_CONFIGURATION",
            dataClassification: "ConfigurationMetadata",
          }),
        );
        if (returned !== undefined) return fail();
        await current("Resolve");
        await insert(receipt, null);
        return receipt;
      }),
    assertFinalized(actual: StoreConfigurationOriginalTransaction) {
      if (
        actual !== tx ||
        active ||
        phase !== "Final" ||
        !registered ||
        !guardDone ||
        !finalDone ||
        observed === undefined ||
        (written && observed === null)
      )
        return fail();
      check();
      return deadline;
    },
  });
}
