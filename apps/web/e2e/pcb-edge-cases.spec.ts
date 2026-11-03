import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isInferenceResult, type PersistedReview, type SaveReviewRequest } from '@vip/contracts';
import { accepted, asset, pcbCompleted } from '../src/test/fixtures';
import { workspaceRoot } from './settings';

test.use({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });

// Controlled HTTP fixtures exercise browser recovery and canvas precision. The
// separate trained suite is responsible for actual released-model inference.
test('controlled trained API: a contract-valid edge box renders and saves without rounding original coordinates', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  const xMin = Math.fround(1.3323e-13);
  const box = { x: xMin / 300, y: 0, width: (300 - xMin) / 300, height: 100 / 300 };
  expect(box.x + box.width).toBeGreaterThan(1);
  const result = { ...pcbCompleted.result, detections: [{ ...pcbCompleted.result.detections[0]!, boundingBox: box }] };
  expect(isInferenceResult(result)).toBe(true);
  const original = structuredClone(result);
  const bytes = await readFile(resolve(workspaceRoot, 'fixtures/pcb/5810_t_007.jpg'));
  let review: PersistedReview | undefined;
  let payload: SaveReviewRequest | undefined;
  await page.route(`**${accepted.url}`, route => route.fulfill({ json: {
    ...pcbCompleted, result, candidatePatch: true, reviewWriteSequence: review ? 1 : 0, ...(review ? { review } : {}),
  } }));
  await page.route(`**/api/v1/assets/${asset.id}`, route => route.fulfill({ json: { ...asset, mimeType: 'image/jpeg', width: 300, height: 300 } }));
  await page.route(`**${asset.contentUrl}`, route => route.fulfill({ body: bytes, contentType: 'image/jpeg' }));
  await page.route(`**${accepted.url}/review`, async route => {
    payload = route.request().postDataJSON() as SaveReviewRequest;
    review = { contractVersion: 'v1', taxonomyVersion: payload.taxonomyVersion,
      annotations: payload.annotations, revision: 1, savedAt: pcbCompleted.completedAt };
    await route.fulfill({ json: { operationId: payload.operationId, operationRevision: 1, writeSequence: 1, outcome: 'saved', review } });
  });
  await page.goto(`/inspections/${pcbCompleted.id}`);
  await page.getByRole('button', { name: 'Edit local draft' }).click();
  await expect(page.getByRole('group', { name: 'Annotation canvas', exact: true })).toBeVisible();
  await expect(page.locator('.interactive-canvas canvas').first()).toBeVisible();
  await page.getByRole('button', { name: /Annotation 1: mouse_bite/ }).click();
  await expect(page.getByLabel('Box width', { exact: true })).toHaveText(String(box.width));
  await page.getByLabel('Annotation class', { exact: true }).selectOption('open');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(page.getByText('Review saved · revision 1.', { exact: true })).toBeVisible();
  expect(payload!.annotations[0]!.boundingBox).toEqual(box);
  expect(payload!.annotations[0]!.classId).toBe('open');
  expect(payload!.annotations[0]).not.toHaveProperty('confidence');
  await page.reload();
  await expect(page.getByRole('group', { name: 'Annotation canvas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Annotation 1: open/ }).click();
  await expect(page.getByLabel('Box width', { exact: true })).toHaveText(String(box.width));
  expect(await page.evaluate(async path => (await fetch(path)).json(), accepted.url)).toMatchObject({ result: original, review });
  expect(errors).toEqual([]);
});

test('controlled trained API: lost acceptance stays confirmable during a later availability outage', async ({ page }) => {
  const bytes = await readFile(resolve(workspaceRoot, 'fixtures/pcb/5810_t_007.jpg'));
  let available = true; let uploads = 0;
  const submissions: { body: unknown; key: string | undefined }[] = [];
  await page.route('**/api/v1/inference-modes', route => route.fulfill({ json: {
    trained: { enabled: true, available, ...(!available ? { reason: 'The trained model is temporarily offline.' } : {}) },
  } }));
  await page.route('**/api/v1/assets', async route => {
    uploads++;
    await route.fulfill({ status: 201, json: { ...asset, mimeType: 'image/jpeg', width: 300, height: 300 } });
  });
  await page.route('**/api/v1/inspections', async route => {
    submissions.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    if (submissions.length === 1) await route.abort('failed');
    else await route.fulfill({ status: 202, json: accepted });
  });
  await page.route(`**${accepted.url}`, route => route.fulfill({ json: pcbCompleted }));
  await page.route(`**/api/v1/assets/${asset.id}`, route => route.fulfill({ json: { ...asset, mimeType: 'image/jpeg', width: 300, height: 300 } }));
  await page.route(`**${asset.contentUrl}`, route => route.fulfill({ body: bytes, contentType: 'image/jpeg' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Check trained model availability' }).click();
  await expect(page.getByRole('radio', { name: 'Trained PCB detector' })).toBeEnabled();
  await page.getByRole('radio', { name: 'Trained PCB detector' }).check();
  await page.getByRole('checkbox', { name: /I confirm this is a real 300/ }).check();
  await page.getByLabel('Image file').setInputFiles(resolve(workspaceRoot, 'fixtures/pcb/5810_t_007.jpg'));
  await page.getByRole('button', { name: 'Upload and inspect' }).click();
  await expect(page.getByRole('alert')).toContainText('Your image is saved');
  available = false;
  await page.getByRole('button', { name: 'Check trained model availability' }).click();
  await expect(page.getByText('The trained model is temporarily offline.', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Trained PCB detector' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Retry inspection submission' })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry inspection submission' }).click();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible();
  await expect(page.getByText('Trained model', { exact: true })).toBeVisible();
  expect(uploads).toBe(1); expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
});
