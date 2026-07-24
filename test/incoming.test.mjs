import { describe, it, expect } from 'vitest';
import { Incoming } from './harness.mjs';

describe('Incoming.trimTrailingEmptyCells', () => {
  it('drops trailing empty and whitespace-only cells', () => {
    expect(Incoming.trimTrailingEmptyCells(['a', 'b', '', '  '])).toEqual([
      'a',
      'b'
    ]);
  });

  it('preserves empty cells that are not trailing', () => {
    expect(Incoming.trimTrailingEmptyCells(['a', '', 'c', ''])).toEqual([
      'a',
      '',
      'c'
    ]);
  });

  it('returns an empty array when every cell is empty', () => {
    expect(Incoming.trimTrailingEmptyCells(['', ' '])).toEqual([]);
  });
});

describe('Incoming.cleanDirectiveRows', () => {
  it('strips trailing commas only from directive (#) rows', () => {
    const input = '#directive,,\nfoo,bar,\n#other,';
    expect(Incoming.cleanDirectiveRows(input)).toBe(
      '#directive\nfoo,bar,\n#other'
    );
  });

  it('leaves non-directive rows untouched', () => {
    expect(Incoming.cleanDirectiveRows('a,b,\nc,d,')).toBe('a,b,\nc,d,');
  });
});

describe('Incoming.isDefaultForegroundColor', () => {
  it('treats null/undefined as default', () => {
    expect(Incoming.isDefaultForegroundColor(null)).toBe(true);
    expect(Incoming.isDefaultForegroundColor(undefined)).toBe(true);
  });

  it('recognizes the known default colors (case/space-insensitive)', () => {
    expect(Incoming.isDefaultForegroundColor('')).toBe(true);
    expect(Incoming.isDefaultForegroundColor('#000000')).toBe(true);
    expect(Incoming.isDefaultForegroundColor('  #000  ')).toBe(true);
  });

  it('flags any other color as non-default', () => {
    expect(Incoming.isDefaultForegroundColor('#FFFFFF')).toBe(false);
    expect(Incoming.isDefaultForegroundColor('#ff0000')).toBe(false);
  });
});

describe('Incoming.summarizeFormattingErrors', () => {
  it('reports the count and a per-row preview', () => {
    expect(
      Incoming.summarizeFormattingErrors([{ row: 2, issues: ['bold'] }])
    ).toBe('1 issue(s) - row 2 [bold]');
  });

  it('truncates the preview to 5 rows and notes the remainder', () => {
    const errors = Array.from({ length: 6 }, (_, i) => ({
      row: i + 1,
      issues: ['bold']
    }));
    const summary = Incoming.summarizeFormattingErrors(errors);
    expect(summary.startsWith('6 issue(s) - ')).toBe(true);
    expect(summary.endsWith('; and 1 more')).toBe(true);
  });
});

describe('Incoming.summarizeCharLimitWarnings', () => {
  it('summarizes an over-limit warning', () => {
    expect(
      Incoming.summarizeCharLimitWarnings([
        { row: 3, severity: 'over', enLength: 50, limit: 40 }
      ])
    ).toBe('1 over limit: row 3 over limit (50/40)');
  });

  it('splits the counts between over and near limit', () => {
    const summary = Incoming.summarizeCharLimitWarnings([
      { row: 3, severity: 'over', enLength: 50, limit: 40 },
      { row: 4, severity: 'near', enLength: 38, limit: 40 }
    ]);
    expect(summary.startsWith('1 over limit, 1 near limit: ')).toBe(true);
  });
});
