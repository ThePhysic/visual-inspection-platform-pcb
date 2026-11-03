import { useId, useState, type Dispatch } from 'react';
import { labelsForTaxonomy, MAX_DETECTIONS, type AssetResponse, type InferenceResult } from '@vip/contracts';
import { classColor, confidenceLabel } from '../presentation';
import { changedAnnotations, isDirty, type ClassId, type ReviewAction, type ReviewState } from './draft';
import AnnotationCanvas from './AnnotationCanvas';

export default function AnnotationEditor({ asset, state, dispatch, disabled = false, savedRevision = 0, originalResult }: {
  asset: AssetResponse | undefined; state: ReviewState; dispatch: Dispatch<ReviewAction>; disabled?: boolean; savedRevision?: number; originalResult?: InferenceResult;
}) {
  const labels = labelsForTaxonomy(state.draft.taxonomyVersion)!;
  const [drawingClass, setDrawingClass] = useState<ClassId>(labels[0]!.classId as ClassId);
  const drawingClassId = useId();
  const annotationClassId = useId();
  const selected = state.draft.annotations.find(annotation => annotation.id === state.selectedId);
  const changed = changedAnnotations(state.initial, state.draft);
  const currentIds = new Set(state.draft.annotations.map(annotation => annotation.id));
  const removed = state.initial.annotations.filter(annotation => !currentIds.has(annotation.id));
  const changeCount = changed.length + removed.length;
  const dirty = isDirty(state);
  return <div className="annotation-editor" onKeyDown={event => { if (event.key === 'Escape') dispatch({ type: 'mode', mode: 'select' }); }}>
    <aside className="notice local-notice"><strong>{savedRevision ? `Saved review · revision ${savedRevision}` : 'Local draft — not saved'}</strong><p>Original predictions remain unchanged. Use Save review to persist corrections. Unsaved changes exist only in this page’s memory.</p></aside>
    <p role="status" className={dirty ? 'draft-dirty' : 'muted'}>{dirty ? `Unsaved changes · ${changeCount} annotation${changeCount === 1 ? '' : 's'} changed` : 'No unsaved changes.'}</p>
    <fieldset disabled={disabled} className="editor-fieldset"><legend className="sr-only">Annotation editing controls</legend>
    <div className="editor-tools">
      <div><label htmlFor={drawingClassId}>Class for new annotation</label>
        <select id={drawingClassId} value={drawingClass} onChange={event => { setDrawingClass(event.target.value as ClassId); }}>
          {labels.map(entry => <option value={entry.classId} key={entry.classId}>{entry.label}</option>)}
        </select>
      </div>
      <button type="button" disabled={!asset || state.draft.annotations.length >= MAX_DETECTIONS} aria-pressed={state.mode === 'draw'} onClick={() => { dispatch({ type: 'mode', mode: state.mode === 'draw' ? 'select' : 'draw' }); }}>
        {state.mode === 'draw' ? 'Cancel drawing' : 'Add annotation'}
      </button>
      <button type="button" className="secondary" disabled={!dirty} onClick={() => {
        if (window.confirm('Discard all local annotation changes and reset to the last saved review (or original predictions if none)?')) dispatch({ type: 'reset' });
      }}>Reset draft</button>
    </div>
    <p id="canvas-help">{state.mode === 'draw'
      ? 'Draw a rectangle over the image (at least 12 displayed pixels per side). Release to add it. Press Escape or Cancel drawing to cancel.'
      : 'Select a box or an annotation in the list. Drag the selected box or use its resize handles. Rejected predictions are hidden from the canvas.'}</p>
    <div className="results-grid">
      <div>
        {asset ? <AnnotationCanvas key={asset.id} asset={asset} disabled={disabled} annotations={state.draft.annotations} selectedId={state.selectedId} mode={state.mode}
          onSelect={id => { dispatch({ type: 'select', id }); }}
          onBox={(id, box) => { dispatch({ type: 'box', id, box }); }}
          onDraw={box => { dispatch({ type: 'add', id: `manual:${crypto.randomUUID()}`, classId: drawingClass, box }); }}
          onCancelDraw={() => { dispatch({ type: 'mode', mode: 'select' }); }} />
          : <p>Canonical image metadata is unavailable. Labels and dispositions can still be reviewed.</p>}
      </div>
      <aside className="detections" aria-labelledby="annotations-heading">
        <h3 id="annotations-heading">{state.draft.annotations.length} {state.draft.annotations.length === 1 ? 'annotation' : 'annotations'}</h3>
        {!state.draft.annotations.length && <p>No predictions. Use Add annotation to mark a missed object.</p>}
        <ol>
          {state.draft.annotations.map((annotation, index) => <li key={annotation.id}>
            <button className="detection-item" type="button" aria-pressed={annotation.id === state.selectedId}
              aria-label={`Annotation ${index + 1}: ${annotation.label}. ${annotation.origin === 'manual' ? 'Manually added; no model confidence' : `Prediction; ${confidenceLabel(annotation.originalConfidence)} original confidence; ${annotation.disposition}`}`}
              onClick={() => { dispatch({ type: 'select', id: annotation.id }); }}>
              <span className="detection-number" style={{ backgroundColor: classColor(annotation.classId) }}>{index + 1}</span>
              <span><strong>{annotation.label}</strong><span className="confidence">
                {annotation.origin === 'manual' ? 'Manually added · no model confidence' : `Prediction · ${confidenceLabel(annotation.originalConfidence)} original confidence · ${annotation.disposition}`}
              </span></span>
            </button>
          </li>)}
        </ol>
        {selected ? <section className="annotation-properties" aria-labelledby="selected-heading">
          <h3 id="selected-heading">Selected annotation</h3>
          <p>{selected.origin === 'prediction' ? `Original predicted class: ${originalResult?.detections.find(item => item.id === selected.predictionId)?.label ?? selected.label}` : 'Manually added annotation'}</p>
          {selected.origin === 'prediction' && <details><summary>Prediction technical details</summary><code>{selected.predictionId}</code></details>}
          <label htmlFor={annotationClassId}>Annotation class</label>
            <select id={annotationClassId} value={selected.classId} onChange={event => { dispatch({ type: 'class', id: selected.id, classId: event.target.value as ClassId }); }}>
              {labels.map(entry => <option value={entry.classId} key={entry.classId}>{entry.label}</option>)}
            </select>
          {selected.origin === 'prediction' ? <>
            <p>Original confidence: {confidenceLabel(selected.originalConfidence)}. Disposition: <strong>{selected.disposition}</strong>.</p>
            <div className="property-actions">
              <button type="button" className="secondary" onClick={() => { dispatch({ type: 'disposition', id: selected.id, disposition: 'accepted' }); }}>
                {selected.disposition === 'rejected' ? 'Restore prediction' : 'Accept prediction'}
              </button>
              <button type="button" className="secondary" disabled={selected.disposition === 'rejected'} onClick={() => { dispatch({ type: 'disposition', id: selected.id, disposition: 'rejected' }); }}>Reject prediction</button>
            </div>
            {selected.disposition === 'rejected' && <p>Rejected box is hidden. Restore the prediction to edit its geometry.</p>}
          </> : <button type="button" className="secondary" onClick={() => { dispatch({ type: 'remove', id: selected.id }); }}>Remove manual annotation</button>}
          <dl className="geometry-values" aria-label="Normalized annotation geometry">
            {(['x', 'y', 'width', 'height'] as const).map(key => <div key={key}><dt>{key}</dt><dd><output aria-label={`Box ${key}`}>{selected.boundingBox[key]}</output></dd></div>)}
          </dl>
        </section> : <p className="muted">Select an annotation to change its class or disposition.</p>}
      </aside>
    </div>
    </fieldset>
    {state.draft.annotations.length >= MAX_DETECTIONS && <p>Annotation limit reached (200, including rejected predictions).</p>}
    {dirty && <details className="draft-summary"><summary>Review unsaved changes ({changeCount})</summary><ul>
      {changed.map(annotation => <li key={annotation.id}>{annotation.label} — {annotation.origin === 'manual' ? 'added manually' : annotation.disposition === 'rejected' ? 'rejected prediction' : 'modified prediction'}</li>)}
      {removed.map(annotation => <li key={annotation.id}>{annotation.label} — removed manual annotation</li>)}
    </ul></details>}
  </div>;
}
