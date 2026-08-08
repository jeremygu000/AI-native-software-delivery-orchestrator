#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command()
  .name('forge')
  .description('Repository-aware multi-agent coding orchestrator')
  .version('0.0.1');

program
  .command('analyze')
  .description('Analyze a repository project and symbol graph')
  .argument('[repository]', 'repository to analyze', process.cwd())
  .action((repository: string) => {
    program.error(`Repository analysis is not available yet for ${repository}.`);
  });

program
  .command('plan')
  .description('Validate a task specification and build an execution plan')
  .argument('<specification>', 'path to a YAML task specification')
  .action((specification: string) => {
    program.error(`Planning is not available yet for ${specification}.`);
  });

await program.parseAsync();
