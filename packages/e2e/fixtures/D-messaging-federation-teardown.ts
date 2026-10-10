import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Global teardown for the area D live lane: remove this run's wallet profiles
 * (fixtures/D-messaging-federation-live.ts keeps them across worker restarts,
 * keyed by the runner's pid, which is this process). A run that crashes before
 * this point leaves the directory; the next run removes directories whose
 * runner no longer exists.
 */
export default async function teardown(): Promise<void> {
  rmSync(join(tmpdir(), `smirk-e2e-D-run-${process.pid}`), { recursive: true, force: true });
}
