import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  createPostgresStoreConfigurationAuthoringSource,
  readStoreConfigurationWithdrawal,
  recordStoreConfigurationWithdrawal,
  type StoreConfigurationWithdrawalKind,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** WP-2423 (v15 live check, D2/D3): why a withdrawal was not recorded. */
export class MerchantStoreConfigurationWithdrawalError extends Error {
  constructor(readonly code: "Invalid" | "Denied" | "Conflict") {
    super("Store configuration withdrawal was not recorded");
    this.name = "MerchantStoreConfigurationWithdrawalError";
  }
}
const fail = (code: MerchantStoreConfigurationWithdrawalError["code"]): never => {
  throw new MerchantStoreConfigurationWithdrawalError(code);
};

/**
 * WP-2423 (v15 live check, D2/D3): the Store's latest configuration that is not published yet is
 * withdrawn by the person who made it (permission to save a Store configuration draft) or declined
 * by someone else who may approve it (Store configuration approval). Append-only record and audit;
 * the configuration is kept and the next change builds on it. The command names the exact
 * configuration and version the person saw; a newer change refuses it. `auditReference` makes a
 * retry return the recorded withdrawal.
 */
export function createMerchantStoreConfigurationWithdrawal(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    let command: {
      configurationReference: string;
      configurationVersion: number;
      auditReference: string;
    };
    try {
      const raw = readClosedRecord(input.command, [
        "configurationReference",
        "configurationVersion",
        "auditReference",
      ]);
      const version = raw.configurationVersion;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
        return fail("Invalid");
      command = {
        configurationReference: String(
          parseOpaqueUuidV7(raw.configurationReference, "ACTOR_REFERENCE_INVALID"),
        ),
        configurationVersion: version,
        auditReference: String(parseOpaqueUuidV7(raw.auditReference, "ACTOR_REFERENCE_INVALID")),
      };
    } catch (error) {
      if (error instanceof MerchantStoreConfigurationWithdrawalError) throw error;
      return fail("Invalid");
    }
    const actions = ["store.service.save-draft", "store.service.approve"] as const;
    return options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const scope = await resolveScope(
              tx,
              input.sessionCookie,
              "store.service.read",
              session.sessionReference,
            );
            if (!(await scope.allowed())) return fail("Denied");
            return { scope, decisions: await scope.authorizeActions([...actions]) };
          },
          recheck: async ({ scope, decisions }) => {
            if (!(await scope.allowed())) return false;
            const current = await scope.authorizeActions([...actions]);
            return actions.every(
              (action) => current.get(action)?.effect === decisions.get(action)?.effect,
            );
          },
          denied: () => fail("Denied"),
        },
        async (authority) => {
          const { scope, decisions } = authority.scope;
          const brand = scope.context.brand.brandReference,
            store = scope.store.storeReference,
            actor = String(scope.actorReference),
            at = options.persistence.now();
          const latest = await createPostgresStoreConfigurationAuthoringSource({
            brandReference: brand,
            storeReference: store,
            mode: "Write",
            authorize: () => authority.guard(),
          })(tx, at);
          if (
            latest === null ||
            latest.configurationReference !== command.configurationReference ||
            latest.configurationVersion !== command.configurationVersion ||
            (latest.lifecycle !== "Draft" &&
              latest.lifecycle !== "PendingApproval" &&
              latest.lifecycle !== "Approved")
          )
            return fail("Conflict");
          const kind: StoreConfigurationWithdrawalKind =
            String(latest.authoredByReference) === actor ? "Withdrawn" : "Declined";
          const needed = kind === "Withdrawn" ? actions[0] : actions[1];
          if (decisions.get(needed)?.effect !== "Allow") return fail("Denied");
          const prior = await readStoreConfigurationWithdrawal(tx, {
            brandReference: brand,
            storeReference: store,
            configurationReference: latest.configurationReference,
          });
          if (prior !== null) {
            if (prior.actorReference !== actor || prior.auditReference !== command.auditReference)
              return fail("Conflict");
            return Object.freeze({ status: "AlreadyApplied" as const, kind: prior.kind });
          }
          const reasonCode =
            kind === "Withdrawn" ? "STORE_CONFIGURATION_WITHDRAWN" : "STORE_CONFIGURATION_DECLINED";
          await recordStoreConfigurationWithdrawal(tx, {
            brandReference: brand,
            storeReference: store,
            configurationReference: latest.configurationReference,
            configurationVersion: latest.configurationVersion,
            withdrawnLifecycle: latest.lifecycle,
            kind,
            actorReference: actor,
            reasonCode,
            auditReference: command.auditReference,
            withdrawnAt: at,
          });
          await appendAuditRecordInTransaction(
            tx,
            validateAuditRecord(
              {
                auditId: command.auditReference,
                brandId: brand,
                storeId: store,
                actor: { type: "User", reference: actor },
                actionCode: "STORE_CONFIGURATION_CHANGED",
                targetType: "StoreConfiguration",
                targetId: latest.configurationReference,
                correlationId: command.auditReference,
                reasonCode,
                beforeSummary: { lifecycle: latest.lifecycle },
                afterSummary: { withdrawal: kind },
                occurredAt: at,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              },
              Date.parse(at),
            ),
          );
          return Object.freeze({ status: "Applied" as const, kind });
        },
      ),
    );
  };
}
