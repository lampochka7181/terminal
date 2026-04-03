/**
 * MCP Regression Test Runner
 * Runs every order scenario and records results to JSON.
 * Run: node test_regression.mjs > regression_results.json
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const PREFIX_BYTES = Uint8Array.from([68,84,95,79,82,68,69,82,95,86,49]);
const rotr = (v,s) => (v>>>s)|(v<<(32-s));
const add32 = (...vs) => { let r=0; for(const v of vs) r=(r+v)>>>0; return r; };
const bytesToHex = b => { let o=''; for(let i=0;i<b.length;i++) o+=b[i].toString(16).padStart(2,'0'); return o; };
const encodeAscii = t => { const b=new Uint8Array(t.length); for(let i=0;i<t.length;i++) b[i]=t.charCodeAt(i); return b; };
function sha256(msg) {
  const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const bl=msg.length*8,pl=(((msg.length+9+63)>>6)<<6);
  const padded=new Uint8Array(pl);padded.set(msg);padded[msg.length]=0x80;
  const view=new DataView(padded.buffer);
  view.setUint32(pl-8,Math.floor(bl/0x100000000),false);view.setUint32(pl-4,bl>>>0,false);
  const w=new Uint32Array(64);
  for(let o=0;o<padded.length;o+=64){
    for(let i=0;i<16;i++) w[i]=view.getUint32(o+i*4,false);
    for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=add32(w[i-16],s0,w[i-7],s1);}
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g),t1=add32(h,S1,ch,K[i],w[i]),S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c),t2=add32(S0,maj);h=g;g=f;f=e;e=add32(d,t1);d=c;c=b;b=a;a=add32(t1,t2);}
    H[0]=add32(H[0],a);H[1]=add32(H[1],b);H[2]=add32(H[2],c);H[3]=add32(H[3],d);H[4]=add32(H[4],e);H[5]=add32(H[5],f);H[6]=add32(H[6],g);H[7]=add32(H[7],h);
  }
  const out=new Uint8Array(32);const ov=new DataView(out.buffer);for(let i=0;i<8;i++) ov.setUint32(i*4,H[i],false);return out;
}
function buildBinaryMessage({marketAddress,walletAddress,side,outcome,orderType,price,size,expiryTs,clientOrderId}) {
  const mkt=new PublicKey(marketAddress).toBytes(),own=new PublicKey(walletAddress).toBytes();
  const ctx=new Uint8Array(PREFIX_BYTES.length+32+32+32+3);
  let off=0;ctx.set(PREFIX_BYTES,off);off+=PREFIX_BYTES.length;ctx.set(mkt,off);off+=32;ctx.set(own,off);off+=32;ctx.set(own,off);off+=32;
  ctx[off++]=side==='BID'?0:1;ctx[off++]=outcome==='YES'?0:1;ctx[off++]=orderType==='LIMIT'?0:orderType==='MARKET'?1:2;
  const ctxHash=bytesToHex(sha256(ctx));
  const text=['DT_ORDER_V1','ctx='+ctxHash,'p='+BigInt(Math.floor(price*1000000)),'s='+BigInt(Math.floor(size*1000000)),'e='+BigInt(expiryTs),'c='+BigInt(clientOrderId)].join('\n');
  return Buffer.from(encodeAscii(text)).toString('base64');
}

const PRIVATE_KEY = 'dy1jm6yprdagjpfsVF6J8N6AaGoZNyA7dh85r5JE2esXbieNgve91W5LTwkezEQchemo8amsPunjvWbvHrZDnJX';
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletAddress = keypair.publicKey.toBase58();

// Auth
const {nonce} = await (await fetch('http://localhost:4000/auth/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:walletAddress})})).json();
const nonceSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(nonce),keypair.secretKey));
const authResult = await (await fetch('http://localhost:4000/auth/agent/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:walletAddress,signature:nonceSig,message:nonce,agentName:'mcp-regression'})})).json();
const TOKEN = authResult.token;
const H = {'Content-Type':'application/json','Authorization':'Bearer '+TOKEN};

const results = { wallet: walletAddress, runAt: new Date().toISOString(), scenarios: [] };

async function placeOrder({marketAddress,side,outcome,type,price,size,dollarAmount}) {
  await new Promise(r=>setTimeout(r,80));
  const cid=Date.now(), exp=Math.floor(Date.now()/1000)+3600;
  const canonicalSize=(type==='market'&&side==='bid'&&dollarAmount)?dollarAmount:size;
  const bm=buildBinaryMessage({marketAddress,walletAddress,side:side.toUpperCase(),outcome:outcome.toUpperCase(),orderType:type.toUpperCase(),price,size:canonicalSize,expiryTs:exp,clientOrderId:cid});
  const sig=bs58.encode(nacl.sign.detached(Buffer.from(bm,'base64'),keypair.secretKey));
  const r=await fetch('http://localhost:4000/orders/notify',{method:'POST',headers:H,body:JSON.stringify({marketAddress,side,outcome,type,price,size,dollarAmount,expiry:exp,clientOrderId:cid,signature:sig,binaryMessage:bm})});
  return {httpStatus:r.status, body:await r.json()};
}

async function cancelOrder(orderId) {
  const sig=bs58.encode(nacl.sign.detached(new TextEncoder().encode('cancel:'+orderId),keypair.secretKey));
  const r=await fetch('http://localhost:4000/orders/'+orderId,{method:'DELETE',headers:H,body:JSON.stringify({signature:sig})});
  return {httpStatus:r.status, body:await r.json()};
}

async function getMarkets() {
  const all = await (await fetch('http://localhost:4000/markets')).json();
  return {
    liquid1m: all.filter(m=>m.status==='OPEN'&&m.timeframe==='1m'&&parseFloat(m.yesPrice||0)!==0.5&&m.strike!==0),
    liquid5m: all.filter(m=>m.status==='OPEN'&&m.timeframe==='5m'&&parseFloat(m.yesPrice||0)!==0.5&&m.strike!==0),
    all,
  };
}

function log(scenario, result) {
  results.scenarios.push({scenario, ...result, ts: new Date().toISOString()});
  process.stderr.write(`[${scenario}] HTTP ${result.httpStatus} status=${result.body?.status||result.body?.error?.code||'?'}\n`);
}

// ─── TC-01: Market BUY YES on 5m ───────────────────────────────────────────
{
  const {liquid5m} = await getMarkets();
  const m = liquid5m[0];
  if(m) {
    const r = await placeOrder({marketAddress:m.address,side:'bid',outcome:'yes',type:'market',price:0.99,size:20,dollarAmount:10});
    log('TC-01: market-buy-yes-5m', {marketAddress:m.address,yesPrice:m.yesPrice,...r});
  } else {
    log('TC-01: market-buy-yes-5m', {httpStatus:0,body:{error:{code:'NO_LIQUID_MARKET'}}});
  }
}

// ─── TC-02: Market BUY NO on 5m ────────────────────────────────────────────
{
  const {liquid5m} = await getMarkets();
  const m = liquid5m[0];
  if(m) {
    const r = await placeOrder({marketAddress:m.address,side:'bid',outcome:'no',type:'market',price:0.99,size:20,dollarAmount:10});
    log('TC-02: market-buy-no-5m', {marketAddress:m.address,noPrice:m.noPrice,...r});
  } else {
    log('TC-02: market-buy-no-5m', {httpStatus:0,body:{error:{code:'NO_LIQUID_MARKET'}}});
  }
}

// ─── TC-03: Market BUY YES on 1m ───────────────────────────────────────────
{
  const {liquid1m} = await getMarkets();
  const m = liquid1m[0];
  if(m) {
    const r = await placeOrder({marketAddress:m.address,side:'bid',outcome:'yes',type:'market',price:0.99,size:20,dollarAmount:10});
    log('TC-03: market-buy-yes-1m', {marketAddress:m.address,yesPrice:m.yesPrice,...r});
  } else {
    log('TC-03: market-buy-yes-1m', {httpStatus:0,body:{error:{code:'NO_LIQUID_MARKET'}}});
  }
}

// ─── TC-04: Market BUY NO on 1m ────────────────────────────────────────────
{
  const {liquid1m} = await getMarkets();
  const m = liquid1m[0];
  if(m) {
    const r = await placeOrder({marketAddress:m.address,side:'bid',outcome:'no',type:'market',price:0.99,size:20,dollarAmount:10});
    log('TC-04: market-buy-no-1m', {marketAddress:m.address,noPrice:m.noPrice,...r});
  } else {
    log('TC-04: market-buy-no-1m', {httpStatus:0,body:{error:{code:'NO_LIQUID_MARKET'}}});
  }
}

// ─── TC-05: Limit BUY YES on 5m (resting — price well below market) ────────
{
  const {liquid5m} = await getMarkets();
  const m = liquid5m[0];
  if(m) {
    const r = await placeOrder({marketAddress:m.address,side:'bid',outcome:'yes',type:'limit',price:0.10,size:60});
    log('TC-05: limit-buy-yes-5m-resting', {marketAddress:m.address,...r});
    // Cancel it if it rested
    if(r.body?.orderId && r.body?.status==='open') {
      const cr = await cancelOrder(r.body.orderId);
      log('TC-05b: cancel-resting-limit', {orderId:r.body.orderId,...cr});
    }
  } else {
    log('TC-05: limit-buy-yes-5m-resting', {httpStatus:0,body:{error:{code:'NO_LIQUID_MARKET'}}});
  }
}

// ─── TC-06: Limit BUY YES on 5m (crossing — price above best ask) ──────────
{
  const {liquid5m} = await getMarkets();
  const m = liquid5m[0];
  if(m) {
    const r = await placeOrder({marketAddress:m.address,side:'bid',outcome:'yes',type:'limit',price:0.90,size:60});
    log('TC-06: limit-buy-yes-5m-crossing', {marketAddress:m.address,...r});
  } else {
    log('TC-06: limit-buy-yes-5m-crossing', {httpStatus:0,body:{error:{code:'NO_LIQUID_MARKET'}}});
  }
}

// ─── TC-07: Market SELL YES on 5m (wait 8s for confirm) ────────────────────
{
  process.stderr.write('[TC-07] Waiting 8s for on-chain confirmation before sell...\n');
  await new Promise(r=>setTimeout(r,8000));
  const {liquid5m} = await getMarkets();
  const m = liquid5m[0];
  const pos = await (await fetch('http://localhost:4000/user/positions',{headers:H})).json();
  const yesPos = m && pos.find(p=>p.marketAddress===m.address&&p.yesShares>0.001);
  if(yesPos) {
    const sellSz = Math.floor(yesPos.yesShares*100)/100;
    const r = await placeOrder({marketAddress:m.address,side:'ask',outcome:'yes',type:'market',price:0.01,size:sellSz});
    log('TC-07: market-sell-yes-5m', {marketAddress:m.address,sharesHeld:yesPos.yesShares,sellSize:sellSz,...r});
  } else {
    log('TC-07: market-sell-yes-5m', {httpStatus:0,body:{error:{code:'NO_CONFIRMED_YES_POSITION',detail:m?'market found but no confirmed shares':'no liquid 5m market'}}});
  }
}

// ─── TC-08: Market SELL NO on 5m ───────────────────────────────────────────
{
  const {liquid5m} = await getMarkets();
  const m = liquid5m[0];
  const pos = await (await fetch('http://localhost:4000/user/positions',{headers:H})).json();
  const noPos = m && pos.find(p=>p.marketAddress===m.address&&p.noShares>0.001);
  if(noPos) {
    const sellSz = Math.floor(noPos.noShares*100)/100;
    const r = await placeOrder({marketAddress:m.address,side:'ask',outcome:'no',type:'market',price:0.01,size:sellSz});
    log('TC-08: market-sell-no-5m', {marketAddress:m.address,sharesHeld:noPos.noShares,...r});
  } else {
    log('TC-08: market-sell-no-5m', {httpStatus:0,body:{error:{code:'NO_CONFIRMED_NO_POSITION',detail:'no confirmed NO shares — tx may be PENDING or FAILED'}}});
  }
}

// ─── TC-09: Market SELL YES on 1m ──────────────────────────────────────────
{
  const {liquid1m} = await getMarkets();
  const m = liquid1m[0];
  const pos = await (await fetch('http://localhost:4000/user/positions',{headers:H})).json();
  const yesPos = m && pos.find(p=>p.marketAddress===m.address&&p.yesShares>0.001);
  if(yesPos) {
    const sellSz = Math.floor(yesPos.yesShares*100)/100;
    const r = await placeOrder({marketAddress:m.address,side:'ask',outcome:'yes',type:'market',price:0.01,size:sellSz});
    log('TC-09: market-sell-yes-1m', {marketAddress:m.address,...r});
  } else {
    log('TC-09: market-sell-yes-1m', {httpStatus:0,body:{error:{code:'NO_CONFIRMED_YES_POSITION_1M'}}});
  }
}

// ─── TC-10: Market SELL NO on 1m ───────────────────────────────────────────
{
  const {liquid1m} = await getMarkets();
  const m = liquid1m[0];
  const pos = await (await fetch('http://localhost:4000/user/positions',{headers:H})).json();
  const noPos = m && pos.find(p=>p.marketAddress===m.address&&p.noShares>0.001);
  if(noPos) {
    const sellSz = Math.floor(noPos.noShares*100)/100;
    const r = await placeOrder({marketAddress:m.address,side:'ask',outcome:'no',type:'market',price:0.01,size:sellSz});
    log('TC-10: market-sell-no-1m', {marketAddress:m.address,...r});
  } else {
    log('TC-10: market-sell-no-1m', {httpStatus:0,body:{error:{code:'NO_CONFIRMED_NO_POSITION_1M'}}});
  }
}

// ─── TC-11: cancel_all_orders ──────────────────────────────────────────────
{
  // First place two resting limits
  const {liquid5m,liquid1m} = await getMarkets();
  const m = liquid5m[0] || liquid1m[0];
  const placedIds = [];
  if(m) {
    await new Promise(r=>setTimeout(r,80));
    const r1 = await placeOrder({marketAddress:m.address,side:'bid',outcome:'yes',type:'limit',price:0.05,size:60});
    if(r1.body?.orderId&&r1.body?.status==='open') placedIds.push(r1.body.orderId);
    await new Promise(r=>setTimeout(r,80));
    const r2 = await placeOrder({marketAddress:m.address,side:'bid',outcome:'no',type:'limit',price:0.05,size:60});
    if(r2.body?.orderId&&r2.body?.status==='open') placedIds.push(r2.body.orderId);
  }
  const cr = await fetch('http://localhost:4000/orders',{method:'DELETE',headers:H});
  const cd = await cr.json();
  log('TC-11: cancel-all-orders', {httpStatus:cr.status,body:cd,placedBeforeCancel:placedIds.length,cancelledCount:cd.cancelledCount});
}

// ─── TC-12: cancel_all_orders filtered by market ──────────────────────────
{
  const {liquid5m,liquid1m} = await getMarkets();
  const m = liquid5m[0]||liquid1m[0];
  if(m) {
    await new Promise(r=>setTimeout(r,80));
    await placeOrder({marketAddress:m.address,side:'bid',outcome:'yes',type:'limit',price:0.05,size:60});
    const cr = await fetch('http://localhost:4000/orders?marketAddress='+m.address,{method:'DELETE',headers:H});
    const cd = await cr.json();
    log('TC-12: cancel-all-by-market', {httpStatus:cr.status,body:cd,marketAddress:m.address});
  } else {
    log('TC-12: cancel-all-by-market', {httpStatus:0,body:{error:{code:'NO_LIQUID_MARKET'}}});
  }
}

// ─── Final snapshot ────────────────────────────────────────────────────────
const bal = await (await fetch('http://localhost:4000/user/balance',{headers:H})).json();
const pos = await (await fetch('http://localhost:4000/user/positions',{headers:H})).json();
const trades = await (await fetch('http://localhost:4000/user/trades?limit=20',{headers:H})).json();
const openOrds = await (await fetch('http://localhost:4000/user/orders?status=open',{headers:H})).json();

results.finalState = {
  balance: bal,
  positions: pos,
  recentTrades: trades.transactions?.slice(0,10),
  openOrders: openOrds.orders,
};

console.log(JSON.stringify(results, null, 2));
