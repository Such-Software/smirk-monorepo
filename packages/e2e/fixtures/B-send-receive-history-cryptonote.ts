/**
 * Monero and Wownero address surgery for the refusal checks.
 *
 * The wallet must refuse, before signing, a destination whose public key no
 * wallet could hold (crates/smirk-wasm `check_recipient_keys`: the identity
 * point, a small-order point, a key with a torsion component). Such an
 * address is perfectly well-formed: base58, prefix and Keccak checksum all
 * pass, so the Address step accepts it and only the signer can refuse.
 *
 * `withIdentitySpendKey` takes one of the demo wallets' own addresses and
 * swaps its public spend key for the identity point (0x01 then 31 zero
 * bytes), keeping prefix and view key, then re-checksums. `corrupt` changes
 * one character so the checksum fails, the malformed case the Address step
 * refuses by itself.
 *
 * Self-contained (Keccak-256 and Monero's block base58) so the e2e package
 * gains no dependency. `selfTest` checks both against known vectors.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENCODED_BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const FULL_BLOCK = 8;
const FULL_ENCODED = 11;

const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets r[x][y]. */
const ROTATIONS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const rotl = (v: bigint, n: number): bigint => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

function keccakF(state: bigint[]): void {
  const at = (x: number, y: number) => x + 5 * y;
  for (const rc of ROUND_CONSTANTS) {
    const c = [0, 1, 2, 3, 4].map((x) => state[at(x, 0)]! ^ state[at(x, 1)]! ^ state[at(x, 2)]! ^ state[at(x, 3)]! ^ state[at(x, 4)]!);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) state[at(x, y)] = state[at(x, y)]! ^ d;
    }
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[at(y, (2 * x + 3 * y) % 5)] = rotl(state[at(x, y)]!, ROTATIONS[x]![y]!);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[at(x, y)] = b[at(x, y)]! ^ (~b[at((x + 1) % 5, y)]! & MASK64 & b[at((x + 2) % 5, y)]!);
      }
    }
    state[0] = state[0]! ^ rc;
  }
}

/** Original Keccak-256 (Monero's checksum hash, not FIPS SHA3-256). */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]!);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

function encodeBlock(block: Uint8Array): string {
  let n = 0n;
  for (const byte of block) n = (n << 8n) | BigInt(byte);
  const size = ENCODED_BLOCK[block.length]!;
  let out = '';
  for (let i = 0; i < size; i++) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return out;
}

function decodeBlock(text: string): Uint8Array {
  const size = ENCODED_BLOCK.indexOf(text.length);
  if (size <= 0) throw new Error('bad base58 block length');
  let n = 0n;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('character outside base58');
    n = n * 58n + BigInt(v);
  }
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error('base58 block overflow');
  return out;
}

export function cnBase58Encode(bytes: Uint8Array): string {
  let out = '';
  for (let off = 0; off < bytes.length; off += FULL_BLOCK) out += encodeBlock(bytes.subarray(off, off + FULL_BLOCK));
  return out;
}

export function cnBase58Decode(text: string): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let off = 0; off < text.length; off += FULL_ENCODED) parts.push(decodeBlock(text.slice(off, off + FULL_ENCODED)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function varintLength(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length && i < 10; i++) if ((bytes[i]! & 0x80) === 0) return i + 1;
  throw new Error('bad address prefix');
}

/** True when the address decodes and its Keccak checksum matches. */
export function checksumOk(address: string): boolean {
  try {
    const raw = cnBase58Decode(address);
    const payload = raw.subarray(0, raw.length - 4);
    const sum = keccak256(payload);
    return raw.subarray(raw.length - 4).every((b, i) => b === sum[i]);
  } catch {
    return false;
  }
}

/** The same address with its public spend key replaced by the identity point, re-checksummed. */
export function withIdentitySpendKey(address: string): string {
  const raw = cnBase58Decode(address);
  if (!checksumOk(address)) throw new Error('source address does not checksum');
  const prefix = varintLength(raw);
  const payload = raw.slice(0, raw.length - 4);
  payload.fill(0, prefix, prefix + 32);
  payload[prefix] = 0x01;
  const sum = keccak256(payload);
  const out = new Uint8Array(payload.length + 4);
  out.set(payload);
  out.set(sum.subarray(0, 4), payload.length);
  const crafted = cnBase58Encode(out);
  if (!checksumOk(crafted) || crafted.length !== address.length) throw new Error('crafted address did not round-trip');
  return crafted;
}

/** One character changed in the middle: same alphabet and length, failing checksum. */
export function corrupt(address: string): string {
  const i = Math.floor(address.length / 2);
  const ch = address[i]!;
  const swap = ALPHABET[(ALPHABET.indexOf(ch) + 1) % ALPHABET.length]!;
  return address.slice(0, i) + swap + address.slice(i + 1);
}

/** Known vectors: Keccak-256 of the empty string, and a published Monero address round trip. */
export function selfTest(): void {
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (hex(keccak256(new Uint8Array())) !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') {
    throw new Error('keccak self test failed');
  }
  const donation = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
  if (!checksumOk(donation) || cnBase58Encode(cnBase58Decode(donation)) !== donation) {
    throw new Error('base58 self test failed');
  }
  if (checksumOk(corrupt(donation))) throw new Error('corruption self test failed');
}
