import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const USDC = new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
const conn = new Connection('https://devnet.helius-rpc.com/?api-key=b4d0d438-5540-455d-a24e-5563f1807102', 'confirmed');
const wallets = JSON.parse(readFileSync(resolve(process.cwd(), 'scripts', 'test-wallets.json'), 'utf8'));

let funded = 0;
const unfunded = [];

for (let i = 0; i < wallets.length; i++) {
  try {
    const ata = await getAssociatedTokenAddress(USDC, new PublicKey(wallets[i].pubkey));
    const bal = await conn.getTokenAccountBalance(ata);
    const amt = parseFloat(bal.value.uiAmountString || '0');
    if (amt >= 1000) funded++;
    else unfunded.push(wallets[i].pubkey);
  } catch {
    unfunded.push(wallets[i].pubkey);
  }
  if (i % 10 === 0) await new Promise(r => setTimeout(r, 300));
}

console.log(`Funded: ${funded} / Unfunded: ${unfunded.length}`);
if (unfunded.length > 0) {
  console.log('Unfunded wallets:');
  unfunded.forEach(w => console.log(`  ${w}`));
}
