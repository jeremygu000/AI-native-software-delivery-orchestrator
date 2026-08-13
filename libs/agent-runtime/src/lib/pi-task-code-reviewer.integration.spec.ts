import { createAgentSession, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { createReadOnlyPiTools } from './pi-gateway.js';
import { createIsolatedPlanningResourceLoader } from './pi-planning-agent.js';

describe('PiTaskCodeReviewer real SDK integration', () => {
  it('registers only the three advisory read-only tools through the real Pi SDK', async () => {
    const toolNames = ['forge_read', 'forge_list', 'forge_find'];
    const resourceLoader = await createIsolatedPlanningResourceLoader();
    const { session } = await createAgentSession({
      cwd: '/workspace',
      noTools: 'builtin',
      tools: [...toolNames],
      customTools: createReadOnlyPiTools(async () => ({ content: 'ok' })),
      resourceLoader,
      sessionManager: SessionManager.inMemory('/workspace'),
      settingsManager: SettingsManager.inMemory()
    });

    try {
      session.setActiveToolsByName(toolNames);
      expect(session.state.tools.map((tool) => tool.name)).toEqual(toolNames);
      expect(session.state.tools.map((tool) => tool.name)).not.toContain('bash');
      expect(session.state.tools.map((tool) => tool.name)).not.toContain('forge_edit');
      expect(session.state.tools.map((tool) => tool.name)).not.toContain('forge_write');
      expect(session.state.tools.map((tool) => tool.name)).not.toContain('forge_command');
    } finally {
      session.dispose();
    }
  });
});
