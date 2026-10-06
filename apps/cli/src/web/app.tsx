import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { TaskState } from '@ai-native-software-delivery-orchestrator/domain';
import {
  runViewSchema,
  planListingSchema,
  type RunView,
  type TaskView
} from '../run-view-schema.js';
import { RunEdgeKind, RunStateSource, ObservationState } from '../run-view-schema.js';
import { CompletionStage } from '../completion-values.js';
import {
  taskPositions,
  taskTone,
  taskSymbol,
  taskDetailsText,
  runMetadataText,
  TaskFilter
} from '../presentation.js';

const colors: Record<string, string> = {
  [TaskState.COMPLETED]: '#19b88a',
  [TaskState.FAILED]: '#ef7079',
  [TaskState.CANCELLED]: '#b5a1cc',
  [TaskState.RUNNING]: '#559dff',
  [TaskState.VERIFYING]: '#eab65c',
  [TaskState.INTEGRATING]: '#9b86ff'
};

export function App() {
  const [plans, setPlans] = useState<{ id: string; approved: boolean; runId?: string }[]>([]);
  const [id, setId] = useState(new URLSearchParams(location.search).get('plan') ?? '');
  const [view, setView] = useState<RunView>();
  const [taskId, setTaskId] = useState<string>();
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(true);
  const [refreshVersion, setRefresh] = useState(0);
  const [filter, setFilter] = useState<string>(TaskFilter.All);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string>();
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      try {
        const listing = await fetch('/api/plans', { signal: controller.signal, cache: 'no-store' });
        if (!listing.ok) {
          throw new Error('Listing failed');
        }
        const entries = planListingSchema.parse(await listing.json());
        if (!active) {
          return;
        }
        setPlans(entries);
        if (id) {
          const result = await fetch(`/api/plans/${encodeURIComponent(id)}`, {
            signal: controller.signal,
            cache: 'no-store'
          });
          if (!result.ok) {
            throw new Error('Plan unavailable');
          }
          const next = runViewSchema.parse(await result.json());
          if (next.planId !== id) {
            throw new Error('Plan identity mismatch');
          }
          if (active) {
            setView(next);
            setError('');
            setUpdatedAt(new Date().toLocaleTimeString());
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
    const timer = auto ? setInterval(() => void refresh(), 1000) : undefined;
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [id, auto, refreshVersion]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)
      ) {
        return;
      }
      if (event.key === '?' || event.key === 'F1') {
        event.preventDefault();
        setHelp((value) => !value);
      }
      if (event.key === 'Escape') {
        setHelp(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const selected = view?.tasks.find((task) => task.id === taskId);
  const positions = view ? taskPositions(view) : new Map();
  const visibleTasks =
    view?.tasks.filter((task) => filter === TaskFilter.All || task.id === filter) ?? [];
  const visibleIds = new Set(visibleTasks.map((task) => task.id));
  const nodes: Node[] = visibleTasks.map((task) => ({
    id: task.id,
    position: positions.get(task.id) ?? { x: 0, y: 0 },
    data: {
      label: (
        <div className={`task-node ${taskTone(task.state)}`}>
          <span className="state">
            {taskSymbol(task.state)} {task.state}
          </span>
          <strong>{task.title}</strong>
          <small>{task.id}</small>
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
  }));
  const edges: Edge[] =
    view?.edges
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
      .map((edge) => ({
        ...edge,
        label: edge.label,
        animated: false,
        type: 'smoothstep',
        deletable: false,
        style: {
          stroke: edge.kind === RunEdgeKind.Conflict ? '#ef7079' : '#779ccc',
          strokeDasharray: edge.kind === RunEdgeKind.Conflict ? '5 4' : undefined
        }
      })) ?? [];
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">FORGE / LOCAL CODING</span>
          <h1>Plans & runs</h1>
          <p>Follow the tasks. Inspect the recorded facts.</p>
        </div>
        <span className="readonly">READ ONLY</span>
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
              setFilter(TaskFilter.All);
              setUpdatedAt(undefined);
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
        <button onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
        <label>
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => setAuto(event.target.checked)}
          />{' '}
          Auto · 1s
        </label>
        <label>
          Task{' '}
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value={TaskFilter.All}>All tasks</option>
            {view?.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title} · {task.state}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setHelp((value) => !value)}>Help · ? / F1</button>
        <span className="refresh-time">
          {updatedAt ? `Observed ${updatedAt}` : 'No facts loaded'}
        </span>
      </nav>
      {help && (
        <section className="help" aria-label="Inspector help">
          <h2>Read-only navigation</h2>
          <p>
            Choose a plan, filter task nodes, pan or zoom the graph, and select a task in the graph
            or task list. Use Refresh or auto-refresh to reread local facts. ? / F1 toggles help;
            Escape closes it.
          </p>
          <p>
            Planning, explicit approval and execution are available only in the CLI/TUI. Displayed
            task-event state, recorded run row and final repository checks are distinct
            observations. Missing evidence is not success.
          </p>
          <button onClick={() => setHelp(false)}>Close help</button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {view ? (
        <>
          <section className="summary">
            <span className="eyebrow">PLAN / RUN OBSERVATIONS</span>
            <strong>{view.state}</strong>
            <span>
              Status based on:{' '}
              {view.stateSource === RunStateSource.TaskEvents
                ? 'recorded task events'
                : view.stateSource === RunStateSource.RunRecord
                  ? 'recorded run status'
                  : 'saved plan'}{' '}
              · separately recorded run status: {view.recordedRunState ?? 'not recorded'}
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
            {view.finalRepository && (
              <p>
                Final repository checks: {view.finalRepository.status} · clean:{' '}
                {String(view.finalRepository.clean)} · HEAD {view.finalRepository.head}
                {view.finalRepository.detail ? ` · ${view.finalRepository.detail}` : ''}
              </p>
            )}
          </section>
          <div className="content">
            <section className="graph">
              <div className="legend">
                {[
                  TaskState.COMPLETED,
                  TaskState.RUNNING,
                  TaskState.PENDING,
                  TaskState.FAILED,
                  ObservationState.NotRecorded
                ].map((state) => (
                  <span key={state} className={taskTone(state)}>
                    {taskSymbol(state)} {state}
                  </span>
                ))}
                <span>Solid: dependency · dashed: conflict</span>
              </div>
              <ReactFlow
                key={`${id}:${filter}`}
                nodes={nodes}
                edges={edges}
                fitView
                nodesDraggable={false}
                nodesConnectable={false}
                deleteKeyCode={null}
                colorMode="dark"
                minZoom={0.2}
                maxZoom={1.5}
                elementsSelectable
                onNodeClick={(_event, node) => setTaskId(node.id)}
              >
                <Background />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) =>
                    colors[view.tasks.find((task) => task.id === node.id)?.state ?? ''] ?? '#62748c'
                  }
                />
              </ReactFlow>
            </section>
            <aside aria-label="Task evidence inspector">
              <span className="eyebrow">TASK INSPECTOR</span>
              <div className="task-list">
                {view.tasks.map((task) => (
                  <button
                    key={task.id}
                    className={task.id === taskId ? 'selected' : ''}
                    onClick={() => {
                      setTaskId(task.id);
                      setCopied('');
                    }}
                  >
                    {taskSymbol(task.state)} {task.title}
                  </button>
                ))}
              </div>
              <button
                onClick={() => {
                  const text = `${runMetadataText(view)}${selected ? `\n\n${taskDetailsText(selected)}` : ''}`;
                  void navigator.clipboard
                    .writeText(text)
                    .then(() => setCopied('Copied complete details'))
                    .catch(() =>
                      setCopied('Clipboard unavailable; select and copy the text below.')
                    );
                }}
              >
                Copy {selected ? 'task details / IDs' : 'run metadata'}
              </button>
              <p role="status">{copied}</p>
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
      <footer>
        Local observation only · no browser approval or execution · missing evidence remains not
        recorded.
      </footer>
    </main>
  );
}
export function TaskDetails({ task }: { task: TaskView }) {
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
const root = typeof document === 'undefined' ? null : document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
