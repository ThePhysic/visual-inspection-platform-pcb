import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const compatibility = JSON.parse(await readFile(new URL('./compatibility.json', import.meta.url), 'utf8'));
export const dlRoot = resolve(root, process.env.DL_REPOSITORY_DIR ?? '../visual-inspection-dl');
export async function verifyRelease() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dlRoot, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(revision, compatibility.dlRevision, 'DL checkout must match the pinned compatible revision');
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dlRoot, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(changes, '', 'DL tracked files must match the pinned revision');
  const bundle = resolve(dlRoot, 'releases', compatibility.release);
  const metadata = JSON.parse(await readFile(resolve(bundle, 'metadata.json'), 'utf8'));
  assert.equal(metadata.artifact_digest, compatibility.artifactDigest);
  assert.equal(metadata.model_version, compatibility.release);
  assert.equal(metadata.taxonomy_version, compatibility.taxonomy);
  assert.equal(metadata.confidence_threshold, compatibility.threshold);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const [file, expected] of [['weights.pt', compatibility.weightsSha256], ['evaluation.json', compatibility.evaluationSha256]]) {
    assert.equal(hash(await readFile(resolve(bundle, file))), expected, `${file} digest mismatch`);
  }
  console.log(JSON.stringify({ dlRevision: revision, model: metadata.model_version, artifactDigest: metadata.artifact_digest, verified: true }));
  return { revision, metadata, bundle };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyRelease();
