import { pino } from 'pino';
import {
  readBackendConfig, connectDatabase, createAssetModel, createInspectionModel,
  LocalImageStorage, MockInferenceProvider, startInspectionWorker,
  checkDatabase, EXECUTION_POLICY, OperationalMetrics, operatorPort, startOperatorServer,
  readInferenceConfig, PcbInferenceProvider, checkTrainedModelReadiness,
} from '@vip/backend';
import { startHealthFile } from './health.js';

const logger = pino({ name: 'inspection-worker' });

async function main() {
  const config = readBackendConfig(process.env);
  const inference = readInferenceConfig(process.env);
  const operationsPort = operatorPort(process.env.WORKER_OPERATOR_PORT);
  const metrics = new OperationalMetrics();
  const connection = await connectDatabase(config.mongodbUri);
  connection.on('error', () => { logger.error('MongoDB connection error'); });
  const assets = createAssetModel(connection);
  const inspections = createInspectionModel(connection);
  try { await Promise.all([assets.createIndexes(), inspections.createIndexes()]); }
  catch (error) { await connection.close(); throw error; }

  const consumer = startInspectionWorker(config.redisUrl, {
    inspections, assets, storage: new LocalImageStorage(config.storageDirectory),
    provider: new MockInferenceProvider(), logger, metrics,
    ...(inference.enabled && inference.url ? {
      providers: { 'visual-inspection-dl': new PcbInferenceProvider({ url: inference.url, timeoutMs: inference.timeoutMs }) },
    } : {}),
  });
  const active = new Map<string, number>();
  let lastCompletedAt: number | null = null;
  consumer.worker.on('active', job => { if (job.id) active.set(job.id, Date.now()); });
  consumer.worker.on('completed', job => { if (job.id) active.delete(job.id); lastCompletedAt = Date.now(); });
  consumer.worker.on('failed', job => { if (job?.id) active.delete(job.id); });
  const health = process.env.WORKER_HEALTH_FILE ? startHealthFile(process.env.WORKER_HEALTH_FILE, async () => {
    const mongodb = await checkDatabase(connection).then(() => true, () => false);
    const trainedModel = inference.enabled && inference.url ? await checkTrainedModelReadiness(inference.url) : undefined;
    return { mongodb, redis: consumer.isConnected(), running: consumer.worker.isRunning() && !consumer.worker.isPaused(),
      ...(trainedModel !== undefined ? { trainedModelAvailable: trainedModel } : {}),
      oldestActiveAt: active.size ? Math.min(...active.values()) : null, lastCompletedAt };
  }, EXECUTION_POLICY.leaseMs + 10_000) : undefined;
  let closing = false;
  let operations: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
  async function shutdown(signal: string) {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Worker shutting down');
    try { await consumer.close(); }
    catch { logger.error('Worker shutdown failed'); process.exitCode = 1; }
    finally { await operations?.close(); await health?.close(); await connection.close(); }
  }
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  try {
    if (operationsPort) operations = await startOperatorServer(metrics, operationsPort);
    await consumer.worker.waitUntilReady();
  }
  catch (error) { await shutdown('startup-failure'); throw error; }
  if (!closing) logger.info(inference.enabled
    ? 'Inspection worker ready; explicit mock and trained PCB providers configured'
    : 'Inspection worker ready; inference is simulated');
}

main().catch(() => { logger.error('Worker startup failed; check dependency configuration'); process.exitCode = 1; });
