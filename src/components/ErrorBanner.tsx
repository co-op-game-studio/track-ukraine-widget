/**
 * ErrorBanner — inline/banner error display.
 *
 * Traces to: NFR-6, T-019.
 * v2.6.0 — carries an optional trace ID (FR-36 AC-36.5) and an optional
 * retry affordance (FR-37 AC-37.5). Both fields are purely additive; legacy
 * callers that pass only `message` still render exactly as before.
 */

export interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  /** Per-request trace ID from the Worker's `X-Trace-Id` header or the
   *  FR-37 error envelope's `error.traceId` field. Rendered as a muted,
   *  monospace, selectable reference line so a bug reporter can quote it. */
  traceId?: string;
  /** When supplied, renders a "Try again" button wired to this callback.
   *  Caller decides retryability — typically from the FR-37 envelope's
   *  `error.retryable` flag. */
  onRetry?: () => void;
}

export function ErrorBanner({ message, onDismiss, traceId, onRetry }: ErrorBannerProps) {
  return (
    <div className="viw-error-banner" role="alert">
      <span className="viw-error-banner-message">{message}</span>
      {traceId && (
        <span className="viw-error-banner-trace">Reference: {traceId}</span>
      )}
      {onRetry && (
        <button
          type="button"
          className="viw-error-banner-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="viw-error-banner-close"
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          ×
        </button>
      )}
    </div>
  );
}
