import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { safePatchTarget, serializeExactPatch } from '../../src/tools/data/text-diff.export';

async function assertGitApplies(before: string, after: string, target = 'sample.txt', context = 3): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omnitool-text-diff-'));
  const safeRoot = resolve(root);
  if (safeRoot !== resolve(root)) throw new Error('Temporary patch root did not resolve consistently.');
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: safeRoot });
    const path = join(safeRoot, target);
    const patchPath = join(safeRoot, 'change.diff');
    await writeFile(path, before, 'utf8');
    const patch = serializeExactPatch(before, after, { target, context });
    expect(patch).not.toBeNull();
    await writeFile(patchPath, patch as string, 'utf8');
    execFileSync(
      'git',
      ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', ...(context === 0 ? ['--unidiff-zero'] : []), 'change.diff'],
      { cwd: safeRoot },
    );
    expect(await readFile(path)).toEqual(Buffer.from(after, 'utf8'));
  } finally {
    if (resolve(root).startsWith(safeRoot)) await rm(safeRoot, { recursive: true, force: true });
  }
}

describe('exact unified patches', () => {
  for (const [name, before, after] of [
    ['LF to CRLF', 'one\ntwo\n', 'one\r\ntwo\r\n'],
    ['CRLF to LF', 'one\r\ntwo\r\n', 'one\ntwo\n'],
    ['mixed endings', 'one\r\ntwo\nthree\r', 'one\ntwo\r\nthree\r'],
    ['lone CR payload', 'one\rtwo', 'one\rthree'],
    ['BOM add and final newline', 'one', '\ufeffone\n'],
    ['BOM removal', '\ufeffone\n', 'one\n'],
    ['BOM only', '\ufeff', ''],
    ['no final newline on either side', 'one\ntwo', 'one\nTWO'],
    ['final newline added', 'one\ntwo', 'one\ntwo\n'],
    ['final newline removed', 'one\ntwo\n', 'one\ntwo'],
    ['both final newline', 'one\ntwo\n', 'one\nTWO\n'],
    ['empty insertion', '', 'a\nb\n'],
    ['empty deletion', 'a\nb\n', ''],
    ['zero-context replacement', 'a\nb\nc\n', 'a\nB\nc\n'],
    ['metadata change outside ordinary context', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\r\n'],
  ] as const) {
    it(`git apply recreates bytes for ${name}`, () => assertGitApplies(before, after));
  }

  it('applies a requested zero-context hunk with Git’s explicit zero-context switch', () =>
    assertGitApplies('a\nb\nc\n', 'a\nB\nc\n', 'sample.txt', 0));

  it('uses one safe portable target basename for both headers', () => {
    for (const unsafe of ['../../CON', 'CON', 'report.', 'a/b.txt', 'a\\b.txt', 'bad\u0000name.txt', '.', '..']) {
      expect(safePatchTarget(unsafe)).toBe('comparison.txt');
    }
    expect(safePatchTarget('report.txt')).toBe('report.txt');
    const patch = serializeExactPatch('a\n', 'b\n', { target: '../bad', context: 3 }) as string;
    expect(patch).toContain('--- a/comparison.txt\n+++ b/comparison.txt');
  });

  it('does not claim an applicable patch for raw-identical text', () => {
    expect(serializeExactPatch('same\n', 'same\n', { target: 'same.txt', context: 3 })).toBeNull();
  });

  it('includes ignored whitespace and case changes in an exact patch', () => {
    const patch = serializeExactPatch('Alpha\n  value\n', 'alpha\n\tvalue\n', {
      target: 'source.txt',
      context: 3,
    });
    expect(patch).toContain('-Alpha');
    expect(patch).toContain('+alpha');
  });
});
