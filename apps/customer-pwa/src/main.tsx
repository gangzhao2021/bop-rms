import { loadInternalEntryToken } from "./entry/internal-entry.js";
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
import { restoreCustomerSession } from "./session/session-bootstrap.js";
import { protectCustomerHistoryRestore } from "./session/history-recovery.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppErrorBoundary } from "@bop-rms/ui";
import { App } from "./App.js";
import { createCustomerEntryClient } from "./entry/entry-client.js";
import "./styles.css";
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
  let initialMenuContext: MenuJourneyContext | undefined;
  if (window.location.pathname !== "/")
    await restoreCustomerSession(window.fetch.bind(window), (context) => {
      initialMenuContext = context;
    });
  const hash = window.location.hash;
  const inMemoryToken = await loadInternalEntryToken({
    enabled: import.meta.env.VITE_BOP_INTERNAL_SIMULATED_PAYMENT === "1",
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
          />
        </BrowserRouter>
      </AppErrorBoundary>
    </StrictMode>,
  );
  startCustomerServiceWorker();
}
void start();
