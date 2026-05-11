import type { Theme } from './types';

/**
 * Default theme — the dark Bauhaus look the v0.3 popup ships with.
 * Acts as the fallback when no theme is set or a partial theme is
 * applied (missing tokens inherit from here).
 */
export const defaultTheme: Theme = {
  id: 'default',
  name: 'Smirk Dark',
  description: 'The default Smirk look — dark, calm, ceramic.',
  tokens: {
    bg: '#0e0e10',
    bgElevated: '#1a1a1d',
    bgSunken: 'rgba(255,255,255,0.03)',
    fg: '#f5f5f5',
    fgMuted: '#6b7280',
    accent: '#8b5cf6',
    accentHover: '#7c4ddc',
    accentFg: '#ffffff',
    border: 'rgba(255,255,255,0.08)',
    borderStrong: 'rgba(255,255,255,0.16)',
    positive: '#22c55e',
    negative: '#ef4444',
    warning: '#f59e0b',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontFamilyMono: "'SF Mono', Monaco, 'Cascadia Code', monospace",
    fontSizeBase: '14px',
    fontSizeSmall: '12px',
    radius: '8px',
    radiusSm: '4px',
    radiusLg: '12px',
    shadowRaised: 'none',
    shadowSunken: 'none',
  },
};
