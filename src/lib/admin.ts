/**
 * Emails listed in ADMIN_EMAILS (comma-separated) get the ADMIN role. Admin still needs a verified
 * email to sign in, so only whoever controls that inbox becomes admin.
 */
export function adminEmails(env: string | undefined = process.env.ADMIN_EMAILS): Set<string> {
  return new Set(
    (env ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const isAdminEmail = (email: string, env?: string) => adminEmails(env).has(email.trim().toLowerCase());
