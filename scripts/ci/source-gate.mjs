#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredChecks = ['rust', 'typescript', 'openapi-drift', 'secret-scan', 'supply-chain'];

export function requireSourceChecks(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
    throw new Error('Source check dependency evidence is missing');
  }
  for (const name of requiredChecks) {
    if (!Object.hasOwn(needs, name)) throw new Error(`Source check ${name} has no result`);
  }
  for (const [name, check] of Object.entries(needs)) {
    if (check?.result !== 'success') {
      const result = ['failure', 'cancelled', 'skipped'].includes(check?.result) ? check.result : 'missing or invalid';
      throw new Error(`Source check ${name} result is ${result}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let needs;
    try { needs = JSON.parse(process.env.NEEDS_JSON ?? ''); }
    catch { throw new Error('Source check dependency evidence is not valid JSON'); }
    requireSourceChecks(needs);
    console.log('All required source checks passed.');
  } catch (failure) {
    console.error(`source-gate: ${failure.message}`);
    process.exitCode = 1;
  }
}
