import type { TuiRequest } from './controller.js';

// Prompt labels are application-owned English text. Values use native cell-aware truncation.
export function wrapPrompt(value: string, columns: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/u)) {
    if (line && line.length + word.length + 1 > columns) {
      lines.push(line);
      line = '';
    }
    let remaining = word;
    while (remaining.length > columns) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(remaining.slice(0, columns));
      remaining = remaining.slice(columns);
    }
    line = line ? `${line} ${remaining}` : remaining;
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

export function codingLayout(width: number, height: number, request?: TuiRequest) {
  const padding = width >= 80 && height >= 32 ? 1 : 0;
  const columns = Math.max(1, width - padding * 2 - 4);
  const banner =
    width >= 80 &&
    height >= 36 &&
    request?.kind === 'choice' &&
    request.title === 'What do you want to do?';
  const header = 7 + (banner ? 6 : 0);
  const footer = 2;
  const titleLines = request ? wrapPrompt(request.title, columns) : [];
  const available = height - padding * 2 - header - footer - (request ? 3 : 2);
  const editorRows =
    request?.kind === 'task' ? Math.min(7, Math.max(2, available - titleLines.length - 5)) : 1;
  const optionRows =
    request?.kind === 'choice'
      ? Math.min(request.options.length, Math.max(1, available - titleLines.length - 5))
      : editorRows;
  const menu = request ? 2 + titleLines.length + optionRows : 0;
  const body = available - menu;
  return {
    padding,
    columns,
    banner,
    header,
    footer,
    titleLines,
    editorRows,
    optionRows,
    menu,
    body: Math.max(3, body),
    tooSmall: width < 40 || height < 24 || body < 3
  };
}
