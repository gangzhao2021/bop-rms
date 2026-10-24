import { createInternalMerchantSession } from "./pilot-merchant-session.mjs";
import { createInternalMerchantCognitoSession } from "./pilot-merchant-cognito-session.mjs";
import { loadPilotStaffSignIn } from "./pilot-staff-sign-in.mjs";

const defaults = Object.freeze({
  createInternalMerchantSession,
  createInternalMerchantCognitoSession,
  loadPilotStaffSignIn,
});

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF / DEC-PILOT-RUNTIME-ENVIRONMENT: the staff session of this
 * installation, chosen once by `staff-sign-in.json` for every composition that authorizes staff
 * (merchant BFF and the customer-side dining staff commands): Cognito when configured (the only
 * choice a Pilot Store can start with), otherwise the TEST-ONLY roster sign-in of InternalTest.
 * One session per resources object, so both compositions of one process share it (and one
 * Cognito pool check).
 */
const shared = new WeakMap();
export function createPilotStaffSessionFactory(
  directory,
  installation,
  { credentials, publicOrigin, implementations = defaults },
) {
  const f = { ...defaults, ...implementations };
  const create = async (resources) => {
    const signIn = await f.loadPilotStaffSignIn(directory);
    return signIn.mode === "cognito"
      ? f.createInternalMerchantCognitoSession(resources, {
          signIn,
          createInternalMerchantCredentials: credentials.createInternalMerchantCredentials,
          // The staff origin is the HTTPS server's public origin (DEC-PILOT-MAINTENANCE-PAGE).
          staffOrigin: publicOrigin,
        })
      : f.createInternalMerchantSession(resources, {
          loadEmployee: () => installation.loadCustomerData("internal-test-merchant.json"),
          expectedDatabaseName: installation.database,
          createInternalMerchantCredentials: credentials.createInternalMerchantCredentials,
        });
  };
  return (resources) => {
    if (resources === null || typeof resources !== "object") return create(resources);
    let byDirectory = shared.get(resources);
    if (byDirectory === undefined) {
      byDirectory = new Map();
      shared.set(resources, byDirectory);
    }
    let session = byDirectory.get(directory);
    if (session === undefined) {
      session = create(resources);
      byDirectory.set(directory, session);
      // A failed start is not remembered: the next composition attempt reads the files again.
      session.catch(() => byDirectory.delete(directory));
    }
    return session;
  };
}
