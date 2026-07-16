import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
let envFile = ".env";
let checkPorts = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--check-ports") checkPorts = true;
  else if (argument === "--env-file") {
    envFile = args[index + 1];
    index += 1;
    if (!envFile) throw new Error("--env-file requires a path");
  } else throw new Error(`Unknown argument: ${argument}`);
}

try {
  const config = await loadEnvironment({ checkPorts, envFile, root });
  const result = {
    checkout: config.root,
    composeProject: config.projectName,
    ports: config.ports,
    status: "valid",
    tools: config.toolchain.actual,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(
      {
        error: error instanceof Error ? error.message : "unknown validation error",
        status: "invalid",
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
