import { describe, expect, it } from 'vitest';
import { PCB_LABELS, validReviewAnnotations, type InferenceResult } from '@vip/contracts';
import { pcbResult, result } from '../test/fixtures';
import { changedAnnotations, createReviewState, isDirty, reviewReducer, savePayload } from './draft';

const initialize = (inspectionId = 'inspection-one') => createReviewState({ inspectionId, result });
describe('local annotation drafts', () => {
  it('copies every prediction, identity, confidence, and box into a separate snapshot', () => {
    const state = initialize();
    expect(state.draft.annotations).toHaveLength(result.detections.length);
    expect(state.draft.annotations[0]).toMatchObject({ origin: 'prediction', predictionId: result.detections[0]!.id, originalConfidence: 0.94, disposition: 'accepted' });
    expect(state.draft.annotations[0]!.boundingBox).toEqual(result.detections[0]!.boundingBox);
    expect(state.draft.annotations[0]!.boundingBox).not.toBe(result.detections[0]!.boundingBox);
    expect(isDirty(state)).toBe(false);
    expect(initialize().draft.annotations.map(annotation => annotation.id)).toEqual(state.draft.annotations.map(annotation => annotation.id));
  });
  it('relabels and moves a frozen prediction without changing server data or the initial snapshot', () => {
    const frozen = structuredClone(result);
    for (const detection of frozen.detections) { Object.freeze(detection.boundingBox); Object.freeze(detection); }
    Object.freeze(frozen.detections); Object.freeze(frozen);
    const initial = createReviewState({ inspectionId: 'one', result: frozen });
    const id = initial.draft.annotations[0]!.id;
    let edited = reviewReducer(initial, { type: 'class', id, classId: 'edge-defect' });
    edited = reviewReducer(edited, { type: 'box', id, box: { x: 0.2, y: 0.1, width: 0.2, height: 0.3 } });
    expect(edited.draft.annotations[0]).toMatchObject({ classId: 'edge-defect', label: 'Edge defect', originalConfidence: 0.94, predictionId: frozen.detections[0]!.id });
    expect(initial.draft.annotations[0]!.label).toBe('Surface mark');
    expect(frozen).toEqual(result); expect(isDirty(edited)).toBe(true);
  });
  it('accepts, rejects, and restores predictions without deleting them', () => {
    const initial = initialize(); const id = initial.draft.annotations[0]!.id;
    expect(reviewReducer(initial, { type: 'disposition', id, disposition: 'accepted' })).toBe(initial);
    const rejected = reviewReducer(initial, { type: 'disposition', id, disposition: 'rejected' });
    expect(rejected.draft.annotations).toHaveLength(2); expect(rejected.draft.annotations[0]).toMatchObject({ disposition: 'rejected' });
    expect(isDirty(rejected)).toBe(true);
    const restored = reviewReducer(rejected, { type: 'disposition', id, disposition: 'accepted' });
    expect(isDirty(restored)).toBe(false);
    expect(reviewReducer(initial, { type: 'remove', id })).toBe(initial);
  });
  it('adds a stable manual annotation with no fabricated prediction identity or confidence', () => {
    const initial = initialize(); const manual = reviewReducer(initial, { type: 'add', id: 'manual:unique', classId: 'edge-defect', box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } });
    const annotation = manual.draft.annotations[2]!;
    expect(annotation).toMatchObject({ id: 'manual:unique', origin: 'manual', classId: 'edge-defect', label: 'Edge defect' });
    expect(annotation).not.toHaveProperty('predictionId'); expect(annotation).not.toHaveProperty('originalConfidence');
    expect(isDirty(manual)).toBe(true); expect(changedAnnotations(manual.initial, manual.draft)).toEqual([annotation]);
    expect(reviewReducer(manual, { type: 'class', id: annotation.id, classId: 'surface-mark' }).draft.annotations[2]!.id).toBe(annotation.id);
    expect(isDirty(reviewReducer(manual, { type: 'remove', id: annotation.id }))).toBe(false);
  });
  it('supports zero predictions and manual additions', () => {
    const empty = createReviewState({ inspectionId: 'zero', result: { ...result, detections: [] } });
    expect(empty.draft.annotations).toEqual([]);
    expect(reviewReducer(empty, { type: 'add', id: 'manual:1', classId: 'surface-mark', box: { x: 0, y: 0, width: 1, height: 1 } }).draft.annotations).toHaveLength(1);
  });
  it('selection, mode changes, and floating point noise do not mark a draft dirty', () => {
    const initial = initialize(); const first = initial.draft.annotations[0]!;
    let state = reviewReducer(initial, { type: 'select', id: first.id });
    state = reviewReducer(state, { type: 'mode', mode: 'draw' });
    state = reviewReducer(state, { type: 'box', id: first.id, box: { ...first.boundingBox, x: first.boundingBox.x + 1e-14 } });
    expect(isDirty(state)).toBe(false);
    expect(state.draft.annotations[0]).toBe(first);
    const moved = reviewReducer(state, { type: 'box', id: first.id, box: { ...first.boundingBox, x: first.boundingBox.x + 1e-5 } });
    expect(isDirty(moved)).toBe(true);
  });
  it('reset restores the complete initial snapshot, selection, and mode', () => {
    const initial = initialize();
    let state = reviewReducer(initial, { type: 'disposition', id: initial.draft.annotations[0]!.id, disposition: 'rejected' });
    state = reviewReducer(state, { type: 'add', id: 'manual:1', classId: 'surface-mark', box: { x: 0, y: 0, width: 0.2, height: 0.2 } });
    state = reviewReducer(state, { type: 'mode', mode: 'draw' });
    const reset = reviewReducer(state, { type: 'reset' });
    expect(reset.draft).toBe(initial.draft); expect(reset.selectedId).toBeUndefined(); expect(reset.mode).toBe('select'); expect(isDirty(reset)).toBe(false);
  });
  it('creates an independent state for a different inspection ID', () => {
    const first = initialize('first'); const edited = reviewReducer(first, { type: 'class', id: first.draft.annotations[0]!.id, classId: 'edge-defect' });
    const second = initialize('second'); expect(second.draft.inspectionId).toBe('second'); expect(second.draft.annotations[0]!.label).toBe('Surface mark');
    expect(isDirty(second)).toBe(false); expect(edited.draft.annotations[0]!.label).toBe('Edge defect');
  });
  it('rejects invalid geometry and duplicate manual identifiers', () => {
    const state = initialize(); const id = state.draft.annotations[0]!.id;
    expect(reviewReducer(state, { type: 'add', id, classId: 'surface-mark', box: { x: 0, y: 0, width: 0.2, height: 0.2 } })).toBe(state);
    expect(reviewReducer(state, { type: 'box', id, box: { x: NaN, y: 0, width: 0.2, height: 0.2 } })).toBe(state);
    expect(reviewReducer(state, { type: 'add', id: 'manual:bad', classId: 'surface-mark', box: { x: 0, y: 0, width: 0, height: 0.2 } })).toBe(state);
  });
  it('does not silently edit an unsupported taxonomy', () => {
    expect(() => createReviewState({ inspectionId: 'one', result: { ...result, taxonomyVersion: 'unknown' } as unknown as InferenceResult })).toThrow('Unsupported review taxonomy');
  });
});

describe('PCB taxonomy drafts', () => {
  it.each(PCB_LABELS)('supports $classId relabels, dispositions, geometry, manual additions, and saved-review reopen', entry => {
    const original = structuredClone(pcbResult);
    const state = createReviewState({ inspectionId: 'pcb', result: pcbResult });
    const first = state.draft.annotations[0]!;
    let edited = reviewReducer(state, { type: 'class', id: first.id, classId: entry.classId });
    edited = reviewReducer(edited, { type: 'disposition', id: first.id, disposition: 'rejected' });
    edited = reviewReducer(edited, { type: 'box', id: first.id, box: { x: 0.05, y: 0.05, width: 0.25, height: 0.25 } });
    const manualId = 'manual:12345678-1234-4123-8123-123456789012';
    edited = reviewReducer(edited, { type: 'add', id: manualId, classId: entry.classId, box: { x: 0.6, y: 0.6, width: 0.1, height: 0.1 } });
    const payload = savePayload(edited.draft, 0, 0, '12345678-1234-4123-8123-123456789012');
    expect(payload.taxonomyVersion).toBe('pcb-ind-v4-1');
    expect(validReviewAnnotations(payload.annotations, pcbResult)).toBe(true);
    const reopened = createReviewState({ inspectionId: 'pcb', result: pcbResult, review: {
      contractVersion: 'v1', taxonomyVersion: payload.taxonomyVersion, annotations: payload.annotations, revision: 1, savedAt: '2026-11-02T00:00:00.000Z',
    } });
    expect(reopened.draft.annotations[0]).toMatchObject({ classId: entry.classId, disposition: 'rejected', originalConfidence: 0.8 });
    const manual = reopened.draft.annotations.find(item => item.id === manualId)!;
    expect(manual).toMatchObject({ classId: entry.classId, origin: 'manual' });
    expect(manual).not.toHaveProperty('originalConfidence'); expect(manual).not.toHaveProperty('predictionId');
    expect(reviewReducer(reopened, { type: 'remove', id: manualId }).draft.annotations).toHaveLength(8);
    expect(pcbResult).toEqual(original);
  });
  it('rejects cross-taxonomy relabels and additions in both directions', () => {
    const pcb = createReviewState({ inspectionId: 'pcb', result: pcbResult });
    expect(reviewReducer(pcb, { type: 'class', id: pcb.draft.annotations[0]!.id, classId: 'edge-defect' })).toBe(pcb);
    expect(reviewReducer(pcb, { type: 'add', id: 'manual:x', classId: 'surface-mark', box: { x: 0, y: 0, width: 1, height: 1 } })).toBe(pcb);
    const mock = initialize();
    expect(reviewReducer(mock, { type: 'class', id: mock.draft.annotations[0]!.id, classId: 'scratch' })).toBe(mock);
  });
  it('validates a loaded review taxonomy against its associated result', () => {
    expect(() => createReviewState({ inspectionId: 'pcb', result: pcbResult, review: {
      contractVersion: 'v1', taxonomyVersion: 'mock-v1', annotations: [], revision: 1, savedAt: '2026-11-02T00:00:00.000Z',
    } })).toThrow('Invalid saved review');
  });
});
