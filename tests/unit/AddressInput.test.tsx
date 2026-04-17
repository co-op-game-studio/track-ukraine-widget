/**
 * AddressInput Component Tests
 * Traces to: US-1, T-014
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddressInput } from '../../src/components/AddressInput';

describe('AddressInput', () => {
  it('calls onSubmit with trimmed value', () => {
    const onSubmit = vi.fn();
    render(<AddressInput onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/home address/i), {
      target: { value: '  2000 S State St, Chicago, IL 60616  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    expect(onSubmit).toHaveBeenCalledWith('2000 S State St, Chicago, IL 60616');
  });

  it('shows inline error for too-short address', () => {
    const onSubmit = vi.fn();
    render(<AddressInput onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/home address/i), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('disables submit button and shows "Looking up…" when disabled', () => {
    render(<AddressInput onSubmit={vi.fn()} disabled />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/looking up/i);
  });

  it('keeps submit disabled while input is empty', () => {
    render(<AddressInput onSubmit={vi.fn()} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
