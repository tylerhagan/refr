/**
 * Design tokens. Mirrored 1:1 in src/tokens.css (CSS custom properties) and
 * exposed to Tailwind through @theme in src/index.css. Keep the three in sync.
 */

export interface ColourTokens {
  bg: string;
  surface: string;
  raised: string;
  border: string;
  text: string;
  muted: string;
  /** The single accent: marks the active slot. */
  accent: string;
  /** Foreground on top of the accent. */
  onAccent: string;
  /** Clamp / limit states. */
  warning: string;
}

export const colour: { dark: ColourTokens; light: ColourTokens } = {
  dark: {
    bg: '#0a0b0d',
    surface: '#121417',
    raised: '#1a1d21',
    border: '#272b31',
    text: '#e9ebee',
    muted: '#8a9099',
    accent: '#3ddc97',
    onAccent: '#06130d',
    warning: '#ffb020',
  },
  light: {
    bg: '#f4f5f6',
    surface: '#ffffff',
    raised: '#eceef0',
    border: '#d4d8dd',
    text: '#14161a',
    muted: '#5d646e',
    accent: '#0a9b60',
    onAccent: '#ffffff',
    warning: '#b36b00',
  },
};

export const fontFamily = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  /** Tabular numerals for readouts (LUFS, dB, time). */
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

export const typeScale = {
  xs: { size: '0.75rem', lineHeight: '1rem' },
  sm: { size: '0.875rem', lineHeight: '1.25rem' },
  base: { size: '1rem', lineHeight: '1.5rem' },
  lg: { size: '1.25rem', lineHeight: '1.75rem' },
  xl: { size: '1.75rem', lineHeight: '2rem' },
  readout: { size: '2.5rem', lineHeight: '2.5rem' },
} as const;

export const spacing = {
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  6: '1.5rem',
  8: '2rem',
  12: '3rem',
} as const;

export const radius = {
  sm: '4px',
  md: '8px',
  lg: '14px',
  full: '9999px',
} as const;

/**
 * Haptic names. Reserved for the v1.1 Capacitor build: iOS Safari has no
 * Vibration API, so nothing in the web/PWA build fires these.
 */
export const haptics = {
  flip: 'light',
  loopSet: 'medium',
  blindReveal: 'success',
} as const;

export type HapticName = keyof typeof haptics;
