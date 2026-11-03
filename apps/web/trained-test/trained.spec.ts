import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { PCB_CONFIGURATION, PCB_LABELS, isResultForConfiguration } from '@vip/contracts';

const platformRoot = fileURLToPath(new URL('../../../', import.meta.url));
const patchPath = process.env.PCB_DEMO_PATCH ?? resolve(platformRoot, '../visual-inspection-dl/tests/fixtures/pcb-ind/5810_t_007.jpg');
const evidenceDirectory = resolve(platformRoot, 'docs/real-inference');

async function draw(page: Page, start: number, end: number) {
  await page.getByRole('button', { name: 'Add annotation', exact: true }).click();
  const image = page.getByRole('img', { name: 'Canonical image for annotation editing' });
  await image.scrollIntoViewIfNeeded();
  const rectangle = (await image.boundingBox())!;
  await page.mouse.move(rectangle.x + rectangle.width * start, rectangle.y + rectangle.height * start);
  await page.mouse.down();
  await page.mouse.move(rectangle.x + rectangle.width * end, rectangle.y + rectangle.height * end, { steps: 8 });
  await page.mouse.up();
}

test('released CPU model: explicit upload → trained predictions → eight-class review → idempotent save → conflict → history reopen', async ({ page, context }, testInfo) => {
  await mkdir(evidenceDirectory, { recursive: true });
  const browserErrors: string[] = [];
  page.on('pageerror', error => { browserErrors.push(error.message); });
  await page.goto('/');
  await expect(page.getByRole('radio', { name: 'Simulated demo' })).toBeChecked();
  await page.getByRole('button', { name: 'Check trained model availability' }).click();
  await expect(page.getByRole('radio', { name: 'Trained PCB detector' })).toBeEnabled();
  await page.getByRole('radio', { name: 'Trained PCB detector' }).check();
  await page.getByRole('checkbox', { name: /I confirm this is a real 300/ }).check();
  await page.getByLabel('Image file').setInputFiles(patchPath);
  await page.screenshot({ path: testInfo.outputPath('01-trained-upload.png'), fullPage: true });
  await page.screenshot({ path: resolve(evidenceDirectory, 'trained-upload.png'), fullPage: true });
  const uploadStarted = performance.now();
  await page.getByRole('button', { name: 'Upload and inspect' }).click();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible({ timeout: 60_000 });
  const observedUploadToHeadingMs = performance.now() - uploadStarted;
  await writeFile(resolve(evidenceDirectory, 'browser-workflow.json'), JSON.stringify({
    observedAt: new Date().toISOString(), sampleCount: 1, observedUploadToHeadingMs,
    inspectionId: new URL(page.url()).pathname.split('/').at(-1),
    measurement: 'Playwright click dispatch on Upload and inspect through visible Completed heading; includes upload, durable creation, queue, trained HTTP inference, commit, browser polling and automation observation overhead.',
    pollingMs: 2000, temperature: 'Uncontrolled initial service state; not a cold-start claim.',
    fixture: 'PCB-IND v4 5810_t_007.jpg, training-set serving smoke fixture; not holdout evaluation.',
    baseURL: testInfo.project.use.baseURL,
  }, null, 2) + '\n');
  await expect(page.getByText('Trained model', { exact: true })).toBeVisible();
  const inspectionUrl = page.url();
  const apiPath = new URL(inspectionUrl).pathname.replace('/inspections/', '/api/v1/inspections/');
  const originalRecord = await (await page.request.get(apiPath)).json();
  expect(originalRecord.requested).toEqual(PCB_CONFIGURATION);
  expect(isResultForConfiguration(originalRecord.result, PCB_CONFIGURATION)).toBe(true);
  expect(originalRecord.result.simulated).toBe(false);
  expect(originalRecord.result.backend).toBe('trained');
  expect(originalRecord.result.detections.length).toBeGreaterThan(0);
  await expect(page.getByRole('img', { name: 'Canonical uploaded image' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('02-trained-predictions.png'), fullPage: true });
  await page.screenshot({ path: resolve(evidenceDirectory, 'trained-result.png'), fullPage: true });

  await page.getByRole('button', { name: 'Edit local draft' }).click();
  await page.getByRole('button', { name: /Annotation 1:/ }).click();
  expect(await page.getByLabel('Annotation class', { exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(PCB_LABELS.map(entry => entry.classId));
  const correctedClass = originalRecord.result.detections[0].classId === 'open' ? 'scratch' : 'open';
  await page.getByLabel('Annotation class', { exact: true }).selectOption(correctedClass);
  await page.getByRole('button', { name: 'Reject prediction' }).click();
  await page.getByLabel('Class for new annotation').selectOption('short');
  await draw(page, 0.6, 0.85);
  await expect(page.getByRole('button', { name: /short.*Manually added; no model confidence/ })).toBeVisible();
  // A second addition can be removed without deleting original predictions.
  await draw(page, 0.1, 0.3);
  await page.getByRole('button', { name: 'Remove manual annotation' }).click();

  const savePayloads: unknown[] = [];
  await page.route('**/api/v1/inspections/*/review', async route => {
    savePayloads.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (savePayloads.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByText('Review saved · revision 1.', { exact: true })).toBeVisible();
  expect(savePayloads).toHaveLength(2); expect(savePayloads[0]).toEqual(savePayloads[1]);
  await page.unroute('**/api/v1/inspections/*/review');
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(`Annotation 1: ${correctedClass}.*rejected`) })).toBeVisible();
  await expect(page.getByRole('button', { name: /short.*Manually added; no model confidence/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('03-saved-trained-review.png'), fullPage: true });
  await page.screenshot({ path: resolve(evidenceDirectory, 'trained-review.png'), fullPage: true });

  const other = await context.newPage(); await other.goto(inspectionUrl);
  await other.getByRole('button', { name: /Annotation 1:/ }).click();
  await other.getByRole('button', { name: 'Restore prediction' }).click();
  await page.getByRole('button', { name: /Annotation 1:/ }).click();
  await page.getByLabel('Annotation class', { exact: true }).selectOption('stain');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(page.getByText('Review saved · revision 2.', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('A newer review exists');
  await expect(other.getByRole('button', { name: new RegExp(`Annotation 1: ${correctedClass}.*accepted`) })).toBeVisible();
  other.once('dialog', dialog => dialog.accept());
  await other.getByRole('button', { name: 'Load latest saved review' }).click();
  await expect(other.getByRole('button', { name: /Annotation 1: stain.*rejected/ })).toBeVisible();
  await other.close();

  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.locator(`a[href="${new URL(inspectionUrl).pathname}"]`).first()).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, 'trained-history.png'), fullPage: true });
  await page.locator(`a[href="${new URL(inspectionUrl).pathname}"]`).first().click();
  await expect(page.getByRole('button', { name: /Annotation 1: stain.*rejected/ })).toBeVisible();
  const finalRecord = await (await page.request.get(apiPath)).json();
  expect(finalRecord.result).toEqual(originalRecord.result);
  expect(finalRecord.review.taxonomyVersion).toBe('pcb-ind-v4-1');
  expect(finalRecord.review.revision).toBe(2);
  expect(finalRecord.review.annotations).toHaveLength(originalRecord.result.detections.length + 1);
  expect(browserErrors).toEqual([]);
});

test('trained browser-visible warmed upload latency: twenty sequential candidate-patch inspections', async ({ page }, testInfo) => {
  const samples: number[] = [];
  for (let index = 0; index < 20; index++) {
    await page.goto('/');
    await page.getByRole('button', { name: 'Check trained model availability' }).click();
    await expect(page.getByRole('radio', { name: 'Trained PCB detector' })).toBeEnabled();
    await page.getByRole('radio', { name: 'Trained PCB detector' }).check();
    await page.getByRole('checkbox', { name: /I confirm this is a real 300/ }).check();
    await page.getByLabel('Image file').setInputFiles(patchPath);
    const started = performance.now();
    await page.getByRole('button', { name: 'Upload and inspect' }).click();
    await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible({ timeout: 60_000 });
    samples.push(performance.now() - started);
    await expect(page.getByText('Trained model', { exact: true })).toBeVisible();
  }
  const sorted = [...samples].sort((a, b) => a - b);
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(resolve(evidenceDirectory, 'browser-warmed.json'), JSON.stringify({
    observedAt: new Date().toISOString(), sampleCount: samples.length, samplesMs: samples,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    percentileMethod: 'Nearest rank; p95 is descriptive of these 20 samples, not an SLA; no p99 claim.',
    measurement: 'Playwright click dispatch on Upload and inspect through visible Completed heading, including upload, durable creation, queue, trained HTTP inference, commit, browser polling and automation observation overhead. File selection and readiness check excluded.',
    pollingMs: 2000, concurrency: 1, temperature: 'Warmed service after preceding trained review workflow.',
    fixture: 'Same 300×300 PCB-IND v4 5810_t_007.jpg training-set smoke patch repeated; differing input distribution and workload from mock benchmark.',
    baseURL: testInfo.project.use.baseURL, failures: 0,
  }, null, 2) + '\n');
});
