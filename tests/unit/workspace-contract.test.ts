import { describe, expect, it } from 'vitest';

import { accepts, applicabilityFor } from '../../src/core/format';
import { createState, runBlockedReason, typeMismatch } from '../../src/ui/state';
import type { ToolDef } from '../../src/types';

const workspace: ToolDef = {
  id: 'test-workspace', name: 'Test workspace', blurb: '', group: 'data', kind: 'transform',
  accepts: ['text/plain'], minInputs: 2, maxInputs: 2,
  workspace: () => Promise.reject(new Error('unused')),
  load: () => Promise.reject(new Error('unused')),
};

describe('workspace-owned source selection', () => {
  it('stays selectable with unrelated or excessive tray files', () => {
    const types = ['application/pdf', 'image/png', 'application/zip'];
    expect(accepts(workspace, types)).toBe(true);
    expect(applicabilityFor([workspace], types).primary).toEqual([workspace]);
    expect(runBlockedReason(workspace, types)).toBeNull();
    expect(typeMismatch(workspace, types)).toBe(false);

    const state = createState([workspace]);
    state.selectTool(workspace.id);
    state.addFiles(types.map((type, index) => ({
      file: new File(['x'], `${index}.bin`, { type }), type,
    })));
    expect(state.snapshot().selected).toBe(workspace);
    expect(state.snapshot().runBlockedReason).toBeNull();
  });
});
