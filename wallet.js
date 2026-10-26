// Zero-dependency EVM wallet: keccak256 + secp256k1 address derivation (Node built-ins only).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MASK = (1n << 64n) - 1n;
const rotl = (v, n) => n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK;

function keccakF(s) {
  let R = 1;
  for (let round = 0; round < 24; round++) {
    const C = [], D = [];
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
    for (let i = 0; i < 25; i++) s[i] ^= D[i % 5];
    let x = 1, y = 0, cur = s[1];
    for (let t = 0; t < 24; t++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const tmp = s[x + 5 * y];
      s[x + 5 * y] = rotl(cur, BigInt(((t + 1) * (t + 2) / 2) % 64));
      cur = tmp;
    }
    for (let yy = 0; yy < 5; yy++) {
      const row = s.slice(5 * yy, 5 * yy + 5);
      for (let xx = 0; xx < 5; xx++) s[xx + 5 * yy] = row[xx] ^ ((~row[(xx + 1) % 5] & MASK) & row[(xx + 2) % 5]);
    }
    for (let j = 0; j < 7; j++) {
      R = ((R << 1) ^ ((R >> 7) * 0x71)) % 256;
      if (R & 2) s[0] ^= 1n << BigInt((1 << j) - 1);
    }
  }
}

function keccak256(data) {
  const rate = 136;
  const msg = Buffer.from(data);
  const padLen = rate - (msg.length % rate);
  const padded = Buffer.concat([msg, Buffer.alloc(padLen)]);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

function addressFromPrivateKey(pkHex) {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(pkHex.replace(/^0x/, ''), 'hex'));
  const pub = ecdh.getPublicKey(null, 'uncompressed').subarray(1);
  const addr = keccak256(pub).subarray(12).toString('hex');
  const hash = keccak256(Buffer.from(addr)).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  return out;
}

function withKey(address, pk, created) {
  const o = { address, created };
  Object.defineProperty(o, 'privateKey', { value: pk, enumerable: false }); // never serialized or logged
  return o;
}

// Key sources, in order: AGENT_PRIVATE_KEY env (Railway variable) -> wallet.json in `dir` (local / volume).
function loadOrCreateWallet(dir = __dirname) {
  const envKey = (process.env.AGENT_PRIVATE_KEY || '').trim();
  if (envKey) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(envKey)) throw new Error('AGENT_PRIVATE_KEY must be 32 bytes of hex');
    const pk = '0x' + envKey.replace(/^0x/, '');
    return withKey(addressFromPrivateKey(pk), pk, false);
  }
  const file = path.join(dir, 'wallet.json');
  if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return withKey(j.address, j.privateKey, false); }
  fs.mkdirSync(dir, { recursive: true });
  for (;;) {
    const pk = crypto.randomBytes(32).toString('hex');
    try {
      const address = addressFromPrivateKey(pk);
      fs.writeFileSync(file, JSON.stringify({ address, privateKey: '0x' + pk, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return withKey(address, '0x' + pk, true);
    } catch (e) { /* invalid scalar, retry */ }
  }
}

module.exports = { keccak256, addressFromPrivateKey, loadOrCreateWallet };

if (require.main === module) {
  const w = loadOrCreateWallet(process.env.STATE_DIR || __dirname);
  console.log(w.created ? 'New agent wallet created (key saved to wallet.json, never printed).' : 'Existing wallet found.');
  console.log('Base address:', w.address);
}
