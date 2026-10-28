import { LanguageRoot } from "./i18n/i18n.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { loadLocalCustomerDemo } from "./customer-demo-entry.js";
import "./customer-demo.css";
import "./styles.css";
import "./customer-v3.css";

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
      <LanguageRoot>
        {() =>
          EntryLifecycle ? (
            <EntryLifecycle />
          ) : (
            <App {...(demo === null ? {} : { demo })} {...dining} />
          )
        }
      </LanguageRoot>
    </BrowserRouter>
  </StrictMode>,
);
