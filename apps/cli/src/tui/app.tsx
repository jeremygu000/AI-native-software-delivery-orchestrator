import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TextareaRenderable, ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import {
  renderPlanDetails,
  renderRunProgress,
  renderRunCompletion,
  integrationTaskIds
} from '../interactive-render.js';
import { CodingTuiController, stageLabels, type TuiRequest } from './controller.js';

const accent = '#7aa2f7';
const muted = '#9aa5b8';
function Entry({ request, controller }: { request: TuiRequest; controller: CodingTuiController }) {
  const textarea = useRef<TextareaRenderable | null>(null);
  const [inputValue, setInputValue] = useState(request.initial);
  const [selected, setSelected] = useState(0);
  useKeyboard((key) => {
    if (request.kind === 'choice') {
      if (key.name === 'up' || key.name === 'down') {
        setSelected(
          (value) =>
            (value + (key.name === 'up' ? -1 : 1) + request.options.length) % request.options.length
        );
      }
      if (key.name === 'return') {
        controller.submit(selected);
      }
    } else if (request.kind === 'task' && key.name === 'return' && key.ctrl) {
      key.preventDefault();
      controller.submit(textarea.current?.plainText ?? '');
    }
  });
  return (
    <box border borderColor={accent} title={request.title} padding={1} flexDirection="column">
      {request.kind === 'choice' ? (
        request.options.map((option, index) => (
          <text key={option} fg={index === selected ? accent : muted}>
            {index === selected ? '❯ ' : '  '}
            {option}
          </text>
        ))
      ) : request.kind === 'task' ? (
        <textarea
          ref={textarea}
          focused
          height={7}
          wrapMode="word"
          initialValue={request.initial}
          placeholder="Describe the coding task naturally across multiple lines…"
        />
      ) : (
        <input
          focused
          value={inputValue}
          onInput={setInputValue}
          onSubmit={() => controller.submit(inputValue || request.initial)}
        />
      )}
      <text fg={muted}>
        {request.kind === 'task'
          ? 'Ctrl+Enter Submit'
          : request.kind === 'choice'
            ? '↑/↓ Select · Enter Confirm'
            : 'Enter Continue'}{' '}
        · Esc Cancel
      </text>
    </box>
  );
}

export function ForgeTui({
  controller,
  environment,
  exit
}: {
  controller: CodingTuiController;
  environment: NodeJS.ProcessEnv;
  exit: () => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [tick, setTick] = useState(0);
  const content = useRef<ScrollBoxRenderable | null>(null);
  const [exitRequested, setExitRequested] = useState(false);
  useEffect(() => {
    if (exitRequested && state.finished) {
      exit();
    }
  }, [exitRequested, state.finished, exit]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 140);
    return () => clearInterval(timer);
  }, []);
  useKeyboard((key) => {
    if (key.name === 'pageup' || key.name === 'pagedown') {
      key.preventDefault();
      content.current?.scrollBy(key.name === 'pageup' ? -8 : 8);
    }
    if (key.name === 'escape') {
      if (state.finished) {
        exit();
      } else {
        controller.cancel();
      }
    }
    if (key.ctrl && key.name === 'c') {
      if (state.finished) {
        exit();
      } else {
        setExitRequested(true);
        controller.cancel();
      }
    }
    if (state.finished && key.name === 'return') {
      exit();
    }
  });
  const artifact = state.events.find((event) => event.type === 'plan');
  const run = state.events.find((event) => event.type === 'run');
  const repository = state.events.find((event) => event.type === 'repository');
  const identity = state.events.find((event) => event.type === 'identity');
  const model = state.events.find((event) => event.type === 'model');
  const stages = state.events.filter((event) => event.type === 'stage');
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      padding={1}
      gap={1}
      backgroundColor="#10141c"
    >
      <box border borderColor={accent} paddingX={1} flexDirection="column">
        <text fg={accent}>FORGE · Repository-aware multi-agent coding orchestrator</text>
        <text fg={muted}>
          {model?.provider ?? environment.FORGE_WORKER_REVIEW_PROVIDER ?? 'Select model'} /{' '}
          {model?.model ?? environment.FORGE_WORKER_REVIEW_MODEL ?? '—'} {model?.reasoning ?? ''} ·
          Authority {environment.FORGE_WORKER_AUTHORITY_MODE ?? 'legacy'} · Queue{' '}
          {environment.TEMPORAL_TASK_QUEUE ?? 'deployment default'}
        </text>
      </box>
      {repository?.type === 'repository' && (
        <box border borderColor="#38465e" title="Repository" paddingX={1}>
          <text>{repository.path}</text>
        </box>
      )}
      <scrollbox
        ref={content}
        flexGrow={1}
        focused={state.request === undefined}
        border
        borderColor="#38465e"
        title={run ? 'Durable run status' : artifact ? 'Immutable plan review' : 'Execution'}
        padding={1}
      >
        {artifact?.type === 'plan' && run === undefined && (
          <text>
            {renderPlanDetails(artifact.artifact)}
            {'\n'}Execution profile: {artifact.artifact.authority.codeReviewPolicyFingerprint}
            {'\n'}Repository identity: {artifact.artifact.repository.repositoryId}
            {'\n'}Approved base: {artifact.artifact.repository.baseCommit}
            {'\n'}Integration task IDs: {integrationTaskIds(artifact.artifact).join(', ') || 'none'}
            {'\n'}Verification policy: {artifact.artifact.authority.verificationPolicyFingerprint}
          </text>
        )}
        {stages.map((event) => (
          <text
            key={event.stage}
            fg={
              event.state === 'complete' ? '#9ece6a' : event.state === 'failed' ? '#f7768e' : accent
            }
          >
            {event.state === 'complete'
              ? '✓'
              : event.state === 'failed'
                ? '✗'
                : ['◐', '◓', '◑', '◒'][tick % 4]}{' '}
            {stageLabels[event.stage]}
          </text>
        ))}
        {run?.type === 'run' && (
          <text
            fg={
              run.status.state === 'COMPLETED'
                ? '#9ece6a'
                : ['FAILED', 'CANCELLED'].includes(run.status.state)
                  ? '#f7768e'
                  : accent
            }
          >
            {state.finished ? renderRunCompletion(run.status) : renderRunProgress(run.status)}
          </text>
        )}
        {run?.type === 'run' && (
          <text fg={muted}>
            Latest durable events{'\n'}
            {run.status.timeline
              .slice(-8)
              .map((event) => `${event.sequence}. ${event.type} ${event.correlation.taskId ?? ''}`)
              .join('\n') || 'No event recorded yet'}
            {'\n'}Latest review summaries{'\n'}
            {run.status.tasks
              .map(
                (task) => `${task.title}: ${task.reviews.at(-1)?.summary ?? 'No review recorded'}`
              )
              .join('\n')}
            {artifact?.type === 'plan' &&
              `\nApproved predicted writes (not an observed diff):\n${artifact.artifact.decision.specification.tasks.flatMap((task) => task.expectedWrites.map((write) => `${write.type}:${write.value}`)).join('\n') || 'none'}`}
          </text>
        )}
        {identity?.type === 'identity' && (
          <text fg={muted}>
            Run {identity.runId}
            {'\n'}Approval {identity.approvalId}
            {'\n'}Artifact {identity.artifactId}
          </text>
        )}
        {state.notices.slice(-3).map((notice, index) => (
          <text key={`${index}:${notice}`} fg={muted}>
            {notice}
          </text>
        ))}
        {state.error && <text fg="#f7768e">{state.error}</text>}
      </scrollbox>
      {state.request && (
        <Entry key={state.request.id} request={state.request} controller={controller} />
      )}
      <text fg={muted}>
        {state.finished
          ? 'Enter Close · Ctrl+C Exit'
          : 'Esc Cancel current flow / request run cancellation · Ctrl+C Exit'}{' '}
        · PgUp/PgDn Scroll · Durable state is authoritative
      </text>
    </box>
  );
}
