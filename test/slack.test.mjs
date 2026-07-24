import { describe, it, expect } from 'vitest';
import { SlackCommand } from './harness.mjs';

describe('SlackCommand.constantTimeEquals', () => {
  it('returns true for identical strings', () => {
    expect(SlackCommand.constantTimeEquals('secret', 'secret')).toBe(true);
  });

  it('returns false for same-length strings that differ', () => {
    expect(SlackCommand.constantTimeEquals('secret', 'secreT')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(SlackCommand.constantTimeEquals('secret', 'secret1')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(SlackCommand.constantTimeEquals('', '')).toBe(true);
  });
});
