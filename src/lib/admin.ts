/**
 * Emails listed in ADMIN_EMAILS (comma-separated) get the ADMIN role. Admin still needs a verified
 * email to sign in, so only whoever controls that inbox becomes admin.
 */
export function adminEmails(env: string | undefined = process.env.ADMIN_EMAILS): Set<string> {
  return parseEmailList(env);
}

/** Comma-separated emails, trimmed and lowercased. No default env: callers pass the variable they mean (OWNER_EMAILS must never fall back to ADMIN_EMAILS). */
export const parseEmailList = (raw: string | undefined): Set<string> =>
  new Set((raw ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

export const isAdminEmail = (email: string, env?: string) => adminEmails(env).has(email.trim().toLowerCase());
