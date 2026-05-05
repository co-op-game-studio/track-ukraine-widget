/**
 * AC-52.46 + AC-52.48 — BillImportPanel.
 *
 * Two tabs:
 *   - Direct (congress / type / number)
 *   - Paste Congress.gov URL (regex parser → triple)
 *
 * Submitting POSTs /api/admin/import-bill and resolves with the new bill_id.
 * Esc and Cancel close (resolve null). Errors render inline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BillImportPanel } from '../../src/admin/components/BillImportPanel';

interface PostCall {
  url: string;
  body: unknown;
}

function installFetch(opts: {
  importResult?: Record<string, unknown>;
  importStatus?: number;
  importBody?: Record<string, unknown>;
  onCall?: (c: PostCall) => void;
} = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    const bodyText = (init?.body as string | undefined) ?? null;
    const body = bodyText ? JSON.parse(bodyText) : null;
    if (url.includes('/api/admin/import-bill') && method === 'POST') {
      opts.onCall?.({ url, body });
      const status = opts.importStatus ?? 200;
      const respBody = opts.importBody ?? opts.importResult ?? {
        bill: { bill_id: '119-HR-1601', title: 'Test Bill', direction: 'pro-ukraine' },
        votes_imported: 0, votes_updated: 0, votes_skipped: 0,
        cosponsors_imported: 9, actions_imported: 12,
        cached: false, duration_ms: 1234, trace_id: 'tr_test',
      };
      return new Response(JSON.stringify(respBody), { status });
    }
    return new Response('{}', { status: 404 });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BillImportPanel — Direct tab (AC-52.46)', () => {
  it('submits congress / type / number to /api/admin/import-bill', async () => {
    const calls: PostCall[] = [];
    installFetch({ onCall: (c) => calls.push(c) });
    const onResolve = vi.fn();
    render(<BillImportPanel onResolve={onResolve} />);

    const number = screen.getByLabelText(/Number/i) as HTMLInputElement;
    fireEvent.change(number, { target: { value: '1601' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import$/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body['congress']).toBe(119);
    expect(body['type']).toBe('HR');
    expect(body['number']).toBe('1601');
    expect(body['_reason']).toMatch(/Onboarding/i);
  });

  it('strips non-digits from Number input', () => {
    installFetch();
    render(<BillImportPanel onResolve={() => undefined} />);
    const number = screen.getByLabelText(/Number/i) as HTMLInputElement;
    fireEvent.change(number, { target: { value: 'HR-2471 ' } });
    expect(number.value).toBe('2471');
  });

  it('Import button disabled until Number is filled', () => {
    installFetch();
    render(<BillImportPanel onResolve={() => undefined} />);
    const importBtn = screen.getByRole('button', { name: /^Import$/i }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Number/i), { target: { value: '99' } });
    expect(importBtn.disabled).toBe(false);
  });

  it('on success, calls onResolve(bill_id) after a brief delay', async () => {
    installFetch();
    const onResolve = vi.fn();
    render(<BillImportPanel onResolve={onResolve} />);
    fireEvent.change(screen.getByLabelText(/Number/i), { target: { value: '1601' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import$/i }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('119-HR-1601'), { timeout: 2000 });
  });

  it('on upstream 404, surfaces error inline (no resolve)', async () => {
    installFetch({
      importStatus: 404,
      importBody: { error: 'bill_not_found', detail: 'Congress.gov has no such bill' },
    });
    const onResolve = vi.fn();
    render(<BillImportPanel onResolve={onResolve} />);
    fireEvent.change(screen.getByLabelText(/Number/i), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import$/i }));
    await waitFor(() =>
      expect(screen.getByText(/Congress\.gov has no such bill/i)).toBeInTheDocument(),
    );
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe('BillImportPanel — Paste Congress.gov URL tab (AC-52.46)', () => {
  it('parses house-bill URL into the right triple', async () => {
    const calls: PostCall[] = [];
    installFetch({ onCall: (c) => calls.push(c) });
    render(<BillImportPanel onResolve={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /Paste Congress\.gov URL/i }));
    const url = screen.getByLabelText(/Congress\.gov URL/i) as HTMLInputElement;
    fireEvent.change(url, {
      target: { value: 'https://www.congress.gov/bill/119th-congress/house-bill/1601' },
    });
    // Parsed-hint text should appear.
    expect(screen.getByText(/119-HR-1601/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Import$/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body['congress']).toBe(119);
    expect(body['type']).toBe('HR');
    expect(body['number']).toBe('1601');
  });

  it('parses senate-joint-resolution URL into SJRES type', async () => {
    installFetch();
    render(<BillImportPanel onResolve={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Paste Congress\.gov URL/i }));
    fireEvent.change(screen.getByLabelText(/Congress\.gov URL/i), {
      target: { value: 'https://www.congress.gov/bill/118th-congress/senate-joint-resolution/77' },
    });
    expect(screen.getByText(/118-SJRES-77/)).toBeInTheDocument();
  });

  it('rejects unparseable URL with inline error', async () => {
    installFetch();
    render(<BillImportPanel onResolve={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Paste Congress\.gov URL/i }));
    fireEvent.change(screen.getByLabelText(/Congress\.gov URL/i), {
      target: { value: 'https://google.com' },
    });
    // Submit disabled (no parse hint either).
    const importBtn = screen.getByRole('button', { name: /^Import$/i }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
  });
});

describe('BillImportPanel — close behavior', () => {
  it('Cancel button resolves with null', () => {
    installFetch();
    const onResolve = vi.fn();
    render(<BillImportPanel onResolve={onResolve} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Cancel$/i })[0]!);
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('✕ icon button resolves with null', () => {
    installFetch();
    const onResolve = vi.fn();
    render(<BillImportPanel onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: /Close/i }));
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('Esc key resolves with null', () => {
    installFetch();
    const onResolve = vi.fn();
    render(<BillImportPanel onResolve={onResolve} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onResolve).toHaveBeenCalledWith(null);
  });
});
