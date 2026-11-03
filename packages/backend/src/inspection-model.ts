import mongoose, { type Connection, type InferSchemaType, type Types } from 'mongoose';
import { isInferenceResult, isPersistedReview, isProviderConfiguration, isResultForConfiguration, isReviewForResult } from '@vip/contracts';

const configuration = new mongoose.Schema({
  providerId: { type: String, required: true, enum: ['mock', 'visual-inspection-dl'] },
  modelId: { type: String, required: true, enum: ['mock-detector', 'pcb-ind-ssdlite'] },
  modelVersion: { type: String, required: true, enum: ['1.0.0', 'pcb-ind-ssdlite-v1'] },
  taxonomyVersion: { type: String, enum: ['pcb-ind-v4-1'] },
  artifactDigest: { type: String, match: /^[a-f0-9]{64}$/ },
  confidenceThreshold: { type: Number, enum: [0.2] },
}, { _id: false });

const failure = new mongoose.Schema({
  code: { type: String, required: true }, message: { type: String, required: true },
}, { _id: false });

const receipt = new mongoose.Schema({
  operationId: { type: String, required: true }, fingerprint: { type: String, required: true },
  revision: { type: Number, required: true }, writeSequence: { type: Number, required: true },
}, { _id: false });
const reviewControl = new mongoose.Schema({
  sequence: { type: Number, required: true, min: 0 },
  operations: { type: [receipt], default: undefined },
}, { _id: false });

const schema = new mongoose.Schema({
  assetId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  status: { type: String, enum: ['queued', 'processing', 'completed', 'failed'], required: true, default: 'queued' },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true },
  updatedAt: { type: Date, required: true, default: Date.now },
  processingStartedAt: Date,
  completedAt: Date,
  requested: { type: configuration, required: true, immutable: true,
    validate: (value: unknown) => isProviderConfiguration(value instanceof mongoose.Document ? value.toObject() : value) },
  candidatePatch: { type: Boolean, immutable: true, validate: (value: unknown) => value === undefined || value === true },
  attemptCount: { type: Number, required: true, default: 0, min: 0, max: 3 },
  maxAttempts: { type: Number, required: true, default: 3, min: 1, max: 3, immutable: true },
  dispatchGeneration: { type: Number, required: true, default: 0, min: 0 },
  nextAttemptAt: { type: Date, required: true, default: Date.now },
  attemptId: String,
  leaseExpiresAt: Date,
  requestScope: { type: String, required: true, immutable: true },
  requestKey: { type: String, required: true, immutable: true },
  requestFingerprint: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true },
  retriedFrom: { type: mongoose.Schema.Types.ObjectId, immutable: true },
  failure,
  result: { type: mongoose.Schema.Types.Mixed, validate: isInferenceResult },
  processingDurationMs: Number,
  review: { type: mongoose.Schema.Types.Mixed, validate: isPersistedReview },
  reviewControl,
}, { collection: 'inspections', versionKey: false, bufferCommands: false, autoIndex: false });

schema.pre('validate', function () {
  const requestedValue: unknown = this.requested;
  const requested = requestedValue instanceof mongoose.Document ? requestedValue.toObject() : requestedValue;
  if (isProviderConfiguration(requested) && requested.providerId === 'visual-inspection-dl' && this.candidatePatch !== true) {
    this.invalidate('candidatePatch', 'Trained inspections require an explicitly identified candidate patch.');
  }
  if (this.result !== undefined && !isResultForConfiguration(this.result, requested)) {
    this.invalidate('result', 'Inference provenance must match the immutable requested configuration.');
  }
  if (this.review !== undefined && (!isInferenceResult(this.result) || !isReviewForResult(this.review, this.result))) {
    this.invalidate('review', 'The review must match the original inference taxonomy and predictions.');
  }
});

schema.index({ requestScope: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });
schema.index({ createdAt: -1, _id: -1 });
schema.index({ status: 1, createdAt: -1, _id: -1 });
// Forward lineage lookup: newest child of a failed inspection, limited to one.
schema.index({ retriedFrom: 1, createdAt: -1, _id: -1 });
schema.index({ status: 1, updatedAt: 1 });

export function createInspectionModel(connection: Connection) {
  return connection.model('Inspection', schema);
}
export type InspectionModel = ReturnType<typeof createInspectionModel>;
export type InspectionRecord = InferSchemaType<typeof schema> & { _id: Types.ObjectId };
