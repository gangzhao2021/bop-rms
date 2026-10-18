import { createPostgresStorePauseHistorySource } from "./pause-history-source.js";
import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  validateStoreConfigurationForPublication,
  parseStoreAdministrationReference,
  type StoreConfigurationVersion,
} from "../../contracts/store-configuration-administration.js";
import { storeServiceModes } from "../../contracts/store-operating-status.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const fail = (code: string): never => {
  throw new Error(code);
};
function exact(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !("value" in (Object.getOwnPropertyDescriptor(value, key) ?? {})),
    )
  )
    return fail("STORE_SERVICE_COMMAND_INVALID");
  return value as Record<string, unknown>;
}
function parse(value: unknown) {
  const input = exact(value, [
    "command",
    "operationReference",
    "configurationReference",
    "actorReference",
    "purposeCode",
    "expectedVersion",
    "auditReference",
    "content",
  ]);
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    (input.expectedVersion as number) < 0 ||
    typeof input.purposeCode !== "string" ||
    !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(input.purposeCode)
  )
    return fail("STORE_SERVICE_COMMAND_INVALID");
  const common = {
    operationReference: parseStoreAdministrationReference(input.operationReference),
    configurationReference: parseStoreAdministrationReference(input.configurationReference),
    actorReference: parseStoreAdministrationReference(input.actorReference),
    auditReference: parseStoreAdministrationReference(input.auditReference),
    purposeCode: input.purposeCode,
    expectedVersion: input.expectedVersion as number,
  };
  if (input.command === "PauseService") {
    const content = exact(input.content, ["effectiveUntil", "serviceModes"]);
    const modes = content.serviceModes;
    if (
      modes !== null &&
      (!Array.isArray(modes) ||
        !modes.length ||
        modes.length > 3 ||
        new Set(modes).size !== modes.length ||
        modes.some((mode) => !storeServiceModes.includes(mode)))
    )
      return fail("STORE_SERVICE_COMMAND_INVALID");
    return Object.freeze({
      ...common,
      command: "PauseService" as const,
      content: Object.freeze({
        effectiveUntil: parseCanonicalInstant(content.effectiveUntil),
        serviceModes:
          modes === null
            ? null
            : Object.freeze(storeServiceModes.filter((mode) => modes.includes(mode))),
      }),
    });
  }
  if (input.command !== "ResumeService") return fail("STORE_SERVICE_COMMAND_INVALID");
  const content = exact(input.content, ["pauseOperationReference"]);
  return Object.freeze({
    ...common,
    command: "ResumeService" as const,
    content: Object.freeze({
      pauseOperationReference: parseStoreAdministrationReference(content.pauseOperationReference),
    }),
  });
}
export type StoreServiceControlCommand = ReturnType<typeof parse>;
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return fail("STORE_SERVICE_STORAGE_UNAVAILABLE");
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    return fail("STORE_SERVICE_STORAGE_UNAVAILABLE");
  return descriptor.value;
}
function version(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return fail("STORE_SERVICE_STORAGE_UNAVAILABLE");
  return Number(value);
}
export function createPostgresStoreServiceControl(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  now(): string;
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  authorize(tx: Transaction, command: StoreServiceControlCommand, at: string): Promise<boolean>;
  currentConfiguration(
    tx: Transaction,
    reference: string,
    at: string,
  ): Promise<StoreConfigurationVersion>;
  hashIntent(command: StoreServiceControlCommand): string;
  appendAudit(
    tx: Transaction,
    input: {
      readonly command: StoreServiceControlCommand;
      readonly occurredAt: string;
      readonly resultingVersion: number;
    },
  ): Promise<void>;
}) {
  const brand = parseBrandReference(options.brandReference),
    store = parseStoreReference(options.storeReference);
  return async (raw: unknown) => {
    const command = parse(raw);
    const at = parseCanonicalInstant(options.now());
    const digest = options.hashIntent(command);
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return fail("STORE_SERVICE_COMMAND_INVALID");
    return options.run(async (tx) => {
      if ((await options.authorize(tx, command, at)) !== true)
        return fail("STORE_SERVICE_PERMISSION_DENIED");
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query(
        "LOCK TABLE rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content IN SHARE ROW EXCLUSIVE MODE",
        [],
      );
      const original = rows(
        await tx.query(
          "SELECT intent_digest,resulting_version FROM rms_store.store_configuration_operation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
          [brand, store, command.operationReference],
        ),
      );
      if (original.length) {
        if (original.length !== 1 || original[0]?.intent_digest !== digest)
          return fail("STORE_SERVICE_IDEMPOTENCY_CONFLICT");
        if ((await options.authorize(tx, command, at)) !== true)
          return fail("STORE_SERVICE_PERMISSION_DENIED");
        return Object.freeze({
          status: "AlreadyApplied" as const,
          resultingVersion: version(original[0].resulting_version),
        });
      }
      const current = version(
        rows(
          await tx.query(
            "SELECT coalesce(max(resulting_version),0)::text AS version FROM rms_store.store_configuration_operation WHERE brand_id=$1 AND store_id=$2 AND command_type IN ('PauseService','ResumeService')",
            [brand, store],
          ),
        )[0]?.version,
      );
      if (current !== command.expectedVersion || current === Number.MAX_SAFE_INTEGER)
        return fail("STORE_SERVICE_VERSION_CONFLICT");
      const configuration = createStoreConfigurationVersion(
        await options.currentConfiguration(tx, command.configurationReference, at),
      );
      validateStoreConfigurationForPublication(configuration);
      if (
        configuration.brandReference !== brand ||
        configuration.storeReference !== store ||
        configuration.configurationReference !== command.configurationReference ||
        configuration.effectiveFrom > at ||
        (configuration.effectiveUntil !== null && configuration.effectiveUntil <= at)
      )
        return fail("STORE_SERVICE_CONFIGURATION_UNAVAILABLE");
      if (command.command === "PauseService") {
        if (
          command.content.effectiveUntil <= at ||
          command.content.serviceModes?.some(
            (mode) => !configuration.enabledServiceModes.includes(mode),
          )
        )
          return fail("STORE_SERVICE_COMMAND_INVALID");
      } else {
        const pause = rows(
          await tx.query(
            "SELECT p.effective_from,p.effective_until FROM rms_store.store_service_pause_content p WHERE p.brand_id=$1 AND p.store_id=$2 AND p.operation_id=$3 AND NOT EXISTS (SELECT 1 FROM rms_store.store_service_resume_content r WHERE r.brand_id=p.brand_id AND r.store_id=p.store_id AND r.pause_operation_id=p.operation_id)",
            [brand, store, command.content.pauseOperationReference],
          ),
        );
        const from = pause[0]?.effective_from,
          until = pause[0]?.effective_until;
        if (
          pause.length !== 1 ||
          !(from instanceof Date) ||
          !(until instanceof Date) ||
          from.toISOString() >= at ||
          until.toISOString() <= at
        )
          return fail("STORE_SERVICE_PAUSE_NOT_ACTIVE");
      }
      if ((await options.authorize(tx, command, at)) !== true)
        return fail("STORE_SERVICE_PERMISSION_DENIED");
      const next = current + 1;
      await tx.query(
        "INSERT INTO rms_store.store_configuration_operation VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ConfigurationMetadata')",
        [
          command.operationReference,
          brand,
          store,
          command.configurationReference,
          command.command,
          digest,
          current,
          next,
          command.actorReference,
          command.purposeCode,
          command.auditReference,
          at,
        ],
      );
      if (command.command === "PauseService")
        await tx.query(
          "INSERT INTO rms_store.store_service_pause_content VALUES ($1,$2,$3,'PauseService',$4,$5,$6,'ConfigurationMetadata')",
          [
            brand,
            store,
            command.operationReference,
            at,
            command.content.effectiveUntil,
            command.content.serviceModes,
          ],
        );
      else
        await tx.query(
          "INSERT INTO rms_store.store_service_resume_content VALUES ($1,$2,$3,'ResumeService',$4,$5,'ConfigurationMetadata')",
          [brand, store, command.operationReference, command.content.pauseOperationReference, at],
        );
      await options.appendAudit(tx, { command, occurredAt: at, resultingVersion: next });
      return Object.freeze({ status: "Applied" as const, resultingVersion: next });
    });
  };
}

/** Read version and active pauses under the same history fence used by mutations. */
export function createPostgresStoreServiceControlState(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  authorize(tx: Transaction, at: string): Promise<boolean>;
  verifyOperation: Parameters<typeof createPostgresStorePauseHistorySource>[0]["verifyOperation"];
}) {
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const pauses = createPostgresStorePauseHistorySource(options);
  return async (tx: Transaction, now: string) => {
    const at = parseCanonicalInstant(now);
    const activePauses = await pauses(tx, at);
    const expectedVersion = version(
      rows(
        await tx.query(
          "SELECT coalesce(max(resulting_version),0)::text AS version FROM rms_store.store_configuration_operation WHERE brand_id=$1 AND store_id=$2 AND command_type IN ('PauseService','ResumeService')",
          [brand, store],
        ),
      )[0]?.version,
    );
    if ((await options.authorize(tx, at)) !== true) return fail("STORE_SERVICE_PERMISSION_DENIED");
    return Object.freeze({ expectedVersion, activePauses, observedAt: at });
  };
}
