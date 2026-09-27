import type { TestInfo } from '@playwright/test';
export const PRIVATE_USE: Readonly<{ trace: 'off'; screenshot: 'off'; video: 'off' }>;
export function assertPrivateCapture(options?: { trace?: unknown; screenshot?: unknown; video?: unknown }, env?: Record<string, string | undefined>): void;
export function sanitizeTestErrors(testInfo: Pick<TestInfo, 'errors'>): void;
