import { lazy, Suspense, useEffect, useReducer, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { validReviewAnnotations, type AssetResponse, type InferenceResult, type InspectionResponse, type PersistedReview, type SaveReviewRequest } from '@vip/contracts';
import DetectionViewer from '../DetectionViewer';
import { ApiClientError, fetchInspection, saveReview } from '../api';
import { canEdit, createReviewState, isDirty, reviewReducer, savePayload } from './draft';
import { useDraftWarning } from './useDraftWarning';

const AnnotationEditor = lazy(() => import('./AnnotationEditor'));

export default function ReviewWorkspace(props: {
  inspectionId: string; asset: AssetResponse | undefined; result: InferenceResult;
  review?: PersistedReview | undefined; reviewWriteSequence?: number | undefined;
}) {
  // Keyed by inspection ID. Server refetches never replace an active draft.
  const [state, dispatch] = useReducer(reviewReducer, props, createReviewState);
  const [editing, setEditing] = useState(Boolean(props.review));
  const [baseline, setBaseline] = useState({ revision: props.review?.revision ?? 0, sequence: props.reviewWriteSequence ?? 0 });
  const [pending, setPending] = useState<SaveReviewRequest>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const client = useQueryClient();
  const controller = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const dirty = isDirty(state);
  useDraftWarning(dirty || Boolean(pending));
  const mutation = useMutation({
    retry: false, networkMode: 'always',
    mutationFn: (request: SaveReviewRequest) => {
      controller.current = new AbortController();
      return saveReview(props.inspectionId, request, controller.current.signal);
    },
  });
  const locked = Boolean(pending) || loadingLatest;
  const newer = (props.reviewWriteSequence ?? 0) > baseline.sequence;

  async function submit() {
    if (busy.current || conflict || (!dirty && !pending)) return;
    busy.current = true;
    const request = pending ?? savePayload(state.draft, baseline.revision, baseline.sequence, crypto.randomUUID());
    setPending(request); setError(''); setMessage('');
    try {
      const response = await mutation.mutateAsync(request);
      if (!active.current) return;
      if (response.review.taxonomyVersion !== props.result.taxonomyVersion || !validReviewAnnotations(response.review.annotations, props.result)) throw new ApiClientError('The service returned an incompatible review. Retry this save.', true);
      if (response.outcome === 'superseded') {
        setPending(undefined); setConflict(true); setError('This save was committed, but a newer review has since been saved. Your local draft is retained.');
        return;
      }
      dispatch({ type: 'baseline', state: createReviewState({ ...props, review: response.review }) });
      setBaseline({ revision: response.review.revision, sequence: response.writeSequence });
      setPending(undefined); setMessage(`Review saved · revision ${response.review.revision}.`);
      void client.invalidateQueries({ queryKey: ['inspection-history'], refetchType: 'none' });
      await client.cancelQueries({ queryKey: ['inspection', props.inspectionId] });
      client.setQueryData<InspectionResponse>(['inspection', props.inspectionId], previous => previous?.status === 'completed'
        && (previous.reviewWriteSequence ?? 0) <= response.writeSequence
        ? { ...previous, review: response.review, reviewWriteSequence: response.writeSequence } : previous);
    } catch (cause) {
      if (!active.current) return;
      setError(cause instanceof ApiClientError ? cause.message : 'The save could not be confirmed. Retry the same save.');
      if (cause instanceof ApiClientError && !cause.retryable) {
        setPending(undefined);
        if (cause.status === 409) setConflict(true);
      }
    } finally { busy.current = false; }
  }

  async function loadLatest() {
    if (busy.current || !window.confirm('Discard the local draft and load the latest saved review? Unsaved edits will be lost.')) return;
    busy.current = true; setLoadingLatest(true); setError('');
    try {
      const latest = await client.fetchQuery({ queryKey: ['inspection', props.inspectionId],
        queryFn: ({ signal }) => fetchInspection(props.inspectionId, signal), staleTime: 0 });
      if (!active.current) return;
      if (latest.status !== 'completed') throw new Error('This inspection is no longer available for review.');
      dispatch({ type: 'baseline', state: createReviewState({ ...props, result: latest.result, review: latest.review }) });
      setBaseline({ revision: latest.review?.revision ?? 0, sequence: latest.reviewWriteSequence ?? 0 });
      setPending(undefined); setConflict(false); setMessage('Latest saved review loaded.');
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : 'Could not load the latest review. Your draft is retained.');
    } finally { busy.current = false; if (active.current) setLoadingLatest(false); }
  }
  return <>
    <div className="review-toolbar">
      <button type="button" className="secondary" disabled={!canEdit(props.result)} onClick={() => { setEditing(value => !value); }}>
        {editing ? 'View original predictions' : dirty ? 'Continue editing local draft' : baseline.revision ? 'Edit saved review' : 'Edit local draft'}
      </button>
      <p>{baseline.revision ? `Saved revision ${baseline.revision}` : 'No saved review'}. Original predictions remain unchanged.</p>
      <button type="button" disabled={(!dirty && !pending) || mutation.isPending || conflict || loadingLatest}
        onClick={() => { void submit(); }}>{mutation.isPending ? 'Saving review…' : pending ? 'Retry save' : 'Save review'}</button>
      {!editing && dirty && <p role="status">Unsaved local draft retained. Original predictions are shown below.</p>}
    </div>
    {message && !dirty && <p role="status">{message}</p>}
    {error && <div role="alert" className="error-panel"><p>{error}</p>
      {pending && <p>The outcome is uncertain. Editing is paused so Retry save can safely reuse the same operation and snapshot.</p>}
    </div>}
    {(conflict || newer) && <aside className="notice"><p>A newer review exists. Your draft has not been replaced. Load the latest review to continue from the server version.</p>
      <button type="button" disabled={mutation.isPending || loadingLatest} onClick={() => { void loadLatest(); }}>{loadingLatest ? 'Loading latest review…' : 'Load latest saved review'}</button>
    </aside>}
    {editing ? <Suspense fallback={<p role="status">Loading annotation editor…</p>}>
      <AnnotationEditor asset={props.asset} state={state} dispatch={dispatch} disabled={locked}
        savedRevision={baseline.revision} originalResult={props.result} />
    </Suspense> : <DetectionViewer asset={props.asset} result={props.result} />}
  </>;
}
