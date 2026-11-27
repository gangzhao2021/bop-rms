import { useEffect } from "react";

/**
 * b19: a link to a section further down a page (`#sole-operator` from Approvals) opens the page
 * before that section has loaded, so the browser's own jump to the anchor finds nothing. Watch the
 * page until the section appears (at most `waitMs`), then bring it to the top once. Returns the
 * cleanup. Only plain ids are followed.
 */
export function scrollToAnchorWhenShown(
  hash: string,
  doc: Document = document,
  waitMs = 10_000,
): () => void {
  const id = /^#[A-Za-z][\w-]*$/u.test(hash) ? hash.slice(1) : null;
  if (id === null) return () => undefined;
  let done = false;
  const show = () => {
    if (done) return;
    const target = doc.getElementById(id);
    if (target === null) return;
    done = true;
    stop();
    target.scrollIntoView({ block: "start" });
  };
  const observer = new MutationObserver(show);
  const timer = setTimeout(() => stop(), waitMs);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(doc.body, { childList: true, subtree: true });
  show();
  return () => {
    done = true;
    stop();
  };
}

/** Brings the section the address names into view once it has rendered. */
export function useScrollToAnchor(hash: string) {
  useEffect(() => scrollToAnchorWhenShown(hash), [hash]);
}
