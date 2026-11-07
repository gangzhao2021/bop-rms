import { MediaServiceError } from "../../application/media-service.js";
import {
  createMediaScope,
  parseAssetVersionReference,
  parseMediaInstant,
  parseMediaReferenceId,
  type MediaScope,
} from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import type { MediaPersistenceTransaction } from "./media-upload-store.js";

export const mediaImageProcessingRequiredFields = Object.freeze([
  "sourceVersion",
  "scanAdmission",
  "processingIntent",
  "processingResult",
  "asset",
  "renditions",
  "audit",
] as const);
export interface MediaImageProcessingTransactionIdentity {
  readonly phase: "Plan" | "Complete";
  readonly sourceAssetVersionReference: string;
  readonly scanEventDigest: string;
  readonly admissionReference: string;
}
export interface MediaImageProcessingAuthorityInput extends MediaImageProcessingTransactionIdentity {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly systemActorReference: string;
  readonly actorKind: "System";
  readonly action: "media.asset.promote";
  readonly purposeCode: "MEDIA_IMAGE_PROMOTION";
  readonly requiredFields: typeof mediaImageProcessingRequiredFields;
  readonly operationReference: string | null;
  readonly originalIntentDigest: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MediaImageProcessingTransactionOptions {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  /** Named Worker principal/config reference; Identity System actors themselves
   * have actorReference=null. This reference alone never grants authority. */
  readonly systemActorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: MediaPersistenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly registerBeforeCommit: (
    tx: MediaPersistenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  /** Must retain both current System action/field authority and the trusted scan
   * admission bound to this exact digest and source version until commit. */
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MediaPersistenceTransaction,
      input: MediaImageProcessingAuthorityInput,
    ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
  };
}
export interface MediaImageProcessingTransactionContext {
  readonly tx: MediaPersistenceTransaction;
  now(): string;
  bind(operationReference: string, intentDigest: string): Promise<void>;
}
const fail = (): never => {
  throw new MediaServiceError("MEDIA_COMMIT_FAILED");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[key] = d.value;
  }
  return r;
}
function digest(value: unknown): string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : fail();
}
function resultRows(value: unknown): readonly unknown[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (!d?.enumerable || !("value" in d)) return fail();
  const rows = copyMediaUploadStorageValue(d.value);
  return Array.isArray(rows) ? rows : fail();
}
function identity(value: unknown): MediaImageProcessingTransactionIdentity {
  const r = closed(copyMediaUploadStorageValue(value), [
    "phase",
    "sourceAssetVersionReference",
    "scanEventDigest",
    "admissionReference",
  ]);
  if (r.phase !== "Plan" && r.phase !== "Complete") return fail();
  return Object.freeze({
    phase: r.phase,
    sourceAssetVersionReference: parseAssetVersionReference(r.sourceAssetVersionReference),
    scanEventDigest: digest(r.scanEventDigest),
    admissionReference: parseMediaReferenceId(r.admissionReference),
  });
}

/** Private Media processing transaction only. This does not authenticate scan
 * JSON, run Provider work, or manufacture a User/System permission decision. */
export function createMediaImageProcessingTransaction(
  options: MediaImageProcessingTransactionOptions,
) {
  let tenantReference: string, scope: MediaScope, systemActorReference: string;
  let now: () => string,
    host: MediaImageProcessingTransactionOptions["transactions"]["run"],
    register: MediaImageProcessingTransactionOptions["registerBeforeCommit"],
    hold: MediaImageProcessingTransactionOptions["authority"]["holdUntilTransactionCompletes"];
  try {
    const r = closed(options, [
        "tenantReference",
        "scope",
        "systemActorReference",
        "clock",
        "transactions",
        "registerBeforeCommit",
        "authority",
      ]),
      clock = closed(r.clock, ["now"]),
      transactions = closed(r.transactions, ["run"]),
      authority = closed(r.authority, ["holdUntilTransactionCompletes"]);
    tenantReference = parseMediaReferenceId(r.tenantReference);
    scope = createMediaScope(copyMediaUploadStorageValue(r.scope) as MediaScope);
    systemActorReference = parseMediaReferenceId(r.systemActorReference);
    if (
      typeof clock.now !== "function" ||
      typeof transactions.run !== "function" ||
      typeof r.registerBeforeCommit !== "function" ||
      typeof authority.holdUntilTransactionCompletes !== "function"
    )
      return fail();
    now = (clock.now as () => string).bind(r.clock);
    host = (transactions.run as typeof host).bind(r.transactions);
    register = (r.registerBeforeCommit as typeof register).bind(options);
    hold = (authority.holdUntilTransactionCompletes as typeof hold).bind(r.authority);
  } catch {
    return fail();
  }
  const active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async run<T>(
      value: MediaImageProcessingTransactionIdentity,
      work: (context: MediaImageProcessingTransactionContext) => Promise<T>,
    ): Promise<T> {
      let captured: MediaImageProcessingTransactionIdentity | undefined,
        entryAt: string | undefined;
      try {
        captured = identity(value);
        entryAt = parseMediaInstant(now());
      } catch {
        /* Register poison protection before reporting invalid input. */
      }
      const callback = work;
      let actualTx: MediaPersistenceTransaction | undefined,
        entered = false,
        calls = 0,
        completed = false,
        asyncCompleted = false,
        finalCompleted = false;
      let resultValue: T | undefined;
      try {
        const result = await host(async (tx) => {
          if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
          actualTx = tx;
          if (++calls !== 1 || active.has(tx) || failed.has(tx)) {
            failed.add(tx);
            return fail();
          }
          active.add(tx);
          entered = true;
          const originalQuery = tx.query,
            rawQuery = originalQuery.bind(tx);
          let latest = "",
            deadline = "",
            ready = false,
            workOpen = false,
            pendingQueries = 0,
            bindCalls = 0,
            bound = false,
            asyncCalls = 0,
            finalCalls = 0,
            operationReference: string | null = null,
            originalIntentDigest: string | null = null;
          const poison = (): never => {
            failed.add(tx);
            return fail();
          };
          const check = () => {
            try {
              const at = parseMediaInstant(now());
              if (
                failed.has(tx) ||
                tx.query !== originalQuery ||
                !deadline ||
                at < latest ||
                at >= deadline
              )
                return poison();
              latest = at;
              return at;
            } catch {
              return poison();
            }
          };
          const query: MediaPersistenceTransaction["query"] = async <Row>(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            try {
              const result = await rawQuery<Row>(sql, values);
              check();
              return result;
            } catch {
              return poison();
            }
          };
          const authorize = async () => {
            check();
            if (!captured || !entryAt) return poison();
            const lease = closed(
                await hold(
                  tx,
                  Object.freeze({
                    ...captured,
                    tenantReference,
                    scope,
                    systemActorReference,
                    actorKind: "System" as const,
                    action: "media.asset.promote" as const,
                    purposeCode: "MEDIA_IMAGE_PROMOTION" as const,
                    requiredFields: mediaImageProcessingRequiredFields,
                    operationReference,
                    originalIntentDigest,
                    observedAt: entryAt,
                    validUntil: deadline,
                  }),
                ),
                ["observedAt", "validUntil"],
              ),
              until = parseMediaInstant(lease.validUntil);
            if (
              parseMediaInstant(lease.observedAt) !== entryAt ||
              until > deadline ||
              until <= check()
            )
              return poison();
            deadline = until;
            check();
          };
          try {
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++asyncCalls !== 1 || !ready || !bound || workOpen || pendingQueries !== 0)
                      return poison();
                    await authorize();
                    check();
                    asyncCompleted = true;
                  } catch {
                    return poison();
                  }
                },
                () => {
                  if (
                    ++finalCalls !== 1 ||
                    asyncCalls !== 1 ||
                    !asyncCompleted ||
                    !ready ||
                    !bound ||
                    workOpen ||
                    pendingQueries !== 0
                  )
                    return poison();
                  check();
                  finalCompleted = true;
                },
              )) !== undefined
            )
              return poison();
            if (!captured || !entryAt || typeof callback !== "function") return poison();
            latest = entryAt;
            deadline = new Date(Date.parse(entryAt) + 5000).toISOString();
            await authorize();
            const isolation = resultRows(
              await query("SELECT current_setting('transaction_isolation') AS isolation", []),
            );
            // Drivers may return command/rowCount metadata, so inspect only the
            // descriptor-safe rows payload rather than prescribing a pg result.
            if (
              isolation.length !== 1 ||
              closed(isolation[0], ["isolation"]).isolation !== "read committed"
            )
              return poison();
            await query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)",
              [tenantReference, scope.brandReference, scope.storeReference ?? ""],
            );
            const facade: MediaPersistenceTransaction = Object.freeze({
              query: async <Row>(sql: string, values: readonly unknown[]) => {
                if (!workOpen) return poison();
                pendingQueries++;
                try {
                  return await query<Row>(sql, values);
                } finally {
                  pendingQueries--;
                }
              },
            });
            const context: MediaImageProcessingTransactionContext = Object.freeze({
              tx: facade,
              now: () => {
                if (!workOpen) return poison();
                return check();
              },
              bind: async (operation: string, intent: string) => {
                try {
                  if (!workOpen || ++bindCalls !== 1) return poison();
                  check();
                  operationReference = parseMediaReferenceId(operation);
                  originalIntentDigest = digest(intent);
                  await authorize();
                  check();
                  if (!workOpen) return poison();
                  bound = true;
                } catch {
                  return poison();
                }
              },
            });
            await query("SAVEPOINT media_image_processing", []);
            try {
              workOpen = true;
              resultValue = await callback(context);
              workOpen = false;
              check();
              if (!bound || bindCalls !== 1 || pendingQueries !== 0) return poison();
              await query("RELEASE SAVEPOINT media_image_processing", []);
              ready = completed = true;
              return resultValue;
            } catch {
              workOpen = false;
              failed.add(tx);
              await rawQuery("ROLLBACK TO SAVEPOINT media_image_processing", []);
              await rawQuery("RELEASE SAVEPOINT media_image_processing", []);
              return fail();
            }
          } catch {
            return poison();
          }
        });
        if (
          calls !== 1 ||
          !completed ||
          !asyncCompleted ||
          !finalCompleted ||
          !actualTx ||
          failed.has(actualTx) ||
          !Object.is(result, resultValue)
        )
          return fail();
        return result;
      } catch (error) {
        if (actualTx) failed.add(actualTx);
        const code =
          error && typeof error === "object"
            ? Object.getOwnPropertyDescriptor(error, "code")
            : undefined;
        if (code && "value" in code && code.value === "COMMIT_OUTCOME_UNKNOWN")
          throw new MediaServiceError("MEDIA_COMMIT_OUTCOME_UNKNOWN");
        return fail();
      } finally {
        if (actualTx && entered) active.delete(actualTx);
      }
    },
  });
}
