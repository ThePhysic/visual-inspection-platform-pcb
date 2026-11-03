import { act, fireEvent, screen } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from './test/render';
import { accepted, apiError, asset, completed, failed, processing, queued } from './test/fixtures';
import { INSPECTION_POLL_MS } from './queries';

afterEach(() => { vi.useRealTimers(); focusManager.setFocused(undefined); });
async function tick(ms = 1) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function lifecycle(...responses: (() => Response | Promise<Response>)[]) {
  let index = 0;
  const fetchMock = vi.fn<typeof fetch>(async path => {
    if (path === `/api/v1/assets/${asset.id}`) return Response.json(asset);
    if (path === accepted.url) return responses[Math.min(index++, responses.length - 1)]!();
    throw new Error(`Unexpected ${String(path)}`);
  });
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
}
const getCalls = (mock: ReturnType<typeof lifecycle>) => mock.mock.calls.filter(([path]) => path === accepted.url).length;

describe('inspection routes and polling', () => {
  it('polls queued → processing → completed, then stops', async () => {
    vi.useFakeTimers(); const fetchMock = lifecycle(() => Response.json(queued), () => Response.json(processing), () => Response.json(completed));
    renderApp(`/inspections/${queued.id}`); await tick();
    expect(screen.getByRole('heading', { name: 'Queued' })).toBeVisible();
    await tick(INSPECTION_POLL_MS + 5);
    expect(screen.getByRole('heading', { name: 'Processing' })).toBeVisible();
    await tick(INSPECTION_POLL_MS + 5);
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(screen.getByText('Simulated demo')).toBeVisible();
    expect(screen.getByText('mock-detector · 1.0.0')).toBeVisible();
    await tick(INSPECTION_POLL_MS * 4); expect(getCalls(fetchMock)).toBe(3);
  });
  it('shows a terminal processing failure and stops polling', async () => {
    vi.useFakeTimers(); const fetchMock = lifecycle(() => Response.json(failed));
    renderApp(`/inspections/${failed.id}`); await tick();
    expect(screen.getByRole('heading', { name: 'Inspection failed' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('INFERENCE_FAILED');
    await tick(INSPECTION_POLL_MS * 3); expect(getCalls(fetchMock)).toBe(1);
  });
  it('keeps the last queued state after a temporary polling failure and recovers', async () => {
    vi.useFakeTimers(); const fetchMock = lifecycle(() => Response.json(queued), () => { throw new TypeError('offline'); }, () => Response.json(completed));
    renderApp(`/inspections/${queued.id}`); await tick(); await tick(INSPECTION_POLL_MS + 5);
    expect(screen.getByRole('alert')).toHaveTextContent('Updates are temporarily unavailable');
    expect(screen.getByRole('heading', { name: 'Queued' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Inspection failed' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try fetching again' })); await tick();
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(getCalls(fetchMock)).toBe(3);
  });
  it('retains completed predictions when a manual background refresh fails', async () => {
    vi.useFakeTimers(); lifecycle(() => Response.json(completed), () => apiError('DATABASE_FAILURE', 503));
    renderApp(`/inspections/${completed.id}`); await tick(5);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await tick(5);
    expect(screen.getByRole('alert')).toHaveTextContent('Showing the last received result');
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Surface mark/ })).toBeVisible();
  });
  it('pauses interval polling while the tab is unfocused', async () => {
    vi.useFakeTimers(); const fetchMock = lifecycle(() => Response.json(queued));
    renderApp(`/inspections/${queued.id}`); await tick();
    focusManager.setFocused(false); await tick(INSPECTION_POLL_MS * 3);
    expect(getCalls(fetchMock)).toBe(1);
    focusManager.setFocused(true); await tick(INSPECTION_POLL_MS + 5);
    expect(getCalls(fetchMock)).toBeGreaterThan(1);
  });
  it('does not overlap a slow request and cancels it when unmounted', async () => {
    vi.useFakeTimers(); const fetchMock = lifecycle(() => new Promise(() => {}));
    const { unmount } = renderApp(`/inspections/${queued.id}`); await tick();
    await tick(INSPECTION_POLL_MS * 3); expect(getCalls(fetchMock)).toBe(1);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    unmount(); expect(signal?.aborted).toBe(true);
    await tick(INSPECTION_POLL_MS * 3); expect(getCalls(fetchMock)).toBe(1);
  });
  it('rejects malformed inspection URLs without a network call', () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); renderApp('/inspections/not-an-id');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid inspection link');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows a missing inspection and does not poll a 404', async () => {
    vi.useFakeTimers(); const fetchMock = lifecycle(() => apiError('INSPECTION_NOT_FOUND', 404));
    renderApp(`/inspections/${queued.id}`); await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be found');
    expect(screen.queryByRole('button', { name: 'Try fetching again' })).not.toBeInTheDocument();
    await tick(INSPECTION_POLL_MS * 3); expect(getCalls(fetchMock)).toBe(1);
  });
  it('loads an existing detail URL again using a fresh query cache', async () => {
    const fetchMock = lifecycle(() => Response.json(completed));
    const first = renderApp(`/inspections/${completed.id}`);
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible(); first.unmount();
    renderApp(`/inspections/${completed.id}`);
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(getCalls(fetchMock)).toBe(2);
  });
  it('retains prediction details if image metadata retrieval fails', async () => {
    vi.useFakeTimers(); const fetchMock = lifecycle(() => Response.json(completed));
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, options) => path === accepted.url ? implementation(path, options) : apiError('STORAGE_FAILURE', 503));
    renderApp(`/inspections/${completed.id}`); await tick(5);
    expect(screen.getByRole('alert')).toHaveTextContent('Predictions remain available');
    expect(screen.getByRole('button', { name: /Surface mark/ })).toBeVisible();
  });
  it('opens history for the collection path, including a trailing slash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], hasMore: false })));
    renderApp('/inspections/'); expect(screen.getByRole('heading', { name: 'Inspection history' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'No inspections yet' })).toBeVisible();
  });
  it('allows retry after an initial fetch network failure', async () => {
    vi.useFakeTimers(); lifecycle(() => { throw new TypeError('offline'); }, () => Response.json(completed));
    renderApp(`/inspections/${completed.id}`); await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this inspection');
    fireEvent.click(screen.getByRole('button', { name: 'Try fetching again' })); await tick(5);
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeVisible();
  });
});
