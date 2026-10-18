import { expect, it } from "vitest";
import {
  parsePilotRecoveryArguments,
  assertPilotRecoveryConnection,
} from "./pilot-recovery-plan.mjs";
const args = [
  ".local/pilot-v12",
  "bop_rms_wp2402_restore_v12_new",
  "pilot-postgres-1",
  "recovery-new",
];
const installation = {
  database: "bop_rms_wp2402_pilot_v12",
  connection: { host: "127.0.0.1", port: 55435 },
};
const config = {
  environment: "local",
  host: "127.0.0.1",
  port: 55435,
  database: installation.database,
};
it("requires explicit isolated target and private relative output label", () => {
  const plan = parsePilotRecoveryArguments(args);
  expect(plan).toEqual({
    runtimeDirectory: args[0],
    target: args[1],
    container: args[2],
    label: args[3],
  });
  expect(() =>
    assertPilotRecoveryConnection(plan, installation, config, "development"),
  ).not.toThrow();
});
it.each([
  [],
  args.slice(0, 3),
  [...args, "--force"],
  ["../pilot", ...args.slice(1)],
  [args[0], "postgres", ...args.slice(2)],
  [args[0], args[1], "--help", args[3]],
  [...args.slice(0, 3), "../backup"],
  [...args.slice(0, 3), "recovery-x/y"],
])("rejects unsafe/missing/extra arguments %j", (value) => {
  expect(() => parsePilotRecoveryArguments(value)).toThrow();
});
it.each([
  { host: "localhost" },
  { port: 5432 },
  { database: "other" },
  { environment: "production" },
])("rejects connection drift %j", (patch) => {
  expect(() =>
    assertPilotRecoveryConnection(
      parsePilotRecoveryArguments(args),
      installation,
      { ...config, ...patch },
      "development",
    ),
  ).toThrow();
});
it("rejects source overwrite and nondevelopment use", () => {
  const plan = parsePilotRecoveryArguments(args);
  expect(() =>
    assertPilotRecoveryConnection(
      { ...plan, target: installation.database },
      installation,
      config,
      "development",
    ),
  ).toThrow();
  expect(() => assertPilotRecoveryConnection(plan, installation, config, "production")).toThrow();
});
