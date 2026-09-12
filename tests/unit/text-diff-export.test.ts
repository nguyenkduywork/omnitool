import { describe, expect, it } from 'vitest';

import { diffLines } from '../../src/tools/data/diff';
import { BoundedTextWriter, MAX_EXPORT_BYTES, TextDiffExportError, serializeChanges, serializeHtmlReport } from '../../src/tools/data/text-diff.export';

describe('Text Diff shared exports', () => {
  it('escapes hostile source text and records selected detail/configuration without similarity', () => {
    const result = diffLines('<script>x</script>\n', '<script>y</script>\n');
    const html = serializeHtmlReport({
      result, names: { a: 'old <x>', b: 'new <x>' }, options: { ignoreWhitespace: true, ignoreCase: false },
      scope: 'changes', context: 3, detail: 'character', identity: { rawIdentical: false, exactDisplayLinesIdentical: false, normalizedIdentical: false, metadataOnlyDifference: false },
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('character detail');
    expect(html).toContain('Whitespace changes were ignored');
    expect(html).not.toContain('% unchanged');
  });

  it('makes metadata-only and ignored-only copy summaries explicit', () => {
    const metadata = serializeChanges({
      result: diffLines('x\n', 'x\r\n'), names: { a: 'a', b: 'b' }, context: 3,
      rules: { ignoreWhitespace: false, ignoreCase: false }, identity: { rawIdentical: false, exactDisplayLinesIdentical: true, normalizedIdentical: true, metadataOnlyDifference: true },
    });
    expect(metadata).toContain('Metadata-only difference');
    expect(metadata).toContain('No line changes');
  });

  it('reports metadata alongside changed text, including reordered mixed terminators', () => {
    const original = '\ufeffalpha\r\nold\nkeep\r';
    const revised = 'alpha\nnew\r\nkeep\r';
    const result = diffLines(original, revised);
    const common = { result, names: { a: 'old.txt', b: 'new.txt' }, rawSources: { a: original, b: revised } };
    const copy = serializeChanges({ ...common, context: 3, rules: { ignoreWhitespace: false, ignoreCase: false } });
    expect(copy).toContain('Original source: MIXED line endings; BOM present; final newline present');
    expect(copy).toContain('Revised source: MIXED line endings; no BOM; final newline present');
    expect(copy).toContain('Aligned line endings differ.');
    expect(copy).toContain('- old\n+ new');
    expect(copy).not.toContain('Metadata-only difference');

    const html = serializeHtmlReport({ ...common, options: { ignoreWhitespace: false, ignoreCase: false }, scope: 'changes', context: 3 });
    expect(html).toContain('Original source: MIXED line endings; BOM present; final newline present');
    expect(html).toContain('Revised source: MIXED line endings; no BOM; final newline present');
    expect(html).toContain('Aligned line endings differ.');
    expect(html).toContain('old');
    expect(html).toContain('new');
    expect(html).not.toContain('Metadata-only difference');
  });

  it('enforces the export cap incrementally while retaining surrogate-pair byte accuracy', () => {
    const writer = new BoundedTextWriter();
    writer.write('x'.repeat(MAX_EXPORT_BYTES - 8195));
    writer.write('x'.repeat(8191) + '😀');
    expect(() => writer.write('x')).toThrow(TextDiffExportError);
    const escaped = new BoundedTextWriter();
    expect(() => escaped.escaped('&'.repeat(Math.ceil((MAX_EXPORT_BYTES + 1) / 5)))).toThrow(TextDiffExportError);
  });

  it('wraps an unbroken long source name in the report heading', () => {
    const html = serializeHtmlReport({
      result: diffLines('a\n', 'b\n'), names: { a: 'a'.repeat(255), b: 'b'.repeat(255) },
      options: { ignoreWhitespace: false, ignoreCase: false }, scope: 'changes', context: 3,
    });
    expect(html).toContain('h1,.sub{overflow-wrap:anywhere}');
  });
});
