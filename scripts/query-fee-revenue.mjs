/**
 * Query total on-chain fee revenue for the platform.
 * Zero dependencies — uses native Node.js fetch + Solana JSON-RPC directly.
 *
 * The FEE_RECIPIENT in .env is the WALLET address.
 * We derive the USDC ATA via getTokenAccountsByOwner, then sum all
 * positive inflows (= trading fees) from pre/post token balance diffs.
 *
 * Usage: node scripts/query-fee-revenue.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env manually (zero deps) ─────────────────────────────────────────

function loadEnv() {
  try {
    const envPath = resolve(__dirname, '..', '.env');
    const lines = readFileSync(envPath, 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

const env = loadEnv();
const RPC_URL = env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const NETWORK = env.SOLANA_NETWORK || 'devnet';
const PROGRAM_ID = env.PROGRAM_ID || '';
const FEE_RECIPIENT_WALLET = env.FEE_RECIPIENT;
const USDC_MINT = env.USDC_MINT || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

if (!FEE_RECIPIENT_WALLET) {
  console.error('ERROR: FEE_RECIPIENT not found in .env');
  process.exit(1);
}

// ── Solana JSON-RPC helpers ─────────────────────────────────────────────────

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function queryFeeRevenue() {
  console.log('='.repeat(70));
  console.log('  ON-CHAIN FEE REVENUE REPORT');
  console.log('='.repeat(70));
  console.log('');

  // ── 0. Find the fee recipient's USDC ATA via RPC ─────────────────────
  console.log(`  Network:           ${NETWORK}`);
  console.log(`  RPC:               ${RPC_URL}`);
  console.log(`  Program ID:        ${PROGRAM_ID}`);
  console.log(`  Fee Wallet:        ${FEE_RECIPIENT_WALLET}`);
  console.log(`  USDC Mint:         ${USDC_MINT}`);
  console.log('');
  console.log('  Looking up USDC token account for fee wallet...');

  // Use getTokenAccountsByOwner to find the USDC ATA
  const tokenAccounts = await rpc('getTokenAccountsByOwner', [
    FEE_RECIPIENT_WALLET,
    { mint: USDC_MINT },
    { encoding: 'jsonParsed' },
  ]);

  if (!tokenAccounts.value || tokenAccounts.value.length === 0) {
    console.error('  ERROR: No USDC token account found for fee wallet.');
    console.error('  Run setup-fee-recipient first to create the ATA.');
    process.exit(1);
  }

  const feeAta = tokenAccounts.value[0].pubkey;
  const currentBalance =
    tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmountString;

  console.log(`  Fee Wallet ATA:    ${feeAta}`);
  console.log(`  Current Balance:   ${currentBalance} USDC`);
  console.log('');

  // ── 1. Fetch all transaction signatures for the ATA ──────────────────
  console.log('  Fetching transaction history...');
  const allSigs = [];
  let before = undefined;

  while (true) {
    const sigs = await rpc('getSignaturesForAddress', [
      feeAta,
      { before, limit: 1000 },
    ]);
    if (!sigs || sigs.length === 0) break;
    allSigs.push(...sigs);
    before = sigs[sigs.length - 1].signature;
    if (sigs.length === 1000) await sleep(500);
  }

  console.log(`  Found ${allSigs.length} transactions\n`);

  if (allSigs.length === 0) {
    console.log('  No transactions found. Nothing to report.');
    return;
  }

  // ── 2. Parse each transaction to extract fee inflows ─────────────────
  let totalFeeRevenue = 0;
  let feeCount = 0;
  const feeEntries = [];

  // Process in batches of 5 (devnet rate limits are tight)
  const BATCH = 5;
  const totalBatches = Math.ceil(allSigs.length / BATCH);

  for (let i = 0; i < allSigs.length; i += BATCH) {
    const batchNum = Math.floor(i / BATCH) + 1;
    process.stdout.write(`\r  Processing batch ${batchNum}/${totalBatches}...`);

    const batch = allSigs.slice(i, i + BATCH);

    // Fetch transactions in parallel within each batch
    const txPromises = batch.map(sig =>
      rpc('getTransaction', [
        sig.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]).catch(() => null),
    );

    let txResults;
    try {
      txResults = await Promise.all(txPromises);
    } catch {
      // Rate limit — back off
      console.warn(`\n  Rate limited at batch ${batchNum}, waiting 3s...`);
      await sleep(3000);
      txResults = await Promise.all(
        batch.map(sig =>
          rpc('getTransaction', [
            sig.signature,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ]).catch(() => null),
        ),
      );
    }

    for (let j = 0; j < txResults.length; j++) {
      const tx = txResults[j];
      const sig = batch[j];
      if (!tx || !tx.meta) continue;

      // Skip failed txns
      if (tx.meta.err) continue;

      const feeAmount = extractFeeTransfer(tx, feeAta, FEE_RECIPIENT_WALLET);
      if (feeAmount > 0) {
        totalFeeRevenue += feeAmount;
        feeCount++;
        const timestamp = sig.blockTime || 0;
        const date = timestamp
          ? new Date(timestamp * 1000).toISOString()
          : 'unknown';
        feeEntries.push({ date, timestamp, amount: feeAmount, tx: sig.signature });
      }
    }

    if (i + BATCH < allSigs.length) await sleep(400);
  }

  console.log('\n');

  // ── 3. Sort chronologically ──────────────────────────────────────────
  feeEntries.sort((a, b) => a.timestamp - b.timestamp);

  // ── 4. Individual transactions ────────────────────────────────────────
  console.log('-'.repeat(70));
  console.log('  INDIVIDUAL FEE TRANSACTIONS');
  console.log('-'.repeat(70));

  for (const entry of feeEntries) {
    const shortDate =
      entry.date !== 'unknown'
        ? entry.date.replace('T', ' ').slice(0, 19) + ' UTC'
        : 'unknown                ';
    const shortTx = entry.tx.slice(0, 16) + '...';
    const amountStr =
      entry.amount < 0.01
        ? `$${entry.amount.toFixed(6)}`
        : `$${entry.amount.toFixed(2)}`;
    console.log(
      `  ${shortDate}  ${amountStr.padStart(12)} USDC   tx: ${shortTx}`,
    );
  }

  // ── 5. Daily breakdown ────────────────────────────────────────────────
  const dailyMap = new Map();
  for (const entry of feeEntries) {
    const day = entry.date !== 'unknown' ? entry.date.slice(0, 10) : 'unknown';
    const existing = dailyMap.get(day) || { count: 0, total: 0 };
    existing.count++;
    existing.total += entry.amount;
    dailyMap.set(day, existing);
  }

  console.log('');
  console.log('-'.repeat(70));
  console.log('  DAILY BREAKDOWN');
  console.log('-'.repeat(70));
  console.log('  Date          Trades    Revenue');
  console.log('  ' + '-'.repeat(40));

  for (const [day, data] of [...dailyMap.entries()].sort()) {
    const rev =
      data.total < 0.01
        ? `$${data.total.toFixed(6)}`
        : `$${data.total.toFixed(2)}`;
    console.log(
      `  ${day.padEnd(14)} ${String(data.count).padStart(6)}    ${rev.padStart(12)} USDC`,
    );
  }

  // ── 6. Summary ────────────────────────────────────────────────────────
  const avgFee = feeCount > 0 ? totalFeeRevenue / feeCount : 0;
  const currentNum = parseFloat(currentBalance) || 0;
  const withdrawn = totalFeeRevenue - currentNum;

  console.log('');
  console.log('='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Total Transactions:     ${allSigs.length}`);
  console.log(`  Fee-Bearing Trades:     ${feeCount}`);
  console.log(`  Total Fee Revenue:      $${totalFeeRevenue.toFixed(6)} USDC`);
  console.log(`  Average Fee / Trade:    $${avgFee.toFixed(6)} USDC`);
  console.log(`  Current ATA Balance:    $${currentNum.toFixed(6)} USDC`);
  if (withdrawn > 0.001) {
    console.log(`  Withdrawn / Spent:      $${withdrawn.toFixed(6)} USDC`);
  }
  console.log('='.repeat(70));
}

// ── Fee extraction ──────────────────────────────────────────────────────────

/**
 * Extract the USDC amount (human-readable) transferred INTO the fee recipient
 * ATA in a single parsed transaction by diffing pre/post token balances.
 */
function extractFeeTransfer(tx, feeAtaAddress, feeWalletAddress) {
  let total = 0;
  const preBalances = tx.meta?.preTokenBalances || [];
  const postBalances = tx.meta?.postTokenBalances || [];
  const accountKeys = tx.transaction?.message?.accountKeys || [];

  for (const post of postBalances) {
    // Match by ATA address in account keys, OR by owner wallet
    const accountKey = accountKeys[post.accountIndex]?.pubkey;
    const isOurAta =
      accountKey === feeAtaAddress || post.owner === feeWalletAddress;

    if (!isOurAta) continue;

    const postAmount = parseFloat(post.uiTokenAmount?.uiAmountString || '0');
    const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
    const preAmount = pre
      ? parseFloat(pre.uiTokenAmount?.uiAmountString || '0')
      : 0;

    const diff = postAmount - preAmount;
    if (diff > 0) {
      total += diff;
    }
  }

  return total;
}

// ── Run ─────────────────────────────────────────────────────────────────────

queryFeeRevenue()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
