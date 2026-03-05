const { Connection, PublicKey } = require('@solana/web3.js');
const { createHash } = require('crypto');

async function main() {
  const PROGRAM_ID = new PublicKey('5Kq43SR2HUNsyNZWaau1p8kQzAvW2UA2mAvempdchTrk');
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  const [globalStatePda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PROGRAM_ID
  );

  console.log('GlobalState PDA:', globalStatePda.toBase58());
  console.log('Expected bump:', bump);

  const accountInfo = await connection.getAccountInfo(globalStatePda);

  if (!accountInfo) {
    console.log('ERROR: GlobalState account does not exist!');
    return;
  }

  console.log('');
  console.log('=== Account Info ===');
  console.log('Owner:', accountInfo.owner.toBase58());
  console.log('Data length:', accountInfo.data.length, 'bytes');
  console.log('Expected (current code): 202 bytes');
  console.log('Expected (audit code): 266 bytes');

  const expectedDisc = createHash('sha256').update('account:GlobalState').digest().slice(0, 8);
  const actualDisc = accountInfo.data.slice(0, 8);
  console.log('');
  console.log('=== Discriminator ===');
  console.log('Expected:', Buffer.from(expectedDisc).toString('hex'));
  console.log('Actual:  ', Buffer.from(actualDisc).toString('hex'));
  console.log('Match:', Buffer.from(expectedDisc).equals(actualDisc));

  const data = accountInfo.data;
  console.log('');
  console.log('=== Raw hex (first 80 bytes) ===');
  console.log(data.slice(0, 80).toString('hex'));

  if (data.length >= 202) {
    let offset = 8;
    const admin = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const feeRecipient = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const makerFeeBps = data.readUInt16LE(offset); offset += 2;
    const takerFeeBps = data.readUInt16LE(offset); offset += 2;
    const paused = data[offset] !== 0; offset += 1;
    offset += 100;
    const pausedAt = Number(data.readBigInt64LE(offset)); offset += 8;
    const totalMarkets = Number(data.readBigUInt64LE(offset)); offset += 8;
    const totalVolume = Number(data.readBigUInt64LE(offset)); offset += 8;
    const bumpVal = data[offset]; offset += 1;
    
    console.log('');
    console.log('=== Parsed (202-byte layout) ===');
    console.log('admin:', admin.toBase58());
    console.log('feeRecipient:', feeRecipient.toBase58());
    console.log('makerFeeBps:', makerFeeBps);
    console.log('takerFeeBps:', takerFeeBps);
    console.log('paused:', paused);
    console.log('totalMarkets:', totalMarkets);
    console.log('totalVolume:', totalVolume);
    console.log('bump:', bumpVal);
    console.log('PDA bump:', bump);
    console.log('Bump match:', bumpVal === bump);
  }
  
  if (data.length > 202) {
    console.log('');
    console.log('!!! MISMATCH: Account has', data.length, 'bytes but code expects 202 bytes');
    console.log('Extra bytes:', data.length - 202);
    console.log('This is likely the root cause of error 3003!');
  } else if (data.length === 202) {
    console.log('');
    console.log('Account size matches expected 202 bytes - discriminator or data issue');
  }
}
main().catch(console.error);
