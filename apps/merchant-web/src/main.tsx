import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppErrorBoundary } from "@bop-rms/ui";
import { App } from "./App.js";
import { installStaffSignInFetchGate } from "./staff-session-reads.js";
import "./styles.css";
// v15 37e0ecbe: no request with an ended staff sign-in leaves this tab; a refusal checks at once.
installStaffSignInFetchGate();
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
