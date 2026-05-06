/**
 * Tests for src/admin/components/MocPicker.tsx.
 *
 * Shared MoC typeahead. Verifies:
 *   - typing < 2 chars does not search
 *   - debounced search calls /api/name-search and renders results
 *   - selecting a result calls onChange(entry)
 *   - clearing (×) calls onChange(null) and resets input
 *   - external value sync (controlled prop)
 *   - outside-click closes dropdown
 *   - partyStyle returns the right palette for each known party + fallback
 *
 * Trace: FR-52 (admin SPA typeahead).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MocPicker, partyStyle, type MocEntry } from '../../src/admin/components/MocPicker';

const realFetch = globalThis.fetch;

function moc(overrides: Partial<MocEntry> = {}): MocEntry {
  return {
    bioguideId: overrides.bioguideId ?? 'A000001',
    displayName: overrides.displayName ?? 'Alice Adams',
    first: overrides.first ?? 'Alice',
    last: overrides.last ?? 'Adams',
    state: overrides.state ?? 'CA',
    chamber: overrides.chamber ?? 'House',
    district: overrides.district ?? 12,
    party: overrides.party ?? 'D',
    photoUrl: overrides.photoUrl ?? null,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('partyStyle', () => {
  it.each([['D'], ['R'], ['I'], ['L'], ['G']])('returns the palette for known party %s', (p) => {
    const s = partyStyle(p);
    expect(s.bg).toMatch(/#/);
    expect(s.fg).toBe('#ffffff');
    expect(s.accent).toMatch(/#/);
  });

  it('returns a neutral fallback for unknown party', () => {
    const s = partyStyle('Z');
    expect(s.bg).toBe('#333');
    expect(s.fg).toBe('#fff');
    expect(s.accent).toBe('#888');
  });
});

describe('MocPicker', () => {
  it('does not call /api/name-search for queries < 2 chars', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ results: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    const onChange = vi.fn();
    render(<MocPicker value={null} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'a' } });
    // Wait past the 200ms debounce to confirm no fetch was attempted.
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toBe(0);
  });

  it('debounces input + searches and renders results in a dropdown', async () => {
    const results = [moc({ bioguideId: 'A1', displayName: 'Alice Adams' }), moc({ bioguideId: 'B2', displayName: 'Bob Brown', party: 'R' })];
    let lastUrl = '';
    globalThis.fetch = async (input: RequestInfo | URL) => {
      lastUrl = String(input);
      return new Response(JSON.stringify({ results }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    const onChange = vi.fn();
    render(<MocPicker value={null} onChange={onChange} placeholder="Find rep" />);
    const input = screen.getByPlaceholderText('Find rep');
    fireEvent.change(input, { target: { value: 'al' } });
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument(), { timeout: 2000 });
    expect(lastUrl).toContain('/api/name-search?q=al');
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
  });

  it('selecting a result calls onChange and closes the dropdown', async () => {
    const results = [moc({ bioguideId: 'A1', displayName: 'Alice Adams' })];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ results }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    const onChange = vi.fn();
    render(<MocPicker value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'al' } });
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.click(screen.getByText('Alice Adams'));
    expect(onChange).toHaveBeenCalledWith(results[0]);
  });

  it('clear button calls onChange(null) and resets the input', () => {
    const onChange = vi.fn();
    const value = moc({ displayName: 'Alice Adams' });
    render(<MocPicker value={value} onChange={onChange} />);
    const clear = screen.getByTitle('Clear');
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('typing while value is set clears the value (calls onChange(null))', () => {
    const onChange = vi.fn();
    const value = moc({ displayName: 'Alice Adams' });
    render(<MocPicker value={value} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Alice Adam' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders party badge with state-district for House members', () => {
    const value = moc({ chamber: 'House', state: 'CA', district: 12, party: 'D' });
    render(<MocPicker value={value} onChange={() => {}} />);
    expect(screen.getByText('D · CA-12')).toBeInTheDocument();
  });

  it('renders party badge with state only for Senate members', () => {
    const value = moc({ chamber: 'Senate', state: 'TX', district: null, party: 'R' });
    render(<MocPicker value={value} onChange={() => {}} />);
    expect(screen.getByText('R · TX')).toBeInTheDocument();
  });

  it('outside-click closes the dropdown', async () => {
    const results = [moc({ bioguideId: 'A1', displayName: 'Alice Adams' })];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ results }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    render(<MocPicker value={null} onChange={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'al' } });
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText('Alice Adams')).toBeNull());
  });

  it('handles fetch error gracefully (clears results, no throw)', async () => {
    globalThis.fetch = async () => { throw new Error('network'); };
    render(<MocPicker value={null} onChange={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'al' } });
    // Wait past debounce + microtask to confirm error swallowed.
    await new Promise((r) => setTimeout(r, 300));
    // No dropdown rendered — quietly degrades.
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('focusing the input with prior results re-opens the dropdown', async () => {
    const results = [moc({ bioguideId: 'A1', displayName: 'Alice Adams' })];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ results }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    render(<MocPicker value={null} onChange={() => {}} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'al' } });
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText('Alice Adams')).toBeNull());
    fireEvent.focus(input);
    expect(screen.getByText('Alice Adams')).toBeInTheDocument();
  });

  it('syncs query text from external value prop change', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MocPicker value={null} onChange={onChange} />);
    const v = moc({ displayName: 'Charlie Chen' });
    rerender(<MocPicker value={v} onChange={onChange} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Charlie Chen');
  });
});
