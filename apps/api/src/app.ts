import Fastify, { LogController, type FastifyError, type FastifyServerOptions } from 'fastify';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import {
  ApiErrorResponseSchema,
  HEALTH_PATH,
  HealthResponseSchema,
  INFERENCE_MODES_PATH,
  InferenceModesSchema,
  INSPECTIONS_PATH,
  type ApiErrorResponse,
  type HealthResponse,
} from '@vip/contracts';
import { ApiError } from './errors.js';
import { admitRequest, LOCAL_HOSTS } from './admission.js';
import { registerAssetRoutes, multipartLimits, type AssetDependencies } from './assets.js';
import { registerInspectionRoutes } from './inspections.js';
import { OperationalMetrics, errorCategory, type InspectionDependencies, type InspectionQueue } from '@vip/backend';

export function buildApp(options: Pick<FastifyServerOptions, 'logger'> & {
  assets?: AssetDependencies;
  inspections?: InspectionDependencies;
  dispatchQueue?: Pick<InspectionQueue, 'healthy'>;
  notifyAccepted?: (inspectionId: string) => void;
  metrics?: OperationalMetrics;
  allowedHosts?: readonly string[];
  trainedInference?: { enabled: boolean; ready: () => Promise<boolean> };
} = {}) {
  const app = Fastify({
    logger: false,
    logController: new LogController({ requestIdLogLabel: 'requestId', disableRequestLogging: true }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    requestTimeout: 30_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const metrics = options.metrics ?? new OperationalMetrics();
  const starts = new WeakMap<object, number>();
  app.addHook('onRequest', async (request, reply) => {
    starts.set(request, metrics.now());
    reply.header('X-Request-Id', request.id);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    // Route templates retain useful diagnostics without recording query values
    // or arbitrary path/header data in the normal access log.
    request.log.info({ method: request.method, route: request.routeOptions.url ?? 'unmatched' }, 'Request received');
    admitRequest(request, options.allowedHosts ?? LOCAL_HOSTS);
  });
  app.addHook('onResponse', async (request, reply) => {
    const start = starts.get(request);
    if (start !== undefined) metrics.http(request.routeOptions.url, request.method, reply.statusCode, metrics.elapsed(start));
    request.log.info({ statusCode: reply.statusCode, responseTime: start === undefined ? undefined : metrics.elapsed(start) }, 'Request completed');
    starts.delete(request);
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.validation ? 400 : (error.statusCode ?? 500);
    const serverError = statusCode >= 500;
    const inspectionId = request.routeOptions.url?.startsWith(INSPECTIONS_PATH);

    if (serverError) {
      request.log.error({ statusCode, errorCategory: errorCategory(statusCode),
        failureCode: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' }, 'Request failed');
    }

    const response: ApiErrorResponse = {
      error: {
        code: error instanceof ApiError ? error.code
          : error.validationContext === 'params' ? inspectionId ? 'INVALID_INSPECTION_ID' : 'INVALID_ASSET_ID'
          : error.validation ? request.routeOptions.url?.endsWith('/review') ? 'INVALID_REVIEW'
          : request.method === 'GET' && request.routeOptions.url === INSPECTIONS_PATH ? 'INVALID_HISTORY_QUERY'
          : 'INVALID_REQUEST' : serverError ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: error instanceof ApiError ? error.message
          : error.validationContext === 'params' ? `${inspectionId ? 'Inspection' : 'Asset'} ID must be 24 hexadecimal characters.`
          : error.validation ? 'Request validation failed.' : serverError ? 'An unexpected error occurred.' : error.message,
        requestId: request.id,
      },
    };

    void reply.code(statusCode).send(response);
  });

  app.register(multipart, { limits: multipartLimits });
  registerAssetRoutes(app, options.assets, options.dispatchQueue);
  registerInspectionRoutes(app, options.inspections, options.notifyAccepted);

  app.get(INFERENCE_MODES_PATH, {
    schema: { querystring: Type.Object({}, { additionalProperties: false }),
      response: { 200: InferenceModesSchema, 400: ApiErrorResponseSchema } },
  }, async () => {
    const enabled = options.trainedInference?.enabled === true;
    // Availability is an observation, not part of durable acceptance or API health.
    const available = enabled && await options.trainedInference!.ready().catch(() => false);
    return { trained: { enabled, available,
      ...(!available ? { reason: enabled
        ? 'The pinned trained PCB model is not ready. Check the inference service and retry the availability check.'
        : 'Trained PCB inference is not enabled. Start the optional real-model stack.' } : {}) } };
  });

  app.setNotFoundHandler((request, reply) => {
    const response: ApiErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: request.id,
      },
    };
    void reply.code(404).send(response);
  });

  app.get(HEALTH_PATH, {
    schema: {
      querystring: Type.Object({}, { additionalProperties: false }),
      response: {
        200: HealthResponseSchema,
        400: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
      },
    },
  }, async (): Promise<HealthResponse> => ({
    apiVersion: 'v1',
    service: 'visual-inspection-api',
    status: 'ok',
  }));

  return app;
}
