/**
 * ErrorBanner — inline error display.
 * Traces to: NFR-6, T-019.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBanner } from '../../src/components/ErrorBanner';

describe('ErrorBanner', () => {
  it('renders the message text inside a role=alert region', () => {
    render(<ErrorBanner message="Lookup failed." />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Lookup failed.');
  });

  it('omits the dismiss button when onDismiss is not provided', () => {
    render(<ErrorBanner message="Oh no." />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });

  it('renders a dismiss button with accessible label when onDismiss is provided', () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="Oh no." onDismiss={onDismiss} />);
    const btn = screen.getByRole('button', { name: /dismiss error/i });
    expect(btn).toBeInTheDocument();
  });

  it('fires onDismiss exactly once when the close button is clicked', () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="Oh no." onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
