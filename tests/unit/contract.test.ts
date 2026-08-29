import { describe, expect, it } from 'vitest';
import { OpError } from '../../src/types';

describe('OpError (src/types.ts contract)', () => {
  it('carries code, message, and file', () => {
    const err = new OpError('CorruptFile', 'could not parse PDF', 'small.pdf');

    expect(err.code).toBe('CorruptFile');
    expect(err.message).toBe('could not parse PDF');
    expect(err.file).toBe('small.pdf');
  });

  it('file is optional', () => {
    const err = new OpError('InvalidOptions', 'bad options');

    expect(err.file).toBeUndefined();
  });

  it('is a real Error (instanceof holds, name is set)', () => {
    const err = new OpError('Cancelled', 'stopped');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OpError);
    expect(err.name).toBe('OpError');
  });
});
