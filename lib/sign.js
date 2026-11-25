// 纯 JS secp256k1 签名 + RLP + EIP-155（零依赖），用于私钥钱包本地签名直发
const crypto = require('node:crypto');
const { keccak256 } = require('./keccak');

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const Nn = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n
];

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = P) {
  let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (lo > 1n) { const q = hi / lo; [hi, lo] = [lo, hi - q * lo]; [x1, x0] = [x0, x1 - q * x0]; }
  return mod(x0, m);
}

// Jacobian 坐标点乘
function dbl([X, Y, Z]) {
  if (Y === 0n) return [0n, 1n, 0n];
  const S = mod(4n * X * Y * Y), M = mod(3n * X * X);
  const X3 = mod(M * M - 2n * S), Y3 = mod(M * (S - X3) - 8n * Y * Y * Y * Y), Z3 = mod(2n * Y * Z);
  return [X3, Y3, Z3];
}
function add(p, q) {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1), S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? dbl(p) : [0n, 1n, 0n];
  const H = mod(U2 - U1), R = mod(S2 - S1), H2 = mod(H * H), H3 = mod(H * H2);
  const X3 = mod(R * R - H3 - 2n * U1 * H2), Y3 = mod(R * (U1 * H2 - X3) - S1 * H3), Z3 = mod(H * Z1 * Z2);
  return [X3, Y3, Z3];
}
function mul(k, pt = G) {
  let r = [0n, 1n, 0n], q = [pt[0], pt[1], 1n];
  while (k > 0n) { if (k & 1n) r = add(r, q); q = dbl(q); k >>= 1n; }
  const zi = inv(r[2]);
  return [mod(r[0] * zi * zi), mod(r[1] * zi * zi * zi)];
}

const hex32 = n => n.toString(16).padStart(64, '0');
function privToAddr(pk) {
  const [x, y] = mul(BigInt('0x' + pk.replace(/^0x/, '')));
  return '0x' + keccak256(Buffer.from(hex32(x) + hex32(y), 'hex')).slice(24);
}
function sign(hashHex, pk) {
  const d = BigInt('0x' + pk.replace(/^0x/, ''));
  const z = BigInt('0x' + hashHex);
  while (true) {
    const k = mod(BigInt('0x' + crypto.randomBytes(32).toString('hex')), Nn);
    if (k === 0n) continue;
    const R = mul(k);
    const r = mod(R[0], Nn);
    if (r === 0n) continue;
    let s = mod(inv(k, Nn) * (z + r * d), Nn);
    if (s === 0n) continue;
    let rec = Number(R[1] & 1n) | (R[0] >= Nn ? 2 : 0);
    if (s > Nn / 2n) { s = Nn - s; rec ^= 1; }
    return { r, s, rec };
  }
}

// RLP 编码
const bi = v => { v = BigInt(v); if (v === 0n) return Buffer.alloc(0); let h = v.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
const hb = s => Buffer.from((s || '').replace(/^0x/, ''), 'hex');
function lenp(l, o) {
  if (l < 56) return Buffer.from([o + l]);
  let h = l.toString(16);
  if (h.length % 2) h = '0' + h;
  const b = Buffer.from(h, 'hex');
  return Buffer.concat([Buffer.from([o + 55 + b.length]), b]);
}
function rlp(x) {
  if (Array.isArray(x)) { const b = Buffer.concat(x.map(rlp)); return Buffer.concat([lenp(b.length, 0xc0), b]); }
  if (x.length === 1 && x[0] < 0x80) return x;
  return Buffer.concat([lenp(x.length, 0x80), x]);
}

// 旧式交易 EIP-155（BSC chainId 默认 56）
function signTx(tx, pk, chainId = 56) {
  const f = [bi(tx.nonce), bi(tx.gasPrice), bi(tx.gas), hb(tx.to), bi(tx.value || 0), hb(tx.data || '0x')];
  const h = keccak256(rlp([...f, bi(chainId), Buffer.alloc(0), Buffer.alloc(0)]));
  const { r, s, rec } = sign(h, pk);
  const raw = rlp([...f, bi(BigInt(chainId) * 2n + 35n + BigInt(rec & 1)), bi(r), bi(s)]);
  return { raw: '0x' + raw.toString('hex'), hash: '0x' + keccak256(raw) };
}

function newKey() {
  while (true) {
    const k = crypto.randomBytes(32).toString('hex');
    const n = BigInt('0x' + k);
    if (n > 0n && n < Nn) return k;
  }
}

module.exports = { privToAddr, signTx, newKey, sign };
