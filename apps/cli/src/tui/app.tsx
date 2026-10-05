import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TextareaRenderable, ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { codingLayout } from './layout.js';
import {
  renderPlanDetails,
  renderRunProgress,
  renderRunCompletion,
  integrationTaskIds
} from '../interactive-render.js';
import { CodingTuiController, stageLabels, type TuiRequest } from './controller.js';

const accent = '#7aa2f7';
const muted = '#9aa5b8';
function Entry({
  request,
  controller,
  layout,
  suspended
}: {
  request: TuiRequest;
  controller: CodingTuiController;
  layout: ReturnType<typeof codingLayout>;
  suspended: boolean;
}) {
  const textarea = useRef<TextareaRenderable | null>(null);
  const [inputValue, setInputValue] = useState(request.initial);
  const [selected, setSelected] = useState(0);
  useKeyboard((key) => {
    if (suspended || key.defaultPrevented) {
      return;
    }
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
  const firstOption = Math.max(
    0,
    Math.min(selected - layout.optionRows + 1, request.options.length - layout.optionRows)
  );
  return (
    <box
      visible={!suspended}
      height={layout.menu}
      flexShrink={0}
      border
      borderColor={accent}
      title="Menu"
      paddingX={1}
      flexDirection="column"
    >
      {layout.titleLines.map((line, index) => (
        <text key={index} height={1} flexShrink={0} wrapMode="none">
          {line}
        </text>
      ))}
      {request.kind === 'choice' ? (
        request.options
          .slice(firstOption, firstOption + layout.optionRows)
          .map((option, offset) => (
            <text
              key={option}
              height={1}
              flexShrink={0}
              wrapMode="none"
              truncate
              fg={firstOption + offset === selected ? accent : muted}
            >
              {firstOption + offset === selected ? '❯ ' : '  '}
              {option}
            </text>
          ))
      ) : request.kind === 'task' ? (
        <textarea
          ref={textarea}
          focused={!suspended}
          height={layout.editorRows}
          flexShrink={0}
          wrapMode="word"
          initialValue={request.initial}
          placeholder="Describe the coding task…"
        />
      ) : (
        <input
          focused={!suspended}
          flexShrink={0}
          value={inputValue}
          onInput={setInputValue}
          onSubmit={() => controller.submit(inputValue || request.initial)}
        />
      )}
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
  const [help, setHelp] = useState(false);
  const { width, height } = useTerminalDimensions();
  const layout = codingLayout(width, height, state.request);
  const editing = state.request?.kind === 'input' || state.request?.kind === 'task';
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
  useEffect(() => {
    content.current?.scrollTo(0);
  }, [help]);
  useKeyboard((key) => {
    if (key.name === 'f1' || (!editing && (key.name === '?' || key.sequence === '?'))) {
      key.preventDefault();
      setHelp((value) => !value);
      return;
    }
    if (help && (key.name === 'escape' || key.name === 'return')) {
      key.preventDefault();
      setHelp(false);
      return;
    }
    if (layout.tooSmall && !['escape', 'c'].includes(key.name)) {
      key.preventDefault();
      return;
    }
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
  const metadata = [
    ['Provider', model?.provider ?? environment.FORGE_WORKER_REVIEW_PROVIDER ?? 'Select model'],
    ['Model', model?.model ?? environment.FORGE_WORKER_REVIEW_MODEL ?? '—'],
    ['Reasoning', model?.reasoning ?? environment.FORGE_MODEL_REASONING_EFFORT ?? '—'],
    ['Authority', environment.FORGE_WORKER_AUTHORITY_MODE ?? 'legacy'],
    ['Queue', environment.TEMPORAL_TASK_QUEUE ?? 'deployment default']
  ] as const;
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      padding={layout.padding}
      gap={1}
      backgroundColor="#10141c"
    >
      {layout.tooSmall && (
        <text wrapMode="word">
          Forge needs at least 40 columns and 24 rows. Enlarge the terminal to continue. Esc
          cancels.
        </text>
      )}
      <box
        visible={!layout.tooSmall}
        height={layout.header}
        flexShrink={0}
        border
        borderColor={accent}
        title="FORGE · Execution"
        paddingX={1}
        flexDirection="column"
      >
        {layout.banner && (
          <box height={6} flexShrink={0} alignItems="center">
            <ascii-font text="FORGE" font="block" color={accent} flexShrink={0} />
          </box>
        )}
        {metadata.map(([label, value]) => (
          <text key={label} height={1} flexShrink={0} wrapMode="none" truncate fg={muted}>
            {label.padEnd(10)}
            {value}
          </text>
        ))}
      </box>
      <scrollbox
        ref={content}
        visible={!layout.tooSmall}
        height={help ? layout.body + layout.menu + (state.request ? 1 : 0) : layout.body}
        flexShrink={0}
        focused={help || state.request === undefined}
        border
        borderColor="#38465e"
        title={
          help
            ? 'Help · full execution details'
            : run
              ? 'Durable run status'
              : artifact
                ? 'Immutable plan review'
                : 'Execution'
        }
        paddingX={1}
        contentOptions={{ flexDirection: 'column', flexShrink: 0 }}
      >
        {help ? (
          <text flexShrink={0} wrapMode="word">
            {metadata.map(([label, value]) => `${label}: ${value}`).join('\n')}
            {repository?.type === 'repository' && `\nRepository: ${repository.path}`}
            {
              '\n\n↑/↓ Select · Enter Confirm\nCtrl+Enter Submit multiline task\nEsc Cancel current flow / request run cancellation\nCtrl+C Request cancellation and exit\nPgUp/PgDn Scroll evidence\n? / F1 Help · Esc / Enter Close help\n\nDurable state is authoritative. Predicted writes are not an observed diff.'
            }
          </text>
        ) : (
          <>
            {repository?.type === 'repository' && (
              <text height={1} flexShrink={0} truncate wrapMode="none" fg={muted}>
                Repository: {repository.path}
              </text>
            )}
            {artifact?.type === 'plan' && run === undefined && (
              <text flexShrink={0}>
                {renderPlanDetails(artifact.artifact)}
                {'\n'}Execution profile: {artifact.artifact.authority.codeReviewPolicyFingerprint}
                {'\n'}Repository identity: {artifact.artifact.repository.repositoryId}
                {'\n'}Approved base: {artifact.artifact.repository.baseCommit}
                {'\n'}Integration task IDs:{' '}
                {integrationTaskIds(artifact.artifact).join(', ') || 'none'}
                {'\n'}Verification policy:{' '}
                {artifact.artifact.authority.verificationPolicyFingerprint}
              </text>
            )}
            {stages.map((event) => (
              <text
                flexShrink={0}
                key={event.stage}
                fg={
                  event.state === 'complete'
                    ? '#9ece6a'
                    : event.state === 'failed'
                      ? '#f7768e'
                      : accent
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
                flexShrink={0}
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
              <text flexShrink={0} fg={muted}>
                Latest durable events{'\n'}
                {run.status.timeline
                  .slice(-8)
                  .map(
                    (event) => `${event.sequence}. ${event.type} ${event.correlation.taskId ?? ''}`
                  )
                  .join('\n') || 'No event recorded yet'}
                {'\n'}Latest review summaries{'\n'}
                {run.status.tasks
                  .map(
                    (task) =>
                      `${task.title}: ${task.reviews.at(-1)?.summary ?? 'No review recorded'}`
                  )
                  .join('\n')}
                {artifact?.type === 'plan' &&
                  `\nApproved predicted writes (not an observed diff):\n${artifact.artifact.decision.specification.tasks.flatMap((task) => task.expectedWrites.map((write) => `${write.type}:${write.value}`)).join('\n') || 'none'}`}
              </text>
            )}
            {identity?.type === 'identity' && (
              <text flexShrink={0} fg={muted}>
                Run {identity.runId}
                {'\n'}Approval {identity.approvalId}
                {'\n'}Artifact {identity.artifactId}
              </text>
            )}
            {state.notices.slice(-3).map((notice, index) => (
              <text key={`${index}:${notice}`} flexShrink={0} fg={muted}>
                {notice}
              </text>
            ))}
            {state.error && (
              <text flexShrink={0} fg="#f7768e">
                {state.error}
              </text>
            )}
          </>
        )}
      </scrollbox>
      {state.request && (
        <Entry
          key={state.request.id}
          request={state.request}
          controller={controller}
          layout={layout}
          suspended={help || layout.tooSmall}
        />
      )}
      <box visible={!layout.tooSmall} height={layout.footer} flexShrink={0} flexDirection="column">
        <text height={1} flexShrink={0} wrapMode="none" truncate fg={muted}>
          {help
            ? 'Esc / Enter Close help'
            : state.finished
              ? 'Enter Close'
              : state.request?.kind === 'task'
                ? 'Ctrl+Enter Submit · Enter Newline'
                : state.request?.kind === 'input'
                  ? 'Enter Continue'
                  : '↑/↓ Select · Enter Confirm'}
        </text>
        <text height={1} flexShrink={0} wrapMode="none" truncate fg={muted}>
          Esc Cancel · Ctrl+C Exit · {editing ? 'F1' : '?'} Help
        </text>
      </box>
    </box>
  );
}
