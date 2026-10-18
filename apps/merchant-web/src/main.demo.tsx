import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppErrorBoundary } from "@bop-rms/ui";
import { App } from "./App.js";
import { loadLocalMerchantDemo } from "./merchant-demo-entry.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");

const demo = await loadLocalMerchantDemo(() => import("./merchant-demo.js"));
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App {...(demo === null ? {} : { demo })} />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
