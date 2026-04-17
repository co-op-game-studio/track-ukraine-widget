/**
 * RepDetail — the full-width detail panel shown beneath the chip grid when a
 * member is selected. Always visible when rendered; collapse/expand is owned
 * by ResultsPanel.
 *
 * Traces to: US-2, US-3, US-4, US-5, US-7, US-8 (v2.2.0), US-9 (design).
 */
import { useEffect, useState } from 'react';
import type { Representative } from '../types/domain';
import { stateCodeToName } from '../utils/fipsMap';
import { useVotingRecord } from '../hooks/useVotingRecord';
import { useSponsoredBills } from '../hooks/useSponsoredBills';
import { useUkraineScore } from '../hooks/useUkraineScore';
import { VoteList } from './VoteList';
import { BillList } from './BillList';
import { UkraineScoreBadge } from './UkraineScoreBadge';

export interface RepDetailProps {
  representative: Representative;
  apiBase: string;
  onClose: () => void;
}

type Tab = 'votes' | 'bills';

function partyCssClass(abbr: string): string {
  if (abbr === 'D') return 'dem';
  if (abbr === 'R') return 'rep';
  return 'ind';
}

function chamberLabel(rep: Representative): string {
  if (rep.chamber === 'senate') return 'U.S. Senator';
  if (rep.isNonVoting) return 'U.S. Delegate (non-voting)';
  return `U.S. Representative · District ${rep.district}`;
}

export function RepDetail({ representative, apiBase, onClose }: RepDetailProps) {
  const [tab, setTab] = useState<Tab>('votes');
  const votingRecord = useVotingRecord(representative, apiBase);
  const bills = useSponsoredBills(representative.bioguideId, apiBase);
  const score = useUkraineScore(votingRecord.data, bills.data);

  useEffect(() => {
    // Auto-load on mount (or when member switches)
    if (!(representative.isNonVoting && representative.chamber === 'house') && votingRecord.status === 'idle') {
      votingRecord.load();
    }
    if (bills.status === 'idle') {
      bills.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [representative.bioguideId]);

  const stateName = stateCodeToName(representative.state) ?? representative.state;
  const partyClass = partyCssClass(representative.partyAbbreviation);

  const obstructionCount =
    (votingRecord.data?.obstructionCount ?? 0)
    + (bills.data?.sponsored.filter((b) => b.valence === 'sponsor-anti').length ?? 0)
    + (bills.data?.cosponsored.filter((b) => b.valence === 'sponsor-anti').length ?? 0);

  return (
    <section
      className={`viw-detail viw-detail-${partyClass}`}
      aria-labelledby={`viw-detail-name-${representative.bioguideId}`}
    >
      <header className="viw-detail-header">
        <div className="viw-detail-identity">
          {representative.photoUrl ? (
            <img src={representative.photoUrl} alt="" className="viw-detail-photo" loading="lazy" />
          ) : (
            <div className="viw-detail-photo viw-detail-photo-placeholder" aria-hidden />
          )}
          <div className="viw-detail-ident-text">
            <h3 id={`viw-detail-name-${representative.bioguideId}`} className="viw-detail-name">
              {representative.name}
            </h3>
            <div className="viw-detail-meta">
              <span className={`viw-detail-party viw-detail-party-${partyClass}`}>
                {representative.party.toUpperCase()}
              </span>
              <span className="viw-detail-state">{stateName}</span>
              <span className="viw-detail-chamber">{chamberLabel(representative)}</span>
            </div>
            {representative.officialWebsiteUrl && (
              <a
                href={representative.officialWebsiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="viw-detail-link"
              >
                Official website ↗
              </a>
            )}
          </div>
        </div>
        <button type="button" className="viw-detail-close" onClick={onClose} aria-label="Close detail panel">
          ✕
        </button>
      </header>

      {!representative.isNonVoting && (
        <UkraineScoreBadge
          score={score}
          obstructionCount={obstructionCount}
          primaryAbstentionCount={votingRecord.data?.primaryAbstentionCount ?? 0}
          loading={votingRecord.status === 'loading' || bills.status === 'loading'}
        />
      )}

      <nav className="viw-detail-tabs" role="tablist">
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'votes'}
          className={`viw-detail-tab ${tab === 'votes' ? 'active' : ''}`}
          onClick={() => setTab('votes')}
          disabled={representative.isNonVoting && representative.chamber === 'house'}
        >
          Ukraine Votes
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'bills'}
          className={`viw-detail-tab ${tab === 'bills' ? 'active' : ''}`}
          onClick={() => setTab('bills')}
        >
          Ukraine Legislation
        </button>
      </nav>

      <div className="viw-detail-body">
        {tab === 'votes' &&
          (representative.isNonVoting && representative.chamber === 'house' ? (
            <div className="viw-detail-nonvoting">Non-voting delegate — no floor vote record.</div>
          ) : (
            <VoteList
              clusters={votingRecord.data?.clusters ?? []}
              loading={votingRecord.status === 'loading'}
              error={votingRecord.error?.message ?? null}
            />
          ))}
        {tab === 'bills' && (
          <BillList
            sponsored={bills.data?.sponsored ?? []}
            cosponsored={bills.data?.cosponsored ?? []}
            loading={bills.status === 'loading'}
            error={bills.error?.message ?? null}
          />
        )}
      </div>
    </section>
  );
}
