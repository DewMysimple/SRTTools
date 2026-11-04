import { describe, expect, it } from 'vitest';
import { parseSubtitle } from './parser';
import { processDocument } from './process';
import { getOperationDefinition, operationParametersSchema, validateParameterValues, workflowOperations } from './operation-registry';
import { analyzeWorkflow, createWorkflowStep, executeWorkflow, MAX_WORKFLOW_BYTES, workflowDefinitionSchema, type WorkflowDefinition, type WorkflowStep } from './workflow';

const sample = '1\n00:00:01,000 --> 00:00:03,000\n   \n\n2\n00:00:04,000 --> 00:00:06,000\n  Hello  世界 😀  \nSecond line\n';
function flow(steps: WorkflowStep[], lossyMode: WorkflowDefinition['lossyMode'] = 'reject'): WorkflowDefinition {
  return { schemaVersion: 1, steps, lossyMode };
}
function step(operation: WorkflowStep['operation'], params?: Record<string, unknown>): WorkflowStep {
  const result = createWorkflowStep(operation);
  return { ...result, params: { ...result.params, ...params } };
}

describe('strict workflow configuration and shared operations', () => {
  it('allows empty/all-disabled drafts, but marks them nonexecutable', () => {
    expect(workflowDefinitionSchema.safeParse(flow([])).success).toBe(true);
    expect(analyzeWorkflow(flow([]))).toMatchObject({ valid: true, executable: false, enabledStepCount: 0 });
    expect(analyzeWorkflow(flow([{ ...step('clean-spaces'), enabled: false }])).executable).toBe(false);
  });

  it('supports 1, 3 and 20 steps, rejects 21 and duplicate IDs', () => {
    for (const count of [1, 3, 20]) expect(workflowDefinitionSchema.safeParse(flow(Array.from({ length: count }, () => step('clean-spaces')))).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(flow(Array.from({ length: 21 }, () => step('clean-spaces')))).success).toBe(false);
    const first = step('clean-spaces');
    expect(workflowDefinitionSchema.safeParse(flow([first, { ...first }])).success).toBe(false);
  });

  it('rejects unknown operations, unsupported cardinalities, versions and extra fields', () => {
    for (const operation of ['merge', 'bilingual', 'split-count', 'compare', 'extract', 'template', 'shell', 'eval']) {
      expect(workflowDefinitionSchema.safeParse(flow([{ ...step('clean-spaces'), operation } as WorkflowStep])).success).toBe(false);
    }
    expect(workflowDefinitionSchema.safeParse({ ...flow([step('clean-spaces')]), schemaVersion: 2 }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ ...flow([step('clean-spaces')]), sourcePath: 'C:\\private.srt' }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse(flow([step('shift', { offsetMs: 1, policy: 'reject', shell: 'anything' })])).success).toBe(false);
  });

  it('uses the same parameter definitions and validation as standalone tools', () => {
    const cases: [WorkflowStep['operation'], Record<string, unknown>][] = [
      ['replace', { find: '[', replacement: '', caseSensitive: false, regex: true }],
      ['shift', { offsetMs: 1.5, policy: 'reject' }], ['shift', { offsetMs: 1, policy: 'unknown' }],
      ['wrap', { maxChars: 0 }], ['chinese', { direction: 'unknown' }],
    ];
    for (const [operation, params] of cases) {
      const definition = getOperationDefinition(operation)!;
      expect(operationParametersSchema(operation).safeParse(params).success).toBe(false);
      expect(Object.keys(validateParameterValues(definition, params)).length).toBeGreaterThan(0);
      expect(workflowDefinitionSchema.safeParse(flow([step(operation, params)])).success).toBe(false);
    }
    expect(workflowOperations).toHaveLength(8);
  });

  it('enforces a byte limit without interpreting user-entered replacement text as code', () => {
    const valid = step('replace', { find: 'Hello', replacement: '$() <script> literal data' });
    expect(workflowDefinitionSchema.safeParse(flow([valid])).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(flow([step('replace', { find: 'Hello', replacement: '字'.repeat(MAX_WORKFLOW_BYTES / 2) })])).success).toBe(false);
  });
});

describe('preexecution format analysis', () => {
  it('groups supported and unsupported files without inventing exact change counts', () => {
    const analysis = analyzeWorkflow(flow([step('clean-spaces')]), [
      { id: 'srt', name: 'lesson.srt' }, { id: 'vtt', name: 'web.vtt' }, { id: 'other', name: 'program.exe' },
    ]);
    expect(analysis.files.map(file => file.applicable)).toEqual([true, false, false]);
    expect(analysis).toMatchObject({ executable: true, enabledStepCount: 1, effects: { text: true, time: false, index: false, count: false } });
    expect(analysis).not.toHaveProperty('changedCount');
  });

  it('allows pure Chinese source-layout rewriting for ASS/SSA/VTT', () => {
    const definition = flow([step('chinese', { direction: 's2t' }), step('chinese', { direction: 't2s' })]);
    const analysis = analyzeWorkflow(definition, ['ass', 'ssa', 'vtt'].map(name => ({ id: name, name: `lesson.${name}` })));
    expect(analysis.files.every(file => file.applicable && file.layout === 'source')).toBe(true);
  });

  it('requires explicit lossy normalization for protected-format combinations', () => {
    const steps = [step('chinese'), step('shift', { offsetMs: 500 })];
    const files = ['ass', 'ssa', 'vtt'].map(name => ({ id: name, name: `lesson.${name}` }));
    expect(analyzeWorkflow(flow(steps), files).files.every(file => !file.applicable)).toBe(true);
    const analysis = analyzeWorkflow(flow(steps, 'normalize'), files);
    expect(analysis.files.every(file => file.applicable && file.outputFormat === 'srt' && file.warnings.length > 0)).toBe(true);
  });

  it('normalizes timed TXT to a subtitle output rather than silently extracting plain text', () => {
    expect(analyzeWorkflow(flow([step('shift')]), [{ id: 'txt', name: 'timed.txt' }]).files[0].outputFormat).toBe('srt');
  });
});

describe('in-memory linear execution', () => {
  it('deletes blanks, replaces text and shifts the true remaining cue set', () => {
    const original = parseSubtitle(sample, 'lesson.srt').document;
    const snapshot = structuredClone(original);
    const definition = flow([step('remove-empty'), step('replace', { find: 'Hello', replacement: '你好' }), step('shift', { offsetMs: 500 })]);
    const result = executeWorkflow(original, definition);
    expect(result.document.cues).toHaveLength(1);
    expect(result.document.cues[0]).toMatchObject({ id: original.cues[1].id, text: '  你好  世界 😀  \nSecond line', startMs: 4500, endMs: 6500 });
    expect(result.stepSummaries.map(summary => summary.changedCount)).toEqual([1, 1, 1]);
    expect(result.stepSummaries[0].removedCount).toBe(1);
    expect(original).toEqual(snapshot);
  });

  it('matches serial single-tool semantics and honors order', () => {
    const document = parseSubtitle(sample, 'lesson.srt').document;
    const steps = [step('remove-empty'), step('clean-spaces'), step('shift', { offsetMs: 500 })];
    let serial = document;
    for (const item of steps) serial = processDocument(serial, item.operation, item.params).documents[0];
    expect(executeWorkflow(document, flow(steps)).document).toEqual(serial);
    const replacement = step('replace', { find: 'Hello', replacement: ' X ' });
    const first = executeWorkflow(document, flow([replacement, step('clean-spaces')])).document.cues[1].text;
    const second = executeWorkflow(document, flow([step('clean-spaces'), replacement])).document.cues[1].text;
    expect(first).not.toBe(second);
  });

  it('skips disabled steps and reports progress in exact configured order', () => {
    const document = parseSubtitle(sample, 'lesson.srt').document;
    const definition = flow([step('clean-spaces'), { ...step('shift', { offsetMs: 9000 }), enabled: false }, step('renumber')]);
    const progress: string[] = [];
    const result = executeWorkflow(document, definition, { onStepProgress: event => progress.push(`${event.stepIndex}:${event.status}`) });
    expect(progress).toEqual(['0:processing', '0:success', '1:skipped', '2:processing', '2:success']);
    expect(result.document.cues[0].startMs).toBe(1000);
    expect(result.stepSummaries[1]).toMatchObject({ status: 'skipped', changedCount: 0 });
  });

  it('stops on failed time operations and never executes later steps', () => {
    const document = parseSubtitle(sample, 'lesson.srt').document;
    const progress: number[] = [];
    expect(() => executeWorkflow(document, flow([step('clean-spaces'), step('shift', { offsetMs: -5000 }), step('renumber')]), {
      onStepProgress: event => progress.push(event.stepIndex),
    })).toThrow('第 2 步');
    expect(progress).not.toContain(2);
  });

  it('checks cancellation at step boundaries before executing or reporting success', () => {
    const document = parseSubtitle(sample, 'lesson.srt').document;
    const controller = new AbortController();
    expect(() => executeWorkflow(document, flow([step('clean-spaces'), step('shift')]), {
      signal: controller.signal, onStepProgress: event => { if (event.stepIndex === 0 && event.status === 'success') controller.abort(); },
    })).toThrow('取消');
  });
});
