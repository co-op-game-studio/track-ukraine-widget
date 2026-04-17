/**
 * AddressInput — address form.
 * Traces to: US-1 (AC-1.1, AC-1.5), T-014
 */
import { useState, type FormEvent } from 'react';

export interface AddressInputProps {
  onSubmit: (address: string) => void;
  disabled?: boolean;
}

export function AddressInput({ onSubmit, disabled = false }: AddressInputProps) {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length < 5) {
      setLocalError('Please enter a full U.S. street address.');
      return;
    }
    setLocalError(null);
    onSubmit(trimmed);
  }

  return (
    <form className="viw-address-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor="viw-address" className="viw-address-label">
        Enter your home address
      </label>
      <div className="viw-address-row">
        <input
          id="viw-address"
          type="text"
          className="viw-address-input"
          placeholder="123 Main St, Springfield, IL 62701"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          autoComplete="street-address"
          aria-describedby={localError ? 'viw-address-error' : undefined}
        />
        <button
          type="submit"
          className="viw-address-submit"
          disabled={disabled || value.trim().length === 0}
        >
          {disabled ? 'Looking up…' : 'Look Up'}
        </button>
      </div>
      {localError && (
        <div id="viw-address-error" role="alert" className="viw-address-error">
          {localError}
        </div>
      )}
    </form>
  );
}
