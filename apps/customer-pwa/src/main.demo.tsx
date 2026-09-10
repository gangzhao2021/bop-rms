import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { loadLocalCustomerDemo } from "./customer-demo-entry.js";
import "./customer-demo.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");

const demo = await loadLocalCustomerDemo(() => import("./customer-demo.js"));
const dining =
  new URLSearchParams(window.location.search).get("scenario") === "dining-admission"
    ? (await import("./customer-dining-demo.js")).createLocalDiningAdmissionDemo()
    : undefined;
const EntryLifecycle =
  new URLSearchParams(window.location.search).get("scenario") === "entry-lifecycle"
    ? (await import("./customer-entry-lifecycle-demo.js")).EntryLifecycleDemo
    : null;
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      {EntryLifecycle ? (
        <EntryLifecycle />
      ) : (
        <App {...(demo === null ? {} : { demo })} {...dining} />
      )}
    </BrowserRouter>
  </StrictMode>,
);
