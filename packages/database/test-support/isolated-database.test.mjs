import assert from "node:assert/strict";
import net from "node:net";
import { rm } from "node:fs/promises";
import process from "node:process";
import {
  allocatePort,
  composeDiagnostic,
  composeStartAttempts,
  isComposePortConflict,
  isPortBindable,
  leasePortRange,
  shouldRetryComposeStart,
  withIsolatedDatabase,
} from "./isolated-database.mjs";

await assert.rejects(withIsolatedDatabase(), {
  code: "ISOLATED_DB_USAGE",
  name: "IsolatedDatabaseError",
});
await assert.rejects(
  withIsolatedDatabase({ caseId: "UPPER" }, () => undefined),
  {
    code: "ISOLATED_DB_USAGE",
  },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", failureAt: "unknown" }, () => undefined),
  { code: "ISOLATED_DB_USAGE" },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", environment: "production" }, () => undefined),
  { code: "ISOLATED_DB_UNSAFE_ENVIRONMENT" },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", host: "db.example.test" }, () => undefined),
  { code: "ISOLATED_DB_UNSAFE_ENVIRONMENT" },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", ssl: true }, () => undefined),
  {
    code: "ISOLATED_DB_UNSAFE_ENVIRONMENT",
  },
);

// Leased host ports stay outside the Linux (32768-60999) and macOS/Windows
// (49152-65535) ephemeral ranges, including the unbound API/web values.
assert(leasePortRange.first >= 1_024);
assert(leasePortRange.first + leasePortRange.count - 1 + 5_002 < 32_768);

// Docker's port-conflict answers are retried with a new lease; anything else is not.
const dockerDesktopConflict =
  "Error response from daemon: ports are not available: exposing port TCP 127.0.0.1:21999 -> 127.0.0.1:0: listen tcp4 127.0.0.1:21999: bind: address already in use";
const engineConflict =
  "Error response from daemon: driver failed programming external connectivity on endpoint x: Bind for 127.0.0.1:20001 failed: port is already allocated";
assert(isComposePortConflict(dockerDesktopConflict));
assert(isComposePortConflict(engineConflict));
assert(!isComposePortConflict("Error response from daemon: pull access denied"));
assert(!isComposePortConflict(undefined));
assert(shouldRetryComposeStart({ attempt: 1, stderr: engineConflict }));
assert(shouldRetryComposeStart({ attempt: composeStartAttempts - 1, stderr: engineConflict }));
assert(!shouldRetryComposeStart({ attempt: composeStartAttempts, stderr: engineConflict }));
assert(!shouldRetryComposeStart({ attempt: 1, stderr: "no such image" }));
assert(!shouldRetryComposeStart({ attempt: 1, stderr: "" }));

// The kept diagnostic is bounded and never carries the synthetic password or env values.
const password = "synthetic-abcdefghijklmnopqrstuvwx";
const diagnostic = composeDiagnostic(
  `${"noise ".repeat(1_000)}\n\u001b[31mfailed\u001b[0m with ${password} and POSTGRES_PASSWORD=hunter2 token: abc\n${dockerDesktopConflict}`,
  [password],
);
assert(diagnostic.length <= 2_003);
assert(diagnostic.endsWith("address already in use"));
assert(!diagnostic.includes(password));
assert(!diagnostic.includes("synthetic-"));
assert(!diagnostic.includes("hunter2"));
assert(!diagnostic.includes("abc\n"));
assert(!diagnostic.includes("\u001b"));
assert.equal(composeDiagnostic(undefined), "");

// A port something else already listens on is reported unbindable and never leased.
const holder = net.createServer();
await new Promise((resolve) => holder.listen({ host: "127.0.0.1", port: 0 }, resolve));
const heldPort = holder.address().port;
assert.equal(await isPortBindable(heldPort), false);
holder.close();
await new Promise((resolve) => holder.once("close", resolve));
assert.equal(await isPortBindable(heldPort), true);

// runId 000000... starts the scan at the first port; a busy first port is skipped.
const probed = [];
const claimed = await allocatePort("000000aaaaaa", {
  isPortBindable: async (port) => {
    probed.push(port);
    return probed.length > 1;
  },
});
try {
  assert(probed.length >= 2);
  assert.notEqual(claimed.port, probed[0]);
  assert.equal(claimed.port, probed.at(-1));
  assert(claimed.port >= leasePortRange.first);
  assert(claimed.port < leasePortRange.first + leasePortRange.count);
} finally {
  await rm(claimed.lease, { force: true, recursive: true });
}

process.stdout.write("WP-0024 isolated database unit contract passed\n");
