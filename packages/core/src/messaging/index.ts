/**
 * Messaging plane (identity + encrypted delivery). Default = Nostr NIP-17 DMs
 * over a MessagingProvider seam, discovered from the backend's /capabilities.
 */
export * from './types';
export * from './provider';
export * from './registry';
export * from './dm';
export { NostrMessagingProvider, unwrapDmSecurely, wrapToDirectMessage } from './nostr';
