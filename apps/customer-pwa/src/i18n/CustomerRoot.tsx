import { useMemo, type ReactNode } from "react";
import { AppErrorBoundary, UiTextContext, type UiText } from "@bop-rms/ui";
import { LanguageRoot, t, useLanguage, type CustomerLanguage } from "./i18n.js";

/**
 * Batch 42 (v15 b41 live): the shared frame writes a few words itself (the skip link, the
 * navigation's name, the page shown when something breaks). The guest reads them in the language
 * they chose, as every other word on the page, never English on a Chinese page.
 */
export function customerUiText(): UiText {
  return Object.freeze({
    skipToMainContent: t("Skip to main content"),
    primaryNavigation: t("Primary"),
    errorHeading: t("Something went wrong"),
    errorBody: t(
      "This page could not be shown. Reload to try again. If you were in the middle of something, check it after reloading before doing it again.",
    ),
    reload: t("Reload"),
  });
}

/** The frame's words, following the guest's language as it changes. */
export function CustomerFrameText({ children }: { readonly children: ReactNode }) {
  const { language } = useLanguage();
  // The words follow the chosen language (t() reads it).
  const text = useMemo(customerUiText, [language]);
  return <UiTextContext.Provider value={text}>{children}</UiTextContext.Provider>;
}

/**
 * Every customer page's root: the guest's language, the frame's words in it, and the page shown
 * if rendering breaks (in that language too, since it sits inside them).
 */
export function CustomerRoot({
  initial,
  children,
}: {
  readonly initial?: CustomerLanguage;
  readonly children: () => ReactNode;
}) {
  return (
    <LanguageRoot {...(initial === undefined ? {} : { initial })}>
      {() => (
        <CustomerFrameText>
          <AppErrorBoundary>{children()}</AppErrorBoundary>
        </CustomerFrameText>
      )}
    </LanguageRoot>
  );
}
