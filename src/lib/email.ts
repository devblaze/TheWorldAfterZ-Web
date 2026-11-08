import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { prisma } from "./db";
import { sha256 } from "./crypto";
import { revokeUserNativeSessions } from "./launcher/store";

const DAY = 24 * 60 * 60_000;

const HOUR = 60 * 60_000;
const base = () => process.env.AUTH_URL ?? "http://localhost:3000";

/** Replaces any pending token for the user and sends (or logs) a fresh verification link. */
export async function sendVerification(userId: string, email: string) {
  const token = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } }),
    prisma.emailVerificationToken.create({
      data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + DAY) },
    }),
  ]);
  const link = `${base()}/api/verify?token=${token}`;
  await send(email, "verification", "Verify your TheWorldAfterZ account",
    `Confirm your email to finish signing up:\n\n${link}\n\nThis link expires in 24 hours and works once.`, link);
}

/** Replaces any pending reset token for the user and sends (or logs) a fresh reset link. */
export async function sendPasswordReset(userId: string, email: string) {
  const token = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId, usedAt: null } }),
    prisma.passwordResetToken.create({
      data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + HOUR) },
    }),
  ]);
  const link = `${base()}/reset-password?token=${token}`;
  await send(email, "password reset", "Reset your TheWorldAfterZ password",
    `Someone asked to reset the password for this account. To choose a new one, open:\n\n${link}\n\nThis link expires in 1 hour and works once. If it wasn't you, ignore this email.`, link);
}

/**
 * Consumes a reset token and sets the new password. Returns the user id, or null if the token was
 * invalid, used or expired. Proves inbox ownership, so it also verifies the email.
 */
export async function consumePasswordReset(token: string, passwordHash: string) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!t || t.usedAt || t.expiresAt < new Date()) return null;
    const used = await tx.passwordResetToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) return null;
    const now = new Date();
    const user = await tx.user.findUniqueOrThrow({ where: { id: t.userId } });
    await tx.user.update({
      where: { id: t.userId },
      data: { passwordHash, passwordChangedAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now },
    });
    await revokeUserNativeSessions(tx, t.userId, "password_changed");
    await tx.passwordResetToken.deleteMany({ where: { userId: t.userId, id: { not: t.id } } });
    await tx.auditLog.create({ data: { actorId: t.userId, action: "PASSWORD_RESET", targetId: t.userId } });
    return t.userId;
  });
}

async function send(email: string, kind: string, subject: string, text: string, link: string) {
  if (!process.env.SMTP_HOST) {
    console.log(`[email] SMTP_HOST unset; ${kind} link for ${email}: ${link}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject, text });
}

/** Consumes a token. Returns true if it was valid, unused and unexpired. */
export async function consumeVerification(token: string) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.emailVerificationToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!t || t.usedAt || t.expiresAt < new Date()) return false;
    const used = await tx.emailVerificationToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) return false;
    await tx.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
    return true;
  });
}
