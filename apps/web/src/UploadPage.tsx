import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_UPLOAD_BYTES, PCB_CONFIGURATION, type AssetResponse, type ProviderConfiguration } from '@vip/contracts';
import { ApiClientError, fetchInferenceModes, submitInspection, uploadAsset } from './api';

interface Submission { file: File; key: string; asset?: AssetResponse; provider?: ProviderConfiguration; candidatePatch?: true }

export default function UploadPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [file, setFile] = useState<File>();
  const [validationError, setValidationError] = useState('');
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'submitting'>('idle');
  const [uploaded, setUploaded] = useState<AssetResponse>();
  const [mode, setMode] = useState<'mock' | 'trained'>('mock');
  const [candidatePatch, setCandidatePatch] = useState(false);
  const modes = useQuery({ queryKey: ['inference-modes'], queryFn: ({ signal }) => fetchInferenceModes(signal),
    enabled: false, retry: false });
  const trainedAvailable = modes.data?.trained.available === true && !modes.isError;
  const submission = useRef<Submission | undefined>(undefined);
  const busy = useRef(false);
  const mounted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeRequest.current?.abort(); };
  }, []);
  const mutation = useMutation({
    // Try once even when the browser reports offline. Otherwise a paused
    // mutation could start after this page has already been left.
    networkMode: 'always',
    mutationFn: async (attempt: Submission) => {
      if (!mounted.current) return;
      const controller = new AbortController();
      activeRequest.current = controller;
      if (!attempt.asset) {
        setPhase('uploading');
        const asset = await uploadAsset(attempt.file, controller.signal);
        if (controller.signal.aborted) return;
        attempt.asset = asset;
        setUploaded(asset);
      }
      if (attempt.provider?.providerId === 'visual-inspection-dl' && (attempt.asset.width !== 300 || attempt.asset.height !== 300)) {
        throw new ApiClientError('Trained mode requires a 300 × 300 PCB candidate patch. The canonical image has different dimensions; choose a supported patch or the simulated demo.', false, 422, 'INVALID_CANDIDATE_PATCH');
      }
      setPhase('submitting');
      const accepted = await submitInspection(attempt.asset.id, attempt.key, controller.signal, attempt.provider, attempt.candidatePatch);
      if (!controller.signal.aborted) {
        void client.invalidateQueries({ queryKey: ['inspection-history'], refetchType: 'none' });
        navigate(`/inspections/${accepted.id}`);
      }
    },
    onSettled: () => { busy.current = false; if (mounted.current) setPhase('idle'); },
  });

  function select(selected?: File) {
    if (busy.current) return;
    mutation.reset();
    submission.current = undefined;
    setUploaded(undefined);
    setFile(selected);
    let error = '';
    if (selected) {
      if (selected.size > MAX_UPLOAD_BYTES) error = 'Choose an image no larger than 10 MiB.';
      else if (!selected.size) error = 'The selected file is empty.';
      else if (!(selected.type ? ['image/jpeg', 'image/png'].includes(selected.type) : /\.(jpe?g|png)$/i.test(selected.name))) error = 'Choose a JPEG or PNG image.';
    }
    setValidationError(error);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || validationError) return;
    if (!file) { setValidationError('Select an image first.'); return; }
    // Confirmation can replay an already accepted intent during an outage. Only
    // a new intent depends on the current availability observation.
    if (mode === 'trained' && !submission.current?.asset && (!trainedAvailable || !candidatePatch)) return;
    submission.current ??= { file, key: crypto.randomUUID(), ...(mode === 'trained' ? { provider: PCB_CONFIGURATION, candidatePatch: true as const } : {}) };
    busy.current = true;
    mutation.mutate(submission.current);
  }

  const canRetry = !mutation.error || !(mutation.error instanceof ApiClientError) || mutation.error.retryable;
  const confirmingSubmission = Boolean(uploaded);
  return <>
    <p className="eyebrow">Image inspection</p>
    <h1>Upload an image. See what’s detected.</h1>
    <p className="intro">Choose a simulated demo or the optional trained PCB detector. Results and human reviews are saved so you can reopen them.</p>
    <section className="upload-panel" aria-labelledby="upload-heading">
      <h2 id="upload-heading">Start an inspection</h2>
      <p id="upload-help">Choose one JPEG or PNG, up to 10 MiB and 20 megapixels. Animated and multipage images are not supported. The server validates and auto-orients your image.</p>
      <form onSubmit={submit} aria-busy={mutation.isPending}>
        <fieldset disabled={mutation.isPending} className="inference-mode"><legend>Inspection mode</legend>
          <label><input type="radio" name="inference-mode" value="mock" checked={mode === 'mock'} onChange={() => {
            setMode('mock'); mutation.reset(); submission.current = undefined; setUploaded(undefined);
          }} /> Simulated demo</label>
          <label><input type="radio" name="inference-mode" value="trained" checked={mode === 'trained'} disabled={!trainedAvailable}
            onChange={() => { setMode('trained'); mutation.reset(); submission.current = undefined; setUploaded(undefined); }} /> Trained PCB detector</label>
          <p className="muted">{modes.isFetching ? 'Checking trained model readiness…'
            : modes.error ? 'Trained model availability could not be verified. The simulated demo is available.'
            : trainedAvailable ? 'The pinned trained PCB model is ready. Availability can change; accepted work uses bounded retries.'
            : modes.data?.trained.reason ?? 'Trained mode is unavailable until its readiness has been checked.'}</p>
          <button type="button" className="secondary" disabled={modes.isFetching} onClick={() => { void modes.refetch(); }}>Check trained model availability</button>
          {mode === 'trained' && <label className="candidate-attestation"><input type="checkbox" checked={candidatePatch}
            onChange={event => { setCandidatePatch(event.target.checked); submission.current = undefined; setUploaded(undefined); mutation.reset(); }} />
            I confirm this is a real 300 × 300 PCB candidate patch, not a full-board image or synthetic demo.</label>}
        </fieldset>
        <label htmlFor="image">Image file</label>
        <input ref={fileInput} id="image" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={mutation.isPending}
          aria-describedby="upload-help file-details" aria-invalid={Boolean(validationError)}
          onChange={event => { select(event.target.files?.[0]); }} />
        <p id="file-details" className="file-details">{file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KiB · ${file.type || 'Type checked by server'}` : 'No image selected.'}</p>
        {validationError && <p role="alert">{validationError}</p>}
        {uploaded && <p className="healthy">Image uploaded: {uploaded.width} × {uploaded.height} canonical pixels.</p>}
        <div role="status">
          {phase === 'uploading' && <p>Uploading and validating your image…</p>}
          {phase === 'submitting' && <p>Image saved. Submitting the inspection…</p>}
        </div>
        {mutation.error && <div role="alert" className="error-panel">
          <p>{uploaded ? 'Your image is saved, but the inspection could not be confirmed.' : 'The image upload could not be confirmed.'}</p>
          <p>{mutation.error instanceof ApiClientError ? mutation.error.message : 'Something went wrong. Please try again.'}</p>
          {uploaded && canRetry && <p>Retry submits the same request using the saved image; it will not upload it again.</p>}
          {!uploaded && canRetry && <p>If the connection failed after saving, retrying may create another image asset.</p>}
        </div>}
        <button type="submit" disabled={!file || Boolean(validationError) || mutation.isPending || !canRetry || (mode === 'trained' && !confirmingSubmission && (!candidatePatch || !trainedAvailable))}>
          {mutation.isPending ? phase === 'uploading' ? 'Uploading…' : 'Submitting…'
            : mutation.error ? uploaded ? 'Retry inspection submission' : 'Retry upload' : 'Upload and inspect'}
        </button>
        {file && !mutation.isPending && <button className="secondary reset-file" type="button" onClick={() => {
          if (fileInput.current) fileInput.current.value = '';
          select();
        }}>Choose another image</button>}
        {mutation.error && !canRetry && <p>Select a valid image again to start a new submission.</p>}
      </form>
    </section>
    {mode === 'mock' ? <aside className="notice"><strong>Simulated demo</strong><p>The mock model demonstrates the inspection workflow. Its labels and confidence scores are not real model measurements.</p></aside>
      : <aside className="notice"><strong>Trained model · PCB candidate patches</strong><p>Use an identified 300 × 300 JPEG/PNG AOI candidate patch. This detector does not search complete boards. Scores are not calibrated probabilities of correctness; false alarms and missed defects remain.</p>
        <p>For a repeatable demo, use <code>fixtures/pcb/5810_t_007.jpg</code> from this repository. This training-set smoke fixture is from PCB-IND v4, Hao Yan, Fujian Polytechnic Normal University, <a href="https://zenodo.org/records/19723114" target="_blank" rel="noreferrer">CC BY 4.0</a>. It demonstrates serving, not holdout generalization.</p></aside>}
  </>;
}
