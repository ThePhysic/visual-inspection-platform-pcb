import { describe, expect, it } from 'vitest';
import { isInferenceResult, NORMALIZED_GEOMETRY_EPSILON } from '@vip/contracts';
import { pcbResult } from '../test/fixtures';
import { canvasViewport, clampPoint, constrainResize, dragBox, drawingPixels, finishDrawing, sameBox, toNormalized, toPixels, transformBox, validBox, type Box } from './geometry';

const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
describe('canonical annotation geometry', () => {
  it('maps an integral canvas to fractional CSS image dimensions without changing normalized motion', () => {
    const display = { width: 357.5, height: 715 };
    const { size, scale, minimum } = canvasViewport(display);
    expect(size).toEqual({ width: 358, height: 715 });
    expect(size.width * scale.x).toBe(display.width); expect(size.height * scale.y).toBe(display.height);
    const pixels = toPixels(box, size);
    const moved = dragBox(box, { x: pixels.x + 22 / scale.x, y: pixels.y + 15 / scale.y }, size);
    expect(moved.x).toBeCloseTo(box.x + 22 / display.width, 12);
    expect(moved.y).toBeCloseTo(box.y + 15 / display.height, 12);
    expect(minimum.width * scale.x).toBeCloseTo(12, 12);
    expect(finishDrawing({ x: 0, y: 0 }, { x: 11.9 / scale.x, y: 20 }, size, minimum)).toBeUndefined();
    expect(finishDrawing({ x: 0, y: 0 }, { x: 12 / scale.x, y: 12 }, size, minimum)).toBeDefined();
  });
  it('absorbs only boundary arithmetic noise while keeping boxes valid', () => {
    expect(toNormalized({ x: -1e-14, y: -1e-14, width: 100 + 1e-14, height: 100 + 1e-14 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  it.each([Math.fround(1.3323e-13), 4.4952189919568735])('renders contract-valid unrounded right-edge geometry for pixel x_min=%s without mutating predictions', xMin => {
    const boundary = { x: xMin / 300, y: 0, width: (300 - xMin) / 300, height: 100 / 300 };
    expect(boundary.x + boundary.width).toBeGreaterThan(1);
    const prediction = { ...pcbResult, detections: [{ ...pcbResult.detections[0]!, boundingBox: boundary }] };
    const original = structuredClone(prediction);
    expect(isInferenceResult(prediction)).toBe(true);
    expect(validBox(boundary)).toBe(true);
    expect(toPixels(boundary, { width: 600, height: 600 })).toEqual({
      x: boundary.x * 600, y: 0, width: boundary.width * 600, height: boundary.height * 600,
    });
    expect(prediction).toEqual(original);
    const invalid = { ...boundary, width: boundary.width + 16 * NORMALIZED_GEOMETRY_EPSILON };
    expect(validBox(invalid)).toBe(false);
    expect(() => toPixels(invalid, { width: 600, height: 600 })).toThrow('Invalid normalized box');
  });
  it.each([{ width: 640, height: 320 }, { width: 320, height: 640 }, { width: 287.375, height: 143.6875 }])('converts and round trips within $width × $height CSS pixels', size => {
    const pixels = toPixels(box, size);
    expect(pixels).toEqual({ x: size.width * 0.1, y: size.height * 0.2, width: size.width * 0.3, height: size.height * 0.4 });
    const normalized = toNormalized(pixels, size);
    expect(sameBox(normalized, box)).toBe(true);
    expect(validBox(normalized)).toBe(true);
  });
  it('preserves canonical geometry across repeated responsive round trips', () => {
    let current: Box = { x: 0.123456789123, y: 0.234567891234, width: 0.345678912345, height: 0.456789123456 };
    const original = { ...current };
    for (let index = 0; index < 1000; index++) {
      const size = index % 2 ? { width: 317.57, height: 635.14 } : { width: 913.25, height: 456.625 };
      current = toNormalized(toPixels(current, size), size);
    }
    expect(sameBox(current, original)).toBe(true);
    expect(current.x).toBeCloseTo(original.x, 12);
  });
  it('clamps dragging at every image boundary while preserving size', () => {
    const size = { width: 200, height: 100 };
    expect(dragBox(box, { x: -100, y: -100 }, size)).toEqual({ x: 0, y: 0, width: 0.3, height: 0.4 });
    const bottomRight = dragBox(box, { x: 1000, y: 1000 }, size);
    expect(bottomRight.x).toBeCloseTo(0.7); expect(bottomRight.y).toBeCloseTo(0.6);
    expect(bottomRight.width).toBeCloseTo(box.width); expect(bottomRight.height).toBeCloseTo(box.height);
    expect(validBox(bottomRight)).toBe(true);
    expect(dragBox(box, { x: 60, y: 10 }, size)).toEqual({ x: 0.3, y: 0.1, width: 0.3, height: 0.4 });
  });
  it.each([
    { x: -20, y: 10, width: 90, height: 50 }, // left edge
    { x: 20, y: -30, width: 50, height: 90 }, // top edge
    { x: 20, y: 10, width: 110, height: 50 }, // right edge
    { x: 20, y: 10, width: 50, height: 120 }, // bottom edge
    { x: -20, y: -20, width: 90, height: 90 }, // top left
    { x: 20, y: -20, width: 110, height: 90 }, // top right
    { x: -20, y: 10, width: 90, height: 120 }, // bottom left
    { x: 20, y: 10, width: 110, height: 120 }, // bottom right
  ])('clips edge/corner resizing to the image: %j', candidate => {
    const size = { width: 100, height: 100 };
    const resized = constrainResize({ x: 20, y: 10, width: 50, height: 50 }, candidate, size);
    expect(resized.x).toBe(Math.max(0, candidate.x)); expect(resized.y).toBe(Math.max(0, candidate.y));
    expect(resized.x + resized.width).toBe(Math.min(100, candidate.x + candidate.width));
    expect(resized.y + resized.height).toBe(Math.min(100, candidate.y + candidate.height));
    expect(validBox(toNormalized(resized, size))).toBe(true);
  });
  it.each([
    { x: 20, y: 10, width: 0, height: 40 }, { x: 20, y: 10, width: -5, height: 40 },
    { x: 20, y: 10, width: 40, height: -5 }, { x: 20, y: 10, width: 11, height: 40 },
    { x: NaN, y: 10, width: 40, height: 40 }, { x: 20, y: 10, width: Infinity, height: 40 },
  ])('rejects invalid/undersized resize without changing the previous box: %j', candidate => {
    const previous = { x: 20, y: 10, width: 40, height: 40 };
    expect(constrainResize(previous, candidate, { width: 100, height: 100 })).toBe(previous);
  });
  it('does not enlarge a tiny original prediction during a drag or no-op resize', () => {
    const tiny = { x: 0.1, y: 0.1, width: 0.01, height: 0.01 };
    const size = { width: 100, height: 100 };
    expect(dragBox(tiny, { x: 20, y: 20 }, size)).toEqual({ ...tiny, x: 0.2, y: 0.2 });
    expect(constrainResize(toPixels(tiny, size), toPixels(tiny, size), size)).toEqual(toPixels(tiny, size));
  });
  it('bakes transformer scaling into normalized dimensions', () => {
    const size = { width: 640, height: 320 };
    const transformed = transformBox(box, { ...toPixels(box, size), scaleX: 2, scaleY: 0.5 }, size);
    expect(transformed).toEqual({ x: 0.1, y: 0.2, width: 0.6, height: 0.2 });
  });
  it.each([-1, 0, NaN, Infinity])('refuses negative/invalid transformer scales %s', scaleX => {
    expect(transformBox(box, { ...toPixels(box, { width: 100, height: 100 }), scaleX, scaleY: 1 }, { width: 100, height: 100 })).toBe(box);
  });
  it('draws in either direction, clamps outside pointers, and drops tiny clicks', () => {
    const size = { width: 200, height: 100 };
    expect(drawingPixels({ x: 100, y: 80 }, { x: -100, y: -10 }, size)).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(finishDrawing({ x: 100, y: 80 }, { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0, width: 0.5, height: 0.8 });
    expect(finishDrawing({ x: 0, y: 0 }, { x: 11, y: 30 }, size)).toBeUndefined();
    expect(finishDrawing({ x: 0, y: 0 }, { x: 12, y: 12 }, size)).toEqual({ x: 0, y: 0, width: 0.06, height: 0.12 });
    expect(finishDrawing({ x: 10, y: 10 }, { x: 10, y: 10 }, size)).toBeUndefined();
  });
  it.each([
    { ...box, x: NaN }, { ...box, height: Infinity }, { ...box, width: -0.1 }, { ...box, width: 0 },
    { ...box, x: -0.1 }, { ...box, x: 0.9 }, { ...box, y: 0.9 },
  ])('rejects invalid normalized geometry: %j', invalid => {
    expect(validBox(invalid)).toBe(false);
    expect(() => toPixels(invalid, { width: 640, height: 320 })).toThrow();
  });
  it('rejects invalid viewports, pixel boxes, and pointer positions', () => {
    expect(() => toPixels(box, { width: 0, height: 320 })).toThrow();
    expect(() => toNormalized({ x: 0, y: 0, width: Infinity, height: 10 }, { width: 100, height: 100 })).toThrow();
    expect(() => toNormalized({ x: -1, y: 0, width: 10, height: 10 }, { width: 100, height: 100 })).toThrow();
    expect(() => clampPoint({ x: NaN, y: 10 }, { width: 100, height: 100 })).toThrow();
  });
});
