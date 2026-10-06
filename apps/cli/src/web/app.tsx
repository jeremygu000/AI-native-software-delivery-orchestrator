import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import {
  runViewSchema,
  planListingSchema,
  type RunView,
  type TaskView
} from '../run-view-schema.js';
import { CompletionStage } from '../completion-values.js';

const colors: Record<string, string> = {
  COMPLETED: '#19b88a',
  FAILED: '#ef7079',
  CANCELLED: '#b5a1cc',
  RUNNING: '#559dff',
  VERIFYING: '#eab65c',
  INTEGRATING: '#9b86ff'
};

function App() {
  const [plans, setPlans] = useState<{ id: string; approved: boolean; runId?: string }[]>([]);
  const [id, setId] = useState(new URLSearchParams(location.search).get('plan') ?? '');
  const [view, setView] = useState<RunView>();
  const [taskId, setTaskId] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      try {
        const listing = await fetch('/api/plans');
        if (!listing.ok) {
          throw new Error('Listing failed');
        }
        const entries = planListingSchema.parse(await listing.json());
        if (!active) {
          return;
        }
        setPlans(entries);
        if (id) {
          const result = await fetch(`/api/plans/${encodeURIComponent(id)}`);
          if (!result.ok) {
            throw new Error('Plan unavailable');
          }
          const next = runViewSchema.parse(await result.json());
          if (active) {
            setView(next);
            setError('');
          }
        }
      } catch {
        if (active) {
          setError('Local evidence is unavailable. Last observed facts remain visible.');
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  const selected = view?.tasks.find((task) => task.id === taskId);
  const nodes: Node[] =
    view?.tasks.map((task, index) => ({
      id: task.id,
      position: { x: (index % 3) * 300, y: Math.floor(index / 3) * 160 },
      data: {
        label: (
          <div>
            <strong>{task.title}</strong>
            <div>
              {task.state}
              {task.state === CompletionStage.Verifying && task.stage === CompletionStage.Reviewing
                ? ` · ${CompletionStage.Reviewing}`
                : ''}
            </div>
          </div>
        )
      },
      style: {
        background: '#152239',
        color: '#edf3ff',
        border: `2px solid ${colors[task.state] ?? '#62748c'}`,
        width: 240
      }
    })) ?? [];
  const edges: Edge[] =
    view?.edges.map((edge) => ({
      ...edge,
      label: edge.label,
      animated: false,
      style: {
        stroke: edge.kind === 'conflict' ? '#ef7079' : '#779ccc',
        strokeDasharray: edge.kind === 'conflict' ? '5 4' : undefined
      }
    })) ?? [];
  return (
    <main>
      <header>
        <b>FORGE · Observable local run</b>
        <span>Read-only · refreshed every second</span>
      </header>
      <nav>
        <label>
          Plan{' '}
          <select
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              setTaskId(undefined);
              setView(undefined);
            }}
          >
            <option value="">Choose a saved plan</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.id} · {plan.runId ? 'run' : plan.approved ? 'approved' : 'planned'}
              </option>
            ))}
          </select>
        </label>
      </nav>
      {error && <p role="alert">{error}</p>}
      {view ? (
        <>
          <section className="summary">
            <strong>{view.state}</strong>
            <span>
              State source: {view.stateSource ?? 'not recorded'} · run row:{' '}
              {view.recordedRunState ?? 'not recorded'}
            </span>
            <span>{view.repository}</span>
            <code>
              plan {view.planId} · run {view.runId ?? 'not started'}
            </code>
            <span>
              Execution: {view.execution ?? 'not recorded'} · Verification:{' '}
              {view.verificationMode ?? 'not recorded'} · Review:{' '}
              {view.reviewMode ?? 'not recorded'}
            </span>
            {view.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </section>
          <div className="content">
            <section className="graph">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                fitView
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                onNodeClick={(_event, node) => setTaskId(node.id)}
              >
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            </section>
            <aside>
              {selected ? (
                <TaskDetails task={selected} />
              ) : (
                <p>Select a task to inspect its observed facts.</p>
              )}
            </aside>
          </div>
        </>
      ) : (
        <p className="empty">
          Choose a saved plan. Approve and run from the CLI or TUI; this page never changes a run.
        </p>
      )}
    </main>
  );
}
function TaskDetails({ task }: { task: TaskView }) {
  return (
    <>
      <h2>{task.title}</h2>
      <p>
        {task.state} {task.stage ? `(last completion observation: ${task.stage})` : ''}
      </p>
      <h3>Goal</h3>
      <p>{task.goal}</p>
      <p>{task.description}</p>
      <h3>Planned files (IDs)</h3>
      <pre>{task.plannedFiles.join('\n') || 'None recorded'}</pre>
      <h3>Actual changed files</h3>
      <pre>{task.actualFiles.join('\n') || 'Not recorded'}</pre>
      <h3>Verification</h3>
      <pre>{task.verification ? JSON.stringify(task.verification, null, 2) : 'Not recorded'}</pre>
      <h3>Independent output review</h3>
      <pre>{task.review ? JSON.stringify(task.review, null, 2) : 'Not recorded'}</pre>
      {task.failure && <p role="alert">{task.failure}</p>}
      <h3>Git / worktree</h3>
      <pre>
        {task.worktree ?? 'Not recorded'}
        {'\n'}
        {task.integratedCommit ?? 'No integrated commit recorded'}
      </pre>
      <details>
        <summary>Actual diff</summary>
        <pre>{task.diff ?? 'Not recorded'}</pre>
      </details>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
