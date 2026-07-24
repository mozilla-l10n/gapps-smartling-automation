import { describe, it, expect } from 'vitest';
import { Convert } from './harness.mjs';

describe('Convert.isSurveyTemplate', () => {
  it('is true when the first header is "Key"', () => {
    expect(Convert.isSurveyTemplate([['Key', 'Default Text', 'fr']])).toBe(true);
  });

  it('is false otherwise or when empty', () => {
    expect(Convert.isSurveyTemplate([['EN Copy', 'fr']])).toBe(false);
    expect(Convert.isSurveyTemplate([])).toBe(false);
  });
});

describe('Convert.normalizeCell', () => {
  it('coerces to a trimmed string', () => {
    expect(Convert.normalizeCell('  hi  ')).toBe('hi');
    expect(Convert.normalizeCell(null)).toBe('');
    expect(Convert.normalizeCell(0)).toBe('');
    expect(Convert.normalizeCell(42)).toBe('42');
  });
});

describe('Convert.columnToLetter', () => {
  it('maps 1-based column numbers to A1 letters', () => {
    expect(Convert.columnToLetter(1)).toBe('A');
    expect(Convert.columnToLetter(26)).toBe('Z');
    expect(Convert.columnToLetter(27)).toBe('AA');
    expect(Convert.columnToLetter(52)).toBe('AZ');
  });
});

describe('Convert.dropColumnByHeader', () => {
  it('drops the matching column across every row', () => {
    const values = [
      ['A', 'B', 'C'],
      ['1', '2', '3']
    ];
    expect(Convert.dropColumnByHeader(values, 'B')).toEqual([
      ['A', 'C'],
      ['1', '3']
    ]);
  });

  it('returns values unchanged when the header is absent', () => {
    const values = [['A', 'B']];
    expect(Convert.dropColumnByHeader(values, 'Z')).toBe(values);
  });
});

describe('Convert.dropRedundantTargetColumn', () => {
  it('drops the target column when every cell equals the source cell', () => {
    const values = [
      ['EN Copy', 'Target Language'],
      ['hello', 'hello'],
      ['world', ' world ']
    ];
    expect(
      Convert.dropRedundantTargetColumn(values, 'EN Copy', 'Target Language')
    ).toEqual([['EN Copy'], ['hello'], ['world']]);
  });

  it('keeps the target column when any cell differs', () => {
    const values = [
      ['EN Copy', 'Target Language'],
      ['hello', 'bonjour']
    ];
    expect(
      Convert.dropRedundantTargetColumn(values, 'EN Copy', 'Target Language')
    ).toBe(values);
  });

  it('is a no-op when a header is missing', () => {
    const values = [['EN Copy', 'fr'], ['hello', 'hello']];
    expect(
      Convert.dropRedundantTargetColumn(values, 'EN Copy', 'Target Language')
    ).toBe(values);
  });
});

describe('Convert.cleanTargetColumns', () => {
  it('drops "Translation" and renames the last header for a survey template', () => {
    const values = [
      ['Key', 'Default Text', 'Translation'],
      ['k1', 'Hello', 'Hello']
    ];
    expect(Convert.cleanTargetColumns(values, 'fr')).toEqual([
      ['Key', 'fr'],
      ['k1', 'Hello']
    ]);
  });

  it('drops a redundant "Target Language" column for a standard template', () => {
    // First column is not "Key", so Convert.isSurveyTemplate treats this as the
    // standard path (dropRedundantTargetColumn on EN Copy / Target Language).
    const values = [
      ['ID', 'EN Copy', 'Target Language'],
      ['k1', 'Hello', 'Hello']
    ];
    expect(Convert.cleanTargetColumns(values, 'de')).toEqual([
      ['ID', 'de'],
      ['k1', 'Hello']
    ]);
  });

  it('renames the last header to the locale without dropping when nothing is redundant', () => {
    const values = [
      ['ID', 'EN Copy', 'Target Language'],
      ['k1', 'Hello', 'Hallo']
    ];
    expect(Convert.cleanTargetColumns(values, 'de')).toEqual([
      ['ID', 'EN Copy', 'de'],
      ['k1', 'Hello', 'Hallo']
    ]);
  });
});
