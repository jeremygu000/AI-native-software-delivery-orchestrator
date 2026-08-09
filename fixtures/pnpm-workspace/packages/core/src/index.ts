import { formatValue } from '../../utils/src/index.js';

export class CoreService {
  readonly label = 'core';

  run(value: string): string {
    return formatValue(`${this.label}:${value}`);
  }
}
