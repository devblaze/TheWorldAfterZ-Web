import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "./db";
import { canAccessBugReports, canAccessPanel, loadStanding } from "./moderation";
import { ipFrom } from "./rate-limit";

export const clientIp = async () => ipFrom(await headers());

/** Current user loaded fresh from the DB (role changes / deletions apply immediately), or null. */
export async function currentUser() {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({ where: { id } });
  // A password reset signs out every session issued before it.
  if (user?.passwordChangedAt && (session.issuedPwdAt ?? 0) < user.passwordChangedAt.getTime()) return null;
  return user;
}

export async function requireUserPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdminPage() {
  const user = await requireUserPage();
  if (user.role !== "ADMIN") redirect("/account");
  return user;
}

/** Access = a redemption whose key has not been revoked. */
export function activeRedemption(userId: string) {
  return prisma.redemption.findFirst({
    where: { userId, key: { status: { not: "REVOKED" } } },
    include: { key: true },
  });
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** 303 back to a same-origin path after a form POST. */
export const seeOther = (path: string) => new Response(null, { status: 303, headers: { Location: path } });

/** For API routes: the signed-in admin, or null (caller returns 403). */
export async function adminOrNull() {
  const user = await currentUser();
  return user?.role === "ADMIN" ? user : null;
}

/** For API routes: the signed-in moderation-panel user (owner, site admin or game admin) with their standing, or null. Recomputed from the DB on every call. */
export async function moderatorOrNull() {
  const user = await currentUser();
  if (!user) return null;
  const standing = await loadStanding(prisma, user);
  return canAccessPanel(standing) ? { user, standing } : null;
}

export async function requireModerator() {
  const user = await requireUserPage();
  const standing = await loadStanding(prisma, user);
  if (!canAccessPanel(standing)) redirect("/account");
  return { user, standing };
}

/** For API routes: signed-in user who may view bug reports (owner, or an admin with the bugReports power), or null. */
export async function bugReportsAdminOrNull() {
  const user = await currentUser();
  if (!user) return null;
  const standing = await loadStanding(prisma, user);
  return canAccessBugReports(standing) ? { user, standing } : null;
}

export async function requireBugReportsPage() {
  const user = await requireUserPage();
  const standing = await loadStanding(prisma, user);
  if (!canAccessBugReports(standing)) redirect("/account");
  return { user, standing };
}
