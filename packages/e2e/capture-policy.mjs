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

export function sanitizeTestErrors(testInfo) {
  for (let i = 0; i < testInfo.errors.length; i++) {
    const location = testInfo.errors[i].location;
    testInfo.errors[i] = {
      message: 'Wallet check failed. Browser call logs, assertion values and page snapshots are withheld because they may contain secrets.',
      ...(location ? { location } : {}),
    };
  }
}
