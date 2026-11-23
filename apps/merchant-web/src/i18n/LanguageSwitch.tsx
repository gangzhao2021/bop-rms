import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { currentLanguage, prepareLanguageSwitch, t, type StaffLanguage } from "./i18n.js";

/*
 * The staff language switch (a React component), kept apart from the translation module so plain
 * TypeScript clients that translate staff text never depend on JSX.
 */

/** How long the "can't switch now" note stays on screen. */
const NOTE_FOR_MS = 8_000;
/** A connection that answers nothing within this long counts as down. */
const ASK_FOR_MS = 5_000;

/**
 * WP-2423 batch 55 (v15 batch 54 live, kitchen display): switching reloads the page (every text a
 * module prepared at load must follow), and a reload while the store system can't be reached loses
 * the screen to the offline page (the kitchen lost its board and its last-seen tickets). So the
 * switch first asks the store system, the same small file the offline page asks; only an answer
 * lets it reload. The browser can say "online" with the store's Wi-Fi up and the internet down.
 */
export async function systemAnswersForReload(
  ask: typeof fetch = (...request) => globalThis.fetch(...request),
): Promise<boolean> {
  if (globalThis.navigator?.onLine === false) return false;
  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(ASK_FOR_MS)
      : undefined;
  try {
    const answer = await ask("/operations/sw.js", {
      cache: "no-store",
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    return answer.ok;
  } catch {
    return false;
  }
}

/** "中文" / "English": switches the whole back office on this device. */
export function LanguageSwitch({ className }: { readonly className?: string }) {
  const next: StaffLanguage = currentLanguage() === "zh-Hans" ? "en" : "zh-Hans";
  const [refused, setRefused] = useState(false);
  const asking = useRef(false);
  useEffect(() => {
    if (!refused) return;
    const clear = () => setRefused(false);
    const timer = globalThis.setTimeout(clear, NOTE_FOR_MS);
    globalThis.addEventListener("online", clear);
    return () => {
      globalThis.clearTimeout(timer);
      globalThis.removeEventListener("online", clear);
    };
  }, [refused]);
  const choose = async () => {
    if (asking.current) return;
    // Offline: nothing to ask, and nothing is written or asked about.
    if (globalThis.navigator?.onLine === false) {
      setRefused(true);
      return;
    }
    // Unsaved work is asked about at once, on the tap.
    const prepared = prepareLanguageSwitch(next);
    if (prepared === null) return;
    asking.current = true;
    try {
      if (await systemAnswersForReload()) {
        setRefused(false);
        prepared.switchNow();
      } else {
        prepared.cancel();
        setRefused(true);
      }
    } finally {
      asking.current = false;
    }
  };
  const note = refused ? (
    <p className="language-switch-note" role="status">
      {t(
        "Can't reach the system right now, so the language can't change. This screen stays as it is; try again once connected.",
      )}
    </p>
  ) : null;
  return (
    <>
      <button
        type="button"
        className={className === undefined ? "language-switch" : `language-switch ${className}`}
        lang={next === "zh-Hans" ? "zh-Hans" : "en"}
        aria-label={next === "zh-Hans" ? "切换到中文" : "Switch to English"}
        onClick={() => void choose()}
      >
        {next === "zh-Hans" ? "中文" : "English"}
      </button>
      {/* Outside the bar, so the note never moves a control of the screen it sits on. */}
      {note !== null && typeof document !== "undefined" ? createPortal(note, document.body) : null}
    </>
  );
}
