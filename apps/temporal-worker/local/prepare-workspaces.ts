import { prepareApprovedWorkspaces } from '../src/operator-workspaces.js';

const [runId, artifactId, approvalId, operation] = process.argv.slice(2);
if (!runId || !artifactId || !approvalId) {
  throw new Error('Usage: prepare-workspaces run-id artifact-id approval-id');
}
await prepareApprovedWorkspaces({
  root: process.cwd(),
  runId,
  artifactId,
  approvalId,
  authorizeWorkspaceCreation: true,
  ...(operation === undefined ? {} : { operation }),
  writeOutput: console.log
});
