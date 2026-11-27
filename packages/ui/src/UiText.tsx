import { createContext, useContext, type ReactNode } from "react";

/**
 * The few words the shared frame writes itself, in the app's language (English unless an app
 * provides its own wording, as the staff back office does for Simplified Chinese), and an optional
 * control every frame header shows (the staff language switch).
 */
export interface UiText {
  readonly skipToMainContent: string;
  readonly primaryNavigation: string;
  readonly errorHeading: string;
  readonly errorBody: string;
  readonly reload: string;
  readonly headerExtra?: ReactNode;
}

export const englishUiText: UiText = Object.freeze({
  skipToMainContent: "Skip to main content",
  primaryNavigation: "Primary",
  errorHeading: "Something went wrong",
  errorBody:
    "This page could not be shown. Reload to try again. If you were in the middle of something, check it after reloading before doing it again.",
  reload: "Reload",
});

export const UiTextContext = createContext<UiText>(englishUiText);

export function useUiText(): UiText {
  return useContext(UiTextContext);
}
