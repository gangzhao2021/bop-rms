import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
export function parsePilotRecoveryArguments(args) {
  if (!Array.isArray(args) || args.length !== 4 || args.some((v) => typeof v !== "string"))
    throw Error("RECOVERY_ARGUMENT_INVALID");
  const [directory, target, container, label] = args;
  const runtimeDirectory = parsePilotRuntimeDirectory(directory);
  if (
    !/^bop_rms_[a-z0-9_]{1,46}_restore_[a-z0-9_]+$/.test(target) ||
    target.length > 63 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container) ||
    !/^recovery-[a-z0-9][a-z0-9-]{0,47}$/.test(label)
  )
    throw Error("RECOVERY_ARGUMENT_INVALID");
  return Object.freeze({ runtimeDirectory, target, container, label });
}
export function assertPilotRecoveryConnection(plan, installation, config, environment) {
  if (
    environment !== "development" ||
    config.environment !== "local" ||
    config.host !== "127.0.0.1" ||
    config.host !== installation.connection.host ||
    config.port !== installation.connection.port ||
    config.database !== installation.database ||
    plan.target === installation.database
  )
    throw Error("RECOVERY_SCOPE_INVALID");
}
