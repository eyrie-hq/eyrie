/**
 * Session notes: the model explains each changed component, and an entry
 * that cites no touched file is rejected, never shown as fact.
 */
import { describe, expect, it } from 'vitest';
import { MAX_NOTED_COMPONENTS, noteRequest, noteSessionChanges, validateSessionNote, type SessionNoteInput } from '@eyrie/knowledge';

const input: SessionNoteInput = {
  task: 'Add store-credit payments',
  components: [
    { id: 'a', label: 'StoreCreditPayment', kind: 'service', lane: 'logic' },
    { id: 'b', label: 'PaymentRouter', kind: 'service', lane: 'logic' },
  ],
  touchedFiles: ['src/services/credit.ts', 'src/services/router.ts'],
};

describe('validateSessionNote', () => {
  it('accepts a note that cites a touched file', () => {
    const checked = validateSessionNote(input, { component: 'a', note: 'Charges the store credit.', files: ['src/services/credit.ts'] });
    expect(checked).toEqual({ entry: { component: 'a', note: 'Charges the store credit.', files: ['src/services/credit.ts'] } });
  });

  it('rejects unknown components, empty notes and untouched files', () => {
    expect(validateSessionNote(input, { component: 'z', note: 'New.', files: ['src/services/credit.ts'] })).toEqual({ error: 'unknown component' });
    expect(validateSessionNote(input, { component: 'a', note: '  ', files: ['src/services/credit.ts'] })).toEqual({ error: 'missing note' });
    expect(validateSessionNote(input, { component: 'a', note: 'New.', files: [] })).toEqual({ error: 'cites no file' });
    expect(validateSessionNote(input, { component: 'a', note: 'New.', files: ['src/elsewhere.ts'] })).toEqual({ error: 'cites a file the session did not touch: src/elsewhere.ts' });
    expect(validateSessionNote(input, { component: 'a', note: 'x'.repeat(501), files: ['src/services/credit.ts'] })).toEqual({ error: 'note too long' });
  });
});

describe('noteSessionChanges', () => {
  it('keeps the grounded entries and rejects the rest', async () => {
    const backend = {
      name: 'scripted',
      run: async () => ({
        json: {
          notes: [
            { component: 'a', note: 'Charges the store credit.', files: ['src/services/credit.ts'] },
            { component: 'b', note: 'Routes around it.', files: ['src/invented.ts'] },
          ],
        },
        model: 'scripted-model',
      }),
    };
    const { noted, model } = await noteSessionChanges(backend, input, 1000);
    expect(model).toBe('scripted-model');
    expect(noted).toEqual([
      { component: 'a', label: 'StoreCreditPayment', status: 'ok', note: 'Charges the store credit.', files: ['src/services/credit.ts'], error: null },
      { component: 'b', label: 'PaymentRouter', status: 'rejected', note: null, files: [], error: 'cites a file the session did not touch: src/invented.ts' },
    ]);
  });

  it('skips components the answer omits and fails all when the call fails', async () => {
    const partial = { name: 'scripted', run: async () => ({ json: { notes: [{ component: 'a', note: 'Charges it.', files: ['src/services/credit.ts'] }] } }) };
    expect((await noteSessionChanges(partial, input, 1000)).noted.map((n) => n.component)).toEqual(['a']);
    const broken = {
      name: 'scripted',
      run: async () => {
        throw new Error('model is down');
      },
    };
    const { noted } = await noteSessionChanges(broken, input, 1000);
    expect(noted).toEqual([
      { component: 'a', label: 'StoreCreditPayment', status: 'failed', note: null, files: [], error: 'model is down' },
      { component: 'b', label: 'PaymentRouter', status: 'failed', note: null, files: [], error: 'model is down' },
    ]);
  });

  it('cuts long sessions to eight components', () => {
    const many: SessionNoteInput = {
      task: 'Big refactor',
      components: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, kind: 'service', lane: 'logic' })),
      touchedFiles: ['src/a.ts'],
    };
    expect(MAX_NOTED_COMPONENTS).toBe(8);
    expect(noteRequest(many, 1000).prompt).toContain('c7');
    expect(noteRequest(many, 1000).prompt).not.toContain('c8');
  });
});
