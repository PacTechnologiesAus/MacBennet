import { useEffect, useState } from 'react';
import type { RunDto } from '@mac/protocol';
import { api } from '../api.js';
import { Alert } from '../components/ui.js';
import { RunTable } from './Dashboard.js';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Awaiting approval', value: 'ready_for_approval' },
  { label: 'Active', value: 'approved,queued,running,blocked,self_review,ready_for_human_review' },
  { label: 'Finished', value: 'completed,failed,cancelled,stopped_by_guardrail' },
];

export function Runs() {
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () =>
      api
        .listRuns(filter ? { status: filter } : {})
        .then((r) => setRuns(r.runs))
        .catch((err: Error) => setError(err.message));

    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [filter]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Runs</h1>
          <p>Every execution attempt, approved or not. Runs are never reopened — a retry is a new run.</p>
        </div>
        <div className="actions">
          {FILTERS.map((option) => (
            <button
              key={option.label}
              className={filter === option.value ? 'primary small' : 'small'}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      <div className="card">
        <RunTable runs={runs} emptyText="No runs match this filter." />
      </div>
    </>
  );
}
