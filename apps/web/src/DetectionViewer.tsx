import { useState } from 'react';
import { type AssetResponse, type InferenceResult } from '@vip/contracts';
import { classColor, confidenceLabel } from './presentation';

export default function DetectionViewer({ asset, result }: { asset?: AssetResponse | undefined; result: InferenceResult }) {
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [imageAttempt, setImageAttempt] = useState(0);
  const [selected, setSelected] = useState<string>();
  return <div className="results-grid">
    <div className="viewer">
      {asset && <figure>
        {imageState === 'loading' && <p role="status">Loading canonical image…</p>}
        {imageState === 'error' && <div role="alert"><p>The stored image could not be loaded. Predictions are still listed.</p><button type="button" onClick={() => { setImageState('loading'); setImageAttempt(value => value + 1); }}>Retry image</button></div>}
        <div className="image-frame" data-testid="image-frame" style={{ aspectRatio: `${asset.width} / ${asset.height}` }} hidden={imageState === 'error'}>
          <img key={imageAttempt} src={asset.contentUrl} width={asset.width} height={asset.height} alt="Canonical uploaded image"
            onLoad={() => { setImageState('loaded'); }} onError={() => { setImageState('error'); }} />
          {imageState === 'loaded' && <div className="box-overlay" aria-hidden="true">
            {result.detections.map((detection, index) => <div key={detection.id} data-testid="detection-box"
              data-prediction-id={detection.id} className={`detection-box${selected === detection.id ? ' selected' : ''}`}
              style={{ left: `${detection.boundingBox.x * 100}%`, top: `${detection.boundingBox.y * 100}%`,
                width: `${detection.boundingBox.width * 100}%`, height: `${detection.boundingBox.height * 100}%`, borderColor: classColor(detection.classId) }}>
              <span style={{ backgroundColor: classColor(detection.classId) }}>{index + 1}</span>
            </div>)}
          </div>}
        </div>
        <figcaption>Canonical image · {asset.width} × {asset.height} pixels. Box numbers match the detection list.</figcaption>
      </figure>}
    </div>
    <aside className="detections" aria-labelledby="detections-heading">
      <h3 id="detections-heading">{result.detections.length} {result.detections.length === 1 ? 'detection' : 'detections'}</h3>
      {!result.detections.length && <p>{result.simulated ? 'No objects detected. This is a valid completed result from the simulated model.' : 'No predictions above the selected operating threshold. This is a valid completed result; missed defects remain possible.'}</p>}
      <ol>
        {result.detections.map((detection, index) => <li key={detection.id}>
          <button type="button" className="detection-item" aria-pressed={selected === detection.id}
            aria-label={`Detection ${index + 1}: ${detection.label}, ${confidenceLabel(detection.confidence)} confidence`}
            onClick={() => { setSelected(current => current === detection.id ? undefined : detection.id); }}>
            <span className="detection-number" style={{ backgroundColor: classColor(detection.classId) }}>{index + 1}</span>
            <span><strong>{detection.label}</strong><span className="confidence">{confidenceLabel(detection.confidence)} confidence</span></span>
          </button>
        </li>)}
      </ol>
      {result.detections.length > 0 && <p className="muted">Select a detection to emphasize its box. {result.simulated ? 'Simulated confidence scores do not measure real model accuracy.' : 'Confidence scores are not calibrated probabilities of correctness.'}</p>}
    </aside>
  </div>;
}
