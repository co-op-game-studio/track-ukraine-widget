/**
 * Settings ▸ App config — read-only display of deployment-time settings.
 *
 * Everything here is set per-env in wrangler.toml (cron schedule, concurrency)
 * and surfaced via /api/admin/config. To change a value, edit wrangler.toml
 * and redeploy — there's no UI knob because these aren't user data.
 */
import { useEffect, useState } from 'react';
import { get } from '../../fetcher';

interface AppConfig {
  pollConcurrency: number;
  socialPollCron: string;
  socialPollStalenessMin: number;
}

export function AppConfigView() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<AppConfig>('/api/admin/config')
      .then(setConfig)
      .catch((e) => setError(typeof e === 'object' && e !== null ? (e as Record<string, unknown>).detail as string ?? String(e) : String(e)));
  }, []);

  return (
    <div style={S.root}>
      <h2 style={S.heading}>App config</h2>
      <p style={S.muted}>
        Read-only deployment-time settings (set per-env in <code>wrangler.toml</code>). To change, edit the file and redeploy.
      </p>
      {error && <div style={{ color: 'var(--tk-danger)' }}>{error}</div>}
      {config && (
        <table style={S.table}>
          <tbody>
            <Row name="POLL_CONCURRENCY" value={String(config.pollConcurrency)} help="Max parallel /poll-handle requests from the admin UI." />
            <Row name="SOCIAL_POLL_CRON" value={config.socialPollCron} help="Cron schedule for the social poll loop. Mirror of [triggers].crons." mono />
            <Row name="staleness window (derived)" value={`${config.socialPollStalenessMin} min`} help="Skip handles polled within this many minutes. Derived from cron interval minus a 5-min safety margin." />
            <Row
              name="curation mode"
              value="Keyword-only"
              help="This deployment auto-curates posts that match a configured keyword. Other modes are reserved for future deployments and not user-tunable here."
            />
          </tbody>
        </table>
      )}

      <h3 style={S.subhead}>Lifting rate / quota caps</h3>
      <p style={S.muted}>
        Rate-limit pauses (HTTP 429) are transient — wait the retry window and the poll resumes. Quota exhaustion (HTTP 403 with quota body) is a hard cap and won't recover until the cap resets or the operator takes one of these actions:
      </p>
      <table style={S.table}>
        <tbody>
          <CapRow
            platform="Bluesky"
            cost="Free (no paid tier)"
            action="Just back off — limits are per-IP, ~3,000 req / 5 min. Resets continuously."
          />
          <CapRow
            platform="Mastodon"
            cost="Free (per-instance)"
            action="Spread handles across multiple instances if one's cap is tight."
          />
          <CapRow
            platform="YouTube"
            cost="Free quota expansion"
            action={<>Apply for &quot;Extended Quota&quot; in <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" rel="noopener noreferrer" style={S.link}>Google Cloud Console ↗</a>. Default 10k units/day → up to 1M with approval (~7 days). Or split across multiple GCP projects.</>}
          />
          <CapRow
            platform="Twitter / X"
            cost="$200 / $5,000 / month"
            action={<>Free tier: ~1,500 reads/month total. Basic ($200/mo): 10k. Pro ($5k/mo): 1M. Upgrade at <a href="https://developer.twitter.com/en/portal/products" target="_blank" rel="noopener noreferrer" style={S.link}>developer.x.com ↗</a>.</>}
          />
        </tbody>
      </table>
    </div>
  );
}

function CapRow({ platform, cost, action }: { platform: string; cost: string; action: React.ReactNode }) {
  return (
    <tr>
      <td style={S.tdName}>{platform}</td>
      <td style={S.tdValue}>{cost}</td>
      <td style={S.tdHelp}>{action}</td>
    </tr>
  );
}

function Row({ name, value, help, mono }: { name: string; value: string; help: string; mono?: boolean }) {
  return (
    <tr>
      <td style={S.tdName}>{name}</td>
      <td style={{ ...S.tdValue, ...(mono ? { fontFamily: 'var(--tk-font-mono)' } : {}) }}>{value}</td>
      <td style={S.tdHelp}>{help}</td>
    </tr>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10 },
  heading: { fontSize: 'var(--tk-fs-md)', fontWeight: 800, margin: 0 },
  subhead: { fontSize: 'var(--tk-fs-sm)', fontWeight: 800, margin: '12px 0 4px 0', textTransform: 'uppercase', letterSpacing: '0.04em' },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)', margin: 0 },
  table: { borderCollapse: 'collapse', width: '100%' },
  tdName: { padding: '8px 10px', fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-sm)', borderBottom: '1px solid var(--tk-border-soft)', whiteSpace: 'nowrap' },
  tdValue: { padding: '8px 10px', fontWeight: 700, borderBottom: '1px solid var(--tk-border-soft)' },
  tdHelp: { padding: '8px 10px', color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)', borderBottom: '1px solid var(--tk-border-soft)' },
  link: { color: 'var(--tk-accent)', textDecoration: 'underline' },
};
