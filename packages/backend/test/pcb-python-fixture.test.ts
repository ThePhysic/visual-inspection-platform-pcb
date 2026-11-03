import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PCB_CONFIGURATION, isResultForConfiguration } from '@vip/contracts';
import { translatePcbPrediction } from '../src/pcb-provider.js';
import { type CanonicalImage } from '../src/provider.js';

describe('captured released-bundle Python contract', () => {
  it('validates the authentic CPU service response and preserves its unrounded image geometry', async () => {
    // These checked-in artifacts were captured by the isolated real container
    // probe. Missing evidence fails this test; there is no simulated replacement.
    const response: unknown = JSON.parse(await readFile(
      new URL('../../../docs/real-inference/python-response.json', import.meta.url), 'utf8',
    ));
    const image = JSON.parse(await readFile(
      new URL('../../../docs/real-inference/python-response-image.json', import.meta.url), 'utf8',
    )) as Pick<CanonicalImage, 'width' | 'height' | 'sha256' | 'mimeType'>;
    expect(image).toMatchObject({ width: 300, height: 300, mimeType: 'image/jpeg',
      sha256: '1aace0662027ba848c79b4a210cd60c4daf2a91dfc23993f2a8549a501529248' });
    const result = translatePcbPrediction(response, image, 100.123456789);
    expect(isResultForConfiguration(result, PCB_CONFIGURATION)).toBe(true);
    expect(result).toMatchObject({ ...PCB_CONFIGURATION, simulated: false, backend: 'trained', durationMs: 100.123456789 });
    expect(result.detections).toHaveLength(2);
    expect(result.detections[0]).toMatchObject({ classId: 'missing_copper', label: 'missing_copper',
      confidence: 0.3231322467327118, boundingBox: {
        x: 0.3862583160400391, y: 0.5226535034179688, width: 0.21819160461425782, height: 0.11240010579427083,
      } });
    expect(result.detections[1]).toMatchObject({ classId: 'spurious_copper', label: 'spurious_copper',
      confidence: 0.3841091990470886, boundingBox: {
        x: 0.39005147298177084, y: 0.361910400390625, width: Number('0.22919082641601562'), height: 0.2504643249511719,
      } });
    const retried = translatePcbPrediction(response, image, 1);
    expect(retried.detections).toEqual(result.detections);
  });
});
