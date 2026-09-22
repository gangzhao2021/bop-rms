import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
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
  authorize(tx: Transaction, observedAt: string): Promise<boolean>;
}) {
  const brand = parseBrandReference(options.brandReference),
    store = parseStoreReference(options.storeReference);
  return async (tx: Transaction, now: string): Promise<StoreConfigurationVersion | null> => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) return unavailable();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query(
        "LOCK TABLE rms_store.store_configuration_authoring_operation IN SHARE MODE",
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
      if ((await options.authorize(tx, at)) !== true) return unavailable();
      return configuration;
    } catch {
      return unavailable();
    }
  };
}
