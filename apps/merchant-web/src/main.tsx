import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppErrorBoundary, UiTextContext, type UiText } from "@bop-rms/ui";
import { t, withContentLocale } from "./i18n/i18n.js";
import { LanguageSwitch } from "./i18n/LanguageSwitch.js";
import { App } from "./App.js";
import { installStaffSignInFetchGate } from "./staff-session-reads.js";
import "./styles.css";
import "./ui-refresh/index.css";
// v15 37e0ecbe: no request with an ended staff sign-in leaves this tab; a refusal checks at once.
installStaffSignInFetchGate();
// Owner 2026-10-24: Store content names on operational screens in the staff member's language.
globalThis.fetch = withContentLocale(
  globalThis.fetch.bind(globalThis),
  () => globalThis.location?.href,
);
// Owner 2026-10-24: the shared frame's own words in the staff language, and the language switch in
// every frame header (the workspace shows it beneath the navigation instead).
const uiText: UiText = Object.freeze({
  skipToMainContent: t("Skip to main content"),
  primaryNavigation: t("Primary"),
  errorHeading: t("Something went wrong"),
  errorBody: t(
    "This page could not be shown. Reload to try again. If you were in the middle of something, check it after reloading before doing it again.",
  ),
  reload: t("Reload"),
  headerExtra: <LanguageSwitch />,
});
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(
  <StrictMode>
    <UiTextContext.Provider value={uiText}>
      <AppErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppErrorBoundary>
    </UiTextContext.Provider>
  </StrictMode>,
);
