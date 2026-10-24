import { createInternalProviderCaptureReview } from "./pilot-provider-capture-review.mjs";
import { join } from "node:path";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createPilotPaymentProvider } from "./pilot-stripe-provider.mjs";
import { createInternalReconciliationRuntime } from "./pilot-reconciliation-runtime.mjs";
import { createOperationalReconciliationScheduler } from "./pilot-reconciliation-scheduler.mjs";
import {
  createPostgresPaymentReconciliationRunSource,
  createPostgresPaymentReconciliationCandidates,
} from "../../packages/rms/payment/src/index.ts";
import { isPilotRuntime, pilotProviderEnvironment } from "./pilot-environment.mjs";
export async function createConfiguredReconciliationExecution(
  directory,
  resources,
  { providerCaptureReview = false } = {},
) {
  const installation = await loadPilotInstallation(directory),
    config = await installation.loadCustomerRuntime();
  const simulator = await createPilotPaymentProvider(
    {},
    {
      directory,
      path: join(directory, "simulated-provider.sqlite"),
      loadProfile: installation.loadProfile,
      expectedDatabaseName: installation.database,
    },
  );
  try {
    const active = async () =>
      isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil;
    const runtime = createInternalReconciliationRuntime({
      resources,
      simulator,
      providerAccountReference: config.providerAccountReference,
    });
    const read = createPostgresPaymentReconciliationRunSource({
      scope: resources.scope,
      authorize: active,
    });
    const due = createPostgresPaymentReconciliationCandidates({
      scope: { ...resources.scope, environment: pilotProviderEnvironment() },
      authorize: active,
    });
    const runOnce = createOperationalReconciliationScheduler({
      scope: resources.scope,
      now: resources.now,
      readRun: (q) => resources.transactions.run((tx) => read(tx, q)),
      hasDue: (q) =>
        resources.transactions.run(async (tx) => (await due(tx, { ...q, limit: 1 })).length > 0),
      execute: (q) => runtime.run(q),
    });
    return {
      runOnce,
      reviewCaptures: providerCaptureReview
        ? createInternalProviderCaptureReview({
            resources,
            simulator,
            providerAccountReference: config.providerAccountReference,
          })
        : null,
      close: () => simulator.close(),
    };
  } catch (error) {
    simulator.close();
    throw error;
  }
}
