// OmniMap — Database Migration Runner
// Applies numbered SQL files from db/migrations/ in order.
// Tracks applied migrations in a migrations table (auto-created).
// Safe to run multiple times — skips already-applied migrations.
//
// Usage:
//   npm run db:migrate
//   DATABASE_URL=postgres://... npm run db:migrate

import * as fs   from 'fs';
import * as path from 'path';
import { Pool }  from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Add it to backend/.env or export it before running.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // required for Supabase
});

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id          SERIAL PRIMARY KEY,
        filename    TEXT UNIQUE NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Collect migration files, sorted numerically
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const filename of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM _migrations WHERE filename = $1',
        [filename],
      );

      if (rows.length > 0) {
        console.log(`  skip  ${filename}`);
        continue;
      }

      console.log(`  apply ${filename} ...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [filename],
        );
        await client.query('COMMIT');
        console.log(`  done  ${filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('\nAll migrations applied.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
