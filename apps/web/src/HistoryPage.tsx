import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Value } from 'typebox/value';
import { InspectionStatusSchema, type InspectionStatus } from '@vip/contracts';
import { ApiClientError, fetchHistory } from './api';

const statusLabels: Record<InspectionStatus, string> = { queued: 'Queued', processing: 'Processing', completed: 'Completed', failed: 'Failed' };
function Preview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="history-preview preview-unavailable">Preview unavailable</span>
    : <img className="history-preview" src={url} alt="Canonical inspection preview" loading="lazy" decoding="async" width={112} height={84}
      onError={() => { setFailed(true); }} />;
}

export default function HistoryPage() {
  const [parameters, setParameters] = useSearchParams();
  const rawStatus = parameters.get('status');
  const status = Value.Check(InspectionStatusSchema, rawStatus) ? rawStatus : undefined;
  const invalid = (rawStatus !== null && !status) || parameters.getAll('status').length > 1;
  const client = useQueryClient();
  const key = ['inspection-history', status ?? 'all'];
  const history = useInfiniteQuery({
    queryKey: key, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchHistory({ ...(status ? { status } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    getNextPageParam: page => page.nextCursor,
    enabled: !invalid, retry: false, staleTime: 30_000, refetchOnWindowFocus: false,
  });
  // Defensive deduplication also covers records changing filter membership while
  // pages are being browsed. Keep the ordering of the first received occurrence.
  const items = [...new Map(history.data?.pages.flatMap(page => page.items).map(item => [item.id, item]) ?? []).values()];
  const restart = () => { void client.resetQueries({ queryKey: key, exact: true }); };
  const badCursor = history.error instanceof ApiClientError && ['INVALID_CURSOR', 'INVALID_HISTORY_QUERY'].includes(history.error.code ?? '');
  return <>
    <h1>Inspection history</h1>
    <p>Reopen inspections and saved reviews. Statuses reflect the last fetch; refresh for newer activity. Each inspection keeps its original selected model.</p>
    <div className="history-tools">
      <div><label htmlFor="history-status">Inspection status</label>
        <select id="history-status" value={status ?? 'all'} onChange={event => {
          setParameters(event.target.value === 'all' ? {} : { status: event.target.value });
        }}>
          <option value="all">All</option>
          {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <button type="button" className="secondary" disabled={invalid || history.isFetching} onClick={restart}>Refresh history</button>
    </div>
    {invalid ? <div role="alert"><p>This history status filter is invalid.</p><button type="button" onClick={() => { setParameters({}); }}>Show all inspections</button></div> : <>
      {history.isPending && <p role="status">{history.fetchStatus === 'paused' ? 'Waiting for a connection to load history…' : 'Loading inspection history…'}</p>}
      {history.data && history.fetchStatus === 'paused' && <p role="status">History updates are paused until a connection is available. Loaded inspections are retained.</p>}
      {history.error && <div role="alert" className="error-panel">
        <p>{items.length ? 'Could not update history. Previously loaded inspections are retained.' : 'Could not load inspection history.'}</p>
        <p>{history.error instanceof ApiClientError ? history.error.message : 'Please check your connection and try again.'}</p>
        {badCursor ? <button type="button" disabled={history.isFetching} onClick={restart}>Restart history browsing</button>
          : <button type="button" disabled={history.isFetching} onClick={() => {
            if (history.isFetchNextPageError) void history.fetchNextPage({ cancelRefetch: false });
            else void history.refetch({ cancelRefetch: false });
          }}>Retry history request</button>}
      </div>}
      {!history.isPending && !history.error && !items.length && <section className="notice">
        <h2>{status ? `No ${status} inspections` : 'No inspections yet'}</h2>
        <p>{status ? 'Choose another status or refresh after an inspection changes state.' : 'Upload an image to create your first inspection.'}</p>
        <Link to="/">Start a new inspection</Link>
      </section>}
      <ol className="history-list" aria-label="Inspection history">
        {items.map(item => <li key={item.id} className="history-card">
          <Preview key={item.previewUrl} url={item.previewUrl} />
          <div className="history-summary">
            <h2><Link to={`/inspections/${item.id}`} state={{ historyStatus: status ?? 'all' }}>
              Inspection · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
            </Link></h2>
            <p><strong>{statusLabels[item.status]}</strong> · Updated <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString()}</time></p>
            {item.requested && <p><span className="badge">{item.requested.providerId === 'mock' ? 'Simulated demo' : 'Trained model'}</span> · {item.requested.modelVersion}</p>}
            {item.status === 'completed' && <p>{item.detectionCount} original {item.detectionCount === 1 ? 'detection' : 'detections'} · {item.hasReview ? `Saved review · revision ${item.reviewRevision}` : 'No saved review'}</p>}
            {item.status === 'failed' && <p>{item.failure.message}</p>}
            {item.retriedFrom && <p>Retry attempt · <Link to={`/inspections/${item.retriedFrom}`} state={{ historyStatus: status ?? 'all' }}>View previous attempt</Link></p>}
          </div>
        </li>)}
      </ol>
      {history.hasNextPage && !badCursor && <button type="button" disabled={history.isFetching} onClick={() => { void history.fetchNextPage({ cancelRefetch: false }); }}>
        {history.isFetchingNextPage ? 'Loading more inspections…' : 'Load more inspections'}
      </button>}
      {history.data && !history.hasNextPage && items.length > 0 && <p role="status">End of inspection history.</p>}
    </>}
  </>;
}
