import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
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
      if (body && typeof body === "object" && "qrToken" in body && typeof body.qrToken === "string")
        hash = `#qr=${body.qrToken}`;
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
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <aside aria-label="Local integration lab">
        Synthetic local integration lab — temporary data. Entry and menu only; ordering and payment
        are unavailable. The clock is fixed for repeatable verification.
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
      <App entryClient={entryClient} />
    </BrowserRouter>
  </StrictMode>,
);
