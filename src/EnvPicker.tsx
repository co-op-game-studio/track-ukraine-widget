/**
 * Env picker for the local dev harness.
 *
 * Routes API calls to the selected env. Supports URL locking via ?env=<name>
 * so the Access-gated non-prod environments can link back to this harness
 * with a fixed env (bypassing the Access challenge the user would otherwise
 * hit when visiting dev/uat/stg directly in a browser).
 *
 * Prod is reachable but the "View prod" link forwards to vote.cogs.it.com
 * directly since that's the real public widget.
 */
import { useMemo, type ChangeEvent } from 'react';

export type EnvName = 'local' | 'dev' | 'uat' | 'stg' | 'prod';

export const ENV_API_BASE: Record<EnvName, string> = {
  // "local" = same-origin, served by whatever is on the Vite dev host (wrangler dev etc)
  local: '',
  // Non-prod envs go through the Vite dev proxy (/env-<name>) so service-token
  // auth is injected server-side and the browser never sees the Access challenge.
  dev: '/env-dev',
  uat: '/env-uat',
  stg: '/env-stg',
  // Prod is public — hit it directly to exercise the real CDN path.
  prod: '/env-prod',
};

export interface EnvPickerProps {
  value: EnvName;
  locked: boolean;
  onChange: (next: EnvName) => void;
}

export function EnvPicker({ value, locked, onChange }: EnvPickerProps) {
  const handle = (e: ChangeEvent<HTMLSelectElement>) => {
    onChange(e.target.value as EnvName);
  };
  return (
    <div
      style={{
        position: 'fixed',
        top: 8,
        right: 8,
        background: '#000',
        color: '#ffd400',
        padding: '6px 10px',
        borderRadius: 4,
        fontFamily: 'monospace',
        fontSize: 12,
        zIndex: 9999,
        border: '2px solid #ffd400',
      }}
    >
      <label htmlFor="viw-env-picker" style={{ marginRight: 6 }}>
        ENV:
      </label>
      <select
        id="viw-env-picker"
        value={value}
        onChange={handle}
        disabled={locked}
        style={{
          background: '#000',
          color: '#ffd400',
          border: '1px solid #ffd400',
          fontFamily: 'monospace',
          fontSize: 12,
          padding: '2px 4px',
        }}
      >
        <option value="local">local</option>
        <option value="dev">dev</option>
        <option value="uat">uat</option>
        <option value="stg">stg</option>
        <option value="prod">prod</option>
      </select>
      {locked && <span style={{ marginLeft: 6 }}>🔒</span>}
      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>
        {ENV_API_BASE[value] || '(same-origin)'}
      </div>
    </div>
  );
}

/** Read the desired env from the URL (?env=<name>) or fall back to a default.
 *  Returns { env, locked } — locked=true if the URL supplied a valid env param. */
export function useEnvFromUrl(defaultEnv: EnvName): { env: EnvName; locked: boolean } {
  return useMemo(() => {
    if (typeof window === 'undefined') return { env: defaultEnv, locked: false };
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('env');
    if (raw && raw in ENV_API_BASE) {
      return { env: raw as EnvName, locked: true };
    }
    return { env: defaultEnv, locked: false };
  }, [defaultEnv]);
}
