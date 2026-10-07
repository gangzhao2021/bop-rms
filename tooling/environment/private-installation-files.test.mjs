import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, chmod, writeFile, symlink, link, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  createPrivateInstallationReader,
  parsePrivateInstallationFilename,
} from "./private-installation-files.mjs";
let directory;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-private-reader-")));
  await chmod(directory, 0o700);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(directory + "-retained", { recursive: true, force: true });
});
it("reads only owner-private bounded UTF8 files and observes an actual later replacement", async () => {
  await writeFile(join(directory, "value.json"), "first", { mode: 0o600 });
  const reader = await createPrivateInstallationReader(directory);
  expect(await reader.read("value.json")).toBe("first");
  await writeFile(join(directory, "next.json"), "second", { mode: 0o600 });
  await rename(join(directory, "next.json"), join(directory, "value.json"));
  expect(await reader.read("value.json")).toBe("second");
});
it.each(["../value", "/absolute", ".hidden", "A.json", "a/b", "x".repeat(97)])(
  "refuses non-basename %s",
  (value) => {
    expect(() => parsePrivateInstallationFilename(value)).toThrow(
      "PRIVATE_INSTALLATION_UNAVAILABLE",
    );
  },
);
it.each(["symlink", "hardlink", "public", "empty", "oversize", "utf8"])(
  "rejects %s without exposing file data",
  async (kind) => {
    const path = join(directory, "value");
    await writeFile(path, "private", { mode: 0o600 });
    if (kind === "symlink") {
      await rename(path, path + "-old");
      await symlink(path + "-old", path);
    }
    if (kind === "hardlink") await link(path, join(directory, "alias"));
    if (kind === "public") await chmod(path, 0o644);
    if (kind === "empty") await writeFile(path, "");
    if (kind === "oversize") await writeFile(path, "x".repeat(65537));
    if (kind === "utf8") await writeFile(path, Buffer.from([0xff]));
    const reader = await createPrivateInstallationReader(directory);
    await expect(reader.read("value")).rejects.toThrow(/^PRIVATE_INSTALLATION_UNAVAILABLE$/u);
  },
);
it("refuses a replaced or newly public directory for an already captured reader", async () => {
  const reader = await createPrivateInstallationReader(directory);
  await rename(directory, directory + "-retained");
  await import("node:fs/promises").then((fs) => fs.mkdir(directory, { mode: 0o700 }));
  await writeFile(join(directory, "value"), "replacement", { mode: 0o600 });
  await expect(reader.read("value")).rejects.toThrow("PRIVATE_INSTALLATION_UNAVAILABLE");
  await chmod(directory, 0o755);
  await expect(createPrivateInstallationReader(directory)).rejects.toThrow(
    "PRIVATE_INSTALLATION_UNAVAILABLE",
  );
});
