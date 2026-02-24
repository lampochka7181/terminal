/**
 * Query On-Chain Fee Revenue
 *
 * Queries the Solana blockchain directly (no DB) to calculate total trading
 * fee revenue collected by the fee recipient USDC ATA.
 *
 * It fetches every transaction that touched the fee recipient ATA, diffs the
 * pre/post USDC token balances, and sums up all positive inflows (= fees).
 *
 * Usage: npx tsx src/scripts/query-fee-revenue.ts
 *   or:  npm run query-fee-revenue
 */

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { config } from '../config.js';

const USDC_DECIMALS = 6;
const USDC_MINT = new PublicKey(config.usdcMint);

// ── helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract the USDC amount (human-readable) that flowed INTO the fee recipient
 * ATA in a single parsed transaction by diffing pre/post token balances.
 */
function extractFeeTransfer(
  tx: ParsedTransactionWithMeta,
  feeRecipientAtaAddress: string,
  feeRecipientWalletAddress: string,
): number {
  let total = 0;

  const preBalances = tx.meta?.preTokenBalances || [];
  const postBalances = tx.meta?.postTokenBalances || [];
  const accountKeys = tx.transaction.message.accountKeys;

  for (const post of postBalances) {
    // Match by ATA address in the account keys list
    const accountAddress = accountKeys[post.accountIndex]?.pubkey.toBase58();
    const isOurAta =
      accountAddress === feeRecipientAtaAddress ||
      post.owner === feeRecipientWalletAddress;

    if (!isOurAta) continue;

    const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');

    // Find the matching pre-balance for the same account index
    const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
    const preAmount = pre
      ? parseFloat(pre.uiTokenAmount.uiAmountString || '0')
      : 0;

    const diff = postAmount - preAmount;
    if (diff > 0) {
      total += diff;
    }
  }

  return total;
}

// ── main ────────────────────────────────────────────────────────────────────

async function queryFeeRevenue() {
  console.log('='.repeat(70));
  console.log('  ON-CHAIN FEE REVENUE REPORT');
  console.log('='.repeat(70));
  console.log('');

  // ── 0. Derive addresses ─────────────────────────────────────────────────
  const feeRecipientWallet = config.feeRecipient
    ? new PublicKey(config.feeRecipient)
    : (() => { throw new Error('FEE_RECIPIENT not set in .env'); })();

  const feeRecipientAta = await getAssociatedTokenAddress(
    USDC_MINT,
    feeRecipientWallet,
  );

  const connection = new Connection(config.solanaRpcUrl, 'confirmed');

  console.log(`  Network:              ${config.solanaNetwork}`);
  console.log(`  RPC:                  ${config.solanaRpcUrl}`);
  console.log(`  Program ID:           ${config.programId}`);
  console.log(`  Fee Wallet:           ${feeRecipientWallet.toBase58()}`);
  console.log(`  Fee Wallet USDC ATA:  ${feeRecipientAta.toBase58()}`);
  console.log(`  USDC Mint:            ${USDC_MINT.toBase58()}`);
  console.log('');

  // ── 1. Current balance ──────────────────────────────────────────────────
  let currentBalance = 0;
  try {
    const balanceInfo = await connection.getTokenAccountBalance(feeRecipientAta);
    currentBalance = balanceInfo.value.uiAmount || 0;
    console.log(`  Current ATA Balance:  ${balanceInfo.value.uiAmountString} USDC`);
  } catch {
    console.log('  Current ATA Balance:  0 USDC (account may not exist yet)');
  }
  console.log('');

  // ── 2. Fetch all tx signatures for the fee ATA ─────────────────────────
  console.log('  Fetching transaction history...');
  const allSignatures: { signature: string; blockTime: number | null | undefined }[] = [];
  let before: string | undefined = undefined;

  while (true) {
    const sigs = await connection.getSignaturesForAddress(feeRecipientAta, {
      before,
      limit: 1000,
    });
    if (sigs.length === 0) break;
    allSignatures.push(
      ...sigs.map(s => ({ signature: s.signature, blockTime: s.blockTime })),
    );
    before = sigs[sigs.length - 1].signature;
    if (sigs.length === 1000) await sleep(500);
  }

  console.log(`  Found ${allSignatures.length} transactions\n`);

  if (allSignatures.length === 0) {
    console.log('  No transactions found for fee recipient. Nothing to report.');
    return;
  }

  // ── 3. Parse transactions and extract fee inflows ──────────────────────
  let totalFeeRevenue = 0;
  let feeCount = 0;
  const feeEntries: {
    date: string;
    timestamp: number;
    amount: number;
    tx: string;
  }[] = [];

  const batchSize = 10;
  const totalBatches = Math.ceil(allSignatures.length / batchSize);

  for (let i = 0; i < allSignatures.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    if (batchNum % 5 === 1 || batchNum === totalBatches) {
      process.stdout.write(`\r  Processing batch ${batchNum}/${totalBatches}...`);
    }

    const batch = allSignatures.slice(i, i + batchSize);
    const txSigs = batch.map(s => s.signature);

    let txs: (ParsedTransactionWithMeta | null)[];
    try {
      txs = await connection.getParsedTransactions(txSigs, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (err: any) {
      // Rate-limited; back off and retry once
      console.warn(`\n  Rate limited at batch ${batchNum}, backing off 2s...`);
      await sleep(2000);
      txs = await connection.getParsedTransactions(txSigs, {
        maxSupportedTransactionVersion: 0,
      });
    }

    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      const sig = batch[j];
      if (!tx || !tx.meta) continue;

      // Skip failed transactions
      if (tx.meta.err) continue;

      const feeAmount = extractFeeTransfer(
        tx,
        feeRecipientAta.toBase58(),
        feeRecipientWallet.toBase58(),
      );
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

    if (i + batchSize < allSignatures.length) await sleep(300);
  }

  console.log('\n');

  // ── 4. Sort chronologically ────────────────────────────────────────────
  feeEntries.sort((a, b) => a.timestamp - b.timestamp);

  // ── 5. Individual transactions ─────────────────────────────────────────
  console.log('-'.repeat(70));
  console.log('  INDIVIDUAL FEE TRANSACTIONS');
  console.log('-'.repeat(70));

  for (const entry of feeEntries) {
    const shortDate = entry.date !== 'unknown'
      ? entry.date.replace('T', ' ').slice(0, 19) + ' UTC'
      : 'unknown';
    const shortTx = entry.tx.slice(0, 16) + '...';
    const amountStr = entry.amount < 0.01
      ? `$${entry.amount.toFixed(6)}`
      : `$${entry.amount.toFixed(2)}`;
    console.log(`  ${shortDate}  ${amountStr.padStart(12)} USDC   tx: ${shortTx}`);
  }

  // ── 6. Daily breakdown ─────────────────────────────────────────────────
  const dailyMap = new Map<string, { count: number; total: number }>();
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
    const rev = data.total < 0.01
      ? `$${data.total.toFixed(6)}`
      : `$${data.total.toFixed(2)}`;
    console.log(
      `  ${day.padEnd(14)} ${String(data.count).padStart(6)}    ${rev.padStart(12)} USDC`,
    );
  }

  // ── 7. Summary ─────────────────────────────────────────────────────────
  const avgFee = feeCount > 0 ? totalFeeRevenue / feeCount : 0;
  const withdrawn = totalFeeRevenue - currentBalance;

  console.log('');
  console.log('='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Total Transactions:     ${allSignatures.length}`);
  console.log(`  Fee-Bearing Trades:     ${feeCount}`);
  console.log(`  Total Fee Revenue:      $${totalFeeRevenue.toFixed(6)} USDC`);
  console.log(`  Average Fee / Trade:    $${avgFee.toFixed(6)} USDC`);
  console.log(`  Current ATA Balance:    $${currentBalance.toFixed(6)} USDC`);
  if (withdrawn > 0.001) {
    console.log(`  Withdrawn / Spent:      $${withdrawn.toFixed(6)} USDC`);
  }
  console.log('='.repeat(70));
}

// ── run ─────────────────────────────────────────────────────────────────────

queryFeeRevenue()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
