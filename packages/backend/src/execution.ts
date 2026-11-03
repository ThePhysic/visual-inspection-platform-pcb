import { createHash, randomUUID } from 'node:crypto';
import { addAbortSignal } from 'node:stream';
import { Value } from 'typebox/value';
import { Worker, UnrecoverableError, type ConnectionOptions, type Job } from 'bullmq';
import {
  InspectionJobSchema, ProviderConfigurationSchema,
  isResultForConfiguration, MAX_IMAGE_PIXELS, type InspectionJob, type InspectionFailure, type ProviderConfiguration,
} from '@vip/contracts';
import { type AssetModel } from './database.js';
import { type InspectionModel } from './inspection-model.js';
import { isImageStorageKey, type LocalImageStorage } from './storage.js';
import { InferenceError, type InferenceProvider, type CanonicalImage } from './provider.js';
import { EXECUTION_POLICY, INSPECTION_QUEUE, redisConnection, closeRedisClients, type ExecutionPolicy, type PipelineLogger } from './queue.js';
import { type OperationalMetrics, type AttemptOutcome } from './metrics.js';

const messages: Record<InspectionFailure['code'], string> = {
  PROVIDER_UNAVAILABLE: 'The inference provider is temporarily unavailable.',
  PROVIDER_TIMEOUT: 'The execution deadline was exceeded.',
  INFERENCE_FAILED: 'Inference failed.',
  INVALID_INFERENCE_RESULT: 'The inference provider returned an invalid result.',
  INVALID_INSPECTION: 'Persisted inspection configuration is invalid.',
  INVALID_ASSET: 'The canonical image or its metadata is invalid.',
  ASSET_UNAVAILABLE: 'Canonical image storage is temporarily unavailable.',
  DATABASE_UNAVAILABLE: 'Inspection persistence is temporarily unavailable.',
  ATTEMPTS_EXHAUSTED: 'The inspection exhausted its execution attempt budget.',
  EXECUTION_INTERRUPTED: 'The previous execution was interrupted.',
};
export function safeFailure(code: InspectionFailure['code']): InspectionFailure { return { code, message: messages[code] }; }
export function retryDelay(attempt: number, policy: ExecutionPolicy) { return policy.backoffMs * 2 ** Math.max(0, attempt - 1); }

async function loadImage(assets: AssetModel, storage: LocalImageStorage, assetId: string, signal: AbortSignal): Promise<CanonicalImage> {
  const asset = await assets.findById(assetId).lean().exec().catch(() => { throw new InferenceError('DATABASE_UNAVAILABLE', true); });
  if (!asset || !isImageStorageKey(asset.storageKey) || !['image/jpeg', 'image/png'].includes(asset.mimeType)
    || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1
    || asset.width * asset.height > MAX_IMAGE_PIXELS || !Number.isInteger(asset.byteLength)
    || asset.byteLength < 1 || asset.byteLength > 80 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new InferenceError('INVALID_ASSET', false);
  }
  let bytes: Buffer;
  try {
    const stream = addAbortSignal(signal, await storage.openContent(asset.storageKey, asset.byteLength));
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += chunk.length;
      if (length > asset.byteLength) { stream.destroy(); throw new InferenceError('INVALID_ASSET', false); }
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks, length);
  } catch (cause) {
    if (cause instanceof InferenceError) throw cause;
    throw new InferenceError('ASSET_UNAVAILABLE', true);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new InferenceError('INVALID_ASSET', false);
  return { bytes, sha256: asset.sha256, mimeType: asset.mimeType, width: asset.width, height: asset.height };
}

async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, shutdown?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let interrupt: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const stop = (code: 'PROVIDER_TIMEOUT' | 'EXECUTION_INTERRUPTED') => {
      const error = new InferenceError(code, true);
      controller.abort(error);
      reject(error);
    };
    timeout = setTimeout(() => { stop('PROVIDER_TIMEOUT'); }, ms);
    interrupt = () => { stop('EXECUTION_INTERRUPTED'); };
    shutdown?.addEventListener('abort', interrupt, { once: true });
    if (shutdown?.aborted) interrupt();
  });
  try { return await Promise.race([work(controller.signal), cancelled]); }
  finally {
    clearTimeout(timeout);
    if (interrupt) shutdown?.removeEventListener('abort', interrupt);
  }
}

export interface ExecutionDependencies {
  inspections: InspectionModel;
  assets: AssetModel;
  storage: LocalImageStorage;
  provider: InferenceProvider;
  providers?: Partial<Record<ProviderConfiguration['providerId'], InferenceProvider>>;
  logger: PipelineLogger;
  policy?: ExecutionPolicy;
  shutdown?: AbortSignal;
  metrics?: OperationalMetrics;
}

export function createInspectionProcessor(dependencies: ExecutionDependencies) {
  const { inspections, assets, storage, provider, logger, metrics } = dependencies;
  const policy = dependencies.policy ?? EXECUTION_POLICY;
  if (policy.leaseMs <= policy.attemptTimeoutMs) throw new Error('Execution lease must exceed the execution deadline.');

  return async function process(job: Pick<Job<InspectionJob>, 'id' | 'data'>) {
    if (!Value.Check(InspectionJobSchema, job.data)) {
      metrics?.ignored('invalid');
      logger.warn({ jobId: job.id }, 'Invalid inspection queue payload discarded');
      return;
    }
    const now = new Date();
    const attemptId = randomUUID();
    const record = await inspections.findOneAndUpdate({
      _id: job.data.inspectionId, status: 'queued', dispatchGeneration: job.data.generation,
      nextAttemptAt: { $lte: now }, $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
    }, {
      $set: { status: 'processing', processingStartedAt: now, updatedAt: now, attemptId,
        leaseExpiresAt: new Date(now.getTime() + policy.leaseMs) },
      $inc: { attemptCount: 1 }, $unset: { failure: 1 },
    }, { returnDocument: 'after' }).lean().exec();
    if (!record) { metrics?.ignored('unclaimed'); return; } // terminal, duplicate, old generation, or not due

    const attemptStarted = performance.now();
    metrics?.attemptStarted();
    let outcome: AttemptOutcome = 'persistence_error';
    let providerDurationMs: number | undefined;
    try {
      const context = { requestId: record.requestId, inspectionId: record._id.toString(), jobId: job.id,
        assetId: record.assetId.toString(), dispatchGeneration: job.data.generation,
        providerId: record.requested?.providerId === 'mock' ? 'mock'
          : record.requested?.providerId === 'visual-inspection-dl' ? 'visual-inspection-dl' : 'invalid',
        modelVersion: record.requested?.modelVersion === '1.0.0' ? '1.0.0'
          : record.requested?.modelVersion === 'pcb-ind-ssdlite-v1' ? 'pcb-ind-ssdlite-v1' : 'invalid',
        backend: record.requested?.providerId === 'mock' ? 'mock'
          : record.requested?.providerId === 'visual-inspection-dl' ? 'trained' : 'invalid',
        queueWaitMs: Math.max(0, now.getTime() - record.createdAt.getTime()),
        ...(record.retriedFrom ? { retriedFrom: record.retriedFrom.toString() } : {}), attemptId, attemptCount: record.attemptCount };
      logger.info({ ...context, from: 'queued', to: 'processing' }, 'Inspection claimed');
      const owned = () => ({ _id: record._id, status: 'processing' as const, attemptId,
        dispatchGeneration: job.data.generation,
        // Evaluate expiry when MongoDB executes the write. A client timestamp
        // captured before a delayed command can authorize an already-expired lease.
        $expr: { $gt: ['$leaseExpiresAt', '$$NOW'] } });
      let result: unknown;
      try {
        result = await withDeadline(async signal => {
          const requested: unknown = record.requested;
          if (!Value.Check(ProviderConfigurationSchema, requested)) throw new InferenceError('INVALID_INSPECTION', false);
          const image = await loadImage(assets, storage, record.assetId.toString(), signal);
          if (requested.providerId === 'visual-inspection-dl'
            && (record.candidatePatch !== true || image.width !== 300 || image.height !== 300)) throw new InferenceError('INVALID_ASSET', false, 'invalid_image');
          signal.throwIfAborted();
          const selected = requested.providerId === 'mock' ? dependencies.providers?.mock ?? provider
            : dependencies.providers?.[requested.providerId];
          if (!selected) throw new InferenceError('PROVIDER_UNAVAILABLE', true, 'unavailable');
          const started = performance.now();
          let observed = false;
          const observe = (state: 'returned' | 'error' | 'cancelled') => {
            if (observed) return;
            observed = true;
            providerDurationMs = Math.max(0, performance.now() - started);
            metrics?.providerFinished(state, providerDurationMs);
          };
          const cancelled = () => { observe('cancelled'); };
          signal.addEventListener('abort', cancelled, { once: true });
          try { const output = await selected.infer(image, signal); observe('returned'); return output; }
          catch (error) { observe('error'); throw error; }
          finally { signal.removeEventListener('abort', cancelled); }
        }, policy.attemptTimeoutMs, dependencies.shutdown);
        if (!isResultForConfiguration(result, record.requested)) {
          throw new InferenceError('INVALID_INFERENCE_RESULT', false);
        }
        result = structuredClone(result);
      } catch (cause) {
        const failure = cause instanceof InferenceError ? cause : new InferenceError('INFERENCE_FAILED', false);
        const retry = failure.retryable && record.attemptCount < record.maxAttempts;
        const date = new Date();
        const changed = await inspections.updateOne(owned(), {
          $set: { status: retry ? 'queued' : 'failed', updatedAt: date, failure: safeFailure(failure.code),
            ...(retry ? { nextAttemptAt: new Date(date.getTime() + retryDelay(record.attemptCount, policy)) } : { completedAt: date }) },
          $unset: { attemptId: 1, leaseExpiresAt: 1 },
        }).exec();
        if (!changed.modifiedCount) { outcome = 'stale'; logger.warn(context, 'Stale failure ignored'); return; }
        outcome = retry ? 'retry' : 'failed';
        metrics?.failure(retry ? 'retry' : 'terminal', failure.code);
        if (!retry) metrics?.terminal('failed', date.getTime() - record.createdAt.getTime());
        logger.warn({ ...context, from: 'processing', to: retry ? 'queued' : 'failed', failureCode: failure.code,
          providerOutcome: failure.providerOutcome,
          providerDurationMs, attemptDurationMs: Math.max(0, performance.now() - attemptStarted),
          processingDurationMs: Math.max(0, date.getTime() - now.getTime()) },
          retry ? 'Inspection retry scheduled' : 'Inspection failed');
        if (retry) throw new Error(failure.code, { cause });
        throw new UnrecoverableError(failure.code);
      }

      // Keep persistence outside the provider-error handler. A lost acknowledgement
      // must never turn an already committed result into a failure or retry.
      const finished = new Date();
      const processingDurationMs = Math.max(0, finished.getTime() - now.getTime());
      const commitStarted = performance.now();
      try {
        const changed = await inspections.updateOne({ ...owned(), result: { $exists: false } }, {
          $set: { status: 'completed', updatedAt: finished, completedAt: finished, result, processingDurationMs },
          $unset: { attemptId: 1, leaseExpiresAt: 1, failure: 1 },
        }, { runValidators: true }).exec();
        if (!changed.modifiedCount) { outcome = 'stale'; logger.warn(context, 'Stale result ignored'); return; }
        outcome = 'completed';
        metrics?.terminal('completed', finished.getTime() - record.createdAt.getTime());
        logger.info({ ...context, from: 'processing', to: 'completed', processingDurationMs, providerDurationMs,
          commitDurationMs: Math.max(0, performance.now() - commitStarted),
          attemptDurationMs: Math.max(0, performance.now() - attemptStarted) }, 'Inspection completed');
      } catch {
        logger.error({ ...context, failureCode: 'DATABASE_UNAVAILABLE' }, 'Inspection result persistence unavailable');
        throw new Error('DATABASE_UNAVAILABLE');
      }
    } finally { metrics?.attemptFinished(outcome, Math.max(0, performance.now() - attemptStarted)); }
  };
}

export function startInspectionWorker(url: string, dependencies: ExecutionDependencies, name = INSPECTION_QUEUE) {
  const redis = redisConnection(url, true);
  // BullMQ duplicates the supplied client for blocking reads. Track ownership
  // through ioredis's public duplicate API so shutdown also covers startup.
  const connections = [redis];
  const duplicate = redis.duplicate.bind(redis);
  redis.duplicate = options => {
    const client = duplicate(options);
    connections.push(client);
    return client;
  };
  redis.on('error', () => { dependencies.logger.warn({ component: 'redis' }, 'Worker connection unavailable'); });
  const shutdown = new AbortController();
  const processor = createInspectionProcessor({ ...dependencies, shutdown: shutdown.signal });
  const worker = new Worker<InspectionJob>(name, processor, { connection: redis as ConnectionOptions, concurrency: 1 });
  worker.on('error', () => { dependencies.logger.error({ component: 'bullmq' }, 'Worker queue error'); });
  worker.on('failed', job => { dependencies.logger.warn({ inspectionId: job?.data.inspectionId, jobId: job?.id }, 'Queue delivery failed'); });
  return { worker, isConnected: () => connections.every(client => client.status === 'ready'), async close() {
    shutdown.abort();
    const force = redis.status !== 'ready';
    if (force) await closeRedisClients(connections);
    try { await worker.close(force); }
    finally { await closeRedisClients(connections); }
  } };
}
