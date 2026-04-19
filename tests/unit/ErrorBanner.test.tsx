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

  describe('FR-36 / FR-37: trace ID + retry affordance', () => {
    it('renders the trace ID reference line when traceId is supplied', () => {
      render(<ErrorBanner message="Lookup failed." traceId="tr_0123456789abcdef" />);
      expect(screen.getByText(/Reference:\s*tr_0123456789abcdef/)).toBeInTheDocument();
    });

    it('does NOT render the trace-ID line when traceId is omitted', () => {
      render(<ErrorBanner message="Oh no." />);
      expect(screen.queryByText(/Reference:/)).toBeNull();
    });

    it('renders a "Try again" button when onRetry is provided', () => {
      const onRetry = vi.fn();
      render(<ErrorBanner message="Upstream hiccup." onRetry={onRetry} />);
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('does NOT render a retry button when onRetry is omitted', () => {
      render(<ErrorBanner message="Bad request." />);
      expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    });

    it('fires onRetry exactly once when "Try again" is clicked', () => {
      const onRetry = vi.fn();
      render(<ErrorBanner message="Upstream hiccup." onRetry={onRetry} />);
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('renders the trace-ID line with the monospace ref class for styling', () => {
      const { container } = render(
        <ErrorBanner message="x" traceId="tr_0123456789abcdef" />,
      );
      const ref = container.querySelector('.viw-error-banner-trace');
      expect(ref).not.toBeNull();
      expect(ref).toHaveTextContent(/tr_0123456789abcdef/);
    });

    it('trace-ID element is selectable (not aria-hidden)', () => {
      const { container } = render(
        <ErrorBanner message="x" traceId="tr_0123456789abcdef" />,
      );
      const ref = container.querySelector('.viw-error-banner-trace');
      expect(ref?.getAttribute('aria-hidden')).not.toBe('true');
    });
  });
});
