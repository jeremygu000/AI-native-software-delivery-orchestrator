const { proxyActivities } = require('@temporalio/workflow');
const { executeBuilder } = proxyActivities({
  startToCloseTimeout: '30 seconds',
  heartbeatTimeout: '3 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second', maximumInterval: '1 second' }
});
exports.abruptBuilderWorkflow = async (input) => {
  try {
    await executeBuilder(input);
    return { status: 'unexpected-completion' };
  } catch {
    return { status: 'quarantined' };
  }
};
