# Root local environment

WP-0006 owns startup-time validation and orchestration of the services already integrated by WP-0004 and WP-0005. It is a local developer workflow, not a production process manager or deployment system.

## Commands

Run all commands from the repository root in the same native macOS or Linux/WSL2 environment:

```bash
pnpm environment:check
pnpm dev
pnpm local:status
pnpm local:stop
```

`pnpm dev` is a foreground supervisor. It validates the environment, builds the four skeletons, starts only the configured Compose PostgreSQL service, launches API/Worker/Merchant Web/Customer PWA, waits finitely for health, and then remains attached. `Ctrl+C`, `SIGTERM`, a child failure, or `pnpm local:stop` stops the application children and the configured PostgreSQL service. The PostgreSQL named volume is preserved.

Runtime metadata lives under ignored `.local/environment/`. A status command trusts it only while the recorded supervisor PID is alive and the configured endpoints match. Application output may interleave in the foreground terminal; the supervisor never prints environment values or reads the PostgreSQL secret.

## Validation boundary

The validator requires:

- Native macOS or Linux/WSL2 and a repository real path outside `/mnt/*`
- Native Git, Node, Corepack, pnpm, and Docker executables; the Docker Desktop Linux CLI bridge under `/mnt/wsl/docker-desktop/` is accepted
- Node `24.18.0`, Corepack `0.35.0`, pnpm `11.13.0`, and Turbo `2.10.5`
- a reachable Linux Docker Engine and Compose
- the complete `.env` contract, valid identifiers, and unique localhost ports
- a non-empty, non-symlink PostgreSQL secret file with mode `0600`
- free configured ports before startup

The non-secret contract is documented by `.env.example`. The root supervisor passes only an individual `PORT` to the API and explicit CLI ports to Vite. It does not pass the PostgreSQL password or the rest of `.env` into application processes.

## Truthful readiness and cleanup

Startup requires API `/health`, both Vite shells, a live Worker process, and a healthy Compose PostgreSQL service. API `/ready` must still return `503`, `not_ready`, and database `not_configured`; no driver, ORM, migration, schema, seed, Repository, or application database connection is present.

The normal stop command preserves the WP-0005 volume. `pnpm environment:verify` instead uses a dedicated `bop-rms-wp0006-verify` Compose project, synthetic temporary credentials under ignored `.local/`, alternate localhost ports, and final `down --volumes` cleanup. It does not inspect, stop, or delete another Compose project's resources.

## Host process inspection

WP-2215 adds native macOS support to the existing lifecycle. Linux reads process identity from
`/proc`; macOS uses bounded `/bin/ps` queries. Both require the expected Node invocation (`node` from the validated PATH or the
resolved Node path), script and supervisor `start` argument before signalling a PID. Invalid or unavailable process identity
fails closed. Verification checks environment-key isolation on both hosts without printing process
arguments or environment values. Windows still requires WSL2, and Docker must run Linux containers.

## Configured Worker entry (WP-2402)

The Worker entry now accepts `--configuration` followed by an absolute local
`.js` or `.mjs` module path. This is trusted executable configuration, loaded
with Node ESM; it must export `workload` implementing the existing WorkerWorkload
contract. Compose the actual `createPersistentConsumerWorker` with real scoped
connections and business consumers. Import must not start work. Initialization
belongs in `start`; `stop` must drain work and release owned connections,
including after partial startup failure. Loading failures are sanitized.

Set optional `BOP_RMS_WORKER_CONFIGURATION` in the existing env file to a
checkout-relative or absolute module path. The supervisor resolves an existing
JavaScript file inside the real checkout, rejects escaping symlinks, and passes
only its absolute path as the Worker argument. It does not import the module or
forward database secret contents. The existing stop/PID handling is retained.

This does not supply a Store configuration. Without the optional setting, Worker
still correctly fails with an unconfigured workload. The older foundation startup
description above does not establish that current `pnpm dev` starts a usable
pilot. The next assembly step is the concrete shared Store/database configuration
and API process wiring; do not use an empty workload to satisfy startup.

## Configured API entry (WP-2402)

Set optional `BOP_RMS_API_CONFIGURATION` to an existing checkout-local JavaScript
module. The supervisor passes its absolute path through `--configuration`.
The module exports `createRuntime({ port })`, returning an ApiServerRuntime
constructed with actual owner ports and a database readiness probe. Import
must not start work. The factory must clean up if construction fails; returned
`shutdown` must drain HTTP and release owned connections. Configuration failures
are sanitized. The process catches listen failures and invokes shutdown.

With this setting the supervisor requires HTTP 200 and ready/database ready.
Without it, the foundation expectation remains HTTP 503 and not_configured.
Neither setting supplies the concrete Store/business configuration or proves
the complete Customer/Merchant/Worker journey.

## Frontend API forwarding

When an API configuration module is selected, the supervisor supplies the
loopback API origin to both Vite processes via `BOP_LOCAL_API_ORIGIN`.
Their development servers proxy `/api`, `/bff` and `/merchant` to that
endpoint, preserving Host, Origin and cookies for API-side validation. This
setting is ignored during production builds and does not select demo entries.
Configure the API's accepted origins/merchant host to the frontend origins.
Secure session configuration remains necessary. A fresh installed Chromium
probe confirmed Secure/HttpOnly/__Host cookies work on the local127.0.0.1
HTTP origin without TLS bypass. This only supports local loopback operation;
real deployment still requires HTTPS and its own browser/session acceptance.

## Workspace source imports (WP-2402)

Local API and Worker processes preload
`tooling/environment/register-workspace-typescript.mjs`. Domain packages export
TypeScript source with relative `.js` imports. The hook preserves real JavaScript
resolution, falls back to existing TypeScript only within workspace package
source (plus their shared module manifest), and transforms using the installed
pinned TypeScript compiler. It does not replace typechecking and is not a
production deployment loader.

For the Media image workload, a protected configuration module can export `workload` from
`createMediaImageWorkerWorkload` in `apps/worker/dist/media-image-workload.js`, after the existing
Worker build. Supply the parsed `MEDIA_IMAGE_WORKER_V1` configuration, a restricted connection
acquirer, the database cleanup function, and positive polling/drain settings. The module uses
the existing `--configuration` entry and this local source loader. Importing it does not receive
messages. Startup does not create a queue, grant Permission or provision cloud resources. The
configuration digest must already have a current owning Permission decision, and the queue must
have a retained protected creation receipt. See `packages/bop/media/README.md` for the remaining
deployment assembly and actual AWS evidence requirements. No usable deployment configuration is
created by this documentation.

Direct local starts need the same `node --import` option. The ignored pilot
API configuration is `.local/pilot/api.mjs`; it currently connects the restricted
API database account and owns pool shutdown. Its database readiness does not
prove business-route configuration or pilot acceptance.

## Ordinary refund Worker configuration

A trusted local Worker configuration can export a workload returned by
createConfiguredOrdinaryRefundWorker from ordinary-refund-worker.mjs.
Use the existing --configuration process option; import alone performs no
database acquisition, scan or Provider call. Build API and Worker first, and use
the existing workspace TypeScript registration used by the local process launcher.

Supply open, pageSize, pollIntervalMs and drainDeadlineMs explicitly.
The open() callback returns:

- processing: the complete createOrdinaryRefundProcessing configuration,
  including current Payment/Workforce/Store authorization, bound provider account
  and environment, dispatch identities, observation identities, receipt authority,
  receipt identities and freshness policy.
- failure: audit authorization, fresh audit identity, clock and accepted
  retention policy for createOrdinaryRefundFailureRecorder. Scope and transaction
  runner are always taken from processing, preventing independent overrides.
- close(): release the acquired resource after active work drains. If acquisition
  itself fails before returning, open() must clean up its partial acquisition.

The returned workload can be included alongside the persisted event consumers
with createCompositeWorkerWorkload. The configuration owns connection sharing:
give each workload its own resource lease or a correctly reference-counted lease;
do not let one workload close a shared pool while another is draining.

No Provider, identity, Store policy, audit retention or permission defaults are
supplied. The demonstration Store configuration and health-only candidate API do
not meet these inputs and must not be reported as an activated refund worker.
Actual external test/live readiness and Store approval remain separate gates.

### Persistent customer entry configuration

LocalCustomerRuntimeOptions.entry accepts either the existing explicit source ports
or a persistent configuration plus the shared session binding/credential provider.
The persistent form supplies profile configuration, a transaction runner, and
sources(transaction, input) returning QR, operating, admission and request-scoped
session binding ports. Every returned port must use that retained transaction and
retain current authorization fences. Do not open independent transactions inside
those owner ports or commit before entry establishment completes.

The runtime composes the actual public profile/timing owners and GuestSession
writer in that transaction. An unavailable entry throws internally to roll back;
credentials leave the wrapper only after transaction commit succeeds. The profile
Brand/Store binding must match runtime scope. Cart uses the same configured profile
through a separate complete read transaction. No legacy profile or QR placeholders
are required for persistent entry. The caller still owns database resource cleanup.
A configured factory is not evidence that a candidate process supplies these ports
or that a complete browser journey has passed.

Persistent entry sources may provide operatingReader instead of legacy operating
candidate ports. createPersistentEntryOperatingReader composes actual current
public Store resolution and createPostgresPublishedStoreOperatingStatusReader in
the same entry transaction. Configure matching Tenant/Brand/Store and real current
publication/Live Gate/pause authorization. It returns evaluated state and service
modes without manufacturing release metadata. Entry rejects mismatched scope/time,
unavailable state and disabled modes before consuming admission.

### Customer Cart Catalog and Inventory configuration

LocalCustomerRuntimeOptions.catalogCartItems configures Pickup item mutations with
actual current Catalog selection and quantity/option-specific Recipe/Inventory
observation. catalogDiningCart provides the equivalent shared Dining Cart
composition. Both require cartTransactions; each replaces its corresponding
legacy cartItems/diningCart configuration. Supplying both versions is rejected.

Supply explicit catalogTransactions, catalogScope, catalogSafety and
selectedInventory configuration, plus the owning write/Audit/reference ports.
selectedInventory includes the Tenant/Brand/Store/stock-site scope, dedicated
Repeatable Read/read-only transactions and expiry cutoff resolver. The runtime
supplies the authenticated Cart ownership/session checks. It retains Guest/CSRF
and current Dining participation checks around observations and mutations.
Generic availability and Kill Switch evidence are still mandatory; no default
Allow/Available is supplied. Scope must match the runtime Store. Observation is
not a reservation; checkout/submission still owns final stock validation.

A trusted --configuration module can pass these options to createLocalCustomerRuntime
and retain ownership of database cleanup. This option support does not establish
that a candidate configuration or running process supplies the required facts.

### Configured customer quotes

LocalCustomerRuntimeOptions.configuredCartQuote accepts pickup and dining HTTP
ports returned by createCustomerConfiguredQuoteHttpComposition. Supply each
port's actual scoped Catalog, Pricing, policy, Audit, transaction and current
session/participant dependencies. The runtime uses its shared current Guest
binding to authorize credentials/CSRF and select the matching channel; downstream
quote owners retain Cart authority, durable expiry and original-operation recovery.
Context-only Dining sessions are refused. cartTransactions is required, and legacy
cartQuote cannot be supplied at the same time. No tax, price or discount defaults
are supplied by channel routing. Candidate activation still requires an actual
configuration module that supplies these ports and their underlying facts.

### Dual-channel checkout details

LocalCustomerRuntimeOptions.channelCheckoutDetails accepts complete pickup and
dining ports from the existing checkout-details compositions. Each must supply
read, policy and save with the same quoteVersion. The runtime selects using its
shared current Guest/CSRF binding, including Dining admission when configured.
Cart transactions are required; simultaneous legacy checkoutDetails is rejected.
Downstream owners retain current Cart, quote, policy and participant authorization.
This supplies no contact, tax, receipt, policy-document or real Store defaults.

### Dual-channel order submission

LocalCustomerRuntimeOptions.channelOrderSubmission accepts pickup and dining
CustomerOrderSubmissionPort instances with the same quoteVersion. Current
Guest/CSRF scope and bound Dining state select the owning service; that service
still authorizes the Cart, current quote, capacity, Inventory and original
submission recovery. Cart transactions are required. Simultaneous legacy
orderSubmission is rejected. No capacity or payment defaults are supplied.

## Existing isolated pilot service recovery (WP-2402)

For the configured Linux/WSL2 `.local/pilot-v12` environment, use the pinned
Node executable from the repository root. Start the existing configuration in
dependency order with:

```bash
node tooling/environment/pilot-start.mjs
```

This starts or adopts API, business worker, kitchen worker, then HTTPS. It checks
API database readiness, recorded completion of all declared business loops (events, payment wait and
dining checkout expiry) and the kitchen
loop, and the HTTPS `/app` shell using `customer-tls-cert.pem` from the same
current runtime directory as the service controller. It does not depend on a
certificate in a preserved historical runtime directory. Startup reads are retried
at most20 times with500ms spacing; no retry restarts a process. An incomplete result
identifies the failed stage and completed services, leaving existing processes
intact for inspection. Successful output is startup evidence, not full business
readiness or proof that every pending transaction completed. It does not provision
Docker, credentials, migrations or a clean-machine installation.

Individual service operations remain available:

```bash
node tooling/environment/pilot-service.mjs status api
node tooling/environment/pilot-service.mjs status customer
node tooling/environment/pilot-service.mjs status business-worker
node tooling/environment/pilot-service.mjs status kitchen-queue-worker
node tooling/environment/pilot-service.mjs start api
node tooling/environment/pilot-service.mjs start customer
node tooling/environment/pilot-service.mjs start business-worker
node tooling/environment/pilot-service.mjs start kitchen-queue-worker
node tooling/environment/pilot-service.mjs restart api
node tooling/environment/pilot-service.mjs restart customer
node tooling/environment/pilot-service.mjs stop customer
node tooling/environment/pilot-service.mjs stop api
```

`start` recovers a missing or exited process using existing private configuration
and credential files. A matching live process is left running; an unrelated live
PID or occupied loopback port blocks startup. The Node version must match `.nvmrc`.
Cold starts set `NODE_ENV=development` and API `PORT=4300`, inheriting only PATH,
HOME and TMPDIR. They do not copy unrelated secrets or NODE_OPTIONS, generate
credentials, start Docker, rebuild assets, or provision another machine.

`stop` and `restart` verify the PID, directory, complete command and process start
identity immediately before SIGTERM. Restart preserves the live environment in
memory without printing or saving it. A process that does not stop within 30
seconds is left alone; no forced kill is used. Mutating operations share an
exclusive lock and publish a new PID atomically. Each command controls only its named service;
the database is never stopped. The same actions support `business-worker` and
`kitchen-queue-worker`, using their exact configured commands.

Workers have no listening port. Before starting an exited or missing-PID worker,
the tool scans for matching processes in this workspace and verifies their full
identity. One live match is adopted into PID metadata; multiple matches or an
invalid candidate block startup. A live registered worker is left running.
After recovery, inspect fresh `worker_started` events and workload progress;
process identity alone does not prove consumer or projection completeness.

Kitchen cycle diagnostics are available separately:

```bash
node tooling/environment/pilot-service.mjs health kitchen-queue-worker
node tooling/environment/pilot-service.mjs health business-worker
```

This reads a private atomic record bound to the current PID and Linux process
start identity. It reports lifecycle, in-flight state, completed polling cycles,
last start/completion instants and elapsed ages. A completed empty poll is not a
processed order. Increasing in-flight duration or unchanged completion time is
an investigation signal; no overall healthy/unhealthy threshold is inferred.
The first record may be unavailable during startup: recheck the same live process
before restarting. Invalid, old-process or missing records are unavailable, never
assumed healthy. Diagnostic writes happen on actual cycle/lifecycle changes and
introduce no extra polling timer. Business-worker output contains separate `events` and `paymentWait` observations.
Each has its own report age and cycle/completion times, so an active loop cannot
make another loop appear current. Both records must match the current process.
The event-cycle observation includes parked retries, consumer retries and outbox
dispatch; it does not prove that every individual business transaction succeeded.

Returned states describe process identity, not business readiness. After API
startup, check `http://127.0.0.1:4300/ready` for HTTP200 and `status: ready`; allow
startup time and retry the read before considering another restart. For customer
HTTPS, check the affected application route with its configured development CA.

On failure inspect the local service log, PID, configuration and pinned Node.
Do not remove a lock while another recovery operation owns it. This tool recovers
an existing isolated pilot; it is not production supervision or database recovery.

### Configured pilot Cart expiry

The v10 business entrypoint enables an Ordering-owned Cart expiry workload. It scans
up to 10 due Active carts per cycle within the configured Brand/Store, using current
server time, then invokes the existing audited lifecycle command. Concurrent version
changes or already-terminal carts are reconsidered on later scans; other failures
fail the composite worker. Stopping drains the current command. This transition
does not release tables, close Dining sessions, cancel Orders or expire Payment
batches. Replacement remains an explicit Host action with settlement checks.

The current `health business-worker` output covers events and payment-wait cycles;
it does not separately report Cart expiry cycle progress. Startup readiness is not
a complete business acceptance result. Temporary worker factories leave expiry
disabled unless explicitly configured by the real entrypoint.

### InternalTest Toronto boundary

`pilot-toronto-boundary.mjs` contains the current InternalTest Toronto local-time
boundary adapter. It preserves the UTC instant, milliseconds and actual offset
across daylight-saving transitions. It does not determine Business Date or accept
new operating hours. The private v12 compatibility module imports this repository
implementation; remaining private runtime composition and credentials are not
a clean-machine distribution.

`pilot-read-transactions.mjs` supplies the existing InternalTest Inventory read
transaction adapter. Callers provide the configured database pool and resolved
Brand/Store scope; the adapter opens a read-only repeatable-read transaction,
sets local scope and releases failed connections after attempted rollback. It
does not resolve user permissions or provision database access. The private v12
entry remains a compatibility re-export.

### InternalTest refund composition

`pilot-refund-send.mjs` and `pilot-refund-reconciliation.mjs` compose the existing
API refund commands. The local caller supplies its configured Provider account,
simulator factory and receipt-observation refresher. These modules preserve
current session/scope checks and lazy Provider cleanup; construction sends no
refund. They are InternalTest composition, not a live Provider integration or
permission grant. Build the API first and use the workspace TypeScript loader.
The private v12 wrappers retain local binding and simulator dependencies.

The same runtime extraction includes `pilot-refund-preparation.mjs` and
`pilot-receipt-observations.mjs`. Receipt refresh takes a local simulator factory
and account binding, finishes Order planning before Provider retrieval and
records actual observations. It never captures a payment, invents a success
event or extends receipt freshness. Private wrappers retain existing signatures.

### Extracted checkout and Dining adapters

The `pilot-checkout-details`, `pilot-checkout`, `pilot-dining-binding`,
`pilot-dining-join`, `pilot-dining-parent`, `pilot-dining-payment-route` and
`pilot-payment-preparation` modules retain the existing InternalTest composition.
They accept configured resources and use the existing API/Domain public entrypoints.
`pilot-payment-failure` retains only the local simulated Provider failure journal;
its records are not real Provider evidence. The private v12 files re-export these
implementations. This extraction neither changes policies nor provisions a Store,
credentials, database or legal acceptance.

Kitchen command/queue, merchant Dining service, order confirmation/submitted,
payment status and Dining checkout expiry now use the corresponding
`pilot-*.mjs` composition modules. Queue actor and payment account are injected
by local wrappers. Scope/profile authorization, polling and simulation gates
remain unchanged; these modules do not grant permissions or activate cancellation.

Dining checkout, additional submission, Cart binding and Kitchen consumers also
use shared `pilot-*.mjs` modules. Cart policy version/timeouts remain configured
by the private wrapper; Kitchen consumers use the existing injected queue factory.
This migration does not change Cart expiry, additional-payment clocks or consumer
registration/idempotency.

Kitchen ticket generation and Pickup fulfillment/readiness/proof-consumer/Order
completion-consumer adapters now live in shared `pilot-*.mjs` modules. Factories
for configured confirmation, proof credentials and completion stay injected from
private wrappers. This does not generate a new proof, replay an event or activate
a service; original consumer identities and scope checks remain unchanged.

Receipt issuance, Original/Additional receipt consumers, Order completion and
Order status composition are also shared `pilot-*.mjs` modules. Local wrappers
load the existing receipt-template and Pickup Workflow JSON and inject configured
account/actor bindings. No configuration file is distributed by these modules;
loading an exported module alone does not issue a receipt or complete an Order.

Dining Cart and channel Quote/Payment selection use shared runtime adapters with
private factory injection. Additional-payment composition takes the parsed local
Workflow, expected database binding and simulator control reference from its
wrapper; existing InternalTest/scope/simulator checks remain mandatory. No
Workflow publication or payment execution happens when these modules are imported.

`pilot-items.mjs` and `pilot-configured-quote.mjs` accept configured Inventory binding and
pricing-policy loading from local wrappers. Every new cart uses the configured Quote (v2), with or
without options (WP-2423 slice 4). Synthetic price/tax evidence remains
private InternalTest configuration and is not a legal or live Store assertion.
The modules retain the existing owner Inventory and current Quote services.

`pilot-worker-services.mjs`, `pilot-worker.mjs` and `pilot-cart-expiry.mjs` provide
the shared consumer registry, worker composition and Cart expiry adapter. Local
wrappers supply configured factories. Consumer identities, optional workload
flags, lease ownership and retry schedules retain existing behavior; importing
or constructing the registry does not start event processing.

`pilot-paid-outcome.mjs` composes initial/additional payment outcomes and durable
acceptance waiting. Local wrappers supply sequential Workflow loaders and
configured account/system actor. Inventory/capacity evaluation and consumer
permissions remain unchanged; construction does not process captured payments.

Pickup/Dining/customer entry and Dining session composition use shared modules
with private profile/table/QR/credential and merchant-session loaders. QR hints
select an existing verifier only; full signed QR and current session/store
authorization remain authoritative. No key, session or role is provisioned by
importing these modules.

Merchant acceptance/Pickup, Pickup proof and Dining Cart replacement composition
use shared modules. Local wrappers still select Workflow files, expected database,
account, workstation and credential factories. The shared implementations retain
current permissions, proof attempt budgets, original-operation retries and audit.
No acceptance, handoff or proof issuance occurs on module import.

`pilot-order.mjs` and `pilot-payment-intent.mjs` contain shared Order/payment
composition with lazy configured Workflow loading. Both reject unsupported
channels before loading configuration. Local expected-database/control bindings
remain private; Guest, Inventory, capacity and published Workflow checks are
unchanged. The loader split does not authorize a payment or accept a new policy.

`pilot-payment-terminal.mjs` provides shared simulated payment terminal recovery.
The local wrapper supplies the configured Provider account. Immutable journal
occurrence verification, Guest authorization before and after Provider lookup,
and explicit simulation/deadline checks remain in place. Importing this module
does not capture a payment or reconcile an Order.

`pilot-payment-provider.mjs` and `pilot-refund-provider.mjs` contain the local
simulated Provider implementation. The caller supplies the absolute SQLite
journal path, lazy InternalTest profile loader and expected database name.
Development/profile restrictions and journal owner/mode checks remain mandatory.
The simulator records demo payments and refunds only; its journal is not real
Provider settlement evidence. The current private wrapper retains existing
configuration and storage, including its optional provisioning behavior.

`pilot-merchant.mjs` and `pilot-merchant-session.mjs` compose the InternalTest
employee BFF and session service. Private wrappers supply employee/task queue
configuration, credential factories, expected database, account and role mapping.
Existing current-session/scope authorization and owner MFA checks are retained.
This extraction neither provisions permissions nor issues an employee session.

`pilot-resources.mjs`, `pilot-connections.mjs`, `pilot-customer-admission.mjs`
and `pilot-api.mjs` provide shared resource/database/admission/API composition.
Private wrappers supply configuration loaders, credential paths, connection
bindings and configured factories. File ownership/mode and environment checks,
Tenant transaction ownership and shutdown cleanup remain unchanged. These
modules do not by themselves provision a clean installation.

`pilot-customer-server.mjs` exposes the InternalTest HTTPS startup function.
The private executable injects profile/TLS locations and configured factories.
Existing loopback Host/origin and simulation-confirmation rules are preserved.
Partial startup failures close acquired simulator/database resources; three
focused tests cover environment denial and failures during simulator/entry setup.
Clean-install configuration and assembled runtime acceptance remain separate.

`pilot-credentials.mjs`, `pilot-dining-credentials.mjs` and `pilot-qr.mjs`
provide configured credential/QR loader factories. Private wrappers supply
absolute key paths, profile loaders and expected database names. Factory
construction does not read or provision keys; explicit provisioning methods
retain their environment and exclusive-create safeguards. Runtime loading
never replaces a missing or invalid key file. Cryptographic behavior is unchanged.

`pilot-worker-entry.mjs` supplies business and Kitchen worker startup. Private
executables pass their configuration factories and health directory. Existing
workload flags, health identities, polling and drain intervals are preserved.
Construction failures release resources; repeated stop/failure cleanup shares
one close promise. Importing the module does not start a worker.

The WP-2402 batch324 composed startup milestone loaded the shared modules in all
four existing v12 services. The existing pilot-start readiness check passed for
the API database, trusted HTTPS and completed business/Kitchen worker cycles.
This validates the current configured runtime after extraction; it does not
establish clean-machine provisioning or complete refund/cancellation acceptance.

`provisionPilotCredentials({ directory, expectedDatabaseName })` from
`pilot-provision-credentials.mjs` is an explicit InternalTest bootstrap step.
It requires development mode, an absolute owner-only `0700` directory and an
existing matching InternalTest profile. It creates missing application, Dining,
QR and Guest admission keys using exclusive creation and `0600` permissions;
valid existing files are retained. It does not rotate keys, provision TLS or
database credentials, seed business records or grant permissions. On partial
failure, created keys remain for a subsequent retry; no key is silently replaced.
This helper alone is not a complete fresh-machine installer.

`provisionPilotTls({ directory, expectedDatabaseName })` from
`pilot-provision-tls.mjs` explicitly prepares local InternalTest HTTPS files.
It requires local OpenSSL, development mode, a private absolute `0700` directory
and a matching InternalTest profile. New self-signed server certificates last
30 days and identify only `127.0.0.1`; both certificate and private key use `0600`.
Existing valid pairs are retained. Invalid, expired or incomplete pairs are
refused rather than replaced. Generation is staged under an exclusive directory
lock; target publication uses non-overwriting hard links. An interrupted partial
publication requires explicit operator recovery; this function never deletes
an existing target or rotates it. It does not install system/browser trust,
configure real Store TLS or alter the current runtime.

### Explicit local security initialization

After an authorized initializer supplies a matching InternalTest profile in an
owner-only directory, run from the repository root with pinned Node and OpenSSL:

```bash
NODE_ENV=development node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/pilot-provision-local-security.mjs /absolute/private/runtime-directory expected_database_name
```

The command creates missing application/Dining/QR/Guest admission keys and local
loopback TLS files. It reports only Created/Retained status, never key material.
Existing valid files remain unchanged; errors are redacted. Partial success is
retained for retry, while invalid or incomplete TLS pairs need explicit recovery.
This does not create the profile, database, roles, business configuration or
browser trust; it is not the complete pilot installer. Do not point it at an
existing runtime to rotate keys. WP-2402 batch327 exercised the actual command in
an isolated directory, including retry and mismatched database refusal.

### Internal Dining customer entry

`pilot-customer-server.mjs` accepts optional `diningEntries` containing a unique
non-sensitive `selector`, a public `label`, and a lazy `loadQr` factory. The
existing QR owner must validate the configured InternalTest/database/Store binding.
`pilot-dining-launcher.mjs` serves `/internal-test/dining` only in the development
InternalTest server. Links carry table selectors only; the same-origin, no-store
exchange returns the QR credential in its response body. The customer simulation
build passes that credential directly in memory to the existing entry client,
which clears the URL and posts to the regular entry handler. Nothing is saved in
browser storage. Joining still requires the current staff-issued session code and
normal Dining binding; the launcher never starts a session or grants membership.

WP-2402 batch344 proves actual DEMO-02 selection reaches the Join this table
screen with the URL cleared to `/`. This is entry evidence, not full Dining
browser acceptance. Do not capture complete pages while join or pickup proof is
visible; use bounded non-sensitive states. The active v12 wrapper supplies its
three existing private table configurations; no production QR provisioning is
implied.

### Selecting a configured local installation

Run from the repository root with pinned Node in WSL/Linux:

```bash
node tooling/environment/pilot-start.mjs .local/pilot-installation
node tooling/environment/pilot-service.mjs status api .local/pilot-installation
node tooling/environment/pilot-service.mjs health business-worker .local/pilot-installation
```

The optional final argument selects one directory directly under `.local/`;
names use lowercase letters, digits, underscores and hyphens (1–64 characters).
Omitting it retains `.local/pilot-v12`. Absolute paths, traversal and symlinked
runtime directories are refused. Supply the same argument for start, status,
health, stop and restart. PID/log/lock/health files, exact process identities and
HTTPS certificate checks all use the selected directory. API and HTTPS ports
remain 4300/4443: this selects an installation, not simultaneous instances.

The directory must already contain its authorized private configuration and
service entry modules (`api.mjs`, `customer-server.mjs`, `business-worker.mjs`,
`kitchen-queue-worker.mjs`) plus TLS files. This command does not create database
roles, publish business configuration, grant authority or generate missing wrappers.
A successful start includes readiness observations; a controller PID alone is
not proof of application readiness. Never copy an existing installation's secrets
to create a new one.

### Existing installation resource configuration

`createConfiguredPilotResources(absoluteDirectory)` now composes the database,
application credentials, Guest admission and existing profile/menu loaders without
machine-specific resource factories. Its `installation.json` has exactly:

```json
{
  "schemaVersion": 1,
  "environment": "InternalTest",
  "database": "synthetic_pilot",
  "port": 55435,
  "roles": { "api": "synthetic_api", "worker": "synthetic_worker" }
}
```

These example database and role names do not provision anything. Supply names of
already authorized local resources. Connections are loopback-only. Keep the
canonical installation directory owner-only `0700` and the configuration,
`internal-test-profile.json` and `internal-test-menu.json` owner-only `0600`.
The loader rejects symlinks, oversized files, unexpected fields, production mode
and profile/menu database mismatches. Existing owner parsers still validate the
business payloads; the envelope is not proof of publication or permission.

Passwords remain in `api-password`/`worker-password`; application keys and Guest
admission pepper remain in their existing private files. The factory only loads
these files; it never creates or rotates them, grants privileges or seeds business
facts. The caller must close returned resources. WP-2402 batch349 loaded the
current v12 resources and successfully probed its database through this entry;
other service factories and full fresh-install provisioning remain incomplete.

`createConfiguredPilotDatabase(directory, service)` applies the same installation
configuration to standalone API/worker consumers. It loads existing role-specific
password files through the original connection owner and never grants authority.
WP-2402 batch350 verified actual database/current-role matches for both services,
then loaded the configuration in all four v12 processes. API database readiness,
trusted HTTPS and completed business/Kitchen worker cycles passed after one
controlled restart per service. This is current-runtime adoption, not evidence
of creating a fresh database or completing financial acceptance.

### Optional isolated reconciliation projection process

The service controller launches `reconciliation-worker` using the repository-owned
`tooling/environment/pilot-reconciliation-worker.mjs` entry and the selected
`.local/<installation>` argument. It needs the same authorized private installation
configuration loaded by `createConfiguredPilotResources`; no private worker wrapper
or copied credentials are required. Default startup does not launch this process.
After its exact local read permissions are authorized, selecting
`--require-reconciliation-projection` on `pilot-start.mjs` includes this isolated
process and checks a recent completed cycle from its actual PID. Use the same
installation argument with the service controller for health/status/stop.

A completed cycle is scheduler evidence only. Unlinked reconciliation records remain visible with unavailable Order references;
only linked cases enable order-specific actions. Other owner sources plus complete business journeys
must be accepted before declaring workbench coverage or the pilot complete.

### Kitchen worker repository entry

The service controller now starts `pilot-kitchen-queue-worker.mjs` with the explicit
installation directory. It reuses the existing Kitchen worker lifecycle and queue
factory. The private executable wrappers are no longer required for this service.

Provide `kitchen-queue-worker.json` in the protected installation directory
(directory mode0700, file mode0600). The exact fields are `schemaVersion: 1`,
`environment: "InternalTest"`, the installation `database`, the existing Kitchen
`actorReference`, and `scope` with `tenantReference`, `brandReference`, and
`storeReference` matching the existing profile binding. References must be UUIDv7
strings. Copy the installation's existing authorized values; do not invent an
actor or grant privileges as part of startup. Missing or invalid configuration
blocks Kitchen startup but does not prevent other lazy configuration loads.
The entry rechecks scope after resource loading and closes resources on mismatch.

For an existing installation use the service controller's `start`, `stop` and
`health` commands with `kitchen-queue-worker` and the installation directory.
When migrating from the old private wrapper, stop the old process with the old
controller identity before switching the entry. Health requires the current PID
and completed refresh cycles; successful startup alone is insufficient.
This removes one executable-wrapper dependency, not the need for the remaining
private configuration or full fresh-machine provisioning.

### Business worker repository entry

The controller starts `pilot-business-worker.mjs` with an explicit installation
directory. `pilot-business-composition.mjs` wires all currently enabled event
consumers, payment waiting, Cart expiry and Dining checkout expiry from repository
factories. It no longer imports executable files from the private runtime directory.

Provide protected `business-worker.json` with exactly `schemaVersion: 1`,
`environment: "InternalTest"`, the installation `database`, the existing Test
`providerAccountReference`, `actors` containing `paidOutcome`, `orderCompletion`
and `kitchenQueue`, and `scope` containing `tenantReference`, `brandReference` and
`storeReference`. All identity values are UUIDv7 strings; scope must match the
existing profile. Preserve the previously configured system actors. The entry
rechecks scope against opened resources and closes resources on mismatch.

The existing Pickup, DineIn and AdditionalRelease workflow JSON files are loaded
through the protected installation reader and checked against database/profile
scope. The existing receipt-template file is also read through that boundary;
its publication remains resolved by the owning receipt runtime. The simulator
uses the existing local SQLite file without provisioning or replacing it. Files
must have mode0600 in the mode0700 installation directory.

Cancellation and compensation default to disabled. An optional `workloads` object
in `business-worker.json` must contain exactly boolean `batchCancellation` and
`compensation`; missing configuration means both false. CLI flags cannot enable
them. The composition rejects an option not explicitly enabled by that configuration.
Enabling a workload is a separate operational activation after its existing exact
approval and prerequisites; this schema is not permission to change current flags.
The present v12 configuration remains unchanged with both false. Cancellation
loads protected `cancellation-workflow-draft-result.json` and still requires the
current matching published workflow; the draft file alone cannot authorize it.
Compensation reuses the existing Test simulator and current owner/amount checks.
Their separate pending approvals and activation work are still required. For an
existing installation, stop the old business process with its old controller
identity before switching entries; start the new entry via the controller and
require fresh event, payment-wait and Dining-expiry health cycles. This is not
fresh installation, real Provider activation or release acceptance.

### InternalTest pricing fixture

`pilot-pricing-policy.mjs` contains the existing synthetic CAD/Toronto fixture
previously implemented in the private pricing script. It accepts profile/menu
loaders and an explicit expected database; the compatibility wrapper now uses
`loadPilotInstallation` for protected reads. Production or non-InternalTest input
is refused. Money remains integer minor units, and current local output/digests
were compared against the previous implementation before the wrapper switched.

This module preserves the existing simulation's price and tax fixtures. Its
synthetic registration/professional evidence is not actual legal or Store evidence
and must not satisfy external activation gates. Runtime quotes continue to use
the existing owning Pricing service and persisted publications. This extraction
does not complete API/HTTPS composition or provision a new installation.

### Customer API repository entry

The API controller now runs `pilot-api-entry.mjs` with the installation directory,
`NODE_ENV=development` and `PORT=4300`. `pilot-customer-composition.mjs` retains the
existing Dining/Pickup customer factories without importing private executable
configuration. The existing API lifecycle still owns listening and shutdown.

Provide protected `customer-runtime.json` with exactly `schemaVersion: 1`,
`environment: "InternalTest"`, installation `database`, `providerAccountReference`,
`controlReference`, `scope`, `cart`, and `diningTableFiles`. Scope has the existing
Tenant/Brand/Store references matching the profile. Cart has the existing
`policyVersionReference`, positive integer `idleTimeoutSeconds`, and integer
`absoluteTimeoutSeconds` at least as large. References are UUIDv7 strings.
The table list contains 1–100 distinct filenames matching
`internal-test-dining-table.json` or `internal-test-dining-table-NN.json`; paths
outside the private installation cannot be supplied.

Existing inventory, employee and table JSON files are loaded through the protected
reader and checked against the installation database and profile scope. Existing
keys, workflows, menu and simulator remain in place. Startup never provisions a
provider, grants privileges or publishes configurations. Profile scope is checked
again after resources open, and mismatches close resources. These files require
mode0600 in the mode0700 installation directory.

For migration, stop the old API via its existing controller identity before
switching entries. Start through the controller, then require database readiness
and customer route evidence. A runtime constructed without listening can report
`ERR_SERVER_NOT_RUNNING` when the existing HTTP shutdown routine closes it;
construction alone is not a successful lifecycle check. This entry does not
migrate the separate HTTPS/merchant composition or constitute full pilot acceptance.

### HTTPS and merchant repository entry

The customer service controller now runs `pilot-https-entry.mjs` with the explicit
installation directory. It shares the customer configuration described above and
uses `pilot-merchant-composition.mjs` for the existing merchant flows. Runtime
startup no longer imports private executable wrappers. Existing TLS keys, QR keys,
credentials and simulator data remain private and are never regenerated on start.

Provide protected `merchant-runtime.json` with exactly `schemaVersion: 1`,
`environment: "InternalTest"`, installation `database`, matching `scope`,
`roleMapping`, and `workstation`. Scope contains Tenant/Brand/Store references;
workstation contains the existing `deviceReference` and `pickupLocationReference`.
All these references must be UUIDv7 strings. Role mapping has exactly `Manager`,
`Owner` and `Finance`, each an array of the existing role codes. Preserve the
previous mapping: adding a role is an authority change, not startup configuration
migration. No grants are performed by these readers or compositions.

To configure Product reads, publication and operation recovery, use
`schemaVersion: 2` with the same fields and an additional closed `product` object:
`contentPolicy` contains `configurationVersionReference`, `expectedBrandVersion`,
`policyReference` and `policyVersion`; `maximumApprovalValiditySeconds` is an
integer from 1 to 86400. The references must identify the actual current Brand and
Published policy records. Startup does not create them. Version 1 remains valid
without Product configuration. Version 2 also accepts an optional closed
`product.authoringSources` object for ordinary Create and Save Draft composition.
It contains exactly `configurationVersionReference`, `expectedBrandVersion`,
`policyReference`, `policyVersion` and `allergenRegistryVersionReference`. The
configuration and policy references are UUIDv7; both versions are integers from
1 to 2147483647. The allergen registry version reference is explicitly a UUIDv7
or `null`. These selectors name actual owner records and are independent of the
publication `contentPolicy` selectors. Omission retains the existing publication
configuration without enabling authoring; a malformed or partial object refuses
startup. No defaults, unit definitions, dictionary entries, credentials, grants
or feature activation are generated by selecting authoring sources. Every actual
source and current permission remains independently required by its workflow.

Optional `product.optionSetPublicationSources` configures ordinary Option publication
commands and original-operation Resolve together. Its closed six fields are
`brandConfigurationVersionReference`, `expectedBrandVersion`, `policyReference`,
`policyVersion`, `optionSetPolicyFamilyReference` and `mediaScope`. References must
be UUIDv7; versions are integers from 1 through 2147483647. Media scope is exactly
`{kind: "Brand", brandReference, storeReference: null}` or
`{kind: "Store", brandReference, storeReference}` with the configured actual Brand
and selected Store. These selectors name independently configured owning Option
policy and Brand records; Product policy selectors do not supply Option defaults.
When present, startup requires the actual credentials reference generator and
rejects a missing generator. When omitted, the existing Option read Context/List
and Product handlers remain available, without registering Option publication
writes or inventing readiness. This configuration does not enable FeatureControl
or grant the required current User permissions.

Optional `product.optionPriceSources` registers ordinary OptionPrice authoring and
review handlers together. It contains exactly `currencyMetadata` and
`publicationPolicyFamilyReference`. Currency metadata is the actual public snapshot:
`currencyCode` (three uppercase letters), `minorUnitExponent` (integer 0–6),
`metadataVersion` (positive safe integer), `metadataVersionReference` (UUIDv7), and
`metadataDigest` (`sha256:` plus 64 lowercase hexadecimal digits). The policy family
is a UUIDv7 identifying the independently configured owning OptionPrice policy;
Product and OptionSet policy selectors do not supply defaults. Startup requires the
existing credentials reference generator, validates and freezes the configuration,
and allocates no operation, evidence, Audit or version IDs before a request. Omission
leaves these handlers unconfigured. Every request still requires current User
permissions and Pricing FeatureControl admission, genuine policy/review evidence,
and configured currency metadata matching the actual Brand and selected Store
currency. This configuration creates no policy, credentials, grants or activation.

Catalog cursors derive a separate key from the existing protected Merchant encryption key and database identity; missing keys
fail startup instead of generating replacements.

The existing protected `internal-test-merchant.json` single-Actor form remains
supported. Its version 2 form has exactly `schemaVersion: 2`,
`environment: "InternalTest"`, installation `database`, matching `scope`, and
`actors`. Supply 1–16 entries containing only `selector`, `actorReference` and
`validUntil`; selectors and Actor references must each be unique. Selectors start
with a lowercase letter and contain up to 40 lowercase letters, digits or hyphens;
Actor references are UUIDv7 and expiry is a UTC instant with milliseconds.
The local staff page requires an explicit selector when multiple Actors exist.
The roster is reread for login and current-session checks, so removed or expired
entries lose access. This test identity roster does not grant business permissions.

The Products candidate uses `/app/commerce/products`. Actual current Store access,
Brand Catalog field permissions and the Published `catalog.product.list` capability
determine whether it appears; configuring handlers alone does not show it. Editor,
publication, explicit warning confirmation and operation recovery independently
require current Edit authority. Missing prices, base recipes, Inventory or Menu
configuration are reported as specific warnings requiring explicit confirmation;
hard errors remain blocking. The accepted ordinary effective-time policy allows
an inclusive seven-day backdate from the original server qualification observation.
The lifecycle HTTP handler uses current canonical screen authority; Draft SKU
activation requires `catalog.sku.activate` and the actual Published
`catalog.sku.detail` capability. It preserves complete recorded content and
returns the original receipt on retry; activation alone does not authorize sale.
Archive/Restore mappings and required lifecycle review sources remain unavailable.
Create, complete draft saving and the frontend activation/recovery flow remain
unfinished work; this configuration is not a complete Product journey acceptance.

The existing task queue configuration is read through the protected loader and
checked against the database and all three profile scope references. Merchant and
customer scopes must agree before construction; the opened resources are checked
again and closed on mismatch. Files require mode0600 in the mode0700 directory.

Stop the old HTTPS process with its old controller identity before switching
entries. After starting, use the existing certificate as CA to check employee
entry, merchant shell and customer API proxy. HTTP200 shell/menu reads prove
transport availability, not authenticated operation or complete business journeys.
The existing permissions, MFA, refund roles and exception source coverage still
control operational availability. These entry migrations do not provision a fresh
Store/database or satisfy real Provider/legal/release gates.

### Coordinated local maintenance stop

Run from the repository root with the pinned Node runtime:

```bash
node tooling/environment/pilot-stop.mjs .local/pilot-v12
```

The coordinator stops HTTPS customer/merchant ingress, API, business processing,
Kitchen projection, reconciliation projection and Dining exception projection in
that order. It includes optional workers so an earlier enabled process cannot be
missed. Existing PID identity is checked before SIGTERM; no forced kill is used.
A missing or terminal PID is accepted only after confirming the loopback port is
free (API/HTTPS) or no matching worker remains. Unreadable state, unrelated live
PID, occupied port or untracked matching worker prevents a successful stop claim.

On failure, the command returns `incomplete`, the failed service and the confirmed
stopped prefix. It does not restart earlier services, continue stopping later
ones, or declare a backup window. Resolve the specific obstruction and repeat;
already stopped services are safe to revisit. Keep other operators and launchers
from starting services during maintenance: this command is not a persistent write
fence or a supervisor lock.

Resume only the previously authorized service set through `pilot-start.mjs` and
its required optional readiness gates. For the current v12 installation:

```bash
node tooling/environment/pilot-start.mjs .local/pilot-v12 --require-dining-exception-projection
```

A successful stop/start drill proves process recovery with existing data and
configuration. It does not prove a consistent backup across PostgreSQL, simulator
and keys, an isolated restore, RPO/RTO, real Provider reconciliation or full pilot
business acceptance. Do not take the older v11 rollback database as current backup.

### Repository local recovery drill

`pilot-recovery.mjs` promotes the batch412 procedure for an **existing** protected
InternalTest installation. It requires all five standard services, including the
Dining exception worker, to be running and identity-matched before maintenance.
It preserves an already running reconciliation worker and configured cancellation/
compensation readiness gates when restoring the source service set.

From the repository root, with the pinned Node runtime, explicitly provide four
arguments: runtime directory, a new isolated `bop_rms_*_restore_*` database name,
Docker container name, and a new `recovery-*` output label. For example, after
selecting and authorizing a maintenance window and previously unused targets:

```bash
NODE_ENV=development node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/pilot-recovery.mjs .local/pilot-v12 bop_rms_wp2402_restore_v12_next bop-rms-wp2402-pilot-v4-postgres-1 recovery-next
```

This command stops services, creates a new database and retains private backups;
it is not a read-only preflight. The example has not been executed. Existing target
DBs/output directories are refused. The protected installation and migration
configuration must agree on the local source database/port; Docker must expose
5432 only at that exact loopback endpoint. No role/credential provisioning or
source data mutation is performed. Keep other launchers/operators fenced during
the maintenance window, as described above.

The procedure exports a PostgreSQL snapshot, creates its full dump and a native
SQLite simulator backup, restores only the new target, compares content and
attempts source-service resumption even if recovery fails. Files use private
permissions; target/backup/error logs are retained for diagnosis, never deleted
automatically. Resource-close failures are reported without skipping resumption.
An unsuccessful resume requires operator attention; no forced process kill or
success claim is made. It does not switch applications to the restored target.

The original batch412 drill is historical evidence. Batch421 executes this
repository entry against the v12 source, with new isolated target
`bop_rms_wp2402_restore_v12_421` and private output `recovery-421`. All382 PostgreSQL
tables/7249 rows and all4 SQLite tables/48 rows match; source preservation and
original-service resumption pass. This is existing-installation local recovery
acceptance. It does not prove fresh-machine keys/roles, real Provider recovery,
application cutover or production RPO/RTO.
