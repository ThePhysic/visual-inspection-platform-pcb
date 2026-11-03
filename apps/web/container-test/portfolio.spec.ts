import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

test.use({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const screenshots = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
async function capture(page: Page, name: string) {
  if (process.env.VIP_CAPTURE_PORTFOLIO !== '1') return;
  await mkdir(screenshots, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(screenshots, `${name}.png`), fullPage: true });
}
async function inspect(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Image file').setInputFiles(fileURLToPath(new URL(`../../../fixtures/inspections/${name}.png`, import.meta.url)));
  await page.getByRole('button', { name: 'Upload and inspect' }).click();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Canonical uploaded image' })).toBeVisible();
  return new URL(page.url()).pathname;
}
async function imageRectangle(page: Page) {
  const image = page.getByRole('img', { name: 'Canonical image for annotation editing' });
  await image.scrollIntoViewIfNeeded();
  const rectangle = (await image.boundingBox())!;
  await expect(async () => {
    const overlay = (await page.locator('.interactive-canvas canvas').first().boundingBox())!;
    expect(overlay.width).toBeCloseTo(rectangle.width, 0);
    expect(overlay.height).toBeCloseTo(rectangle.height, 0);
  }).toPass();
  return rectangle;
}
async function drag(page: Page, x: number, y: number, toX: number, toY: number) {
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 10 }); await page.mouse.up();
}

test('portfolio fixtures: real upload, canvas corrections, persisted reopen, portrait, zero results and history', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  const path = await inspect(page, 'machined-panel');
  await expect(page.getByRole('heading', { name: '3 detections', exact: true })).toBeVisible();
  await expect(page.getByTestId('detection-box')).toHaveCount(3);
  const before = await (await page.request.get(`/api/v1${path}`)).json();
  await expect(page.getByText('Simulated demo', { exact: true })).toBeVisible();
  await capture(page, 'inspection');

  await page.getByRole('button', { name: 'Edit local draft' }).click();
  await page.getByRole('button', { name: /Annotation 1:/ }).click();
  await page.getByLabel('Annotation class', { exact: true }).selectOption('surface-mark');
  const image = await imageRectangle(page);
  const box = before.result.detections[0].boundingBox;
  const x = image.x + (box.x + box.width / 2) * image.width;
  const y = image.y + (box.y + box.height / 2) * image.height;
  await drag(page, x, y, x + 12, y + 8);
  await expect(async () => {
    expect(Number(await page.getByLabel('Box x', { exact: true }).textContent())).toBeGreaterThan(box.x);
  }).toPass();
  const movedX = Number(await page.getByLabel('Box x', { exact: true }).textContent());
  const movedY = Number(await page.getByLabel('Box y', { exact: true }).textContent());
  const resizeX = image.x + (movedX + box.width) * image.width;
  const resizeY = image.y + (movedY + box.height) * image.height;
  await drag(page, resizeX, resizeY, resizeX + 18, resizeY + 10);
  await expect(async () => {
    expect(Number(await page.getByLabel('Box width', { exact: true }).textContent())).toBeGreaterThan(box.width);
  }).toPass();
  await page.getByRole('button', { name: /Annotation 3:/ }).click();
  await page.getByRole('button', { name: 'Reject prediction' }).click();
  await page.getByLabel('Class for new annotation').selectOption('surface-mark');
  await page.getByRole('button', { name: 'Add annotation', exact: true }).click();
  const draw = await imageRectangle(page);
  await drag(page, draw.x + draw.width * 0.65, draw.y + draw.height * 0.65,
    draw.x + draw.width * 0.72, draw.y + draw.height * 0.72);
  await expect(page.getByRole('heading', { name: '4 annotations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(page.getByText('Review saved · revision 1.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Annotation 1: Surface mark/ }).click();
  await expect(page.getByLabel('Annotation class', { exact: true })).toHaveValue('surface-mark');
  const after = await (await page.request.get(`/api/v1${path}`)).json();
  expect(after.result).toEqual(before.result);
  expect(after.review.revision).toBe(1);
  expect(after.review.annotations).toHaveLength(4);
  expect(after.review.annotations.filter((entry: { disposition: string }) => entry.disposition === 'rejected')).toHaveLength(1);
  expect(after.review.annotations.find((entry: { predictionId?: string }) => !entry.predictionId)).not.toHaveProperty('confidence');
  await imageRectangle(page);
  await capture(page, 'review');

  await inspect(page, 'edge-component');
  await expect(page.getByRole('heading', { name: '1 detection', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const portrait = page.getByRole('img', { name: 'Canonical uploaded image' });
  const portraitBox = (await portrait.boundingBox())!;
  expect(portraitBox.height / portraitBox.width).toBeCloseTo(1100 / 800, 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await inspect(page, 'clean-panel');
  await expect(page.getByRole('heading', { name: '0 detections', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await page.getByLabel('Inspection status').selectOption('completed');
  const card = page.locator('.history-card').filter({ has: page.locator(`a[href="${path}"]`) });
  await expect(card).toContainText('Saved review · revision 1');
  await expect(page.locator('.history-card img').first()).toBeVisible();
  await capture(page, 'history');
  await card.getByRole('link', { name: /Inspection ·/ }).click();
  await expect(page.getByRole('heading', { name: '4 annotations', exact: true })).toBeVisible();
  // Functional pagination QA, after the presentation captures. Normal accepted
  // requests reuse one asset; no fabricated results or direct database seeding.
  for (let index = 0; index < 21; index++) {
    const response = await page.request.post('/api/v1/inspections', {
      headers: { 'idempotency-key': randomUUID() }, data: { assetId: before.assetId },
    });
    expect(response.status()).toBe(202);
  }
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.locator('.history-card')).toHaveCount(20);
  await page.getByRole('button', { name: 'Load more inspections', exact: true }).click();
  await expect(card).toContainText('Saved review · revision 1');
  const links = await page.locator('.history-card').getByRole('link', { name: /Inspection ·/ }).evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
  expect(links.length).toBeGreaterThan(20);
  expect(new Set(links).size).toBe(links.length);
  await card.getByRole('link', { name: /Inspection ·/ }).click();
  await expect(page.getByRole('heading', { name: '4 annotations', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
