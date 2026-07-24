import { describe, it, expect } from 'vitest';
import { Shared } from './harness.mjs';

describe('Shared.parseCsvLenient', () => {
  it('parses simple rows', () => {
    expect(Shared.parseCsvLenient('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ]);
  });

  it('honors quoted fields with embedded commas and newlines', () => {
    expect(Shared.parseCsvLenient('"a,b","c\nd"')).toEqual([['a,b', 'c\nd']]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(Shared.parseCsvLenient('"she said ""hi"""')).toEqual([
      ['she said "hi"']
    ]);
  });

  it("tolerates Smartling's stray character after a closing quote", () => {
    // Malformed per RFC-4180 (a trailing space after the closing quote); the
    // strict parser throws on this, the lenient one appends the trailing text.
    expect(Shared.parseCsvLenient('"text." ,next')).toEqual([
      ['text. ', 'next']
    ]);
  });

  it('treats a quote mid-unquoted-field as a literal character', () => {
    // Documented divergence from RFC-4180: quoting only starts when field === ''.
    expect(Shared.parseCsvLenient('ab"c,d')).toEqual([['ab"c', 'd']]);
  });

  it('handles CRLF line endings', () => {
    expect(Shared.parseCsvLenient('a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });

  it('does not emit a dangling empty row when input ends on a terminator', () => {
    expect(Shared.parseCsvLenient('a,b\n')).toEqual([['a', 'b']]);
  });

  it('returns an empty array for empty input', () => {
    expect(Shared.parseCsvLenient('')).toEqual([]);
    expect(Shared.parseCsvLenient(null)).toEqual([]);
  });
});

describe('Shared.splitLocaleFromName', () => {
  it('splits a base and locale from a .csv name', () => {
    expect(Shared.splitLocaleFromName('foo_bar_v2_fr.csv')).toEqual({
      nameWithoutExtension: 'foo_bar_v2_fr',
      base: 'foo_bar_v2',
      locale: 'fr'
    });
  });

  it('strips the .csv extension case-insensitively', () => {
    expect(Shared.splitLocaleFromName('report_de.CSV').locale).toBe('de');
  });

  it('works when there is no extension', () => {
    expect(Shared.splitLocaleFromName('report_it')).toEqual({
      nameWithoutExtension: 'report_it',
      base: 'report',
      locale: 'it'
    });
  });

  it('falls back to empty locale when there is no _suffix', () => {
    expect(Shared.splitLocaleFromName('report.csv')).toEqual({
      nameWithoutExtension: 'report',
      base: 'report',
      locale: ''
    });
  });
});

describe('Shared.detectTemplate', () => {
  it('detects charLimit before standard (both carry "EN Copy")', () => {
    const header = [
      'EN Character count',
      'Target Character Limit',
      'Key',
      'EN Copy',
      'fr'
    ];
    expect(Shared.detectTemplate(header)).toEqual({
      type: 'charLimit',
      enCol: 4,
      limitCol: 2
    });
  });

  it('detects a standard template', () => {
    expect(Shared.detectTemplate(['Key', 'EN Copy', 'fr'])).toEqual({
      type: 'standard',
      enCol: 2
    });
  });

  it('detects a 3-column survey template', () => {
    expect(Shared.detectTemplate(['Key', 'Default Text', 'fr'])).toEqual({
      type: 'survey',
      enCol: 2
    });
  });

  it('returns null for empty or unrecognized headers', () => {
    expect(Shared.detectTemplate([])).toBeNull();
    expect(Shared.detectTemplate(null)).toBeNull();
    expect(Shared.detectTemplate(['A', 'B', 'C', 'D'])).toBeNull();
  });
});
