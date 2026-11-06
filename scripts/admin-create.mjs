// Usage: npm run admin:create -- --email admin@example.com
// Promotes an existing user to ADMIN, or creates a verified ADMIN with a random password (printed once).
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";

const { values } = parseArgs({ options: { email: { type: "string" } } });
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error("Usage: npm run admin:create -- --email you@example.com");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const existing = await prisma.user.findUnique({ where: { email } });
  let user;
  if (existing) {
    user = await prisma.user.update({ where: { email }, data: { role: "ADMIN", emailVerifiedAt: existing.emailVerifiedAt ?? new Date() } });
    console.log(`Promoted ${email} to ADMIN.`);
  } else {
    const password = randomBytes(18).toString("base64url");
    user = await prisma.user.create({
      data: { email, role: "ADMIN", emailVerifiedAt: new Date(), passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    console.log(`Created ADMIN ${email}\nPassword (shown once): ${password}`);
  }
  await prisma.auditLog.create({ data: { actorId: null, action: "ADMIN_GRANTED_CLI", targetId: user.id, meta: { email } } });
} finally {
  await prisma.$disconnect();
}
