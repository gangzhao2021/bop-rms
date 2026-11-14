// Test support only (WP-2423 DEC-PILOT-MAINTENANCE-PAGE tests): a throwaway root CA and a leaf
// certificate for a public-looking name, made with the openssl CLI the pilot TLS tests already use.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const openssl = (args, cwd) => run("openssl", args, { cwd, timeout: 30_000 });

export async function createTestCertificates(
  directory,
  { hostname = "order.store-pilot.ca", days = 30 } = {},
) {
  await fs.writeFile(
    path.join(directory, "leaf.cnf"),
    `[v3]\nsubjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  await fs.writeFile(
    path.join(directory, "root.cnf"),
    "[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
  );
  await openssl(
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Synthetic Test Root",
      "-keyout",
      "root.key",
      "-out",
      "root.csr",
    ],
    directory,
  );
  await openssl(
    [
      "x509",
      "-req",
      "-in",
      "root.csr",
      "-signkey",
      "root.key",
      "-days",
      String(days),
      "-sha256",
      "-extfile",
      "root.cnf",
      "-extensions",
      "v3",
      "-out",
      "root.pem",
    ],
    directory,
  );
  await openssl(
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${hostname}`,
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
    ],
    directory,
  );
  await openssl(
    [
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "root.pem",
      "-CAkey",
      "root.key",
      "-set_serial",
      "2",
      "-days",
      String(days),
      "-sha256",
      "-extfile",
      "leaf.cnf",
      "-extensions",
      "v3",
      "-out",
      "leaf.pem",
    ],
    directory,
  );
  for (const name of ["root.key", "leaf.key"]) await fs.chmod(path.join(directory, name), 0o600);
  return {
    root: await fs.readFile(path.join(directory, "root.pem"), "utf8"),
    certificateFile: path.join(directory, "leaf.pem"),
    keyFile: path.join(directory, "leaf.key"),
    rootFile: path.join(directory, "root.pem"),
    rootKeyFile: path.join(directory, "root.key"),
  };
}
