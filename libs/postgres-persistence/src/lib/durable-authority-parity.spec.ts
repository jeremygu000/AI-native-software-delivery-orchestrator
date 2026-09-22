import { describe, it } from 'vitest';

import { durableAuthorityContract } from '../../../persistence/src/lib/durable-authority.contract.test.js';

// A connection handle is not an OrchestrationPersistence adapter. Keep the
// exact same suite visibly pending until a PostgreSQL adapter can satisfy it.
describe.skip('PostgreSQL durable Forge authority — adapter not implemented', () => {
  durableAuthorityContract('PostgreSQL candidate', async () => {
    throw new Error('PostgreSQL OrchestrationPersistence adapter is not implemented');
  });
  it('requires schema/role isolation and a real PostgreSQL fixture');
});
