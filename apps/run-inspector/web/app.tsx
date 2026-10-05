import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, Controls, MiniMap, ReactFlow, type Node } from '@xyflow/react';
import type {
  ForgeRunInspection,
  InspectionEnvironment,
  InspectionNode,
  InspectionState
} from '@ai-native-software-delivery-orchestrator/run-inspection/inspection';
import {
  isInspectionEnvironment,
  isRunInspection
} from '@ai-native-software-delivery-orchestrator/run-inspection/response';
import '@xyflow/react/dist/style.css';
import './style.css';

const symbols: Record<InspectionState, string> = {
  complete: '✓',
  active: '◐',
  pending: '○',
  failed: '✗',
  unknown: '?'
};
async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : 'Inspection unavailable'
    );
  }
  return body;
}
function App() {
  const [environment, setEnvironment] = useState<InspectionEnvironment>();
  const [runId, setRunId] = useState(new URLSearchParams(location.search).get('runId') ?? '');
  const [inspection, setInspection] = useState<ForgeRunInspection>();
  const [selected, setSelected] = useState<string>();
  const [task, setTask] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [copied, setCopied] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const serial = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    void readJson('/api/environment', controller.signal)
      .then((value) => {
        if (!isInspectionEnvironment(value)) {
          throw new Error('Invalid inspector environment response');
        }
        setEnvironment(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(String(reason));
        }
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, []);
  const refresh = async () => {
    if (environment === undefined || runId.trim() === '') {
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++serial.current;
    setBusy(true);
    setError('');
    try {
      const result = await readJson(
        `/api/runs/${encodeURIComponent(runId.trim())}?environment=${encodeURIComponent(environment.id)}`,
        controller.signal
      );
      if (
        !isRunInspection(result) ||
        result.environment.id !== environment.id ||
        result.runId !== runId.trim()
      ) {
        throw new Error('Inspection identity mismatch. No alternate environment will be queried.');
      }
      if (current === serial.current) {
        setInspection(result);
        setSelected((previous) =>
          result.nodes.some((node) => node.id === previous) ? previous : 'metadata'
        );
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Inspection unavailable');
        setInspection(undefined);
      }
    } finally {
      if (current === serial.current) {
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (!auto) {
      return undefined;
    }
    const timer = setInterval(() => {
      if (!busy) {
        void refresh();
      }
    }, 5000);
    return () => clearInterval(timer);
  });
  const visible =
    inspection?.nodes.filter(
      (node) => task === 'all' || node.taskId === undefined || node.taskId === task
    ) ?? [];
  const taskIds = [
    ...new Set(visible.flatMap((node) => (node.taskId === undefined ? [] : [node.taskId])))
  ];
  const row = new Map<string, number>();
  const nodes: Node[] = visible.map((node) => {
    const lane = node.taskId ?? 'run';
    const position = row.get(lane) ?? 0;
    row.set(lane, position + 1);
    return {
      id: node.id,
      position: { x: lane === 'run' ? 0 : (taskIds.indexOf(lane) + 1) * 300, y: position * 100 },
      data: {
        label: (
          <>
            <span className={`state ${node.state}`}>
              {symbols[node.state]} {node.state.toUpperCase()}
            </span>
            <strong>{node.label}</strong>
            {node.taskId && <small>{node.taskId}</small>}
          </>
        )
      },
      className: `inspection-node ${node.state}`,
      selected: selected === node.id,
      style: { width: 258 },
      draggable: false,
      connectable: false,
      deletable: false
    };
  });
  for (const id of taskIds) {
    const entry = inspection?.tasks.find((item) => item.id === id);
    nodes.push({
      id: `task-label:${id}`,
      position: { x: (taskIds.indexOf(id) + 1) * 300, y: -110 },
      data: {
        label: (
          <>
            <strong>{entry?.title ?? id}</strong>
            <small>Recorded task state: {entry?.state}</small>
          </>
        )
      },
      type: 'input',
      className: 'inspection-node task-heading',
      style: { width: 258 },
      draggable: false,
      connectable: false,
      selectable: false,
      deletable: false
    });
  }
  const visibleIds = new Set(visible.map((node) => node.id));
  const edges =
    inspection?.edges
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
      .map((edge) => ({
        ...edge,
        type: 'smoothstep',
        style: { stroke: '#3d5365' },
        selectable: false,
        deletable: false
      })) ?? [];
  const detail: InspectionNode | undefined = inspection?.nodes.find((node) => node.id === selected);
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">FORGE / OPERATOR TOOLING</span>
          <h1>Run Inspector</h1>
          <p>Trace the evidence. Locate the boundary.</p>
        </div>
        <span className="readonly">READ ONLY</span>
      </header>
      {environment && (
        <section className="environment" aria-label="Selected environment">
          <div>
            <span className="eyebrow">SELECTED ENVIRONMENT</span>
            <strong>{environment.label}</strong>
          </div>
          <dl>
            {Object.entries({
              Authority: environment.authorityMode,
              Database: `${environment.host} / ${environment.database}`,
              Schema: environment.schema,
              Role: environment.role,
              Queue: environment.taskQueue,
              Namespace: environment.namespace,
              Repository: environment.repository
            }).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void refresh();
        }}
      >
        <label>
          Run ID
          <input
            aria-label="Run ID"
            value={runId}
            placeholder="Enter a run ID in this environment"
            onChange={(event) => {
              request.current?.abort();
              serial.current += 1;
              setBusy(false);
              setRunId(event.target.value);
              setInspection(undefined);
              setTask('all');
            }}
          />
        </label>
        <button disabled={environment === undefined || busy || runId.trim() === ''}>
          {busy ? 'Inspecting…' : inspection ? 'Refresh' : 'Inspect run'}
        </button>
        <label className="auto">
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => setAuto(event.target.checked)}
          />
          Auto-refresh · 5s
        </label>
        <label>
          Task
          <select value={task} onChange={(event) => setTask(event.target.value)}>
            <option value="all">All task lanes</option>
            {inspection?.tasks.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.state}
              </option>
            ))}
          </select>
        </label>
        <span className="refresh-time">
          {inspection
            ? `Last refresh ${new Date(inspection.refreshedAt).toLocaleTimeString()}`
            : 'No run loaded'}
        </span>
      </form>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <section className="workspace">
        <div className="graph">
          <div className="legend">
            {Object.entries(symbols).map(([state, symbol]) => (
              <span key={state} className={`state ${state}`}>
                {symbol} {state}
              </span>
            ))}
            <span>Edges describe lifecycle order, not proof.</span>
          </div>
          {inspection ? (
            <ReactFlow
              key={`${inspection.runId}:${task}`}
              nodes={nodes}
              edges={edges}
              onNodeClick={(_event, node) => {
                setSelected(node.id);
                setCopied(false);
              }}
              nodesDraggable={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              fitView
              fitViewOptions={{
                nodes: nodes.filter((node) => node.position.y <= 400),
                minZoom: 0.5,
                maxZoom: 0.8,
                padding: 0.2
              }}
              minZoom={0.15}
              maxZoom={1.6}
              colorMode="dark"
            >
              <Background color="#233848" gap={24} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) =>
                  ({
                    complete: '#54d6ae',
                    active: '#71adff',
                    failed: '#f68d9b',
                    pending: '#adbac8',
                    unknown: '#e7bd73'
                  })[visible.find((item) => item.id === node.id)?.state ?? 'unknown']
                }
              />
            </ReactFlow>
          ) : (
            <div className="empty">
              <span className="empty-mark">⌁</span>
              <h2>Inspect one exact run</h2>
              <p>
                Select a run ID to compose durable authority,
                <br />
                Temporal, worktree and local evidence.
              </p>
              <p>Missing evidence remains unknown.</p>
            </div>
          )}
        </div>
        <aside aria-label="Evidence inspector">
          <span className="eyebrow">EVIDENCE INSPECTOR</span>
          <h2>{detail?.label ?? 'Select a node'}</h2>
          {detail && (
            <>
              <dl className="context">
                <div>
                  <dt>Run ID</dt>
                  <dd>{inspection?.runId}</dd>
                </div>
                {detail.taskId && (
                  <div>
                    <dt>Task ID</dt>
                    <dd>{detail.taskId}</dd>
                  </div>
                )}
              </dl>
              <span className={`state ${detail.state}`}>
                {symbols[detail.state]} {detail.state.toUpperCase()}
              </span>
              <p>{detail.explanation}</p>
              <button
                className="copy"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(
                      JSON.stringify(
                        {
                          runId: inspection?.runId,
                          nodeId: detail.id,
                          taskId: detail.taskId,
                          evidence: detail.evidence
                        },
                        null,
                        2
                      )
                    )
                    .then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy evidence / IDs'}
              </button>
              {detail.evidence.length === 0 && (
                <p className="missing">No relevant evidence observed.</p>
              )}
              {detail.evidence.map((entry, index) => (
                <section className="evidence" key={index}>
                  <h3>{entry.source}</h3>
                  <time>{entry.observedAt}</time>
                  <dl>
                    {Object.entries(entry.fields).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{value === null ? 'not observed' : String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </>
          )}
          {inspection && (
            <section className="sources">
              <h3>Source availability</h3>
              {inspection.sources.map((source) => (
                <div key={source.source}>
                  <strong>{source.source}</strong>
                  <span className={source.status === 'unavailable' ? 'unknown' : 'complete'}>
                    {source.status}
                  </span>
                  <p>{source.message}</p>
                </div>
              ))}
            </section>
          )}
        </aside>
      </section>
      <footer>
        No retry, recovery, cancellation or mutation actions. Separate sources are not an atomic
        authority snapshot.
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
