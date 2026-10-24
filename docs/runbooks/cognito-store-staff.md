# Store staff sign-in with Amazon Cognito (WP-2423 DEC-COGNITO-STORE-STAFF)

Design: [DEC-COGNITO-STORE-STAFF](../spec/design/cognito-store-staff.md). This runbook creates the
workforce user pool and app client, wires a pilot installation to it and switches the Store over.
Nothing here is done by the repository; every step needs the Owner's AWS account (external gate).
Never paste secrets into chat, tickets, logs or this repository.

## 1. User pool (ca-central-1)

Create one workforce user pool in **ca-central-1** (the code only accepts
`https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_…` issuers):

- Sign-in: **username**, with **email as an alias** (staff type their work email). Case-insensitive.
- Self sign-up: **off** (invitation only). Admin-created users only.
- Password policy: minimum 12 characters; temporary password validity **7 days** (matches the
  app's invitation expiry).
- MFA: **required**, **authenticator app (TOTP) only**; no SMS, no email OTP.
- Sign-in options (choice-based sign-in / first factors): **password only** — no passkey, no email or
  SMS one-time password as a first factor.
- Device tracking: **don't remember devices** (a remembered device must never skip MFA).
- The app checks these settings itself (section 9): Cognito's user-pool tokens carry no `acr`/`amr`,
  so the pool's MFA setting is what proves the authenticator was used. Any other setting stops sign-in.
- Account recovery: **admin only** (no self-service email recovery), per IDR-0025.
- Custom attribute: `custom:bop_invitation_intent` (String, max 80, **immutable**). The app writes
  the invitation's intent digest here and checks it on the first sign-in.
- Required attributes: `email` only. Do not add name/phone attributes (names live in Membership).
- Invitation message (AdminCreateUser template, email): for example
  "You've been invited to sign in to your store on BOP. Go to https://<staff host>/operations/sign-in
  and sign in with this email and the temporary password {####} (your account name is {username}).
  You'll choose your own password and add an authenticator app. This invitation expires in 7 days."
  Use a verified SES sender for production volume.
- Deletion protection: on. Advanced security: audit mode at least.

## 2. App client and managed login

- App client type: **confidential** (client secret), authorization code grant only, scope `openid`
  only. No implicit grant, no client credentials.
- Callback URLs (exactly): `https://<staff origin>/merchant/callback` and
  `https://<staff origin>/merchant/identity/step-up/callback`. Sign-out URL:
  `https://<staff origin>/app`. Until the hosting/TLS gap closes the staff origin is
  `https://127.0.0.1:4443` (the pilot HTTPS server answers only there).
- Identity providers: Cognito user pool only.
- Token lifetimes: ID/access 60 min, refresh 12 h (the app keeps only the refresh token, encrypted,
  to revoke it on sign-out; it never refreshes).
- Managed login domain: an AWS domain `https://<prefix>.auth.ca-central-1.amazoncognito.com`
  (or a custom domain with its certificate).
- IAM for the pilot host (instance role or the AWS credential chain of the API process):
  `cognito-idp:AdminCreateUser`, `cognito-idp:AdminGetUser`, `cognito-idp:AdminDeleteUser`,
  `cognito-idp:GetUserPoolMfaConfig`, `cognito-idp:DescribeUserPool` on this pool's ARN only. The
  same two read actions are needed on the Brand administration and Platform pools for their sign-ins.

## 3. Installation files (private runtime directory, owner-only `0600`, directory `0700`)

- `cognito-client-secret` — the app client secret (one line).
- `staff-pin-pepper`, `store-device-key`, `staff-pin-choice-key` — three **different** 32-byte keys as
  64 hex characters each (`openssl rand -hex 32`). Changing the pepper invalidates every staff PIN
  (staff set a new one after a full sign-in); changing the device key un-registers every tablet.
- `staff-sign-in.json`:

```json
{
  "schemaVersion": 1,
  "environment": "InternalTest",
  "mode": "cognito",
  "exactOrigin": "https://127.0.0.1:4443",
  "cognito": {
    "bindingEnvironment": "bop-pilot",
    "issuer": "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_XXXXXXXXX",
    "clientId": "<app client id>",
    "managedLoginOrigin": "https://<prefix>.auth.ca-central-1.amazoncognito.com",
    "clientSecretFile": "cognito-client-secret"
  },
  "staffPin": {
    "pepperFile": "staff-pin-pepper",
    "deviceKeyFile": "store-device-key",
    "choiceKeyFile": "staff-pin-choice-key"
  }
}
```

For a **Pilot** (production) process the file names no secret files: omit `staffPin` and
`clientSecretFile`; put the client secret in the hosting's managed secrets folder as
`cognito-client-secret` (DEC-PILOT-SECRETS, next to the other managed values; the PIN pepper,
store-device and lock-screen keys are already managed values there).

`environment` must match the process (`InternalTest` for the v15 pilot, `Pilot` for a production
process). Never add `testProvider` outside local testing. Without this file the pilot keeps its
TEST-ONLY sign-in. With it, the `StaffLogin` capability gap closes (`pilot-supervisor` check).

## 4. Database (before the code that needs it)

Apply migration `2000_094_create_cognito_store_staff_sign_in` and the api grants listed in
`docs/spec/pilot-acl-additions.json` under "DEC-COGNITO-STORE-STAFF" (oidc_authorization_transaction
SELECT/INSERT/UPDATE; store_staff_invitation SELECT/INSERT/UPDATE; store_staff_account SELECT/INSERT;
workforce_mfa_status INSERT; bop_membership.membership INSERT; bop_membership.store_assignment
INSERT). Read the grants back. No permission catalog change.

## 5. Switch an existing pilot Store

1. Rebuild and deploy the code (api `dist`, merchant-web `dist`) with the files above in place.
2. For each person who keeps working (their roles and history stay), give them their own sign-in:
   `node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/store-staff-sign-in.mjs link-existing-member --directory <runtime> --env-file <migration env> --confirm-target <env>:<db> --operator <platform actor> --actor <their actor reference> --email <work email>`
3. Each person opens the invitation email, signs in at `/operations/sign-in` with the temporary
   password, sets a password and adds an authenticator app. On a shared tablet they then set a PIN in
   "My PIN" as before (old PINs keep working; a manager can reset).
4. New staff are invited in the app: Staff → "Invite a staff member" (name, work email, role). The role
   starts after another manager approves it, once the person has signed in.
5. `status` lists invitations (masked email only).

## 6. A new Store's first Owner

1. Store roles provisioned (store-role-provisioning, no owner yet).
2. `store-staff-sign-in.mjs invite-first-owner … --operator <platform actor> --name "<full name>" --email <work email>`
   — prints the Owner role request reference (`ownerRoleChange`).
3. The Owner signs in once (this binds their account; they see no Store pages until step 4).
4. Platform approval of the Owner role by a second person: `store-role-provisioning.mjs
prepare-assignment --change <ownerRoleChange> …` → approver `sign-assignment` → operator
   `apply-assignment`. From then on the Owner invites staff in the app.

## 7. Day-to-day support

- **Forgot password / lost authenticator:** recovery is admin-only. The Owner contacts BOP support,
  who verifies the person out of band and in the Cognito console resets the password
  (AdminResetUserPassword) or the MFA (AdminSetUserMFAPreference / re-associate TOTP). The person's
  account binding stays; meanwhile they can use their PIN on a registered tablet for non-sensitive work.
- **Invitation not received / expired:** Staff → person → "Resend invitation" (new temporary password,
  new 7 days). If the app says the email must be entered again, Cognito never created the account.
- **Wrong email:** "Cancel invitation" and invite again with the right address.
- **Someone leaves:** Staff → person → "Remove from this Store" (ends roles and sessions at once). Also
  disable the user in Cognito (AdminDisableUser) so they cannot sign in anywhere. Re-hiring the same
  email later needs that old Cognito user deleted first (email alias is unique).
- **Cognito outage:** signed-in staff keep working; PIN switching on registered tablets works; new
  full sign-ins and "Verify it's you" wait. Follow the store outage procedure for anything longer.

## 8. First real verification (record results in WP-2423)

1. Invite a test staff member; confirm the email template and sender; first sign-in with password
   change and TOTP set-up reaches the app; Staff shows them as joined.
2. Confirm sign-in works with the pool check (section 9): no `STAFF_SIGN_IN_POOL_CHECK_REFUSED` line in
   the API log after startup. Real tokens are expected to carry no `acr`/`amr`; that is accepted.
3. Sign out and sign in again on the same browser: the managed login asks for password and code again.
4. "Verify it's you" on a refund approval opens the sign-in window and the approval goes ahead.
5. Kitchen display start, PIN switch on a registered tablet, 12-hour limit warnings unchanged.
6. Resend, cancel (the Cognito user is deleted), re-invite the same email.

## 9. Pool check (MFA required, authenticator app only)

Real Cognito user-pool tokens carry `auth_time` but no `acr`/`amr`, so before every staff sign-in and
"Verify it's you" the app reads the pool settings (`GetUserPoolMfaConfig` and `DescribeUserPool`, the
IAM actions above). A result older than five minutes is read again; the API also checks at startup and
every four minutes. Sign-in goes ahead only when MFA is `ON`, the authenticator app (TOTP) is enabled,
SMS and email MFA are off, the first factor is password only and remembered devices cannot skip MFA.

When the check does not pass or cannot be read:

- Staff see "Signing in isn't available right now …" on the sign-in page, and the "Verify it's you"
  window says signing in again isn't available. Signed-in staff keep working; PIN switching on a
  registered tablet keeps working. Nothing is recorded.
- The API logs one line per change (no secret, no person):
  `{"event":"STAFF_SIGN_IN_POOL_CHECK_REFUSED","state":"Refused"|"Unknown","reason":…}`.
  `MfaNotRequired` (set MFA to required), `AuthenticatorAppNotEnabled` (enable authenticator apps),
  `TextMessageMfaEnabled` / `EmailMfaEnabled` (turn that MFA method off), `PasswordlessSignInAllowed`
  (sign-in options: password only), `RememberedDevicesSkipMfa` (device tracking: don't remember),
  `Unavailable` (the pool could not be read: IAM actions, pool ID, network or a Cognito outage).
- Fix the setting in the Cognito console; sign-in works again within four minutes (or at the next
  sign-in attempt after the previous result is five minutes old). No restart is needed.
