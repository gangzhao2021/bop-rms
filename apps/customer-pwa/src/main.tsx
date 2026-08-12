import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { createCustomerEntryClient } from "./entry/entry-client.js";
import "./styles.css";
import { startCustomerServiceWorker } from "./pwa/register-service-worker.js";
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
const entryClient =
  window.location.pathname === "/"
    ? createCustomerEntryClient({
        fetch: window.fetch.bind(window),
        hash: window.location.hash,
        pathname: window.location.pathname,
        search: window.location.search,
        replaceState: window.history.replaceState.bind(window.history),
        online: () => window.navigator.onLine,
      })
    : undefined;
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App entryClient={entryClient} />
    </BrowserRouter>
  </StrictMode>,
);
startCustomerServiceWorker();
