/**
 * ErrorBanner — inline/banner error display.
 * Traces to: NFR-6, T-019
 */

export interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="viw-error-banner" role="alert">
      <span className="viw-error-banner-message">{message}</span>
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
