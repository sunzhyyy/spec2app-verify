import { describe, expect, it } from 'vitest';
import { APP_NAME, WORKFLOW_STAGES } from '../src/domain/workflow';

describe('workflow skeleton', () => {
  it('exposes the app name and ordered stages', () => {
    expect(APP_NAME).toBe('Spec2App Verify');
    expect(WORKFLOW_STAGES[0]).toBe('Requirement');
    expect(WORKFLOW_STAGES).toHaveLength(9);
  });
});
