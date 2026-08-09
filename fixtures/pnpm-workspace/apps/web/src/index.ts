import { CoreService } from '../../../packages/core/src/index.js';

export const execute = (value: string): string => new CoreService().run(value);
