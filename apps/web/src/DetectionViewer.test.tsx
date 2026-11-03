import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import DetectionViewer from './DetectionViewer';
import { asset, pcbResult, result } from './test/fixtures';

describe('read-only canonical image viewer', () => {
  it('presents an empty trained response as successful without simulated wording', () => {
    render(<DetectionViewer asset={{ ...asset, width: 300, height: 300 }} result={{ ...pcbResult, detections: [] }} />);
    expect(screen.getByText(/No predictions above the selected operating threshold/)).toHaveTextContent('valid completed result');
    expect(screen.queryByText(/simulated model/)).not.toBeInTheDocument();
  });
  it.each([[640, 320], [320, 640]])('uses normalized geometry for %i × %i images', (width, height) => {
    render(<DetectionViewer asset={{ ...asset, width, height }} result={result} />);
    const img = screen.getByRole('img', { name: 'Canonical uploaded image' });
    expect(img).toHaveAttribute('src', asset.contentUrl);
    expect(img).toHaveAttribute('width', String(width)); expect(img).toHaveAttribute('height', String(height));
    expect(screen.getByTestId('image-frame')).toHaveStyle({ aspectRatio: `${width} / ${height}` });
    expect(screen.queryByTestId('detection-box')).not.toBeInTheDocument();
    fireEvent.load(img);
    const boxes = screen.getAllByTestId('detection-box');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toHaveStyle({ left: '10%', top: '20%', width: '30%', height: '40%' });
    expect(boxes[1]).toHaveStyle({ left: '50%', top: '10%', width: '20%', height: '25%' });
    expect(boxes[0]?.style.borderColor).not.toBe(boxes[1]?.style.borderColor);
    expect(screen.getByRole('button', { name: /Surface mark, 94.0% confidence/ })).toBeVisible();
  });
  it('preserves normalized placement when its container is resized', () => {
    const { container } = render(<DetectionViewer asset={asset} result={result} />);
    fireEvent.load(screen.getByRole('img'));
    const frame = screen.getByTestId('image-frame');
    frame.style.width = '600px'; fireEvent(window, new Event('resize'));
    const geometry = screen.getAllByTestId('detection-box').map(box => box.getAttribute('style'));
    frame.style.width = '240px'; fireEvent(window, new Event('resize'));
    expect(screen.getAllByTestId('detection-box').map(box => box.getAttribute('style'))).toEqual(geometry);
    expect(container.querySelector('canvas')).toBeNull();
  });
  it('emphasizes the selected box using keyboard-accessible controls', async () => {
    const user = userEvent.setup(); render(<DetectionViewer asset={asset} result={result} />);
    fireEvent.load(screen.getByRole('img'));
    const button = screen.getByRole('button', { name: /Surface mark/ });
    button.focus(); await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('detection-box')[0]).toHaveClass('selected');
    await user.keyboard('{Enter}'); expect(button).toHaveAttribute('aria-pressed', 'false');
  });
  it('treats zero detections as a successful empty result', () => {
    render(<DetectionViewer asset={asset} result={{ ...result, detections: [] }} />);
    fireEvent.load(screen.getByRole('img'));
    expect(screen.getByRole('heading', { name: '0 detections' })).toBeVisible();
    expect(screen.getByText(/No objects detected/)).toHaveTextContent('valid completed result');
    expect(screen.queryByTestId('detection-box')).not.toBeInTheDocument();
  });
  it('keeps detections available when image loading fails and offers retry', async () => {
    const user = userEvent.setup(); render(<DetectionViewer asset={asset} result={result} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('alert')).toHaveTextContent('stored image could not be loaded');
    expect(screen.getByRole('button', { name: /Surface mark/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry image' }));
    fireEvent.load(screen.getByRole('img'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('detection-box')).toHaveLength(2);
  });
});
