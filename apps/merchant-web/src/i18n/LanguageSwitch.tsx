import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * Batch 56 (v15 batch 55 live, kitchen display at 390 in zh-Hans): fixed at the bottom of the
 * screen, the "can't switch now" note covered the first ticket's 做好了 / Finished button for 8 s.
 * It now takes its own place in the page, right under the bar that holds the switch (the
 * workspace's top bar, else the screen's own header), so it pushes the screen down instead of
 * covering any of it. Only a page with neither keeps the note at the bottom of the screen.
 * The kitchen board already treats a ticket moved under a finger as "Moved. Tap again.".
 */
export function languageNoteAnchor(button: Element): Element | null {
  const workspace = button.ownerDocument.querySelector(".workspace-content > .workspace-topbar");
  if (workspace !== null) return workspace;
  return button.closest("header");
}
const NOTE_SLOT = "language-switch-note-slot";
function languageNoteSlot(anchor: Element): HTMLElement {
  const after = anchor.nextElementSibling;
  if (after instanceof HTMLElement && after.classList.contains(NOTE_SLOT)) return after;
  const slot = anchor.ownerDocument.createElement("div");
  slot.className = NOTE_SLOT;
  anchor.after(slot);
  return slot;
}

/** "中文" / "English": switches the whole back office on this device. */
export function LanguageSwitch({ className }: { readonly className?: string }) {
  const next: StaffLanguage = currentLanguage() === "zh-Hans" ? "en" : "zh-Hans";
  const [refused, setRefused] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const asking = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
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
  // Placed before the screen is painted, so the note never shows at the bottom first.
  useLayoutEffect(() => {
    if (!refused) return;
    const anchor = button.current === null ? null : languageNoteAnchor(button.current);
    const placed = anchor === null ? null : languageNoteSlot(anchor);
    setSlot(placed);
    return () => {
      setSlot(null);
      if (placed !== null && placed.childElementCount === 0) placed.remove();
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
    <p
      className={
        slot === null
          ? "language-switch-note language-switch-note--floating"
          : "language-switch-note"
      }
      role="status"
    >
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
        ref={button}
        onClick={() => void choose()}
      >
        {next === "zh-Hans" ? "中文" : "English"}
      </button>
      {/* Outside the bar, under it, so the note never covers a control of the screen. */}
      {note !== null && typeof document !== "undefined"
        ? createPortal(note, slot ?? document.body)
        : null}
    </>
  );
}
