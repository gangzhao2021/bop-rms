import process from "node:process";
import { createHash } from "node:crypto";
import {
  createPaymentReconciliationService,
  parsePaymentReconciliationRunInput,
  parseSettlementReconciliationCandidate,
  parsePaymentReference,
  createPostgresPaymentReconciliationRepository,
  createPostgresPaymentReconciliationCandidates,
  createPostgresPaymentReconciliationCandidateSource,
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentTerminalStore,
  createPostgresPaymentTerminalSource,
  createPaymentTerminalService,
} from "../../packages/rms/payment/src/index.ts";
import { createInternalReconciliationLease } from "./pilot-reconciliation-lease.mjs";
import { createInternalReconciliationTerminalOccurrence } from "./pilot-reconciliation-terminal-occurrence.mjs";
const factories = {
  createPaymentReconciliationService,
  createPostgresPaymentReconciliationRepository,
  createPostgresPaymentReconciliationCandidates,
  createPostgresPaymentReconciliationCandidateSource,
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentTerminalStore,
  createPostgresPaymentTerminalSource,
  createPaymentTerminalService,
  createInternalReconciliationLease,
  createInternalReconciliationTerminalOccurrence,
};
/** InternalTest execution; daily evidence must be prepared before the run cutoff. */
export function createInternalReconciliationRuntime(
  { resources: r, simulator, providerAccountReference },
  f = factories,
) {
  const fail = () => {
    throw Error("INTERNAL_RECONCILIATION_UNAVAILABLE");
  };
  const scope = {
    ...r.scope,
    providerAccountReference: String(parsePaymentReference(providerAccountReference)),
    environment: "Test",
  };
  const fullScope = {
    tenantReference: String(parsePaymentReference(r.publicProfile.binding.tenantReference)),
    ...scope,
  };
  const active = () =>
    process.env.NODE_ENV === "development" &&
    simulator.simulation === true &&
    r.now() < r.publicProfile.binding.validUntil &&
    r.scope.brandReference === r.publicProfile.binding.brandReference &&
    r.scope.storeReference === r.publicProfile.binding.storeReference;
  if (!active()) return fail();
  return Object.freeze({
    async run(value, preparedDailyCandidate = null) {
      const run = parsePaymentReconciliationRunInput(value);
      const daily =
        preparedDailyCandidate === null
          ? null
          : parseSettlementReconciliationCandidate(preparedDailyCandidate);
      if (
        !active() ||
        run.brandReference !== r.scope.brandReference ||
        run.storeReference !== r.scope.storeReference ||
        run.actorReference !== null ||
        (run.mode === "DailySettlement" ? daily === null : daily !== null) ||
        (daily !== null &&
          (daily.brandReference !== run.brandReference ||
            daily.storeReference !== run.storeReference ||
            daily.evidenceObservedAt > run.cutoffAt))
      )
        return fail();
      const lease = f.createInternalReconciliationLease({ database: r.database, run, active });
      const held = async () => {
        if (!active()) return fail();
        await lease.assertHeld();
        return true;
      };
      const guard = async (work) => {
        await held();
        const result = await work();
        await held();
        return result;
      };
      const transactions = { run: (work) => r.transactions.run((tx) => guard(() => work(tx))) };
      try {
        const repository = f.createPostgresPaymentReconciliationRepository({
          scope: r.scope,
          transactions,
          authorize: async (_tx, q) =>
            q.runReference === run.runReference &&
            q.brandReference === run.brandReference &&
            q.storeReference === run.storeReference &&
            held(),
        });
        const occurrence = f.createInternalReconciliationTerminalOccurrence({
          simulator,
          scope,
          active,
        });
        const verification = {
          verifyOccurrence: async (_tx, o) =>
            guard(async () => {
              const original = await simulator.readTerminalOccurrence({
                operation: "RetrieveIntent",
                purpose: "RetrievePaymentIntent",
                context: {
                  ...r.scope,
                  provider: "Stripe",
                  environment: "Test",
                  paymentAttemptReference: o.paymentAttemptReference,
                  operationReference: o.causationReference,
                },
                providerIntentReference: o.providerIntentReference,
              });
              return (
                original.status === (o.failureReason === "Cancelled" ? "Cancelled" : o.status) &&
                original.occurredAt === o.occurredAt
              );
            }),
        };
        const terminal = f.createPaymentTerminalService({
          source: f.createPostgresPaymentTerminalSource(transactions, scope, verification),
          repository: f.createPostgresPaymentTerminalStore(transactions, scope, verification),
          clock: { now: r.now },
          references: { generate: r.credentials.reference },
          audit: {
            create: async ({ fact, correlationReference }) => ({
              auditId: r.credentials.reference(),
              brandId: run.brandReference,
              storeId: run.storeReference,
              actor: { type: "System" },
              actionCode: "PAYMENT_TERMINAL_RECORDED",
              targetType: "PaymentIntent",
              targetId: fact.paymentIntentReference,
              afterSummary: { outcome: fact.outcome },
              reasonCode: fact.outcome === "Failed" ? "PAYMENT_FAILED" : "PAYMENT_CAPTURED",
              correlationId: correlationReference,
              occurredAt: fact.recordedAt,
              sourceChannel: "PAYMENT_RECONCILIATION",
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          },
        });
        const observations = f.createPostgresPaymentProviderObservationStore(
          transactions,
          r.scope,
          { now: r.now },
        );
        const exceptionFor = (input) => {
          if (
            input.brandReference !== run.brandReference ||
            input.storeReference !== run.storeReference ||
            !["StateMismatch", "AmountMismatch", "RefundMismatch", "TerminalConflict"].includes(
              input.reason,
            )
          )
            return fail();
          const candidate = String(parsePaymentReference(input.candidateReference)),
            stamp = candidate.replaceAll("-", "").slice(0, 12),
            h = createHash("sha256")
              .update(
                JSON.stringify([
                  "BOP_INTERNAL_RECONCILIATION_EXCEPTION_V1",
                  run.brandReference,
                  run.storeReference,
                  candidate,
                  input.reason,
                ]),
              )
              .digest("hex");
          return String(
            parsePaymentReference(
              stamp.slice(0, 8) +
                "-" +
                stamp.slice(8) +
                "-7" +
                h.slice(0, 3) +
                "-" +
                (8 + (parseInt(h[3], 16) & 3)).toString(16) +
                h.slice(4, 7) +
                "-" +
                h.slice(7, 19),
            ),
          );
        };
        const service = f.createPaymentReconciliationService({
          authorization: {
            authorize: async (q) =>
              active() &&
              q.runReference === run.runReference &&
              q.brandReference === run.brandReference &&
              q.storeReference === run.storeReference &&
              q.actorReference === null &&
              q.mode === run.mode,
          },
          lease,
          repository: {
            loadRun: (q) => guard(() => repository.loadRun(q)),
            commit: (q) => guard(() => repository.commit(q)),
          },
          candidates: {
            claimOperational: async (q) => {
              if (
                q.runReference !== run.runReference ||
                q.brandReference !== run.brandReference ||
                q.storeReference !== run.storeReference ||
                q.cutoffAt !== run.cutoffAt ||
                q.limit !== run.maxCandidates
              )
                return fail();
              const routes = await transactions.run((tx) =>
                f.createPostgresPaymentReconciliationCandidates({
                  scope: { ...r.scope, environment: "Test" },
                  authorize: held,
                })(tx, { cutoffAt: q.cutoffAt, limit: q.limit }),
              );
              const candidates = [];
              for (const route of routes)
                candidates.push(
                  await transactions.run((tx) =>
                    f.createPostgresPaymentReconciliationCandidateSource({
                      scope: fullScope,
                      authorize: async (t, input) =>
                        t === tx &&
                        input.orderReference === route.orderReference &&
                        input.paymentIntentReference === route.paymentIntentReference &&
                        held(),
                    })(tx, route, r.now()),
                  ),
                );
              return candidates;
            },
            claimDailySettlement: async (q) =>
              guard(async () => {
                if (
                  run.mode !== "DailySettlement" ||
                  daily === null ||
                  q.runReference !== run.runReference ||
                  q.brandReference !== run.brandReference ||
                  q.storeReference !== run.storeReference ||
                  q.cutoffAt !== run.cutoffAt ||
                  q.limit < 1
                )
                  return fail();
                return [daily];
              }),
          },
          provider: { retrieveIntent: (q) => guard(() => simulator.adapter.retrieveIntent(q)) },
          observations: { record: (q) => guard(() => observations.record(q)) },
          terminal: {
            occurrence: (q) => guard(() => occurrence(q)),
            record: (q) =>
              guard(async () => {
                const result = await terminal.record(q);
                return {
                  status: result.status,
                  paymentTransactionReference: result.fact.paymentTransactionReference,
                };
              }),
          },
          references: { generate: r.credentials.reference, exceptionFor },
          clock: { now: r.now },
        });
        return await service.run(run);
      } finally {
        await lease.dispose();
      }
    },
  });
}
