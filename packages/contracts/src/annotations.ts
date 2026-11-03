import { Type } from 'typebox';

export const MAX_DETECTIONS = 200;
// Pixel-to-normalized arithmetic can overshoot a mathematically exact edge by one ULP.
export const NORMALIZED_GEOMETRY_EPSILON = 4 * Number.EPSILON;
export const MOCK_LABELS = [
  { classId: 'surface-mark', label: 'Surface mark' },
  { classId: 'edge-defect', label: 'Edge defect' },
] as const;
export const PCB_LABELS = [
  { classId: 'mouse_bite', label: 'mouse_bite' },
  { classId: 'missing_copper', label: 'missing_copper' },
  { classId: 'scratch', label: 'scratch' },
  { classId: 'spurious_copper', label: 'spurious_copper' },
  { classId: 'copper_burr', label: 'copper_burr' },
  { classId: 'stain', label: 'stain' },
  { classId: 'short', label: 'short' },
  { classId: 'open', label: 'open' },
] as const;

/** A closed registry; an unfamiliar taxonomy must remain unsupported. */
export const TAXONOMIES = { 'mock-v1': MOCK_LABELS, 'pcb-ind-v4-1': PCB_LABELS } as const;
export type TaxonomyVersion = keyof typeof TAXONOMIES;
export function labelsForTaxonomy(taxonomyVersion: string) {
  return Object.hasOwn(TAXONOMIES, taxonomyVersion) ? TAXONOMIES[taxonomyVersion as TaxonomyVersion] : undefined;
}
export const BoundingBoxSchema = Type.Object({
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
  width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
}, { additionalProperties: false });
