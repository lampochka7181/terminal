import type { Config } from 'drizzle-kit';
import dotenv from 'dotenv';
import path from 'path';

// Load root .env (repo/.env) so drizzle-kit has DATABASE_URL in dev under pnpm -C apps/api
// Use process.cwd() to avoid ESM/CJS interop issues in drizzle-kit config loading.
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL || '',
  },
} satisfies Config;







