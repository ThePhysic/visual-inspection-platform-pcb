import { Counter, Histogram, Registry } from '@prometheus-io/client';

const routes = new Set([
  '/api/v1/health', '/api/v1/ready', '/api/v1/inference-modes', '/api/v1/assets', '/api/v1/assets/:id', '/api/v1/assets/:id/content',
  '/api/v1/inspections', '/api/v1/inspections/:id', '/api/v1/inspections/:id/review', '/api/v1/inspections/:id/retry',
]);
const failureCodes = new Set(['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'INFERENCE_FAILED', 'INVALID_INFERENCE_RESULT',
  'INVALID_INSPECTION', 'INVALID_ASSET', 'ASSET_UNAVAILABLE', 'DATABASE_UNAVAILABLE', 'ATTEMPTS_EXHAUSTED', 'EXECUTION_INTERRUPTED']);
export const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
export type AttemptOutcome = 'completed' | 'retry' | 'failed' | 'stale' | 'persistence_error';
export function errorCategory(status: number) {
  return status === 503 ? 'dependency' : status >= 500 ? 'internal' : status === 409 ? 'conflict'
    : status === 404 ? 'not_found' : status === 400 || status === 413 || status === 415 || status === 422 ? 'validation' : 'request';
}

/** One explicit registry per process/app, never the global client registry. */
export class OperationalMetrics {
  readonly registry = new Registry();
  private counter(name: string, help: string, labelNames: string[] = []) {
    return new Counter({ name: `vip_${name}`, help, labelNames, registers: [this.registry] });
  }
  private histogram(name: string, help: string, labelNames: string[] = []) {
    return new Histogram({ name: `vip_${name}_seconds`, help, labelNames, buckets: DURATION_BUCKETS, registers: [this.registry] });
  }
  private readonly requests = this.counter('http_requests_total', 'Completed HTTP responses', ['route', 'method', 'status_class']);
  private readonly httpDuration = this.histogram('http_request_duration', 'HTTP response duration, including response streaming', ['route', 'method']);
  private readonly errors = this.counter('http_errors_total', 'HTTP error responses, once per response', ['category']);
  private readonly started = this.counter('inspection_attempts_started_total', 'Successfully claimed application attempts');
  private readonly attempts = this.counter('inspection_attempts_finished_total', 'Observed attempt outcomes; process crashes may leave starts unmatched', ['outcome']);
  private readonly attemptDuration = this.histogram('inspection_attempt_duration', 'Claimed attempt execution duration', ['outcome']);
  private readonly providerDuration = this.histogram('provider_duration', 'Observed provider invocation duration, distinct from deterministic result.durationMs', ['outcome']);
  private readonly deliveries = this.counter('inspection_deliveries_ignored_total', 'Invalid or unclaimed deliveries that execute no attempt', ['reason']);
  private readonly failures = this.counter('inspection_failures_total', 'Committed retry/terminal failure transitions', ['kind', 'code']);
  private readonly terminalDuration = this.histogram('inspection_terminal_latency', 'Persisted creation to terminal timestamp on acknowledged transition', ['status']);
  private readonly committed = this.counter('inspection_terminals_total', 'Acknowledged authoritative terminal transitions', ['status']);
  private readonly dispatches = this.counter('dispatch_total', 'Dispatch observations, not unique jobs or inspections', ['outcome', 'source']);
  private readonly reconciliations = this.counter('reconciliation_total', 'Reconciliation pass outcome', ['outcome']);
  private readonly repairs = this.counter('lease_repairs_total', 'Acknowledged expired lease repairs', ['outcome']);

  constructor(readonly now: () => number = () => performance.now()) {}
  elapsed(start: number) { return Math.max(0, this.now() - start); }
  http(route: string | undefined, method: string, status: number, durationMs: number) {
    const labels = { route: routes.has(route ?? '') ? route! : 'unmatched',
      method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method) ? method : 'OTHER' };
    this.requests.inc({ ...labels, status_class: status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other' });
    this.httpDuration.observe(labels, Math.max(0, durationMs) / 1000);
    if (status >= 400) this.errors.inc({ category: errorCategory(status) });
  }
  attemptStarted() { this.started.inc(); }
  attemptFinished(outcome: AttemptOutcome, ms: number) { this.attempts.inc({ outcome }); this.attemptDuration.observe({ outcome }, ms / 1000); }
  providerFinished(outcome: 'returned' | 'error' | 'cancelled', ms: number) { this.providerDuration.observe({ outcome }, ms / 1000); }
  ignored(reason: 'invalid' | 'unclaimed') { this.deliveries.inc({ reason }); }
  failure(kind: 'retry' | 'terminal', code: string) { this.failures.inc({ kind, code: failureCodes.has(code) ? code : 'OTHER' }); }
  terminal(status: 'completed' | 'failed', ms: number) { this.committed.inc({ status }); this.terminalDuration.observe({ status }, Math.max(0, ms) / 1000); }
  dispatch(outcome: 'added' | 'present' | 'finished' | 'error', source: 'prompt' | 'reconciliation' = 'reconciliation') {
    this.dispatches.inc({ outcome, source });
  }
  reconciliation(outcome: 'ok' | 'error') { this.reconciliations.inc({ outcome }); }
  repair(outcome: 'queued' | 'failed') { this.repairs.inc({ outcome }); }
}
