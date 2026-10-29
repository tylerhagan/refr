import { describe, expect, it } from 'vitest';
import { colour, haptics } from './tokens';

describe('tokens', () => {
  it('defines matching dark and light colour keys', () => {
    expect(Object.keys(colour.dark)).toEqual(Object.keys(colour.light));
  });

  it('maps haptic names', () => {
    expect(haptics.flip).toBe('light');
  });
});
