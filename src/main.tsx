/**
 * Dev entry point — renders the widget with an env picker for local testing.
 * Production embedding uses embed.tsx via the library build.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VoterInfoWidget } from './VoterInfoWidget';
import { initRosters } from './services/bundledRosters';
import { EnvPicker, ENV_API_BASE, useEnvFromUrl, type EnvName } from './EnvPicker';
import './styles/widget.css';

function Harness() {
  const { env: initialEnv, locked } = useEnvFromUrl('dev');
  const [env, setEnv] = useState<EnvName>(initialEnv);
  const apiBase = ENV_API_BASE[env];
  // Re-init the member-profile cache apiBase whenever env changes.
  initRosters(apiBase);
  return (
    <>
      <EnvPicker value={env} locked={locked} onChange={setEnv} />
      <VoterInfoWidget key={env} apiBase={apiBase} showErrorDetails={env !== 'prod'} />
    </>
  );
}

const root = document.getElementById('root')!;
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
