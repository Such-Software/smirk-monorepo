/**
 * Convenience re-export so popup code can `import { jobs } from
 * '../jobs'` rather than reaching into the client module.
 */

import * as client from './client';
export const jobs = client;
export type { JobState } from '../../background/jobs/types';
