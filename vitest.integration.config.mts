import { defineConfig } from "vitest/config";

// Needs a migrated Postgres at DATABASE_URL; see .gitea/workflows/ci.yml for the env it expects.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["tests/integration/**/*.int.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    server: { deps: { inline: ["next-auth"] } },
  },
});
