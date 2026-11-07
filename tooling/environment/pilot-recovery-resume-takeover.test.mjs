import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { writePilotResumeOwner } from "./pilot-recovery-resume-owner.mjs";
const state = vi.hoisted(() => ({ drift: false }));
vi.mock("./pilot-maintenance-status.mjs", () => ({
  readPilotMaintenanceStatus: async () => ({
    state: "OwnerExitedReviewRequired",
    operation: "Recovery",
  }),
}));
vi.mock("./pilot-recovery-review.mjs", () => ({
  inspectPilotRecoveryScope: async (args) => {
    const folder = path.resolve(args[0], args[3]);
    const baselineBytes = await fs.readFile(path.join(folder, "source-baseline.json"));
    if (state.drift) await fs.appendFile(path.join(folder, "source-baseline.json"), " ");
    return { folder, baselineBytes, baseline: JSON.parse(baselineBytes) };
  },
}));
import { preparePilotResumeTakeover } from "./pilot-recovery-resume-takeover.mjs";
async function fixture(work) {
  const runtime = ".local/takeover-test-" + randomUUID(),
    root = path.resolve(runtime);
  const folder = path.join(root, "recovery-test"),
    control = path.join(root, "recovery-resume.lock");
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  state.drift = false;
  await fs.mkdir(root, { mode: 0o700 });
  try {
    await fs.mkdir(folder, { mode: 0o700 });
    await fs.mkdir(control, { mode: 0o700 });
    const lease = JSON.stringify({ operation: "Recovery", pid: process.pid });
    await fs.writeFile(path.join(root, "maintenance.lock"), lease, { mode: 0o600 });
    const leaseSha256 = createHash("sha256").update(lease).digest("hex");
    await fs.writeFile(path.join(folder, "source-baseline.json"), JSON.stringify({ leaseSha256 }), {
      mode: 0o600,
    });
    const owner = await writePilotResumeOwner(control, "recovery-test", leaseSha256);
    const departed = JSON.parse(owner.bytes);
    departed.bootId = "00000000-0000-0000-0000-000000000000";
    await fs.writeFile(owner.file, JSON.stringify(departed), { mode: 0o600 });
    await work({
      root,
      folder,
      control,
      owner,
      lease,
      args: [runtime, "bop_rms_test_restore_resume", "synthetic", "recovery-test"],
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
it.each(["active", "guard", "supervisor", "baseline", "label"])(
  "refuses %s before archiving",
  (mode) =>
    fixture(async (f) => {
      if (mode === "active") await fs.writeFile(f.owner.file, f.owner.bytes);
      if (mode === "guard")
        await fs.mkdir(path.join(f.root, "recovery-resume-takeover.lock"), { mode: 0o700 });
      if (mode === "supervisor")
        await fs.writeFile(path.join(f.root, "supervisor.lock"), "present", { mode: 0o600 });
      if (mode === "baseline") state.drift = true;
      if (mode === "label") f.args[3] = "recovery-other";
      const before = await fs.readFile(f.owner.file);
      await expect(preparePilotResumeTakeover(f.args)).rejects.toThrow();
      expect(await fs.readFile(f.owner.file)).toEqual(before);
      expect(
        (await fs.readdir(f.folder)).filter((name) => name.startsWith("resume-attempt-")),
      ).toEqual([]);
      expect(await fs.readFile(path.join(f.root, "maintenance.lock"), "utf8")).toBe(f.lease);
    }),
);
it.each(["owner", "lease", "guard", "attempt"])("refuses changed %s after adoption", (mode) =>
  fixture(async (f) => {
    const old = await fs.readFile(f.owner.file);
    const adopted = await preparePilotResumeTakeover(f.args);
    expect(await fs.readFile(path.join(adopted.folder, "prior-owner.json"))).toEqual(old);
    await adopted.assertUnchanged();
    if (mode === "owner") await fs.appendFile(adopted.owner.file, " ");
    if (mode === "lease") await fs.appendFile(path.join(f.root, "maintenance.lock"), " ");
    if (mode === "guard" || mode === "attempt") {
      const target =
        mode === "guard" ? path.join(f.root, "recovery-resume-takeover.lock") : adopted.folder;
      await fs.rename(target, target + "-retained");
      await fs.mkdir(target, { mode: 0o700 });
    }
    await expect(adopted.assertUnchanged()).rejects.toThrow();
    if (mode === "guard") await expect(adopted.releaseGuard()).rejects.toThrow();
    else await adopted.releaseGuard();
  }),
);
