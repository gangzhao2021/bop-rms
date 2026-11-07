import { appendPlatformAuditRecordInTransaction } from "@bop/audit";
import {
  createBrandInitialProvisioningOperatorSource,
  createFileWorkforceAccountBindingApprovalSource,
  createPostgresWorkforceAccountBindingProvisioner,
  parseCanonicalInstant,
  parseWorkforceAccountBindingCommand,
} from "@bop/identity";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type ProvisionerOptions = Parameters<typeof createPostgresWorkforceAccountBindingProvisioner>[0];
type OperatorOptions = Parameters<typeof createBrandInitialProvisioningOperatorSource>[0];
export interface AuthenticatedWorkforceAccountBindingOptions {
  readonly transactions: PersistentMerchantBffOptions["transactions"];
  readonly clock: { now(): string };
  readonly configuration: ProvisionerOptions["configuration"];
  readonly hasher: ProvisionerOptions["hasher"];
  readonly envelopes: ProvisionerOptions["envelopes"];
  readonly provisioningRoleName: string;
  readonly nextReference: ProvisionerOptions["nextReference"];
  readonly approvalFiles: { readonly approvalPath: string; readonly trustPath: string };
  readonly operator: Pick<OperatorOptions, "configuration" | "hasher" | "envelopes" | "cookie">;
}
const unavailable = (): never => {
  throw new Error("WORKFORCE_ACCOUNT_BINDING_UNAVAILABLE");
};
/** Controlled deployment composition; no browser route, account creation or
 * business grant. All identity, approval, persistence and Audit rules are owned
 * by the actual public Identity/Audit factories on the same transaction. */
export function createAuthenticatedWorkforceAccountBindingImport(
  options: AuthenticatedWorkforceAccountBindingOptions,
) {
  const transactions = options.transactions,
    run = transactions.run,
    clock = options.clock,
    now = clock.now,
    configuration = options.configuration,
    hasher = options.hasher,
    envelopes = options.envelopes,
    role = options.provisioningRoleName,
    next = options.nextReference,
    files = options.approvalFiles,
    approvalPath = files.approvalPath,
    trustPath = files.trustPath,
    operatorOptions = options.operator,
    operatorConfiguration = operatorOptions.configuration,
    operatorHasher = operatorOptions.hasher,
    operatorEnvelopes = operatorOptions.envelopes,
    cookie = operatorOptions.cookie;
  const executeTransaction = run.bind(transactions);
  let active: (() => never) | undefined;
  return Object.freeze({
    async execute(value: unknown) {
      if (active) return active();
      let failed = false,
        closed = false,
        runCount = 0;
      const poison = (): never => {
        failed = true;
        return unavailable();
      };
      active = poison;
      const check = () => {
        if (
          failed ||
          closed ||
          options.transactions !== transactions ||
          transactions.run !== run ||
          options.clock !== clock ||
          clock.now !== now ||
          options.configuration !== configuration ||
          options.hasher !== hasher ||
          options.envelopes !== envelopes ||
          options.provisioningRoleName !== role ||
          options.nextReference !== next ||
          options.approvalFiles !== files ||
          files.approvalPath !== approvalPath ||
          files.trustPath !== trustPath ||
          options.operator !== operatorOptions ||
          operatorOptions.configuration !== operatorConfiguration ||
          operatorOptions.hasher !== operatorHasher ||
          operatorOptions.envelopes !== operatorEnvelopes ||
          operatorOptions.cookie !== cookie
        )
          return poison();
      };
      try {
        check();
        const command = parseWorkforceAccountBindingCommand(value),
          origin = String(parseCanonicalInstant(now.call(clock))),
          until = String(parseCanonicalInstant(new Date(Date.parse(origin) + 5000).toISOString())),
          host = createMerchantCategoryTransactions({ run: (work) => executeTransaction(work) });
        let assertImporter: (() => void) | undefined, assertApproval: (() => void) | undefined;
        const result = await host.transactions.run(async (hostTx) => {
          if (++runCount !== 1) return poison();
          check();
          const query = hostTx.query;
          const tx = Object.freeze({
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              check();
              if (hostTx.query !== query) return poison();
              const answer = await query.call(hostTx, sql, values);
              check();
              return { rows: answer.rows as readonly Row[], rowCount: answer.rowCount ?? null };
            },
          });
          const register: ProvisionerOptions["registerBeforeCommit"] = async (
            actual,
            guard,
            final,
          ) => {
            check();
            if (actual !== tx) return poison();
            await host.registerBeforeCommit(hostTx, guard, final);
            check();
          };
          const operator = createBrandInitialProvisioningOperatorSource({
            transaction: tx,
            configuration: operatorConfiguration,
            hasher: operatorHasher,
            envelopes: operatorEnvelopes,
            cookie,
            clock,
            actorReference: command.recordedByReference,
            originalObservedAt: origin,
            originalValidUntil: until,
            registerBeforeCommit: register,
          });
          const approval = createFileWorkforceAccountBindingApprovalSource({
            transaction: tx,
            clock,
            approvalPath,
            trustPath,
            originalObservedAt: origin,
            originalValidUntil: until,
            registerBeforeCommit: register,
          });
          const importer = createPostgresWorkforceAccountBindingProvisioner({
            transaction: tx,
            configuration,
            hasher,
            envelopes,
            clock,
            operatorReference: command.recordedByReference,
            provisioningRoleName: role,
            originalObservedAt: origin,
            originalValidUntil: until,
            nextReference: next,
            appendAudit: appendPlatformAuditRecordInTransaction,
            registerBeforeCommit: register,
            authority: {
              async hold(actual, request) {
                check();
                if (actual !== tx) return poison();
                const authenticated = await operator.hold();
                const approved = await approval.hold({
                  configuration: request.configuration,
                  operationReference: request.command.operationReference,
                  actorReference: request.command.actorReference,
                  intentDigest: request.intentDigest,
                  operatorReference: request.command.recordedByReference,
                  approvedByReference: request.command.approvedByReference,
                  approvalEvidenceReference: request.command.approvalEvidenceReference,
                });
                check();
                return Object.freeze({
                  operator: authenticated.actor,
                  approvedByReference: approved.approvedByReference,
                  approvalEvidenceReference: approved.approvalEvidenceReference,
                  validUntil:
                    [request.validUntil, authenticated.validUntil, approved.validUntil].sort()[0] ??
                    poison(),
                });
              },
            },
          });
          // A caught reentry/configuration failure after a provider/file read
          // cannot permit the transaction host to commit a partial binding.
          await register(tx, async () => check(), check);
          const binding = await importer.provision(command);
          assertImporter = () => importer.assertFinalized();
          assertApproval = () => approval.assertFinalized();
          return Object.freeze({
            profile: "WorkforceAccountBindingResultV1" as const,
            actorReference: binding.actorReference,
            operationReference: binding.operationReference,
            intentDigest: binding.intentDigest,
            auditReference: binding.auditReference,
            recordedAt: binding.recordedAt,
          });
        });
        // Pure finalized-state checks only after actual COMMIT.
        if (failed || runCount !== 1 || !assertImporter || !assertApproval) return poison();
        assertImporter();
        assertApproval();
        return result;
      } catch {
        return poison();
      } finally {
        closed = true;
        active = undefined;
      }
    },
  });
}
