import { expect, it } from "vitest";
import process from "node:process";
import net from "node:net";
import {
  parsePilotProcess,
  parsePilotRuntimeDirectory,
  pilotProcessArguments,
  pilotLaunchEnvironment,
  pilotProcessIsStopped,
  assertPilotPortFree,
  isPilotWorkerCandidate,
} from "./pilot-service.mjs";
const root = "/synthetic pilot";
const fixture = (service = "api") => ({
  root,
  service,
  cwd: root,
  executable: process.execPath,
  cmdline: pilotProcessArguments(root, service).join("\0") + "\0",
  environ:
    "NODE_ENV=development\0PORT=4300\0SYNTHETIC_SECRET=never-print=this\0CUSTOM_RUNTIME_SETTING=kept\0",
  stat: "123 (MainThread) " + ["S", ...Array(18).fill("0"), "9876", "0"].join(" "),
});
it("preserves all private environment values and original argument boundaries", () => {
  const input = fixture(),
    result = parsePilotProcess(input);
  expect(result.args).toEqual(pilotProcessArguments(root, "api"));
  expect(result.environment.PORT).toBe("4300");
  expect(result.environment.SYNTHETIC_SECRET).toBe("never-print=this");
  expect(result.environment.CUSTOM_RUNTIME_SETTING).toBe("kept");
  expect(result.started).toBe("9876");
});
it("supports the existing HTTPS service without inventing a PORT variable", () => {
  const input = fixture("customer");
  input.environ = "NODE_ENV=development\0CUSTOM_RUNTIME_SETTING=kept\0";
  expect(parsePilotProcess(input).environment.PORT).toBeUndefined();
});
it.each([
  { cwd: "/other" },
  { cmdline: `${process.execPath}\0-e\0unrelated\0` },
  { environ: "NODE_ENV=production\0PORT=4300\0" },
  { environ: "NODE_ENV=development\0" },
  { environ: "NODE_ENV=development\0PORT=3000\0" },
  { environ: "NODE_ENV=development\0PORT=4300\0PORT=3000\0" },
  { stat: "123 (MainThread) Z " + Array(18).fill("0").join(" ") + " 9876" },
  { stat: "invalid" },
  { service: "database" },
])("rejects an unrelated or untrusted process %j", (change) => {
  expect(() => parsePilotProcess({ ...fixture(), ...change })).toThrow("PILOT_PROCESS_UNAVAILABLE");
});
it("does not accept extra process arguments", () => {
  const input = fixture();
  expect(() => parsePilotProcess({ ...input, cmdline: input.cmdline + "--other\0" })).toThrow();
});

it("accepts a verified symlink to the same pinned Node executable", () => {
  const input = fixture();
  const cmdline = input.cmdline.replace(process.execPath, "/synthetic/bin/node");
  expect(parsePilotProcess({ ...input, cmdline }).args[0]).toBe("/synthetic/bin/node");
});

it("builds cold-start environment without copying unrelated secrets or Node injections", () => {
  const env = {
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    TMPDIR: "/synthetic/tmp",
    NODE_OPTIONS: "--require untrusted",
    SECRET: "not-copied",
    PORT: "9999",
  };
  expect(pilotLaunchEnvironment("api", env)).toEqual({
    NODE_ENV: "development",
    PORT: "4300",
    PATH: env.PATH,
    HOME: env.HOME,
    TMPDIR: env.TMPDIR,
  });
  expect(pilotLaunchEnvironment("customer", env).PORT).toBeUndefined();
});
it("only considers terminal process states stopped", () => {
  for (const state of ["S", "R", "D", "T", "Z", "X"]) {
    const stat = fixture().stat.replace(") S ", ") " + state + " ");
    expect(pilotProcessIsStopped(stat)).toBe(["Z", "X"].includes(state));
  }
  expect(() => pilotProcessIsStopped("invalid")).toThrow();
});
it("refuses an occupied port and releases its own free-port probe", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture unavailable");
  try {
    await expect(assertPilotPortFree(address.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await assertPilotPortFree(address.port);
  await assertPilotPortFree(address.port);
});

it.each([
  "business-worker",
  "kitchen-queue-worker",
  "reconciliation-worker",
  "dining-exception-worker",
])("verifies exact %s identity and minimal launch environment", (service) => {
  const input = fixture(service);
  input.environ = "NODE_ENV=development\0";
  expect(parsePilotProcess(input).args).toEqual(pilotProcessArguments(root, service));
  expect(pilotLaunchEnvironment(service, { PORT: "9999", SECRET: "not-copied" })).toEqual({
    NODE_ENV: "development",
  });
  expect(isPilotWorkerCandidate(root, service, root, input.cmdline)).toBe(true);
  expect(isPilotWorkerCandidate(root, service, "/other", input.cmdline)).toBe(false);
  expect(
    isPilotWorkerCandidate(root, service, root, pilotProcessArguments(root, "customer").join("\0")),
  ).toBe(false);
  expect(() => parsePilotProcess({ ...input, cmdline: input.cmdline + "--extra\0" })).toThrow();
});

it.each([
  "api",
  "customer",
  "business-worker",
  "kitchen-queue-worker",
  "reconciliation-worker",
  "dining-exception-worker",
])("keeps %s process identity bound to the selected installation", (service) => {
  const runtimeDirectory = ".local/pilot-installation";
  const input = { ...fixture(service), runtimeDirectory };
  input.cmdline = pilotProcessArguments(root, service, runtimeDirectory).join("\0") + "\0";
  expect(parsePilotProcess(input).args).toEqual(
    pilotProcessArguments(root, service, runtimeDirectory),
  );
  expect(() => parsePilotProcess({ ...input, runtimeDirectory: ".local/pilot-v12" })).toThrow();
  if (service.endsWith("worker")) {
    expect(isPilotWorkerCandidate(root, service, root, input.cmdline, runtimeDirectory)).toBe(true);
    expect(isPilotWorkerCandidate(root, service, root, input.cmdline)).toBe(false);
  }
});
it.each([
  "",
  "/tmp/pilot",
  ".local/../pilot",
  ".local/pilot/other",
  ".local/.hidden",
  ".local/pilot\\other",
  ".local/pilot\n",
  null,
  12,
])("rejects invalid runtime selection %j before constructing commands", (value) => {
  expect(() => parsePilotRuntimeDirectory(value)).toThrow("PILOT_PROCESS_UNAVAILABLE");
  expect(() => pilotProcessArguments(root, "api", value)).toThrow();
});
it("uses the active v13 default installation with the repository HTTPS entry", () => {
  expect(parsePilotRuntimeDirectory()).toBe(".local/pilot-v14");
  expect(pilotProcessArguments(root, "customer").slice(-2)).toEqual([
    "tooling/environment/pilot-https-entry.mjs",
    ".local/pilot-v14",
  ]);
});

it("launches reconciliation from the repository without requiring a private wrapper", () => {
  const args = pilotProcessArguments(root, "reconciliation-worker", ".local/new-installation");
  expect(args.slice(-2)).toEqual([
    "tooling/environment/pilot-reconciliation-worker.mjs",
    ".local/new-installation",
  ]);
  expect(
    isPilotWorkerCandidate(
      root,
      "reconciliation-worker",
      root,
      args.join("\0"),
      ".local/new-installation",
    ),
  ).toBe(true);
  expect(
    isPilotWorkerCandidate(
      root,
      "reconciliation-worker",
      root,
      args.join("\0"),
      ".local/pilot-v12",
    ),
  ).toBe(false);
});

it("launches dining-exception from the repository without requiring a private wrapper", () => {
  const args = pilotProcessArguments(root, "dining-exception-worker", ".local/new-installation");
  expect(args.slice(-2)).toEqual([
    "tooling/environment/pilot-dining-exception-worker.mjs",
    ".local/new-installation",
  ]);
  expect(
    isPilotWorkerCandidate(
      root,
      "dining-exception-worker",
      root,
      args.join("\0"),
      ".local/new-installation",
    ),
  ).toBe(true);
  expect(
    isPilotWorkerCandidate(
      root,
      "dining-exception-worker",
      root,
      args.join("\0"),
      ".local/pilot-v12",
    ),
  ).toBe(false);
});

it("launches daily settlement independently and rejects another installation", () => {
  const args = pilotProcessArguments(root, "daily-settlement-worker", ".local/pilot-v14");
  expect(args.slice(-2)).toEqual([
    "tooling/environment/pilot-daily-settlement-worker.mjs",
    ".local/pilot-v14",
  ]);
  expect(
    isPilotWorkerCandidate(
      root,
      "daily-settlement-worker",
      root,
      args.join("\0"),
      ".local/pilot-v14",
    ),
  ).toBe(true);
  expect(
    isPilotWorkerCandidate(root, "daily-settlement-worker", root, args.join("\0"), ".local/other"),
  ).toBe(false);
});
