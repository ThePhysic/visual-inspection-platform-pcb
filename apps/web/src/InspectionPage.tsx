import { Link, useParams, useLocation } from 'react-router';
import { Value } from 'typebox/value';
import { InspectionStatusSchema } from '@vip/contracts';
import RetryInspection from './RetryInspection';
import { useQuery } from '@tanstack/react-query';
import { ApiClientError, fetchAsset } from './api';
import { inspectionQuery } from './queries';
import DetectionViewer from './DetectionViewer';
import ReviewWorkspace from './annotations/ReviewWorkspace';
import { canEdit } from './annotations/draft';

export default function InspectionPage() {
  const { inspectionId = '' } = useParams();
  const location = useLocation();
  const navigation = location.state as { historyStatus?: unknown } | null;
  const historyStatus = Value.Check(InspectionStatusSchema, navigation?.historyStatus) ? navigation.historyStatus : undefined;
  const inspection = useQuery(inspectionQuery(inspectionId));
  const record = inspection.data;
  const assetId = record?.status === 'completed' ? record.assetId : '';
  const asset = useQuery({ queryKey: ['asset', assetId], queryFn: ({ signal }) => fetchAsset(assetId, signal), enabled: Boolean(assetId), staleTime: Infinity });
  const invalid = !/^[a-f0-9]{24}$/i.test(inspectionId);
  const retryable = !(inspection.error instanceof ApiClientError) || inspection.error.retryable;
  return <>
    <Link to="/">← New inspection</Link>
    {' · '}<Link to={`/inspections${historyStatus ? `?status=${historyStatus}` : ''}`}>Back to history</Link>
    <h1>Inspection</h1>
    <p className="inspection-id">{inspectionId}</p>
    {invalid ? <div role="alert"><h2>Invalid inspection link</h2><p>An inspection ID must contain 24 hexadecimal characters. Check the URL or start a new inspection.</p></div>
      : <>
        {!record && inspection.isPending && <p role="status">{inspection.fetchStatus === 'paused' ? 'Waiting for a network connection to load this inspection…' : 'Loading inspection…'}</p>}
        {record && inspection.fetchStatus === 'paused' && <p role="status">Updates are paused until a network connection is available. Showing the last received state.</p>}
        {inspection.error && <div role="alert" className="error-panel">
          <p>{record ? 'Updates are temporarily unavailable. Showing the last received result or state.' : 'Could not load this inspection.'}</p>
          <p>{inspection.error instanceof ApiClientError ? inspection.error.message : 'Please check your connection and try again.'}</p>
          {retryable && <button type="button" disabled={inspection.isFetching} onClick={() => { void inspection.refetch({ cancelRefetch: false }); }}>Try fetching again</button>}
        </div>}
        {record && <>
          {record.retriedFrom && <p className="notice">This is a new retry attempt. <Link to={`/inspections/${record.retriedFrom}`} state={location.state}>View previous attempt</Link></p>}
          <section className="status-panel" aria-labelledby="status-heading">
            {record.status !== 'completed' && <p className="badge">{record.requested.providerId === 'mock' ? 'Simulated demo' : 'Trained model'}</p>}
            <div role="status">
              <h2 id="status-heading">{record.status === 'queued' ? 'Queued' : record.status === 'processing' ? 'Processing' : record.status === 'completed' ? 'Completed' : 'Inspection failed'}</h2>
              {record.status === 'queued' && <p>Your inspection is saved and waiting for the worker. This page checks for updates automatically.</p>}
              {record.status === 'processing' && <p>The worker is inspecting your image with {record.requested.providerId === 'mock' ? 'the simulated model' : 'the trained PCB model'}. Results will appear automatically.</p>}
              {record.status === 'completed' && <p>{record.result.simulated ? 'Simulated inference' : 'Trained PCB inference'} is complete. Original predictions are read-only; corrections can be reviewed and saved separately.</p>}
            </div>
            {record.status === 'failed' && <>
              <div role="alert"><p>{record.failure.message}</p><p>Failure code: <code>{record.failure.code}</code>.</p></div>
              {record.latestRetryId && <p><Link to={`/inspections/${record.latestRetryId}`} state={location.state}>View latest retry</Link></p>}
              <RetryInspection key={record.id} inspectionId={record.id} />
            </>}
            <button className="secondary" type="button" disabled={inspection.isFetching} onClick={() => { void inspection.refetch({ cancelRefetch: false }); }}>Refresh status</button>
          </section>
          {record.status === 'completed' && <>
            <section aria-labelledby="results-heading">
              <div className="result-heading"><h2 id="results-heading">Inspection results</h2><span className="badge">{record.result.simulated ? 'Simulated demo' : 'Trained model'}</span></div>
              <dl className="model-details">
                <div><dt>Provider</dt><dd>{record.result.providerId}</dd></div>
                <div><dt>Model</dt><dd>{record.result.modelId} · {record.result.modelVersion}</dd></div>
                <div><dt>Taxonomy</dt><dd>{record.result.taxonomyVersion}</dd></div>
                {!record.result.simulated && <div><dt>Release digest</dt><dd><details><summary><code>{record.result.artifactDigest.slice(0, 12)}…</code></summary><code>{record.result.artifactDigest}</code></details></dd></div>}
                <div><dt>Worker processing</dt><dd>{record.processingDurationMs.toFixed(1)} ms</dd></div>
                {!record.result.simulated && <div><dt>Worker to model HTTP</dt><dd>{record.result.durationMs.toFixed(1)} ms (transfer and response decoding included)</dd></div>}
                {!record.result.simulated && <div><dt>Python request timing</dt><dd>{record.result.providerTimingMs.requestTotal.toFixed(1)} ms (service only)</dd></div>}
              </dl>
              {!record.result.simulated && <aside className="notice"><p>Predictions apply to this PCB candidate patch, not a complete-board diagnosis. Confidence scores are not calibrated probabilities of correctness. False alarms and missed defects remain; review each prediction and add missed defects.</p></aside>}
              {asset.isPending && <p role="status">Loading canonical image metadata…</p>}
              {asset.error && <div role="alert"><p>Image metadata could not be refreshed. Predictions remain available.</p><button type="button" disabled={asset.isFetching} onClick={() => { void asset.refetch({ cancelRefetch: false }); }}>Retry image metadata</button></div>}
              {canEdit(record.result) ? <ReviewWorkspace key={record.id} inspectionId={record.id} asset={asset.data} result={record.result} review={record.review} reviewWriteSequence={record.reviewWriteSequence} />
                : <><p>This taxonomy is available for viewing only.</p><DetectionViewer key={assetId} asset={asset.data} result={record.result} /></>}
            </section>
          </>}
        </>}
      </>}
  </>;
}
