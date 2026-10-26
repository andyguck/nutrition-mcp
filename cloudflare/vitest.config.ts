import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        ALLOWED_EMAILS: 'alice@example.com,bob@example.com',
      },
    },
  })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 30000 },
}));
