/**
 * M50 (WP-2423): print one region of a page. The print styles (ui-refresh/print.css) hide the rest of
 * the page only while `body[data-printing]` is set, so a page printed any other way (Today's summary,
 * the browser's own Print) prints as it is shown.
 */
export function printRegion(region: HTMLElement, kind: string): void {
  const clear = () => {
    document.body.removeAttribute("data-printing");
    region.removeAttribute("data-print-root");
    window.removeEventListener("afterprint", clear);
  };
  document.body.setAttribute("data-printing", kind);
  region.setAttribute("data-print-root", "");
  window.addEventListener("afterprint", clear);
  window.print();
}
