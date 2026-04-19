/**
 * NameSearchInput \u2014 input + inline status glyph.
 * Traces to: FR-31 AC-31.1\u201331.12, FR-33 AC-33.7\u201333.10.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NameSearchInput } from '../../src/components/NameSearchInput';

function baseProps(overrides: Partial<Parameters<typeof NameSearchInput>[0]> = {}) {
  return {
    value: '',
    onChange: vi.fn(),
    ...overrides,
  };
}

describe('NameSearchInput', () => {
  it('renders an input with the documented placeholder and label', () => {
    render(<NameSearchInput {...baseProps()} />);
    expect(screen.getByLabelText(/search by name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Durbin or Tammy/i)).toBeInTheDocument();
  });

  it('calls onChange with each keystroke value', () => {
    const onChange = vi.fn();
    render(<NameSearchInput {...baseProps({ onChange })} value="du" />);
    const input = screen.getByLabelText(/search by name/i);
    fireEvent.change(input, { target: { value: 'durb' } });
    expect(onChange).toHaveBeenCalledWith('durb');
  });

  it('renders disabled when disabled=true', () => {
    render(<NameSearchInput {...baseProps({ disabled: true })} />);
    const input = screen.getByLabelText(/search by name/i) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('AC-33.7: renders NO status glyph in idle state (status undefined)', () => {
    render(<NameSearchInput {...baseProps()} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('AC-33.7: renders the loading glyph with title="Searching\u2026" when status=loading', () => {
    const { container } = render(
      <NameSearchInput {...baseProps({ value: 'du' })} status="loading" />,
    );
    const glyph = screen.getByRole('status');
    expect(glyph).toHaveAttribute('title', expect.stringMatching(/Searching/));
    expect(container.querySelector('.viw-search-status-loading')).not.toBeNull();
  });

  it('AC-33.7: renders the "!" error glyph when status=error', () => {
    render(<NameSearchInput {...baseProps()} status="error" />);
    const glyph = screen.getByRole('status');
    expect(glyph).toHaveTextContent('!');
    expect(glyph.getAttribute('title')).toMatch(/Search failed/i);
  });

  it('AC-33.7: renders the "!" unavailable glyph when status=unavailable', () => {
    render(<NameSearchInput {...baseProps()} status="unavailable" />);
    const glyph = screen.getByRole('status');
    expect(glyph).toHaveTextContent('!');
    expect(glyph.getAttribute('title')).toMatch(/Search unavailable/i);
  });

  it('AC-33.7: renders the "?" warn glyph on status=success + zero results', () => {
    render(
      <NameSearchInput
        {...baseProps({ value: 'zzz' })}
        status="success"
        resultCount={0}
      />,
    );
    const glyph = screen.getByRole('status');
    expect(glyph).toHaveTextContent('?');
    expect(glyph.getAttribute('title')).toMatch(/No matches/i);
  });

  it('AC-33.7: hides the glyph on status=success + nonzero results', () => {
    render(
      <NameSearchInput
        {...baseProps({ value: 'du' })}
        status="success"
        resultCount={3}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('AC-33.9: showErrorDetails=true on error surfaces the upstream message via title', () => {
    render(
      <NameSearchInput
        {...baseProps()}
        status="error"
        showErrorDetails
        errorMessage="Boom."
      />,
    );
    const glyph = screen.getByRole('status');
    expect(glyph.getAttribute('title')).toMatch(/Boom\./);
  });

  it('AC-33.9: showErrorDetails=false on error hides upstream detail', () => {
    render(
      <NameSearchInput
        {...baseProps()}
        status="error"
        errorMessage="Boom."
      />,
    );
    const glyph = screen.getByRole('status');
    // Generic "Search failed" only \u2014 no upstream detail leaking to title.
    expect(glyph.getAttribute('title')).toMatch(/Search failed/i);
    expect(glyph.getAttribute('title')).not.toMatch(/Boom/);
  });

  it('AC-33.10: status glyph carries aria-label matching its title', () => {
    render(
      <NameSearchInput
        {...baseProps()}
        status="error"
        showErrorDetails
        errorMessage="Boom."
      />,
    );
    const glyph = screen.getByRole('status');
    expect(glyph.getAttribute('aria-label')).toBe(glyph.getAttribute('title'));
  });
});
