import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { prisma } from "./db";
import { sha256 } from "./crypto";

const DAY = 24 * 60 * 60_000;

/** Replaces any pending token for the user and sends (or logs) a fresh verification link. */
export async function sendVerification(userId: string, email: string) {
  const token = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } }),
    prisma.emailVerificationToken.create({
      data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + DAY) },
    }),
  ]);
  const base = process.env.AUTH_URL ?? "http://localhost:3000";
  const link = `${base}/api/verify?token=${token}`;

  if (!process.env.SMTP_HOST) {
    console.log(`[email] SMTP_HOST unset; verification link for ${email}: ${link}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: "Verify your TheWorldAfterZ account",
    text: `Confirm your email to finish signing up:\n\n${link}\n\nThis link expires in 24 hours and works once.`,
  });
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
