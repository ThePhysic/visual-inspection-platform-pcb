import { BoundingBoxSchema, NORMALIZED_GEOMETRY_EPSILON } from '@vip/contracts';
import { type Static } from 'typebox';
import { Value } from 'typebox/value';

export type Box = Static<typeof BoundingBoxSchema>;
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export type PixelBox = Box;
export const MIN_BOX_PX = 12;
const EPSILON = 1e-10;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function validBox(value: unknown): value is Box {
  return Value.Check(BoundingBoxSchema, value) && Object.values(value).every(Number.isFinite)
    && value.x + value.width <= 1 + NORMALIZED_GEOMETRY_EPSILON
    && value.y + value.height <= 1 + NORMALIZED_GEOMETRY_EPSILON;
}
function assertSize(size: Size) {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new Error('Invalid image viewport.');
}
export function canvasViewport(displayed: Size) {
  assertSize(displayed);
  // Konva rounds canvas CSS dimensions. Keep its internal rectangle integral
  // and scale the DOM to the exact (possibly fractional) image rectangle.
  const size = { width: Math.ceil(displayed.width), height: Math.ceil(displayed.height) };
  const scale = { x: displayed.width / size.width, y: displayed.height / size.height };
  return { size, scale, minimum: { width: MIN_BOX_PX / scale.x, height: MIN_BOX_PX / scale.y } };
}
function assertFinite(box: PixelBox) {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw new Error('Invalid pixel geometry.');
}
export function sameBox(a: Box, b: Box) {
  return (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) <= EPSILON);
}
export function toPixels(box: Box, size: Size): PixelBox {
  assertSize(size);
  if (!validBox(box)) throw new Error('Invalid normalized box.');
  return { x: box.x * size.width, y: box.y * size.height, width: box.width * size.width, height: box.height * size.height };
}
export function toNormalized(box: PixelBox, size: Size): Box {
  assertSize(size); assertFinite(box);
  const rawX = box.x / size.width, rawY = box.y / size.height;
  const x = Math.max(0, rawX), y = Math.max(0, rawY);
  const width = box.width / size.width, height = box.height / size.height;
  if (box.width <= 0 || box.height <= 0 || rawX < -EPSILON || rawY < -EPSILON || x + width > 1 + EPSILON || y + height > 1 + EPSILON) throw new Error('Pixel box is outside the image.');
  // Only absorb arithmetic noise at image boundaries; do not round
  // ordinary coordinates or accumulate viewport pixels in the domain draft.
  const normalized = { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
  if (!validBox(normalized)) throw new Error('Invalid normalized box.');
  return normalized;
}
export function clampPoint(point: Point, size: Size): Point {
  assertSize(size);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid pointer position.');
  return { x: clamp(point.x, 0, size.width), y: clamp(point.y, 0, size.height) };
}
export function dragBox(box: Box, desired: Point, size: Size): Box {
  const pixels = toPixels(box, size);
  clampPoint(desired, size); // finite input validation
  return toNormalized({ ...pixels, x: clamp(desired.x, 0, size.width - pixels.width), y: clamp(desired.y, 0, size.height - pixels.height) }, size);
}
export function constrainResize(previous: PixelBox, candidate: PixelBox, size: Size, minimum: Size = { width: MIN_BOX_PX, height: MIN_BOX_PX }): PixelBox {
  toNormalized(previous, size);
  assertSize(minimum);
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)
    || candidate.width <= 0 || candidate.height <= 0) return previous;
  const left = clamp(candidate.x, 0, size.width), top = clamp(candidate.y, 0, size.height);
  const right = clamp(candidate.x + candidate.width, 0, size.width), bottom = clamp(candidate.y + candidate.height, 0, size.height);
  const next = { x: left, y: top, width: right - left, height: bottom - top };
  // Existing tiny predictions may retain their size. Never silently enlarge
  // them just by selecting/dragging; new drawings require the full minimum.
  if (next.width < Math.min(minimum.width, previous.width) || next.height < Math.min(minimum.height, previous.height)) return previous;
  return next;
}
export function transformBox(previous: Box, node: PixelBox & { scaleX: number; scaleY: number }, size: Size, minimum?: Size): Box {
  if (!Number.isFinite(node.scaleX) || !Number.isFinite(node.scaleY) || node.scaleX <= 0 || node.scaleY <= 0) return previous;
  return toNormalized(constrainResize(toPixels(previous, size), {
    x: node.x, y: node.y, width: node.width * node.scaleX, height: node.height * node.scaleY,
  }, size, minimum), size);
}
export function drawingPixels(start: Point, end: Point, size: Size): PixelBox {
  const a = clampPoint(start, size), b = clampPoint(end, size);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
export function finishDrawing(start: Point, end: Point, size: Size, minimum: Size = { width: MIN_BOX_PX, height: MIN_BOX_PX }): Box | undefined {
  const box = drawingPixels(start, end, size);
  assertSize(minimum);
  if (box.width < Math.min(minimum.width, size.width) || box.height < Math.min(minimum.height, size.height)) return undefined;
  return toNormalized(box, size);
}
