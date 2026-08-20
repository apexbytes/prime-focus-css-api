import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

loadDotenv({ quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL must be set to run drizzle-kit');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
