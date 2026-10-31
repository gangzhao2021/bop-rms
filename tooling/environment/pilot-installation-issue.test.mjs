import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, pbkdf2Sync, createHmac, createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { afterEach, it, vi } from "vitest";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import {
  APPROVAL_PROFILE,
  CART_TIMEOUTS,
  INSTALLATION_FILES,
  MAX_WINDOW_DAYS,
  PILOT_INSTALLATION_PURPOSE,
  buildInstallPlan,
  buildRenewalPlan,
  checkPilotInstallation,
  parseCommand,
  planDigest,
  scramVerifier,
  signInstallationPlan,
  verifyInstallationApproval,
} from "./pilot-installation-issue.mjs";
import { orderWorkflowReleases, platformWorkflows } from "./platform-workflows.mjs";
import { planWorkflowRelease, workflowRuntimeFile } from "./workflow-release-install.mjs";

afterEach(() => vi.unstubAllEnvs());
const id = (n) => "0190c4d0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-20T12:00:00.000Z";
const until = "2026-12-01T12:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const facts = {
  timeZone: "America/Toronto",
  catalogVersion: 17,
  configuration: {
    configurationReference: id(10),
    contentDigest: "sha256:" + "c".repeat(64),
    receiptReference: id(11),
  },
  liveGateRequirementCodes: ["OWNER_LAUNCH_APPROVED", "STORE_READY"],
  menuReference: id(12),
  stockSiteReference: id(13),
  firstWindow: {
    businessDate: "2026-10-19",
    startsAt: "2026-10-19T04:00:00.000Z",
    endsAt: "2026-10-20T04:00:00.000Z",
    configurationReference: id(10),
    configurationVersion: 1,
    contentDigest: "sha256:" + "c".repeat(64),
  },
};
const ownerApproval = {
  approvedBy: "Owner",
  approval: "Approved: install the store until 1 December",
  reason: "Open the pilot store for real orders",
};
const planInput = (directory, overrides = {}) => ({
  at,
  validUntil: until,
  database: "bop_rms_pilot_store",
  databasePort: 55440,
  roles: { api: "store_api", worker: "store_worker" },
  scope,
  directory,
  environmentReference: id(20),
  operatorReference: id(21),
  operationReference: "019a0000-0000-7000-8000-000000000001",
  ownerApproval,
  facts,
  aclDigest: "sha256:" + "a".repeat(64),
  ...overrides,
});
const fileOf = (plan, name) => plan.files.find((file) => file.name === name).content;

async function privateDirectory() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "bop-pilot-install-")));
  await chmod(directory, 0o700);
  return directory;
}
async function writePrivate(directory, name, value) {
  const file = path.join(directory, name);
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

it("parses every command's flags once and refuses unknown, duplicate or malformed values", () => {
  const prepare = [
    "prepare",
    ...[
      ["--env-file", "a.env"],
      ["--directory", "/srv/pilot"],
      ["--environment", id(20)],
      ["--operator", id(21)],
      ["--tenant", id(1)],
      ["--brand", id(2)],
      ["--store", id(3)],
      ["--valid-until", until],
      ["--api-role", "store_api"],
      ["--worker-role", "store_worker"],
      ["--database-port", "55440"],
      ["--owner-approved-by", "Owner"],
      ["--owner-approval", ownerApproval.approval],
      ["--reason", ownerApproval.reason],
      ["--out", "plan.json"],
    ].flat(),
  ];
  assert.equal(parseCommand(prepare).get("--store"), id(3));
  assert.throws(() => parseCommand(prepare.slice(0, -2)), /usage/u);
  assert.throws(() => parseCommand([...prepare, "--force", "x"]), /usage/u);
  assert.throws(() => parseCommand([...prepare, "--store", id(3)]), /usage/u);
  const change = (flag, value) =>
    prepare.map((item, i) => (prepare[i - 1] === flag ? value : item));
  assert.throws(() => parseCommand(change("--directory", "relative/dir")), /usage/u);
  assert.throws(() => parseCommand(change("--worker-role", "store_api")), /usage/u);
  assert.throws(() => parseCommand(change("--api-role", "Bad-Role")), /usage/u);
  assert.throws(() => parseCommand(change("--valid-until", "2026-12-01")), /usage/u);
  assert.throws(() => parseCommand(change("--owner-approval", "ok")), /usage/u);
  assert.throws(() => parseCommand(change("--database-port", "70000")), /usage/u);
  assert.equal(parseCommand([...prepare, "--menu", id(12)]).get("--menu"), id(12));
  assert.throws(() => parseCommand(["install"]), /usage/u);
  assert.equal(
    parseCommand([
      "apply",
      "--env-file",
      "a",
      "--plan",
      "p",
      "--approval",
      "a",
      "--trust",
      "t",
    ]).get("--confirm-target"),
    undefined,
  );
});

it("plans every Pilot file from the read facts, with installation identities derived from the operation", () => {
  const plan = buildInstallPlan(planInput("/srv/pilot"));
  assert.deepEqual(
    plan.files.map((file) => file.name),
    INSTALLATION_FILES,
  );
  assert.equal(plan.files.at(-1).name, "internal-test-profile.json");
  for (const file of plan.files) {
    const content = file.content;
    if (file.name !== "internal-test-receipt-template.json")
      assert.equal(content.database, "bop_rms_pilot_store");
    assert.equal(content.environment, "Pilot");
    // Nothing synthetic, DEMO or InternalTest is ever issued for a Pilot Store.
    assert.doesNotMatch(JSON.stringify(content), /synthetic|DEMO|InternalTest/iu);
  }
  const profile = fileOf(plan, "internal-test-profile.json");
  // The window starts with the first settlement day so the day-end worker may read it.
  assert.deepEqual(profile.binding, {
    ...profile.binding,
    ...scope,
    validFrom: facts.firstWindow.startsAt,
    validUntil: until,
  });
  assert.equal(profile.createdAt, at);
  assert.deepEqual(profile.operating, { liveGateRequirementCodes: facts.liveGateRequirementCodes });
  assert.equal(fileOf(plan, "customer-runtime.json").diningTableFiles.length, 0);
  assert.deepEqual(
    {
      idleTimeoutSeconds: fileOf(plan, "customer-runtime.json").cart.idleTimeoutSeconds,
      absoluteTimeoutSeconds: fileOf(plan, "customer-runtime.json").cart.absoluteTimeoutSeconds,
    },
    CART_TIMEOUTS,
  );
  assert.equal(fileOf(plan, "internal-test-menu.json").menuReference, facts.menuReference);
  assert.equal(
    fileOf(plan, "internal-test-inventory.json").scope.stockSiteReference,
    facts.stockSiteReference,
  );
  assert.deepEqual(fileOf(plan, "daily-settlement-coverage.json").firstWindow, facts.firstWindow);
  assert.equal(
    fileOf(plan, "internal-test-receipt-template.json").templateReference,
    facts.configuration.receiptReference,
  );
  const queue = fileOf(plan, "internal-test-task-queue.json");
  assert.equal(queue.effectiveUntil, until);
  assert.equal(queue.exceptionTaskPolicy.managerQueueReference, queue.queueReference);
  assert.deepEqual(fileOf(plan, "installation.json").roles, {
    api: "store_api",
    worker: "store_worker",
  });
  // The same plan input replays exactly; another operation gets other identities.
  assert.equal(planDigest(buildInstallPlan(planInput("/srv/pilot"))), planDigest(plan));
  const other = buildInstallPlan(
    planInput("/srv/pilot", { operationReference: "019a0000-0000-7000-8000-000000000002" }),
  );
  assert.notEqual(
    fileOf(other, "customer-runtime.json").providerAccountReference,
    fileOf(plan, "customer-runtime.json").providerAccountReference,
  );
  assert.throws(
    () => buildInstallPlan(planInput("/srv/pilot", { validUntil: "2027-10-20T12:00:00.000Z" })),
    { reason: "valid-until-beyond-limit" },
  );
  assert.throws(() => buildInstallPlan(planInput("/srv/pilot", { validUntil: at })), {
    reason: "valid-until-not-in-future",
  });
  assert.equal(MAX_WINDOW_DAYS, 92);
});

it("the issued files load through loadPilotInstallation in a Pilot process and complete the start check", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  const directory = await privateDirectory();
  try {
    assert.deepEqual(await checkPilotInstallation(directory), ["Installation: not-issued"]);
    const plan = buildInstallPlan(planInput(directory));
    for (const file of plan.files) await writePrivate(directory, file.name, file.content);
    const missing = await checkPilotInstallation(directory, { now: () => Date.parse(at) + 1000 });
    assert.deepEqual(missing, [
      "Installation: missing internal-test-workflow-Pickup.json",
      "Installation: missing internal-test-workflow-DineIn.json",
      "Installation: missing internal-test-workflow-AdditionalRelease.json",
      "Installation: missing cancellation-workflow-draft-result.json",
      "Installation: missing api-password",
      "Installation: missing worker-password",
    ]);
    const options = {
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      operatorReference: id(30),
      approvedByReference: id(31),
      approvalEvidenceReference: id(32),
      operationReference: "019a0000-0000-7000-8000-000000000003",
    };
    for (const release of [...orderWorkflowReleases, "UnpaidDineInBatchCancellation"]) {
      const file = workflowRuntimeFile(planWorkflowRelease({ ...options, release }), {
        environment: "Pilot",
        database: "bop_rms_pilot_store",
        scope,
        operationReference: options.operationReference,
        release,
      });
      const name =
        platformWorkflows[release].binding === undefined
          ? "cancellation-workflow-draft-result.json"
          : `internal-test-workflow-${platformWorkflows[release].binding}.json`;
      await writePrivate(directory, name, file);
    }
    await writePrivate(directory, "api-password", "a".repeat(64));
    await writePrivate(directory, "worker-password", "b".repeat(64));
    assert.deepEqual(
      await checkPilotInstallation(directory, { now: () => Date.parse(at) + 1000 }),
      [],
    );
    // Outside the validity window the installation is not in force.
    assert.deepEqual(await checkPilotInstallation(directory, { now: () => Date.parse(until) }), [
      "Installation: validity-window-not-in-force",
    ]);
    const installation = await loadPilotInstallation(directory);
    assert.equal((await installation.loadCustomerRuntime()).diningTableFiles.length, 0);
    assert.equal(
      (await installation.loadWorkflow("Pickup")).workflow.purposeCode,
      "OrderFulfillment",
    );
    assert.equal(
      (await installation.loadWorkflow("AdditionalRelease")).workflow.purposeCode,
      "OrderFulfillmentAdditionalRound",
    );
    // An InternalTest-only file in a Pilot directory is named, never used.
    await writePrivate(directory, "internal-test-keys.json", "{}");
    assert.deepEqual(
      await checkPilotInstallation(directory, { now: () => Date.parse(at) + 1000 }),
      ["Installation: internal-test-file-present internal-test-keys.json"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("the Platform approval binds exactly this plan, a trusted key and an approver who is not the operator", () => {
  const plan = buildInstallPlan(planInput("/srv/pilot"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = id(40);
  const trust = {
    profile: "StoreRoleProvisioningTrustV1",
    keys: [
      {
        keyReference: key,
        approvedByReference: id(41),
        environmentReference: id(20),
        purposeCode: PILOT_INSTALLATION_PURPOSE,
        notBefore: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        publicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      },
    ],
    revokedApprovalEvidenceReferences: [],
  };
  const now = Date.parse(at);
  const approval = signInstallationPlan({
    plan,
    privateKey,
    approvedByReference: id(41),
    approvalEvidenceReference: id(42),
    keyReference: key,
    validHours: 24,
    now,
  });
  assert.equal(approval.profile, APPROVAL_PROFILE);
  assert.equal(approval.planDigest, planDigest(plan));
  assert.equal(verifyInstallationApproval({ plan, approval, trust, now }), approval);
  const refused = (change, reason) =>
    assert.throws(() => verifyInstallationApproval({ plan, approval, trust, now, ...change }), {
      reason,
    });
  // Any change to the plan (a file, the window, the facts) voids the approval.
  refused(
    { plan: { ...plan, window: { ...plan.window, validUntil: "2026-12-02T12:00:00.000Z" } } },
    "approval-not-for-plan",
  );
  refused(
    {
      approval: {
        ...approval,
        signature:
          approval.signature.replace(/^./u, "A") === approval.signature
            ? approval.signature.replace(/^./u, "B")
            : approval.signature.replace(/^./u, "A"),
      },
    },
    "approval-signature-invalid",
  );
  refused({ now: Date.parse(approval.validUntil) }, "approval-not-in-force");
  refused({ trust: { ...trust, revokedApprovalEvidenceReferences: [id(42)] } }, "approval-revoked");
  refused(
    { trust: { ...trust, keys: [{ ...trust.keys[0], purposeCode: "STORE_ROLE_PROVISIONING" }] } },
    "trust-invalid",
  );
  refused(
    { trust: { ...trust, keys: [{ ...trust.keys[0], approvedByReference: id(43) }] } },
    "approval-key-not-trusted",
  );
  assert.throws(
    () =>
      signInstallationPlan({
        plan,
        privateKey,
        approvedByReference: plan.operatorReference,
        approvalEvidenceReference: id(42),
        keyReference: key,
        validHours: 24,
        now,
      }),
    { reason: "approver-is-operator" },
  );
});

it("a renewal moves only the validity window and records the Owner's approval", () => {
  const install = buildInstallPlan(planInput("/srv/pilot"));
  const current = Object.fromEntries(install.files.map((file) => [file.name, file.content]));
  const bytes = Object.fromEntries(
    install.files.map((file) => [
      file.name,
      Buffer.from(JSON.stringify(file.content, null, 2) + "\n"),
    ]),
  );
  const next = "2027-01-15T12:00:00.000Z";
  const renewal = buildRenewalPlan({
    current,
    bytes,
    until: next,
    at: "2026-11-20T12:00:00.000Z",
    database: "bop_rms_pilot_store",
    directory: "/srv/pilot",
    environmentReference: id(20),
    operatorReference: id(21),
    operationReference: "019a0000-0000-7000-8000-000000000009",
    ownerApproval: { ...ownerApproval, approval: "Approved: continue until 15 January" },
    facts: {},
  });
  assert.equal(renewal.kind, "Renew");
  assert.deepEqual(renewal.window, {
    validFrom: facts.firstWindow.startsAt,
    validUntil: next,
    previousValidUntil: until,
  });
  assert.deepEqual(
    renewal.files.map((file) => file.name),
    ["internal-test-task-queue.json", "internal-test-profile.json"],
  );
  const profile = fileOf(renewal, "internal-test-profile.json");
  assert.deepEqual(profile, {
    ...current["internal-test-profile.json"],
    binding: { ...current["internal-test-profile.json"].binding, validUntil: next },
  });
  const queue = fileOf(renewal, "internal-test-task-queue.json");
  assert.equal(queue.effectiveUntil, next);
  assert.equal(queue.exceptionTaskPolicy.effectiveUntil, next);
  assert.equal(queue.queueReference, current["internal-test-task-queue.json"].queueReference);
  assert.equal(renewal.ownerApproval.approval, "Approved: continue until 15 January");
  const renew = (change) =>
    buildRenewalPlan({
      current,
      bytes,
      until: next,
      at: "2026-11-20T12:00:00.000Z",
      database: "bop_rms_pilot_store",
      directory: "/srv/pilot",
      environmentReference: id(20),
      operatorReference: id(21),
      operationReference: "019a0000-0000-7000-8000-000000000009",
      ownerApproval,
      facts: {},
      ...change,
    });
  assert.throws(() => renew({ until: "2026-11-30T12:00:00.000Z" }), {
    reason: "until-shortens-window",
  });
  assert.throws(() => renew({ until: "2027-03-01T12:00:00.000Z" }), {
    reason: "valid-until-beyond-limit",
  });
  assert.throws(
    () =>
      renew({
        current: {
          ...current,
          "internal-test-profile.json": {
            ...current["internal-test-profile.json"],
            environment: "InternalTest",
          },
        },
      }),
    { reason: "not-pilot-installation" },
  );
  assert.throws(
    () =>
      renew({
        current: {
          ...current,
          "internal-test-task-queue.json": {
            ...current["internal-test-task-queue.json"],
            effectiveUntil: "2026-11-25T12:00:00.000Z",
          },
        },
      }),
    { reason: "window-mismatch" },
  );
});

it("the role password reaches the server only as a SCRAM-SHA-256 verifier", async () => {
  const salt = Buffer.alloc(16, 7);
  const verifier = scramVerifier("secret-password", salt, 4096);
  const salted = pbkdf2Sync("secret-password", salt, 4096, 32, "sha256");
  const stored = createHash("sha256")
    .update(createHmac("sha256", salted).update("Client Key").digest())
    .digest("base64");
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/u);
  assert.ok(verifier.includes(stored));
  assert.ok(!verifier.includes("secret-password"));
  // The CLI prints refusals as fixed codes and never prints values.
  const source = await readFile(new URL("./pilot-installation-issue.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.log\(.*password/iu);
});
