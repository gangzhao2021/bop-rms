import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import { v7 as uuidv7 } from "uuid";
import { createDiningAdmissionJourney } from "./dining/dining-admission-journey.js";
import { createBrowserDiningJoinClient } from "./dining/dining-join-client.js";
import { createBrowserDiningBindingClient } from "./dining/dining-binding-client.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "./session/customer-transaction-context.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { createCustomerEntryClient } from "./entry/entry-client.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
// A synthetic QR is delivered in memory. Never place it in the address bar or storage.
let hash = "";
let diningAdmissionEnabled = false;
let cartEnabled = false;
if (window.location.pathname === "/" && window.location.search === "") {
  try {
    const response = await window.fetch("/__local/customer-entry", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        "qrToken" in body &&
        typeof body.qrToken === "string"
      ) {
        hash = `#qr=${body.qrToken}`;
        diningAdmissionEnabled =
          "diningAdmissionEnabled" in body && body.diningAdmissionEnabled === true;
        cartEnabled = "cartEnabled" in body && body.cartEnabled === true;
      }
    }
  } catch {
    // The canonical missing-entry screen remains actionable without fabricated context.
  }
}
const entryClient = createCustomerEntryClient({
  fetch: window.fetch.bind(window),
  hash,
  pathname: window.location.pathname,
  search: window.location.search,
  replaceState: window.history.replaceState.bind(window.history),
  online: () => window.navigator.onLine,
});
const transport = { fetch: window.fetch.bind(window), online: () => window.navigator.onLine };
const diningAdmission = diningAdmissionEnabled
  ? {
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
    }
  : undefined;
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <aside aria-label="Local integration lab">
        Synthetic local integration lab — temporary data. Entry, dining admission and menu
        {cartEnabled ? ", with Cart item editing" : ""}. Ordering and payment are unavailable. The
        clock is fixed for repeatable verification.
        <button
          type="button"
          onClick={async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              const response = await window.fetch("/__local/stop", {
                method: "POST",
                cache: "no-store",
                referrerPolicy: "no-referrer",
                signal: AbortSignal.timeout(5_000),
              });
              button.textContent = response.ok ? "Lab stopped" : "Stop failed — retry";
              button.disabled = response.ok;
            } catch {
              button.textContent = "Stop failed — retry";
              button.disabled = false;
            }
          }}
        >
          Stop local lab
        </button>
      </aside>
      <App entryClient={entryClient} diningAdmission={diningAdmission} />
    </BrowserRouter>
  </StrictMode>,
);
