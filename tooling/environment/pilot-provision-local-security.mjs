import process from "node:process";
import console from "node:console";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { provisionPilotCredentials } from "./pilot-provision-credentials.mjs";
import { provisionPilotTls } from "./pilot-provision-tls.mjs";

/** Existing matching profile required; never grants authority or rotates keys. */
export async function provisionPilotLocalSecurity({ directory, expectedDatabaseName }) {
  const options = { directory: resolve(directory), expectedDatabaseName };
  const credentials = await provisionPilotCredentials(options);
  const tls = await provisionPilotTls(options);
  return {
    status: "Ready",
    credentials: credentials.application,
    tls: tls.status,
    rotationPerformed: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("PILOT_SECURITY_ARGUMENTS_INVALID");
    console.log(
      JSON.stringify(
        await provisionPilotLocalSecurity({
          directory: process.argv[2],
          expectedDatabaseName: process.argv[3],
        }),
      ),
    );
  } catch {
    console.error(
      "PILOT_LOCAL_SECURITY_UNAVAILABLE: requires development mode, a matching InternalTest profile, a private directory and valid existing files. No existing key is replaced.",
    );
    process.exitCode = 1;
  }
}
