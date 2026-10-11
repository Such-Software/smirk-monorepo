/** Wallet tests may display or enter secrets. This suite has no capture lane. */
export const PRIVATE_USE = Object.freeze({ trace: 'off', screenshot: 'off', video: 'off' });

export function assertPrivateCapture(options = {}, env = process.env) {
  for (const name of ['CAPTURE_VIDEO', 'MARKETING_SHOTS']) {
    const value = (env[name] ?? '').trim().toLowerCase();
    if (!['', '0', 'off', 'false', 'no'].includes(value)) {
      throw new Error(`${name} is unavailable in wallet E2E. Use a separately reviewed secret-free demo fixture.`);
    }
  }
  if (env.DEBUG || env.PWDEBUG) {
    throw new Error('Wallet E2E refuses debug logging because browser call logs may contain secrets.');
  }
  for (const name of ['trace', 'screenshot', 'video']) {
    const value = options[name];
    const mode = value && typeof value === 'object' ? value.mode : value;
    if (mode !== undefined && mode !== 'off') {
      throw new Error(`Wallet E2E requires ${name} off, including failure capture.`);
    }
  }
}

/**
 * The source position an error points at, as `file:line`: its location, else
 * the first stack frame in this suite's own code. Only frame lines are read
 * (the message lines before them may hold values), and only a file name and a
 * line number come out, so the result can be printed by the private reporter.
 */
export function failureSite(error) {
  const location = error?.location;
  if (location?.file && Number.isInteger(location.line)) return `${location.file.split(/[\\/]/).pop()}:${location.line}`;
  for (const line of String(error?.stack ?? '').split('\n')) {
    if (!/^\s*at\s/.test(line) || /node_modules|node:|playwright-core/.test(line)) continue;
    const frame = line.match(/([\w.-]+\.(?:ts|mts|mjs|js)):(\d+):\d+\)?\s*$/);
    if (frame) return `${frame[1]}:${frame[2]}`;
  }
  return null;
}

export function sanitizeTestErrors(testInfo) {
  const sites = [];
  for (let i = 0; i < testInfo.errors.length; i++) {
    const location = testInfo.errors[i].location;
    const site = failureSite(testInfo.errors[i]);
    if (site && !sites.includes(site)) sites.push(site);
    testInfo.errors[i] = {
      message: 'Wallet check failed. Browser call logs, assertion values and page snapshots are withheld because they may contain secrets.',
      ...(location ? { location } : {}),
    };
  }
  // The reporter prints these source positions; the stack itself is dropped.
  if (sites.length && Array.isArray(testInfo.annotations)) {
    testInfo.annotations.push({ type: 'failed-at', description: sites.join(', ') });
  }
}
