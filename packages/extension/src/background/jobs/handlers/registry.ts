/**
 * Registry of all job handlers, keyed by `JobKind`. Add new handlers
 * here as their flows port into the background. The offscreen runner
 * dispatches incoming `run` messages by looking the kind up here.
 */

import type { JobHandler, JobKind } from '../types';
import { bootstrapAuthHandler } from './bootstrap-auth';

export const HANDLERS: { readonly [K in JobKind]: JobHandler<K> } = {
  'bootstrap-auth': bootstrapAuthHandler,
};
