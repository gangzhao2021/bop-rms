import { createInternalCaptureJournalSource } from "./pilot-capture-journal.mjs";
import { createInternalSettlementWindowSource } from "./pilot-settlement-provider.mjs";
import process from "node:process";
import {
  createInternalPaymentFailure,
  provisionInternalPaymentFailure,
} from "./pilot-payment-failure.mjs";
import { createInternalSimulatedRefunds } from "./pilot-refund-provider.mjs";
import { DatabaseSync } from "node:sqlite";
import { open, lstat, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  createCreateIntentRequest,
  createRetrieveIntentRequest,
  createPaymentProviderSnapshot,
} from "../../packages/rms/payment/src/index.ts";
const hash = (value) =>
  "sha256:" +
  createHash("sha256")
    .update(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)))
    .digest("hex");
export async function createInternalSimulatedProvider(
  { provision = false } = {},
  { path, loadProfile, expectedDatabaseName },
) {
  if (process.env.NODE_ENV !== "development") throw new Error("SIMULATION_ONLY");
  const profile = await loadProfile();
  if (profile.environment !== "InternalTest" || profile.database !== expectedDatabaseName)
    throw new Error("SIMULATION_ONLY");
  if (provision) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
    } catch (error) {
      // Preserve the existing redacted boundary: filesystem causes can expose private paths.
      // eslint-disable-next-line preserve-caught-error
      if (error.code !== "EEXIST") throw new Error("SIMULATION_UNAVAILABLE");
    }
  }
  const state = await lstat(path);
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    (state.mode & 0o777) !== 0o600 ||
    state.uid !== process.getuid() ||
    (await realpath(path)) !== path
  )
    throw new Error("SIMULATION_UNAVAILABLE");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  if (provision)
    db.exec(
      "CREATE TABLE IF NOT EXISTS intent (reference TEXT PRIMARY KEY, brand TEXT NOT NULL, store TEXT NOT NULL, attempt TEXT NOT NULL, operation TEXT NOT NULL, idempotency TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, amount TEXT NOT NULL, created_at TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS outcome (reference TEXT PRIMARY KEY REFERENCES intent(reference), status TEXT NOT NULL CHECK(status='Captured'), transaction_reference TEXT NOT NULL, occurred_at TEXT NOT NULL) STRICT;",
    );
  if (provision) provisionInternalPaymentFailure(db);
  const failures = createInternalPaymentFailure(db);
  function scope(context) {
    if (
      context.environment !== "Test" ||
      context.brandReference !== profile.binding.brandReference ||
      context.storeReference !== profile.binding.storeReference ||
      Date.now() >= Date.parse(profile.binding.validUntil)
    )
      throw new Error("SIMULATION_SCOPE_DENIED");
  }
  function rowFor(request) {
    scope(request.context);
    const row = db
      .prepare("SELECT * FROM intent WHERE reference=?")
      .get(request.providerIntentReference);
    if (
      !row ||
      row.brand !== request.context.brandReference ||
      row.store !== request.context.storeReference ||
      row.attempt !== request.context.paymentAttemptReference
    )
      throw new Error("SIMULATION_INTENT_UNAVAILABLE");
    return row;
  }
  function snapshot(context, row) {
    const outcome = db.prepare("SELECT * FROM outcome WHERE reference=?").get(row.reference),
      failed = failures.read(row.reference),
      captured = outcome ? BigInt(row.amount) : 0n;
    if (outcome && failed) throw new Error("SIMULATION_OUTCOME_CONFLICT");
    const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
    const value = {
      kind: "Snapshot",
      context,
      providerIntentReference: row.reference,
      providerTransactionReference: outcome?.transaction_reference ?? null,
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
      status: outcome ? "Captured" : failed ? "Failed" : "RequiresCustomerAction",
      requestedAmount: money(BigInt(row.amount)),
      authorizedAmount: money(captured),
      capturedAmount: money(captured),
      refundedAmount: money(refunds.total(row.reference)),
      observedAt: failed?.occurred_at ?? new Date().toISOString(),
    };
    return createPaymentProviderSnapshot({ ...value, evidenceDigest: hash(value) });
  }
  function atomic(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const refunds = createInternalSimulatedRefunds(db, { rowFor, atomic });
  const unsupported = async () => {
    throw new Error("SIMULATION_OPERATION_UNAVAILABLE");
  };
  return {
    simulation: true,
    readCaptureJournal: createInternalCaptureJournalSource(db, {
      authorize: async (context) => {
        scope(context);
        const current = await loadProfile();
        return (
          process.env.NODE_ENV === "development" &&
          current.environment === "InternalTest" &&
          current.database === expectedDatabaseName &&
          current.binding.brandReference === context.brandReference &&
          current.binding.storeReference === context.storeReference &&
          Date.now() < Date.parse(current.binding.validUntil)
        );
      },
    }),
    readSettlementWindow: createInternalSettlementWindowSource(db, {
      authorize: async (context) => {
        scope(context);
        const current = await loadProfile();
        return (
          process.env.NODE_ENV === "development" &&
          current.environment === "InternalTest" &&
          current.database === expectedDatabaseName &&
          current.binding.brandReference === context.brandReference &&
          current.binding.storeReference === context.storeReference &&
          Date.now() < Date.parse(current.binding.validUntil)
        );
      },
    }),
    adapter: {
      async createIntent(value) {
        const input = createCreateIntentRequest(value);
        scope(input.context);
        if (
          input.paymentMethod !== "OnlineCard" ||
          input.captureMode !== "Automatic" ||
          input.amount.currencyCode !== "CAD"
        )
          throw new Error("SIMULATION_METHOD_UNAVAILABLE");
        const fingerprint = hash(input);
        const row = atomic(() => {
          const prior = db
            .prepare("SELECT * FROM intent WHERE idempotency=?")
            .get(input.idempotencyKey);
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              throw new Error("SIMULATION_IDEMPOTENCY_CONFLICT");
            return prior;
          }
          const reference = "pi_DEMO" + randomUUID().replaceAll("-", "");
          db.prepare("INSERT INTO intent VALUES(?,?,?,?,?,?,?,?,?)").run(
            reference,
            input.context.brandReference,
            input.context.storeReference,
            input.context.paymentAttemptReference,
            input.context.operationReference,
            input.idempotencyKey,
            fingerprint,
            input.amount.amountMinor.toString(),
            new Date().toISOString(),
          );
          return db.prepare("SELECT * FROM intent WHERE reference=?").get(reference);
        });
        return snapshot(input.context, row);
      },
      async retrieveIntent(value) {
        const input = createRetrieveIntentRequest(value);
        return snapshot(input.context, rowFor(input));
      },
      cancelIntent: unsupported,
      captureIntent: unsupported,
      async refundPayment(value) {
        const observation = await refunds.refundPayment(value);
        // Compensation consumes the common Provider Snapshot contract. The durable
        // journal and balance fence are shared with ordinary refunds.
        return value.idempotencyKey ===
          "compensation-refund:" + observation.context.operationReference
          ? snapshot(observation.context, rowFor(observation))
          : observation;
      },
      lookupRefund: refunds.lookupRefund,
    },
    async simulateCapture(value, confirmation) {
      if (confirmation !== "SIMULATE_CAPTURE") throw new Error("SIMULATION_CONFIRMATION_REQUIRED");
      const request = createRetrieveIntentRequest(value),
        row = rowFor(request);
      atomic(() =>
        db
          .prepare("INSERT INTO outcome VALUES(?,'Captured',?,?) ON CONFLICT(reference) DO NOTHING")
          .run(
            row.reference,
            "ch_DEMO" + randomUUID().replaceAll("-", ""),
            new Date().toISOString(),
          ),
      );
      return snapshot(request.context, row);
    },
    async simulateFailure(value, confirmation) {
      if (confirmation !== "SIMULATE_FAILURE") throw new Error("SIMULATION_CONFIRMATION_REQUIRED");
      const request = createRetrieveIntentRequest(value),
        row = rowFor(request);
      atomic(() => failures.record(row.reference, new Date().toISOString()));
      return snapshot(request.context, row);
    },
    async readTerminalOccurrence(value) {
      const request = createRetrieveIntentRequest(value),
        row = rowFor(request);
      const captured = db
          .prepare("SELECT occurred_at FROM outcome WHERE reference=?")
          .get(row.reference),
        failed = failures.read(row.reference);
      if (captured && failed) throw new Error("SIMULATION_OUTCOME_CONFLICT");
      if (!captured && !failed) throw new Error("SIMULATION_TERMINAL_UNAVAILABLE");
      return Object.freeze({
        status: captured ? "Captured" : "Failed",
        occurredAt: (captured ?? failed).occurred_at,
      });
    },
    close() {
      db.close();
    },
  };
}
