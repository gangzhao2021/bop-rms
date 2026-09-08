# Local Customer Persistence Lab

This opt-in lab exercises the existing Customer entry and menu screens against the real scoped
API and a disposable PostgreSQL database. All Store, QR, operating and menu facts are synthetic;
the clock is fixed at `2026-01-15T12:00:00.000Z`. It is not a real Store or production service.

## Start

Use the repository's exact Node and pnpm pins, install with `pnpm install --frozen-lockfile`,
and start Docker. OpenSSL must be available for a temporary local-only TLS certificate.
Run from the repository root:

```sh
pnpm lab:customer
```

The command first runs the desktop and mobile browser checks, then prints the local address
`https://127.0.0.1:5184`. Open that address in a browser. Its newly generated self-signed certificate
is only for this disposable loopback lab; use a temporary browser exception for that address.
Do not install a trust root or change global TLS verification. The automated browser accepts only
this test context's certificate. If port 5184 is occupied, stop your previous lab before retrying.

The page labels the synthetic environment. It establishes a ContextOnly Guest Session, shows the
synthetic Store, and offers **Continue to menu**. The menu reads its Latte from PostgreSQL.
The lab supplies its synthetic QR in memory through a same-origin POST, never in the URL.
No order or payment is supported. Prices remain unavailable, and `/ready` deliberately returns 503.
Reloading `/menu` loses its memory-only context; return to `/` to enter again.

Use **Stop local lab** on the page for orderly shutdown, or let the lab expire after 15 interactive
minutes. Ctrl+C interrupts the test runner and may require isolated-resource recovery. Each run creates a new
isolated database and closes its own browser, Vite, API and database resources. It does not connect
to an operational database or retain the temporary TLS private-key file. Do not put real data in it.
An interrupted process may require the existing isolated-database recovery procedure; never remove
resources that are not owned by the recorded isolated test run.

## Automated acceptance

```sh
pnpm customer-lab:acceptance
```

This runs the same startup with finite desktop/mobile Chromium checks and then cleans up.
It records no screenshot, trace, raw Cookie, CSRF value, QR token or private-key material.
Install the repository-pinned Chromium using the existing Customer PWA Playwright dependency if
it is not already available. The command fails rather than replacing a missing browser with a mock.

## Remaining sequence

1. This package: interactive entry/menu persistence lab and browser acceptance.
2. Owning successor package: Cart, authoritative quote and persisted order integration.
3. Owning successor package: payment, signed callback, refund and reconciliation integration.
4. Owning successor package: Kitchen, pickup and immutable receipt integration.

Existing Domain modules are reused and audited at each step. Real Provider, Store/device UAT and
Pilot evidence remain the gates in `pilot-integration-readiness-inventory.md`. No synthetic test
satisfies those gates. The original automatic continuation stays paused.
