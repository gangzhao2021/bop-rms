import console from "node:console";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  INTERNAL_TEST_MEMBER_INBOX,
  createInternalTestMemberMessages,
  memberMessages,
} from "./pilot-member.mjs";

/** WP-2423 取舍 18: the text-message stand-in exists only in InternalTest, and logs nothing. */
const internalTest = { NODE_ENV: "development" };
const directories = [];
const directory = async () => {
  const made = await mkdtemp(join(tmpdir(), "bop-member-"));
  directories.push(made);
  return made;
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((made) => rm(made, { recursive: true, force: true })),
  );
});

it.each([
  [{ NODE_ENV: "production" }],
  [{ NODE_ENV: "production", BOP_PILOT_ENVIRONMENT: "Pilot" }],
  [{ NODE_ENV: "development", BOP_PILOT_ENVIRONMENT: "Pilot" }],
])("refuses to exist in a production configuration: %j", (env) => {
  expect(() => createInternalTestMemberMessages("/nowhere", { env })).toThrow();
});

it("a Pilot Store with no text account has no way to send, never the stand-in", () => {
  expect(
    memberMessages({
      directory: "/nowhere",
      env: { NODE_ENV: "production", BOP_PILOT_ENVIRONMENT: "Pilot" },
    }),
  ).toBeNull();
});

it("a configured text account is used wherever it exists, with the number only in the send", async () => {
  const send = vi.fn(async () => undefined);
  const port = memberMessages({ directory: "/nowhere", sms: { send }, env: internalTest });
  await port.send({ phone: "+16135550131", kind: "Code", text: "t" });
  expect(send).toHaveBeenCalledWith({ channel: "Sms", destination: "+16135550131", text: "t" });
});

it("the tester reads the newest message from a private file; nothing is logged", async () => {
  const logged = ["log", "info", "warn", "error"].map((name) => vi.spyOn(console, name));
  const made = await directory();
  const port = memberMessages({ directory: made, env: internalTest });
  await port.send({ phone: "+16135550132", kind: "Code", text: "first 111111" });
  await port.send({ phone: "+16135550132", kind: "Code", text: "second 222222" });
  const folder = join(made, INTERNAL_TEST_MEMBER_INBOX);
  expect(await readdir(folder)).toEqual(["0132.json"]);
  expect(JSON.parse(await readFile(join(folder, "0132.json"), "utf8"))).toEqual({
    kind: "Code",
    text: "second 222222",
  });
  expect((await stat(join(folder, "0132.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(folder)).mode & 0o777).toBe(0o700);
  for (const spy of logged) expect(spy).not.toHaveBeenCalled();
});
