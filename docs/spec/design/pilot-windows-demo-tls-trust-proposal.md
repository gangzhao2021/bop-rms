# Windows local demonstration certificate trust

Status: accepted by the Owner on2026-09-22 (explicit reply: 批准). WP-2402 local demonstration only. Import completion and Windows HTTPS verification are tracked separately.

## Observed issue

On2026-09-22 the WSL client validates the current private installation's public
certificate and all three demo HTML routes respond200 (batch598). A Windows HTTPS
request using normal certificate validation instead fails with `UntrustedRoot`
(c1bbd3/84a42f). This is a Windows trust gap, not an unavailable WSL service.
Browser automation separately failed to initialize its Windows sandbox; no rendered
browser or login success is claimed from these transport probes.

## Exact certificate

- Existing public file: `.local/pilot-v14/customer-tls-cert.pem`.
- Subject and issuer: `CN=127.0.0.1`; SAN: IP `127.0.0.1`.
- SHA256: `488915F5794F26FA0DF62D6B859346626EB6096EC8E3BEEC384790B97D55E622`.
- Valid2026-09-20T02:52:04Z through2026-10-20T02:52:04Z.
- Basic Constraints: critical, `CA:TRUE`; no narrower key-usage restriction reported.
- The matching private key stays protected in the existing WSL installation. It
  must not be printed, exported, copied into Windows or included in Git.

## Requested change and concrete scope

With explicit approval, read only this public certificate, recheck its SHA256,
identity, SAN and validity, and add it only to the current Windows user's
`Cert:\CurrentUser\Root` store. Do not add it to LocalMachine, replace other
certificates, alter browser-wide certificate validation, open firewall ports,
regenerate keys or change any server/database/account configuration. If the exact
certificate is already present, do not add another copy.

This is a trusted-root change, not merely a localhost exception. Because this
self-signed certificate has CA authority, the current Windows user's applications
can also trust certificates signed by its corresponding private key. The private
key's protection therefore matters. The change is intended only for the local demo;
cloud deployment needs its own approved certificate and this trust entry should be
removed when no longer needed.

## Verification and rollback

After adding it, repeat one Windows HTTPS GET to the staff entry using normal
certificate validation, followed by the other two local entry GETs if successful.
Do not disable certificate validation. Do not submit login, order or refund commands
merely to test trust. Record only aggregate response status, never cookies/tokens.
If trust or endpoint validation fails, report the actual error without automatically
broadening trust scope or changing the server certificate.

Before import, record whether the exact certificate already existed. If this
operation added it, rollback removes only that exact public certificate from the
current user's Root store after verifying its SHA256 again. Never remove an
unrelated or preexisting trust entry. The removal should restore the prior trust
state without deleting the private installation certificate or key.

No trust-store write occurred during proposal preparation. This request is
independent of the already-approved Recovery lock/service changes.

## Executed result

The Owner confirmed the Windows Security Warning. The original import completed
on2026-09-22 with one matching entry added to CurrentUser/Root and no preexisting
match (7a1957). All three Windows demo entry GETs then returned200 with normal TLS
validation (542a67). No private key, system-level store or other certificate was
changed. Only this newly added exact certificate is eligible for the scoped rollback.
