import { chooseLanguage, currentLanguage, type StaffLanguage } from "./i18n.js";

/*
 * The staff language switch (a React component), kept apart from the translation module so plain
 * TypeScript clients that translate staff text never depend on JSX.
 */
/** "中文" / "English": switches the whole back office on this device. */
export function LanguageSwitch({ className }: { readonly className?: string }) {
  const next: StaffLanguage = currentLanguage() === "zh-Hans" ? "en" : "zh-Hans";
  return (
    <button
      type="button"
      className={className === undefined ? "language-switch" : `language-switch ${className}`}
      lang={next === "zh-Hans" ? "zh-Hans" : "en"}
      aria-label={next === "zh-Hans" ? "切换到中文" : "Switch to English"}
      onClick={() => chooseLanguage(next)}
    >
      {next === "zh-Hans" ? "中文" : "English"}
    </button>
  );
}
