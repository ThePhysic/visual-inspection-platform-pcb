import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { workspaceRoot } from './settings';
import { accepted, asset, completed, processing, queued } from '../src/test/fixtures';

async function assertBoxGeometry(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const image = page.getByRole('img', { name: 'Canonical uploaded image' });
  await expect(image).toBeVisible();
  const detection = page.getByTestId('detection-box').first();
  await expect(detection).toBeVisible();
  await expect(async () => {
    const imageRect = (await image.boundingBox())!;
    const boxRect = (await detection.boundingBox())!;
    expect(Math.abs(boxRect.x - imageRect.x - box.x * imageRect.width)).toBeLessThan(1);
    expect(Math.abs(boxRect.y - imageRect.y - box.y * imageRect.height)).toBeLessThan(1);
    expect(Math.abs(boxRect.width - box.width * imageRect.width)).toBeLessThan(1);
    expect(Math.abs(boxRect.height - box.height * imageRect.height)).toBeLessThan(1);
  }).toPass();
}

test('real stack: upload → inspection → predictions, responsive geometry, and direct-link reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.goto('/');
  await page.getByLabel('Image file').setInputFiles(resolve(workspaceRoot, 'fixtures/inspections/panel.png'));
  await page.getByRole('button', { name: 'Upload and inspect' }).click();
  await expect(page).toHaveURL(/\/inspections\/[a-f0-9]{24}$/);
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '1 detection', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Surface mark, 94.0% confidence/ })).toBeVisible();
  await expect(page.getByText('Simulated demo', { exact: true })).toBeVisible();
  const box = { x: 12 / 64, y: 16 / 64, width: 20 / 64, height: 12 / 64 };
  await assertBoxGeometry(page, box);
  await page.setViewportSize({ width: 390, height: 844 }); await assertBoxGeometry(page, box);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible();
  await assertBoxGeometry(page, box); expect(errors).toEqual([]);
});

test('real stack: empty fixture is a successful zero-detection result', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Image file').setInputFiles(resolve(workspaceRoot, 'fixtures/inspections/empty.png'));
  await page.getByRole('button', { name: 'Upload and inspect' }).click();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '0 detections' })).toBeVisible();
  await expect(page.getByText(/No objects detected/)).toBeVisible();
  await expect(page.getByTestId('detection-box')).toHaveCount(0);
});

test('real stack: lost acceptance response retries the same key without another upload', async ({ page }) => {
  const keys: string[] = []; const ids: string[] = []; let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/assets')) uploads++; });
  await page.route('**/api/v1/inspections', async route => {
    keys.push(route.request().headers()['idempotency-key']!);
    const response = await route.fetch(); // The real API durably accepts both requests.
    ids.push((await response.json()).id as string);
    if (keys.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByLabel('Image file').setInputFiles(resolve(workspaceRoot, 'fixtures/inspections/panel.png'));
  await page.getByRole('button', { name: 'Upload and inspect' }).click();
  await expect(page.getByRole('alert')).toContainText('Your image is saved');
  await page.getByRole('button', { name: 'Retry inspection submission' }).click();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible({ timeout: 30_000 });
  expect(uploads).toBe(1); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(ids[0]).toBe(ids[1]);
});

// Fast mock inference may finish between browser polls. Controlled responses
// below verify every visible lifecycle state and non-square browser geometry.
for (const [name, width, height] of [['landscape', 640, 320], ['portrait', 320, 640]] as const) {
  test(`controlled API: queued → processing → completed with ${name} geometry`, async ({ page }) => {
    let stage: 'queued' | 'processing' | 'completed' = 'queued';
    const bytes = await readFile(resolve(workspaceRoot, `apps/web/e2e/fixtures/${name}.png`));
    await page.route(`**${accepted.url}`, async route => {
      await route.fulfill({ json: stage === 'queued' ? queued : stage === 'processing' ? processing : completed });
    });
    await page.route(`**/api/v1/assets/${asset.id}`, route => route.fulfill({ json: { ...asset, width, height } }));
    await page.route(`**${asset.contentUrl}`, route => route.fulfill({ body: bytes, contentType: 'image/png' }));
    await page.route('**/api/v1/assets', route => route.fulfill({ status: 201, json: { ...asset, width, height } }));
    await page.route('**/api/v1/inspections', route => route.fulfill({ status: 202, json: accepted }));
    await page.goto('/');
    await page.getByLabel('Image file').setInputFiles(resolve(workspaceRoot, `apps/web/e2e/fixtures/${name}.png`));
    await page.getByRole('button', { name: 'Upload and inspect' }).click();
    await expect(page.getByRole('heading', { name: 'Queued', exact: true })).toBeVisible();
    stage = 'processing';
    await expect(page.getByRole('heading', { name: 'Processing', exact: true })).toBeVisible();
    stage = 'completed';
    await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2 detections' })).toBeVisible();
    await assertBoxGeometry(page, completed.result.detections[0]!.boundingBox);
    await page.setViewportSize({ width: 375, height: 812 });
    await assertBoxGeometry(page, completed.result.detections[0]!.boundingBox);
  });
}
