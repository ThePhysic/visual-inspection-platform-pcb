import { MOCK_LABELS, PCB_LABELS, labelsForTaxonomy, MAX_DETECTIONS, isInferenceResult, validReviewAnnotations, type PersistedReview, type SaveReviewRequest, type InferenceResult } from '@vip/contracts';
import { sameBox, validBox, type Box } from './geometry';

export { REVIEW_TAXONOMY_VERSION } from '@vip/contracts';
export type ClassId = typeof MOCK_LABELS[number]['classId'] | typeof PCB_LABELS[number]['classId'];
interface AnnotationBase {
  readonly id: string;
  readonly classId: ClassId;
  readonly label: string;
  readonly boundingBox: Readonly<Box>;
}
export type ReviewAnnotation = AnnotationBase & (
  | { readonly origin: 'prediction'; readonly predictionId: string; readonly originalConfidence: number; readonly disposition: 'accepted' | 'rejected' }
  | { readonly origin: 'manual' }
);
export interface ReviewDraft {
  readonly draftVersion: 'v1';
  readonly taxonomyVersion: SaveReviewRequest['taxonomyVersion'];
  readonly inspectionId: string;
  readonly annotations: readonly ReviewAnnotation[];
}
export interface ReviewState {
  readonly initial: ReviewDraft;
  readonly draft: ReviewDraft;
  readonly selectedId: string | undefined;
  readonly mode: 'select' | 'draw';
}
export type ReviewAction =
  | { type: 'select'; id: string | undefined }
  | { type: 'mode'; mode: 'select' | 'draw' }
  | { type: 'class'; id: string; classId: ClassId }
  | { type: 'box'; id: string; box: Box }
  | { type: 'disposition'; id: string; disposition: 'accepted' | 'rejected' }
  | { type: 'add'; id: string; classId: ClassId; box: Box }
  | { type: 'remove'; id: string }
  | { type: 'baseline'; state: ReviewState }
  | { type: 'reset' };

export function labelFor(classId: ClassId) {
  const entry = [...MOCK_LABELS, ...PCB_LABELS].find(label => label.classId === classId);
  if (!entry) throw new Error('Unknown annotation class.');
  return entry.label;
}
export function canEdit(result: InferenceResult) {
  const labels = labelsForTaxonomy(result.taxonomyVersion);
  return isInferenceResult(result) && Boolean(labels)
    && result.detections.every(detection => labels!.some(entry => entry.classId === detection.classId && entry.label === detection.label));
}
export function createReviewState({ inspectionId, result, review }: { inspectionId: string; result: InferenceResult; review?: PersistedReview | undefined }): ReviewState {
  if (!canEdit(result)) throw new Error('Unsupported review taxonomy.');
  if (review && (review.taxonomyVersion !== result.taxonomyVersion || !validReviewAnnotations(review.annotations, result))) throw new Error('Invalid saved review.');
  const draft: ReviewDraft = {
    draftVersion: 'v1', taxonomyVersion: result.taxonomyVersion as SaveReviewRequest['taxonomyVersion'], inspectionId,
    annotations: review ? review.annotations.map((annotation): ReviewAnnotation => {
      const common = { id: annotation.id, classId: annotation.classId, boundingBox: { ...annotation.boundingBox }, label: labelFor(annotation.classId) };
      return annotation.origin === 'manual' ? { ...common, origin: 'manual' }
        : { ...common, origin: 'prediction', predictionId: annotation.predictionId, disposition: annotation.disposition,
          originalConfidence: result.detections.find(prediction => prediction.id === annotation.predictionId)!.confidence };
    }) : result.detections.map(prediction => ({
      id: `prediction:${prediction.id}`, origin: 'prediction', predictionId: prediction.id,
      classId: prediction.classId as ClassId, label: prediction.label,
      originalConfidence: prediction.confidence, disposition: 'accepted', boundingBox: { ...prediction.boundingBox },
    })),
  };
  return { initial: draft, draft, selectedId: undefined, mode: 'select' };
}
export function sameAnnotation(a: ReviewAnnotation, b: ReviewAnnotation) {
  return a.id === b.id && a.origin === b.origin && a.classId === b.classId && a.label === b.label && sameBox(a.boundingBox, b.boundingBox)
    && (a.origin === 'manual' || (b.origin === 'prediction' && a.predictionId === b.predictionId
      && a.originalConfidence === b.originalConfidence && a.disposition === b.disposition));
}
export function changedAnnotations(initial: ReviewDraft, draft: ReviewDraft) {
  const original = new Map(initial.annotations.map(annotation => [annotation.id, annotation]));
  return draft.annotations.filter(annotation => { const previous = original.get(annotation.id); return !previous || !sameAnnotation(previous, annotation); });
}
export function isDirty(state: ReviewState) {
  return state.initial.inspectionId !== state.draft.inspectionId || state.initial.annotations.length !== state.draft.annotations.length
    || changedAnnotations(state.initial, state.draft).length > 0;
}
export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  if (action.type === 'baseline') return { ...action.state, selectedId: action.state.draft.annotations.some(item => item.id === state.selectedId) ? state.selectedId : undefined };
  if (action.type === 'reset') return { ...state, draft: state.initial, selectedId: undefined, mode: 'select' };
  if (action.type === 'mode') return { ...state, mode: action.mode };
  if (action.type === 'select') return { ...state, selectedId: state.draft.annotations.some(item => item.id === action.id) ? action.id : undefined, mode: 'select' };
  if (action.type === 'add') {
    if (!labelsForTaxonomy(state.draft.taxonomyVersion)?.some(entry => entry.classId === action.classId)
      || state.draft.annotations.length >= MAX_DETECTIONS || !validBox(action.box) || !action.id || state.draft.annotations.some(item => item.id === action.id)) return state;
    const annotation: ReviewAnnotation = { id: action.id, origin: 'manual', classId: action.classId, label: labelFor(action.classId), boundingBox: { ...action.box } };
    return { ...state, draft: { ...state.draft, annotations: [...state.draft.annotations, annotation] }, selectedId: action.id, mode: 'select' };
  }
  if (action.type === 'remove') {
    const annotation = state.draft.annotations.find(item => item.id === action.id);
    if (annotation?.origin !== 'manual') return state;
    return { ...state, selectedId: state.selectedId === action.id ? undefined : state.selectedId,
      draft: { ...state.draft, annotations: state.draft.annotations.filter(item => item.id !== action.id) } };
  }
  const annotations = state.draft.annotations.map(annotation => {
    if (annotation.id !== action.id) return annotation;
    if (action.type === 'class') return annotation.classId === action.classId
      || !labelsForTaxonomy(state.draft.taxonomyVersion)?.some(entry => entry.classId === action.classId)
      ? annotation : { ...annotation, classId: action.classId, label: labelFor(action.classId) };
    if (action.type === 'box') return !validBox(action.box) || sameBox(annotation.boundingBox, action.box) ? annotation : { ...annotation, boundingBox: { ...action.box } };
    if (action.type === 'disposition' && annotation.origin === 'prediction') return annotation.disposition === action.disposition ? annotation : { ...annotation, disposition: action.disposition };
    return annotation;
  });
  return annotations.every((annotation, index) => annotation === state.draft.annotations[index]) ? state : { ...state, draft: { ...state.draft, annotations } };
}

export function savePayload(draft: ReviewDraft, expectedRevision: number, expectedWriteSequence: number, operationId: string): SaveReviewRequest {
  return { contractVersion: 'v1', taxonomyVersion: draft.taxonomyVersion, expectedRevision, expectedWriteSequence, operationId,
    annotations: draft.annotations.map(annotation => ({
      id: annotation.id, classId: annotation.classId, boundingBox: { ...annotation.boundingBox },
      ...(annotation.origin === 'prediction' ? { origin: 'prediction' as const, predictionId: annotation.predictionId,
        disposition: annotation.disposition } : { origin: 'manual' as const, disposition: 'accepted' as const }),
    })),
  };
}
