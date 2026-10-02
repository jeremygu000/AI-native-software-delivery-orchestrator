import type { PiToolCall } from './pi-gateway.js';

export const piSessionFrameLimit = 1_048_576;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const protocolObject = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) {
    throw new Error('Invalid isolated Pi protocol object');
  }
  return value;
};

export const protocolText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid isolated Pi protocol text');
  }
  return value;
};

export const parsePiToolCall = (value: unknown): PiToolCall => {
  const call = protocolObject(value);
  const name = protocolText(call.name);
  switch (name) {
    case 'forge_read':
      return { name, path: protocolText(call.path) };
    case 'forge_list':
      return { name, ...(call.path === undefined ? {} : { path: protocolText(call.path) }) };
    case 'forge_find':
      return { name, path: protocolText(call.path), text: protocolText(call.text) };
    case 'forge_write':
      if (typeof call.content !== 'string') {
        throw new Error('Invalid isolated Pi write content');
      }
      return { name, path: protocolText(call.path), content: call.content };
    case 'forge_edit':
      if (typeof call.replacement !== 'string') {
        throw new Error('Invalid isolated Pi edit replacement');
      }
      return {
        name,
        path: protocolText(call.path),
        expected: protocolText(call.expected),
        replacement: call.replacement
      };
    case 'forge_command':
      return { name, commandId: protocolText(call.commandId) };
    default:
      throw new Error('Isolated Pi requested an unknown tool');
  }
};
