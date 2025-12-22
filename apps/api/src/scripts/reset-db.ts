import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function resetDatabase() {
  console.log('🔄 Resetting database...');

  if (!config.databaseUrl) {
    console.error('❌ DATABASE_URL is not set!');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseUrl.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  });

  try {
    // 1. Drop and recreate public schema
    console.log('🗑️  Dropping and recreating public schema...');
    await pool.query('DROP SCHEMA public CASCADE;');
    await pool.query('CREATE SCHEMA public;');
    await pool.query('GRANT ALL ON SCHEMA public TO postgres;');
    await pool.query('GRANT ALL ON SCHEMA public TO public;');

    // 2. Read and execute init-db.sql
    const initSqlPath = path.resolve(__dirname, '../../../../scripts/init-db.sql');
    console.log(`📝 Executing ${initSqlPath}...`);
    const initSql = fs.readFileSync(initSqlPath, 'utf8');
    await pool.query(initSql);

    console.log('✅ Database reset successfully!');
  } catch (err) {
    console.error('❌ Database reset failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

resetDatabase();

