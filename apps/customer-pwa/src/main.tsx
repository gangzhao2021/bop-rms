import { loadInternalEntryToken, loadPickupEntryToken } from "./entry/internal-entry.js";
import { createCustomerStartClient, type CustomerEntryStartSource } from "./entry/start-client.js";
import type { CustomerEntryResumedContext } from "./entry/types.js";
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
import {
  restoreCustomerSession,
  type CustomerCurrentOrder,
  type CustomerRestoredVisit,
} from "./session/session-bootstrap.js";
import { protectCustomerHistoryRestore } from "./session/history-recovery.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppErrorBoundary } from "@bop-rms/ui";
import { App } from "./App.js";
import { LanguageRoot, t } from "./i18n/i18n.js";
import { consumeCustomerQrFragment, createCustomerEntryClient } from "./entry/entry-client.js";
import "./styles.css";
import "./customer-v3.css";
import { ResumeScreen } from "./resume/ResumeScreen.js";
import { orderRecoveryPath, takeOrderRecoveryToken } from "./resume/order-recovery.js";
import { startCustomerServiceWorker } from "./pwa/register-service-worker.js";
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
const recoveryStatus = document.createElement("p");
recoveryStatus.setAttribute("role", "status");
recoveryStatus.hidden = true;
root.before(recoveryStatus);
protectCustomerHistoryRestore({
  events: window,
  cover: () => {
    root.hidden = true;
    // Owner 2026-11-03: in the language chosen by now, and no status text until it is needed.
    recoveryStatus.textContent = t("Checking your session. Please wait.");
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
          <LanguageRoot>
            {() => (
              <ResumeScreen
                token={token}
                fetcher={window.fetch.bind(window)}
                open={(path) => window.location.replace(path)}
              />
            )}
          </LanguageRoot>
        </AppErrorBoundary>
      </StrictMode>,
    );
    return;
  }
  let initialMenuContext: MenuJourneyContext | undefined;
  let currentOrder: CustomerCurrentOrder | undefined;
  let restoredVisit: CustomerRestoredVisit | undefined;
  const hash = window.location.hash;
  const entryLocation = {
    origin: window.location.origin,
    pathname: window.location.pathname,
    search: window.location.search,
    hash,
  };
  // The code leaves the address bar before anything else is fetched (it is kept only in memory).
  const scannedCode =
    window.location.pathname === "/"
      ? consumeCustomerQrFragment({
          hash,
          pathname: window.location.pathname,
          search: window.location.search,
          replaceState: window.history.replaceState.bind(window.history),
        })
      : null;
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
    (visit) => {
      restoredVisit = visit;
    },
  );
  const runtimePayment = await runtimePaymentLoad;
  const pickupEnabled =
    runtimePayment?.internalTestEntry ??
    import.meta.env.VITE_BOP_INTERNAL_SIMULATED_PAYMENT === "1";
  const fetcher = window.fetch.bind(window);
  // M02 (v15 07b7a1b7): where this phone is comes from its own scan or its own visit, never from
  // a default Store (the start sequence is in entry/start-client.ts).
  const source: CustomerEntryStartSource =
    hash === ""
      ? { kind: "None" }
      : scannedCode !== null
        ? { kind: "Code", load: async () => scannedCode }
        : /^#(?:pickup|internal-dining)=/u.test(hash) && entryLocation.search === ""
          ? {
              kind: "Code",
              load: () =>
                loadInternalEntryToken({
                  enabled: pickupEnabled,
                  location: entryLocation,
                  fetcher,
                }),
            }
          : { kind: "Unusable" };
  const restored: CustomerEntryResumedContext | undefined =
    initialMenuContext === undefined
      ? undefined
      : Object.freeze({
          publicStoreReference: initialMenuContext.publicStoreReference,
          channel: initialMenuContext.channel,
          locale: initialMenuContext.locale,
          brandDisplayName: initialMenuContext.brandDisplayName,
          storeDisplayName: initialMenuContext.storeDisplayName,
          publicTableReference: restoredVisit?.publicTableReference ?? null,
          joined: restoredVisit?.joined ?? false,
        });
  const boundary = {
    fetch: fetcher,
    hash: "",
    pathname: entryLocation.pathname,
    search: entryLocation.search,
    // The address was cleaned above; nothing to replace again.
    replaceState: () => undefined,
    online: () => window.navigator.onLine,
  };
  const entryClient =
    // As it was opened (the address was cleaned above): a query is no entry.
    entryLocation.pathname === "/" && entryLocation.search === ""
      ? createCustomerStartClient({
          source,
          restored,
          forCode: (token) => createCustomerEntryClient(boundary, token),
          forReplay: () => createCustomerEntryClient(boundary, undefined, { resume: true }),
          pickupCode: (publicStoreReference) =>
            loadPickupEntryToken({ enabled: pickupEnabled, fetcher, publicStoreReference }),
          pickupOffered: pickupEnabled,
        })
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
          <LanguageRoot>
            {() => (
              <App
                entryClient={entryClient}
                diningAdmission={diningAdmission}
                initialMenuContext={initialMenuContext}
                currentOrder={currentOrder}
              />
            )}
          </LanguageRoot>
        </BrowserRouter>
      </AppErrorBoundary>
    </StrictMode>,
  );
  startCustomerServiceWorker();
}
void start();
