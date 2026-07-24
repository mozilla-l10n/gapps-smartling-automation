import { describe, it, expect } from 'vitest';
import { Organize } from './harness.mjs';

describe('Organize.normalizeNameKey', () => {
  it('lowercases the name', () => {
    expect(Organize.normalizeNameKey('MyProject')).toBe('myproject');
  });

  it('collapses runs of non-alphanumeric characters into a single underscore', () => {
    expect(Organize.normalizeNameKey('a - b   c')).toBe('a_b_c');
    expect(Organize.normalizeNameKey('foo___bar')).toBe('foo_bar');
  });

  it('trims leading and trailing underscores', () => {
    expect(Organize.normalizeNameKey('  hello!  ')).toBe('hello');
    expect(Organize.normalizeNameKey('---x---')).toBe('x');
  });

  it('keeps Unicode letters and digits (Smartling filename sanitization)', () => {
    // Accented letters and non-Latin scripts are \p{L} and must survive; only
    // punctuation/whitespace collapses.
    expect(Organize.normalizeNameKey('Café Menu v2')).toBe('café_menu_v2');
    expect(Organize.normalizeNameKey('日本語_test')).toBe('日本語_test');
  });

  it('coerces non-string input', () => {
    expect(Organize.normalizeNameKey(123)).toBe('123');
  });
});
