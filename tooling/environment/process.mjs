import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function inspectMacProcess(pid, includeEnvironment = false) {
  return execFileSync(
    "/bin/ps",
    [includeEnvironment ? "eww" : "-ww", "-p", String(pid), "-o", "command="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000 },
  ).trim();
}

export function processMatches(pid, root, script, argument) {
  if (!validPid(pid)) return false;
  try {
    const scripts = [script, path.join(root, script)];
    const interpreters = [process.execPath, "node"];
    if (process.platform === "linux") {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return (
        interpreters.includes(args[0]) &&
        scripts.includes(args[1]) &&
        (argument === undefined || args[2] === argument)
      );
    }
    if (process.platform !== "darwin") return false;
    const command = inspectMacProcess(pid);
    return interpreters.some((interpreter) =>
      scripts.some((candidate) => {
        const prefix = `${interpreter} ${candidate}${argument === undefined ? "" : ` ${argument}`}`;
        return command === prefix || command.startsWith(`${prefix} `);
      }),
    );
  } catch {
    // Missing, inaccessible, or unrelated PIDs must never be signalled as our supervisor.
    return false;
  }
}

// Return only the requested key's presence, never process arguments or environment values.
export function processHasEnvironmentVariable(pid, name) {
  if (!validPid(pid) || !/^[A-Z][A-Z0-9_]*$/u.test(name))
    throw new Error("Invalid process environment inspection input");
  try {
    if (process.platform === "linux")
      return fs
        .readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .some((entry) => entry.startsWith(`${name}=`));
    if (process.platform === "darwin") {
      const command = inspectMacProcess(pid, true);
      if (!command) throw new Error("Process unavailable");
      return command.includes(` ${name}=`);
    }
  } catch {
    // Child-process errors can contain captured output; never expose it to verification logs.
    throw new Error("Process environment inspection unavailable");
  }
  throw new Error("Process environment inspection requires Linux or macOS");
}
