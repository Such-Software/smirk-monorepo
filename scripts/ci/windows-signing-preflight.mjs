import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The Windows broker contract shared with every app signing on this host
// (Mushroom's tools/sign_windows_candidate.mjs uses the same rules): the
// breaker must be clear and both queues must be real directories. Broker and
// token liveness are proven only by the signing step itself, which waits a
// bounded ten minutes for a signed file and verifies its Authenticode
// signature, timestamp and publisher. A timeout refuses and is never retried.
//
// The runner account (NT SERVICE\act_runner) cannot enumerate the scheduled
// task registered to the interactive token owner, so task metadata is not an
// observable signal here; requiring it refused every Windows build (run 10002).

function lstat(path, label, io) {
  try { return io.lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    // Fixed labels and errno names only, never file contents or raw messages.
    const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'unclassified I/O error';
    throw new Error(`${label} cannot be read (${code})`);
  }
}

export function preflightWindowsSigning(root = 'C:\\signing', io = { lstatSync }) {
  if (lstat(join(root, 'SIGNING_LOCKED'), 'signing breaker', io)) {
    throw new Error('signing breaker is tripped; operator recovery is required');
  }
  for (const name of ['in', 'out']) {
    const info = lstat(join(root, name), `broker ${name} queue`, io);
    if (!info) throw new Error(`broker ${name} queue is missing`);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`broker ${name} queue is not a real directory`);
    }
  }
  return { breaker: 'clear', queues: 'present', brokerLiveness: 'proven-only-by-signing' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    preflightWindowsSigning();
    console.log('preflight: breaker clear and broker queues present. Liveness is proven only when the signed artifact returns and verifies.');
  } catch (error) {
    console.error(`preflight refused: ${error.message}`);
    process.exitCode = 1;
  }
}
