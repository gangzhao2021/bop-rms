/**
 * Guest entry (M106): the Content-Security-Policy every customer page is served under, in the pilot
 * entry and in the production-build browser proof (`vite preview`), so the browser suites run the
 * app under the same policy guests get.
 *
 * Only this origin's own scripts and styles run (the boot shell has no inline script or style).
 * Card payments use Stripe.js, which needs its script, its frames and its API; those Stripe hosts
 * are the only other origins named. Nothing may frame these pages, and no plugin, base change or
 * form post elsewhere is allowed.
 */
export const customerContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com https://*.js.stripe.com",
  "style-src 'self'",
  "img-src 'self' https://*.stripe.com",
  "font-src 'self'",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com",
  "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://m.stripe.network",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
