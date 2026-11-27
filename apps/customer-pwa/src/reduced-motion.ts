/** Whether the guest asked their device for less motion (then the page jumps, never glides). */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
