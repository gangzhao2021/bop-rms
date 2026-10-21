import { loadInternalEntryToken } from "./entry/internal-entry.js";
import { loadRuntimePaymentConfiguration } from "./payment/payment-runtime-configuration.js";
import type { MenuJourneyContext } from "./menu/types.js";
import { v7 as uuidv7 } from "uuid";
import { createDiningAdmissionJourney } from "./dining/dining-admission-journey.js";
import { createBrowserDiningJoinClient } from "./dining/dining-join-client.js";
import { createBrowserDiningBindingClient } from "./dining/dining-binding-client.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "./session/customer-transaction-context.js";
import { restoreCustomerSession, type CustomerCurrentOrder } from "./session/session-bootstrap.js";
import { protectCustomerHistoryRestore } from "./session/history-recovery.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppErrorBoundary } from "@bop-rms/ui";
import { App } from "./App.js";
import { createCustomerEntryClient } from "./entry/entry-client.js";
import "./styles.css";
import { ResumeScreen } from "./resume/ResumeScreen.js";
import { orderRecoveryPath, takeOrderRecoveryToken } from "./resume/order-recovery.js";
import { startCustomerServiceWorker } from "./pwa/register-service-worker.js";
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
const recoveryStatus = document.createElement("p");
recoveryStatus.setAttribute("role", "status");
recoveryStatus.textContent = "Checking your session. Please wait.";
recoveryStatus.hidden = true;
root.before(recoveryStatus);
protectCustomerHistoryRestore({
  events: window,
  cover: () => {
    root.hidden = true;
    recoveryStatus.hidden = false;
  },
  reload: () => window.location.reload(),
});
async function start() {
  // DEC-PILOT-NOTIFICATIONS R1 (IDR-0031): a one-time order link. The token leaves the address bar
  // before anything else runs; nothing else (session bootstrap, entry, service worker) starts here.
  if (window.location.pathname === orderRecoveryPath) {
    const token = takeOrderRecoveryToken({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      replaceState: window.history.replaceState.bind(window.history),
    });
    if (!root) throw new Error("Application root is missing");
    createRoot(root).render(
      <StrictMode>
        <AppErrorBoundary>
          <ResumeScreen
            token={token}
            fetcher={window.fetch.bind(window)}
            open={(path) => window.location.replace(path)}
          />
        </AppErrorBoundary>
      </StrictMode>,
    );
    return;
  }
  let initialMenuContext: MenuJourneyContext | undefined;
  let currentOrder: CustomerCurrentOrder | undefined;
  const hash = window.location.hash;
  // The deployment's payment mode is runtime configuration, so one image serves both the
  // internal simulator and Stripe; without it the build-time configuration applies.
  const runtimePaymentLoad = loadRuntimePaymentConfiguration({
    location: window.location,
    fetcher: window.fetch.bind(window),
  });
  // WP-2423 Q10: a reopened app, or a QR code scanned again while an order is in progress, still
  // finds the order this browser placed before a new visit could replace its Session.
  await restoreCustomerSession(
    window.fetch.bind(window),
    (context) => {
      initialMenuContext = context;
    },
    (order) => {
      currentOrder = order;
    },
  );
  const runtimePayment = await runtimePaymentLoad;
  const inMemoryToken = await loadInternalEntryToken({
    enabled:
      runtimePayment?.internalTestEntry ??
      import.meta.env.VITE_BOP_INTERNAL_SIMULATED_PAYMENT === "1",
    location: window.location,
    fetcher: window.fetch.bind(window),
  });
  const entryClient =
    window.location.pathname === "/"
      ? createCustomerEntryClient(
          {
            fetch: window.fetch.bind(window),
            hash,
            pathname: window.location.pathname,
            search: window.location.search,
            replaceState: window.history.replaceState.bind(window.history),
            online: () => window.navigator.onLine,
          },
          inMemoryToken,
        )
      : undefined;
  if (!root) throw new Error("Application root is missing");
  const transport = { fetch: window.fetch.bind(window), online: () => window.navigator.onLine };
  const diningAdmission = {
    journey: createDiningAdmissionJourney({
      join: createBrowserDiningJoinClient(transport),
      binding: createBrowserDiningBindingClient(transport),
      online: transport.online,
      generateBindingOperationReference: uuidv7,
      generatePreparationReference: uuidv7,
      csrf: {
        get: getCustomerCsrfCredential,
        set: setCustomerCsrfCredential,
        capture: captureCustomerCsrfContext,
      },
    }),
    generateOperationReference: uuidv7,
  };
  createRoot(root).render(
    <StrictMode>
      <AppErrorBoundary>
        <BrowserRouter>
          <App
            entryClient={entryClient}
            diningAdmission={diningAdmission}
            initialMenuContext={initialMenuContext}
            currentOrder={currentOrder}
          />
        </BrowserRouter>
      </AppErrorBoundary>
    </StrictMode>,
  );
  startCustomerServiceWorker();
}
void start();
