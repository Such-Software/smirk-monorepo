import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const maxHistoryAgeMs = 9 * 60 * 60 * 1000;

function stat(path, label, statFile) {
  try { return statFile(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    // Fixed operation labels and errno names, never file contents or raw errors.
    const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'unclassified I/O error';
    throw new Error(`${label} is unknown: metadata read failed (${code})`);
  }
}

export function readSigningHistory(root = 'C:\\signing', io = { statSync, readFileSync }) {
  if (stat(join(root, 'SIGNING_LOCKED'), 'signing breaker', io.statSync)) {
    throw new Error('signing breaker is tripped; operator recovery is required');
  }
  if (!stat(join(root, 'in'), 'broker queue', io.statSync)?.isDirectory()) {
    throw new Error('broker queue is missing or is not a directory');
  }
  const path = join(root, 'token-state.txt');
  const info = stat(path, 'keepalive history', io.statSync);
  if (!info?.isFile()) throw new Error('keepalive history is missing or is not a file');
  if (info.size > 128) throw new Error('keepalive history is malformed: record is too large');
  try { return io.readFileSync(path, 'utf8'); } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'unclassified I/O error';
    throw new Error(`keepalive history is unknown: read failed (${code})`);
  }
}

export function assessSigningHistory(record, now = Date.now()) {
  const match = typeof record === 'string' && record.trim().match(/^(warm|cold) (\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match || record.length > 128) throw new Error('keepalive history is malformed: expected one state and local timestamp');
  // Fleet's keepalive writes Get-Date -Format s in the host's local time.
  // Do not let Date.parse normalize an impossible calendar date into evidence.
  const [, state, ...parts] = match;
  const [year, month, day, hour, minute, second] = parts.map(Number);
  const stamp = new Date(0);
  stamp.setFullYear(year, month - 1, day);
  stamp.setHours(hour, minute, second, 0);
  if (stamp.getFullYear() !== year || stamp.getMonth() !== month - 1 || stamp.getDate() !== day
      || stamp.getHours() !== hour || stamp.getMinutes() !== minute || stamp.getSeconds() !== second) {
    throw new Error('keepalive history is malformed: invalid calendar timestamp');
  }
  const nextDay = new Date(stamp.getTime() + 24 * 60 * 60 * 1000);
  const repeatedTime = new Date(stamp.getTime() + (nextDay.getTimezoneOffset() - stamp.getTimezoneOffset()) * 60_000);
  if (repeatedTime.getTime() !== stamp.getTime() && repeatedTime.getFullYear() === year
      && repeatedTime.getMonth() === month - 1 && repeatedTime.getDate() === day
      && repeatedTime.getHours() === hour && repeatedTime.getMinutes() === minute) {
    throw new Error('keepalive history age is unknown: ambiguous local timestamp during clock change');
  }
  const ageMs = now - stamp.getTime();
  if (!Number.isFinite(ageMs)) throw new Error('keepalive history age is unknown: invalid observation clock');
  if (ageMs < 0) throw new Error('keepalive history timestamp is in the future');
  if (state !== 'warm') throw new Error('last recorded keepalive was cold; current token login is unknown');
  if (ageMs > maxHistoryAgeMs) throw new Error('last successful keepalive is older than nine hours; current token login is unknown');
  return { lastSuccessfulKeepalive: stamp.toISOString(), ageMs, tokenLogin: 'unknown' };
}

export function observeBroker(run = spawnSync) {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./windows-signing-observe.ps1', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const code = result.error?.code;
    throw new Error(`broker liveness is unknown: metadata observer ${code === 'ETIMEDOUT' ? 'timed out' : code === 'ENOENT' ? 'is unavailable' : 'failed'}`);
  }
  try { return JSON.parse(result.stdout.trim()); } catch {
    throw new Error('broker liveness is unknown: metadata observer returned invalid evidence');
  }
}

export function requireRunningBroker(observation) {
  if (observation?.status !== 'observed') {
    const cause = observation?.cause;
    const errorCode = observation?.errorCode;
    const category = { PermissionDenied: 'permission denied', ObjectNotFound: 'task not found',
      ResourceUnavailable: 'resource unavailable', OperationTimeout: 'query timed out' }[observation?.category];
    const detail = cause === 'query-failed' && Number.isInteger(errorCode)
      ? `ScheduledTasks query failed (${category ? `${category}; ` : ''}HRESULT ${errorCode})`
      : cause === 'identity-mismatch' ? 'named task was not uniquely identified'
        : 'ScheduledTasks metadata was unavailable';
    throw new Error(`broker liveness is unknown: ${detail}`);
  }
  if (observation.state !== 'Running') {
    const state = ['Disabled', 'Queued', 'Ready', 'Unknown'].includes(observation.state) ? observation.state : 'unrecognized';
    throw new Error(`broker is not observed running: task state ${state}`);
  }
  return { brokerLiveness: 'observed-running' };
}

export function preflightWindowsSigning({ readHistory = readSigningHistory, readBroker = observeBroker, now = Date.now() } = {}) {
  const history = assessSigningHistory(readHistory(), now);
  // Reject absent, malformed, future or stale history before querying CIM.
  return { ...history, ...requireRunningBroker(readBroker()) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = preflightWindowsSigning();
    console.log(`preflight: broker observed running; last successful keepalive ${Math.floor(result.ageMs / 60_000)} minutes ago (historical evidence).`);
    console.log('preflight: current token login remains unknown; the shipped artifact must pass signing and signature verification.');
  } catch (error) {
    console.error(`preflight refused: ${error.message}`);
    process.exitCode = 1;
  }
}
