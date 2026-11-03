import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactElement } from 'react';
import { act, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AnnotationCanvasProps } from './AnnotationCanvas';
import ReviewWorkspace from './ReviewWorkspace';
import { PCB_LABELS } from '@vip/contracts';
import { asset, inspectionId, pcbResult, result } from '../test/fixtures';

const clients: QueryClient[] = [];
afterEach(() => { clients.forEach(client => client.clear()); clients.length = 0; });
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  clients.push(client);
  return rtlRender(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

// Component tests isolate standard controls from the rendering engine. Real
// pointer dragging, transformer handles, and drawing are covered by Playwright.
vi.mock('./AnnotationCanvas', () => ({ default: function CanvasDouble(props: AnnotationCanvasProps) {
  return <div>
    <button type="button" onClick={() => { props.onSelect(props.annotations[0]?.id); }}>Select first canvas annotation</button>
    {props.mode === 'draw' && <button type="button" onClick={() => { props.onDraw({ x: 0.2, y: 0.1, width: 0.3, height: 0.2 }); }}>Draw test rectangle</button>}
  </div>;
} }));

async function openEditor() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Edit local draft' }));
  await screen.findByRole('button', { name: 'Add annotation' });
  return user;
}
const renderWorkspace = () => render(<ReviewWorkspace inspectionId={inspectionId} asset={asset} result={result} />);

describe('trained PCB review controls', () => {
  it('offers exactly the eight model classes for relabeling and human additions', async () => {
    render(<ReviewWorkspace inspectionId={inspectionId} asset={{ ...asset, width: 300, height: 300 }} result={pcbResult} />);
    const user = await openEditor();
    const newClass = screen.getByLabelText('Class for new annotation');
    expect(within(newClass).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(PCB_LABELS.map(entry => entry.classId));
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    expect(within(screen.getByLabelText('Annotation class')).getAllByRole('option')).toHaveLength(8);
    await user.selectOptions(screen.getByLabelText('Annotation class'), 'open');
    await user.click(screen.getByRole('button', { name: 'Reject prediction' }));
    expect(screen.getByRole('button', { name: /Annotation 1: open.*rejected/ })).toBeVisible();
    await user.selectOptions(newClass, 'short');
    await user.click(screen.getByRole('button', { name: 'Add annotation' }));
    await user.click(screen.getByRole('button', { name: 'Draw test rectangle' }));
    expect(screen.getByRole('button', { name: /Annotation 9: short.*Manually added; no model confidence/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove manual annotation' }));
    expect(screen.getByRole('heading', { name: '8 annotations' })).toBeVisible();
    expect(pcbResult.detections[0]!.classId).toBe('mouse_bite');
  });
});

describe('local review controls', () => {
  it('keeps the read-only viewer and exposes a clearly unsaved local editor', async () => {
    renderWorkspace();
    expect(screen.getByRole('heading', { name: '2 detections' })).toBeVisible();
    await openEditor();
    expect(screen.getByText('Local draft — not saved')).toBeVisible();
    expect(screen.getByText('No unsaved changes.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset draft' })).toBeDisabled();
  });
  it('selects annotations from the canvas and standard list controls', async () => {
    renderWorkspace(); const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    expect(screen.getByLabelText('Annotation class')).toHaveValue('surface-mark');
    await user.click(screen.getByRole('button', { name: /Annotation 2: Edge defect.*Prediction/ }));
    expect(screen.getByLabelText('Annotation class')).toHaveValue('edge-defect');
    expect(screen.getByText('No unsaved changes.')).toBeVisible();
  });
  it('relabels only the draft, retains confidence, and permits returning to originals', async () => {
    const before = structuredClone(result); renderWorkspace(); const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    await user.selectOptions(screen.getByLabelText('Annotation class'), 'edge-defect');
    expect(screen.getByText(/Unsaved changes · 1 annotation changed/)).toBeVisible();
    expect(screen.getByText(/Original confidence: 94.0%/)).toBeVisible();
    expect(result).toEqual(before);
    await user.click(screen.getByRole('button', { name: 'View original predictions' }));
    expect(screen.getByRole('button', { name: /Surface mark, 94.0% confidence/ })).toBeVisible();
    expect(screen.getByText('Unsaved local draft retained. Original predictions are shown below.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue editing local draft' }));
    expect(await screen.findByLabelText('Annotation class')).toHaveValue('edge-defect');
  });
  it('rejects and restores a prediction while keeping it discoverable', async () => {
    renderWorkspace(); const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    await user.click(screen.getByRole('button', { name: 'Accept prediction' }));
    expect(screen.getByText('No unsaved changes.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reject prediction' }));
    expect(screen.getByRole('heading', { name: '2 annotations' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Annotation 1: Surface mark.*Prediction.*rejected/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restore prediction' }));
    expect(screen.getByText('No unsaved changes.')).toBeVisible();
  });
  it('draws with a controlled class, removes manual annotations, and supports an empty result', async () => {
    render(<ReviewWorkspace inspectionId={inspectionId} asset={asset} result={{ ...result, detections: [] }} />);
    const user = await openEditor();
    await user.selectOptions(screen.getByLabelText('Class for new annotation'), 'edge-defect');
    await user.click(screen.getByRole('button', { name: 'Add annotation' }));
    expect(screen.getByRole('button', { name: 'Cancel drawing' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Draw test rectangle' }));
    expect(screen.getByRole('heading', { name: '1 annotation' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Edge defect.*Manually added; no model confidence/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept prediction' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Annotation class'), 'surface-mark');
    await user.click(screen.getByRole('button', { name: 'Remove manual annotation' }));
    expect(screen.getByRole('heading', { name: '0 annotations' })).toBeVisible();
    expect(screen.getByText('No unsaved changes.')).toBeVisible();
  });
  it('cancels drawing with Escape without dirtying the draft', async () => {
    renderWorkspace(); const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Add annotation' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Add annotation' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('No unsaved changes.')).toBeVisible();
  });
  it('requires confirmation before resetting all edits', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); renderWorkspace(); const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    await user.selectOptions(screen.getByLabelText('Annotation class'), 'edge-defect');
    await user.click(screen.getByRole('button', { name: 'Reset draft' }));
    expect(confirm).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Annotation class')).toHaveValue('edge-defect');
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Reset draft' }));
    expect(screen.getByText('No unsaved changes.')).toBeVisible();
    expect(screen.queryByLabelText('Annotation class')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Annotation 1: Surface mark.*Prediction/ })).toBeVisible();
  });
  it('warns before unload only when meaningful changes exist, and cleans up', async () => {
    const { unmount } = renderWorkspace(); const user = await openEditor();
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    await user.selectOptions(screen.getByLabelText('Annotation class'), 'edge-defect');
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
    unmount(); expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  });
  it('reinitializes on inspection identity change without carrying edits or selection', async () => {
    const rendered = renderWorkspace(); const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    await user.selectOptions(screen.getByLabelText('Annotation class'), 'edge-defect');
    rendered.rerender(<ReviewWorkspace key="different-inspection" inspectionId="different-inspection" asset={asset} result={result} />);
    await user.click(screen.getByRole('button', { name: 'Edit local draft' }));
    expect(await screen.findByText('No unsaved changes.')).toBeVisible();
    expect(screen.queryByLabelText('Annotation class')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Annotation 1: Surface mark.*Prediction/ })).toBeVisible();
  });
  it('retains a local draft through refetches of the same immutable inspection result', async () => {
    const rendered = renderWorkspace(); const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Select first canvas annotation' }));
    await user.selectOptions(screen.getByLabelText('Annotation class'), 'edge-defect');
    rendered.rerender(<ReviewWorkspace inspectionId={inspectionId} asset={asset} result={structuredClone(result)} />);
    expect(screen.getByLabelText('Annotation class')).toHaveValue('edge-defect');
    const details = screen.getByText('Review unsaved changes (1)').closest('details')!;
    fireEvent.click(within(details).getByText('Review unsaved changes (1)'));
    await act(async () => {});
    expect(within(details).getByText('Edge defect — modified prediction')).toBeInTheDocument();
  });
});
