import { Pool } from 'pg';
import { config } from '../config.js';

async function main(): Promise<void> {
  if (!config.databaseUrl) {
    // eslint-disable-next-line no-console
    console.error('❌ DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseUrl.includes('supabase') ? { rejectUnauthorized: false } : undefined,
    max: 1,
  });

  const client = await pool.connect();
  try {
    // 1) Ensure unique constraint on markets.pubkey exists (drizzle-kit prompts for this)
    const constraintExists = await client.query<{ exists: boolean }>(
      `
      select exists(
        select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'u'
          and n.nspname = current_schema()
          and t.relname = 'markets'
          and c.conname = 'markets_pubkey_unique'
      ) as exists;
      `
    );

    if (!constraintExists.rows[0]?.exists) {
      const dup = await client.query<{ pubkey: string; count: string }>(
        `
        select pubkey, count(*)::text as count
        from markets
        group by pubkey
        having count(*) > 1
        limit 1;
        `
      );

      if (dup.rows.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `❌ Cannot add UNIQUE constraint markets_pubkey_unique. Duplicate pubkey detected: ${dup.rows[0].pubkey} (count=${dup.rows[0].count})`
        );
        process.exit(1);
      }

      // eslint-disable-next-line no-console
      console.log('ℹ️ Adding UNIQUE constraint markets_pubkey_unique on markets(pubkey)...');
      await client.query(`alter table markets add constraint markets_pubkey_unique unique (pubkey);`);
    } else {
      // eslint-disable-next-line no-console
      console.log('✅ UNIQUE constraint markets_pubkey_unique already exists');
    }

    // 2) Performance indexes for hot paths
    // getMarkets({asset,status}) ordered by created_at desc
    // keepers: status+expiry_at, status+strike_price (pending activation)
    const statements = [
      `create index if not exists markets_asset_status_created_at_idx on markets (asset, status, created_at desc);`,
      `create index if not exists markets_status_expiry_at_idx on markets (status, expiry_at);`,
      `create index if not exists markets_status_strike_price_idx on markets (status, strike_price);`,
      // CRITICAL: Partial indexes for getMarkets() default query (excludes SETTLED)
      // These dramatically improve performance as SETTLED markets accumulate
      `create index if not exists idx_markets_not_settled_created on markets (created_at desc) where status != 'SETTLED';`,
      `create index if not exists idx_markets_active_created on markets (status, created_at desc) where status != 'SETTLED';`,
      // Index for pending market activation (strikePrice = '0' indicates pending)
      `create index if not exists idx_markets_pending_activation on markets (status) where status = 'OPEN' and strike_price = '0';`,
    ];

    for (const sql of statements) {
      // eslint-disable-next-line no-console
      console.log(`ℹ️ ${sql}`);
      await client.query(sql);
    }

    // eslint-disable-next-line no-console
    console.log('✅ DB indexes/constraints applied');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ Failed to apply DB indexes:', err);
  process.exit(1);
});






