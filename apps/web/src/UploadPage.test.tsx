import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES, PCB_CONFIGURATION } from '@vip/contracts';
import { onlineManager } from '@tanstack/react-query';
import { renderApp } from './test/render';
import { accepted, apiError, asset, completed, pcbCompleted } from './test/fixtures';

const image = () => new File(['image bytes'], 'panel.png', { type: 'image/png' });
function server() {
  return vi.fn<typeof fetch>(async (path, options) => {
    if (path === '/api/v1/assets' && options?.method === 'POST') return Response.json(asset, { status: 201 });
    if (path === '/api/v1/inspections' && options?.method === 'POST') return Response.json(accepted, { status: 202 });
    if (path === accepted.url) return Response.json(completed);
    if (path === `/api/v1/assets/${asset.id}`) return Response.json(asset);
    throw new Error(`Unexpected request: ${String(path)}`);
  });
}

describe('upload and inspection submission', () => {
  it('starts with an accessible file input, constraints, and disabled submit', () => {
    renderApp();
    expect(screen.getByLabelText('Image file')).toHaveAttribute('accept', expect.stringContaining('image/png'));
    expect(screen.getByText('No image selected.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload and inspect' })).toBeDisabled();
    expect(screen.getByText(/up to 10 MiB and 20 megapixels/)).toBeVisible();
  });
  it.each(['image/png', 'image/jpeg'])('selects and submits %s, then navigates to saved results', async type => {
    const fetchMock = server(); vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(); renderApp();
    const file = new File(['bytes'], type === 'image/png' ? 'sample.png' : 'sample.jpg', { type });
    await user.upload(screen.getByLabelText('Image file'), file);
    expect(screen.getByText(new RegExp(file.name))).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '2 detections' })).toBeVisible();
    const upload = fetchMock.mock.calls.find(([path]) => path === '/api/v1/assets');
    const form = upload?.[1]?.body as FormData;
    expect(form.get('source')).toBe('browser'); expect(form.get('image')).toBeInstanceOf(File);
    const submission = fetchMock.mock.calls.find(([path]) => path === '/api/v1/inspections');
    expect(JSON.parse(submission?.[1]?.body as string)).toEqual({ assetId: asset.id });
    expect((submission?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/);
  });
  it.each([
    new File(['bad'], 'bad.gif', { type: 'image/gif' }),
    new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'huge.png', { type: 'image/png' }),
    new File([], 'empty.png', { type: 'image/png' }),
  ])('rejects invalid selection $name before any network call', async file => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false }); renderApp();
    await user.upload(screen.getByLabelText('Image file'), file);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload and inspect' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows uploading and blocks concurrent form submission', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = server().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp();
    await user.upload(screen.getByLabelText('Image file'), image());
    const button = screen.getByRole('button', { name: 'Upload and inspect' });
    await user.dblClick(button);
    expect(screen.getByRole('status')).toHaveTextContent('Uploading and validating');
    expect(screen.getByLabelText('Image file')).toBeDisabled();
    fireEvent.submit(button.closest('form')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(Response.json(asset, { status: 201 }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections')).toHaveLength(1);
  });
  it('shows authoritative backend validation without exposing arbitrary messages', async () => {
    const fetchMock = server().mockResolvedValueOnce(apiError('CORRUPT_IMAGE', 422));
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp();
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be decoded');
    expect(screen.queryByText('Do not show arbitrary server details')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('allows an explicitly requested upload retry after network failure', async () => {
    const fetchMock = server().mockRejectedValueOnce(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp();
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    await user.click(screen.getByRole('button', { name: 'Retry upload' }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(2);
  });
  it.each(['network', 'server', 'invalid acceptance'])('keeps the uploaded asset and idempotency key after %s creation failure', async failure => {
    const fetchMock = server();
    let creates = 0;
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/inspections' && ++creates === 1) {
        if (failure === 'network') throw new TypeError('lost acknowledgement');
        return failure === 'server' ? apiError('DATABASE_FAILURE', 503) : Response.json({ id: 'bad' }, { status: 202 });
      }
      return implementation(path, options);
    });
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp();
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your image is saved');
    expect(screen.getByRole('alert')).toHaveTextContent('will not upload it again');
    await user.click(screen.getByRole('button', { name: 'Retry inspection submission' }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    const submissions = fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections');
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.[1]?.headers).toEqual(submissions[1]?.[1]?.headers);
    expect(submissions[0]?.[1]?.body).toEqual(submissions[1]?.[1]?.body);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(1);
  });
  it('starts a fresh logical request when the user selects another image', async () => {
    const fetchMock = server();
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, options) => path === '/api/v1/inspections' ? apiError('DATABASE_FAILURE', 503) : implementation(path, options));
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp();
    for (const name of ['one.png', 'two.png']) {
      await user.upload(screen.getByLabelText('Image file'), new File(['bytes'], name, { type: 'image/png' }));
      await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
      await screen.findByRole('alert');
    }
    const submissions = fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections');
    expect(submissions[0]?.[1]?.headers).not.toEqual(submissions[1]?.[1]?.headers);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(2);
  });
  it('aborts an upload when navigating away', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise(() => {})); vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(); const { unmount } = renderApp();
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    unmount(); await waitFor(() => { expect(signal?.aborted).toBe(true); });
  });
  it('reports an offline submission immediately instead of queuing a future mutation', async () => {
    onlineManager.setOnline(false);
    try {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline')); vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup(); renderApp();
      await user.upload(screen.getByLabelText('Image file'), image());
      await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
      expect(screen.getByRole('button', { name: 'Retry upload' })).toBeEnabled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { onlineManager.setOnline(true); }
  });
  it('does not create an inspection after a late upload response on an unmounted page', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(); const { unmount } = renderApp();
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    unmount(); finish(Response.json(asset, { status: 201 }));
    await waitFor(() => { expect(fetchMock.mock.settledResults[0]?.type).toBe('fulfilled'); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('blocks duplicate submission while inspection acceptance is pending', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = server(); const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, options) => path === '/api/v1/inspections'
      ? new Promise(resolve => { finish = resolve; }) : implementation(path, options));
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp();
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    const button = await screen.findByRole('button', { name: 'Submitting…' });
    expect(button).toBeDisabled(); expect(screen.getByRole('status')).toHaveTextContent('Image saved');
    fireEvent.submit(button.closest('form')!);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections')).toHaveLength(1);
    finish(Response.json(accepted, { status: 202 }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
  });
});

describe('explicit trained PCB mode', () => {
  function trainedServer(dimensions = 300) {
    const fallback = server().getMockImplementation()!;
    return vi.fn<typeof fetch>(async (path, options) => {
      if (path === '/api/v1/inference-modes') return Response.json({ trained: { enabled: true, available: true } });
      if (path === '/api/v1/assets' && options?.method === 'POST') return Response.json({ ...asset, width: dimensions, height: dimensions }, { status: 201 });
      if (path === accepted.url) return Response.json(pcbCompleted);
      return fallback(path, options);
    });
  }
  async function selectTrained(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Check trained model availability' }));
    await waitFor(() => { expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeEnabled(); });
    await user.click(screen.getByRole('radio', { name: 'Trained PCB detector' }));
  }
  it('keeps trained mode unavailable until readiness is verified and requires an explicit candidate-patch confirmation', async () => {
    const fetchMock = trainedServer(); vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(); renderApp();
    expect(screen.getByRole('radio', { name: 'Simulated demo' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
    await selectTrained(user);
    await user.upload(screen.getByLabelText('Image file'), image());
    expect(screen.getByRole('button', { name: 'Upload and inspect' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I confirm this is a real 300/ }));
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    expect(screen.getByText('Trained model', { exact: true })).toBeVisible();
    const request = fetchMock.mock.calls.find(([path]) => path === '/api/v1/inspections')!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ assetId: asset.id, provider: PCB_CONFIGURATION, candidatePatch: true });
  });
  it('prevents non-300×300 canonical images from reaching trained inference', async () => {
    const fetchMock = trainedServer(600); vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(); renderApp(); await selectTrained(user);
    await user.click(screen.getByRole('checkbox', { name: /I confirm this is a real 300/ }));
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('canonical image has different dimensions');
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections')).toHaveLength(0);
    expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeChecked();
  });
  it('keeps the independent demo available when readiness fails without claiming the model is ready', async () => {
    const fetchMock = server(); const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/inference-modes') throw new TypeError('unavailable');
      return implementation(path, options);
    });
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp();
    await user.click(screen.getByRole('button', { name: 'Check trained model availability' }));
    expect(await screen.findByText(/availability could not be verified/)).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Simulated demo' })).toBeChecked();
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
  });
  it('retries trained acceptance with the same immutable provider, attestation, asset, and key', async () => {
    const fetchMock = trainedServer(); const implementation = fetchMock.getMockImplementation()!;
    let creates = 0;
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/inspections' && ++creates === 1) throw new TypeError('lost response');
      return implementation(path, options);
    });
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp(); await selectTrained(user);
    await user.click(screen.getByRole('checkbox', { name: /I confirm this is a real 300/ }));
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry inspection submission' }));
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    const requests = fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections');
    expect(requests).toHaveLength(2); expect(requests[0]?.[1]?.body).toBe(requests[1]?.[1]?.body);
    expect(requests[0]?.[1]?.headers).toEqual(requests[1]?.[1]?.headers);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(1);
  });
  it('confirms an ambiguous trained submission during a later model outage with the same intent and no re-upload', async () => {
    const fetchMock = trainedServer(); const implementation = fetchMock.getMockImplementation()!;
    let creates = 0; let checks = 0;
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/inference-modes' && ++checks > 1) {
        return Response.json({ trained: { enabled: true, available: false, reason: 'The trained model is temporarily offline.' } });
      }
      if (path === '/api/v1/inspections' && ++creates === 1) throw new TypeError('accepted, but response was lost');
      return implementation(path, options);
    });
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp(); await selectTrained(user);
    await user.click(screen.getByRole('checkbox', { name: /I confirm this is a real 300/ }));
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Check trained model availability' }));
    await screen.findByText('The trained model is temporarily offline.');
    expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeChecked();
    const retry = screen.getByRole('button', { name: 'Retry inspection submission' });
    expect(retry).toBeEnabled();
    await user.click(retry);
    expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
    const requests = fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections');
    expect(requests).toHaveLength(2);
    expect(requests[1]![1]!.body).toEqual(requests[0]![1]!.body);
    expect(requests[1]![1]!.headers).toEqual(requests[0]![1]!.headers);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(1);
  });
  it('blocks a new trained submission if a later availability check reports an outage', async () => {
    const fetchMock = trainedServer(); const implementation = fetchMock.getMockImplementation()!;
    let checks = 0;
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/inference-modes' && ++checks > 1) return Response.json({ trained: { enabled: true, available: false } });
      return implementation(path, options);
    });
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp(); await selectTrained(user);
    await user.click(screen.getByRole('checkbox', { name: /I confirm this is a real 300/ }));
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Check trained model availability' }));
    await waitFor(() => { expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeDisabled(); });
    const submit = screen.getByRole('button', { name: 'Upload and inspect' }); expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets' || path === '/api/v1/inspections')).toHaveLength(0);
  });
  it('does not advertise stale success or allow a new trained intent after the latest availability check fails', async () => {
    const fetchMock = trainedServer(); const implementation = fetchMock.getMockImplementation()!;
    let checks = 0;
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/inference-modes' && ++checks > 1) throw new TypeError('latest check unavailable');
      return implementation(path, options);
    });
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp(); await selectTrained(user);
    await user.click(screen.getByRole('checkbox', { name: /I confirm this is a real 300/ }));
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Check trained model availability' }));
    expect(await screen.findByText(/availability could not be verified/)).toBeVisible();
    expect(screen.queryByText(/The pinned trained PCB model is ready/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Trained PCB detector' })).toBeDisabled();
    const submit = screen.getByRole('button', { name: 'Upload and inspect' }); expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets' || path === '/api/v1/inspections')).toHaveLength(0);
  });
  it.each([true, false])('clears an ambiguous submission and its saved-asset display when attestation changes (available=%s)', async availableAfter => {
    const fetchMock = trainedServer(); const implementation = fetchMock.getMockImplementation()!;
    let available = true; let creates = 0;
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/inference-modes') return Response.json({ trained: { enabled: true, available,
        ...(!available ? { reason: 'The trained model is temporarily offline.' } : {}) } });
      if (path === '/api/v1/inspections' && ++creates === 1) throw new TypeError('accepted, but response was lost');
      return implementation(path, options);
    });
    vi.stubGlobal('fetch', fetchMock); const user = userEvent.setup(); renderApp(); await selectTrained(user);
    const attestation = screen.getByRole('checkbox', { name: /I confirm this is a real 300/ });
    await user.click(attestation);
    await user.upload(screen.getByLabelText('Image file'), image());
    await user.click(screen.getByRole('button', { name: 'Upload and inspect' }));
    await screen.findByRole('alert');
    expect(screen.getByText(/Image uploaded: 300/)).toBeVisible();
    available = availableAfter;
    await user.click(screen.getByRole('button', { name: 'Check trained model availability' }));
    if (!availableAfter) await screen.findByText('The trained model is temporarily offline.');
    await user.click(attestation);
    expect(screen.queryByText(/Image uploaded:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Upload and inspect' });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections')).toHaveLength(1);
    await user.click(attestation);
    if (!availableAfter) {
      expect(submit).toBeDisabled();
      fireEvent.submit(submit.closest('form')!);
      expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections')).toHaveLength(1);
    } else {
      expect(submit).toBeEnabled();
      await user.click(submit);
      expect(await screen.findByRole('heading', { name: 'Completed' })).toBeVisible();
      expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/assets')).toHaveLength(2);
      const requests = fetchMock.mock.calls.filter(([path]) => path === '/api/v1/inspections');
      expect(requests).toHaveLength(2);
      expect((requests[1]![1]!.headers as Record<string, string>)['Idempotency-Key'])
        .not.toBe((requests[0]![1]!.headers as Record<string, string>)['Idempotency-Key']);
    }
  });
});
