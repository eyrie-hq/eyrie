/** The single-executable entry: a CommonJS snapshot, so no import.meta — assets sit beside the binary. */
import { dirname } from 'node:path';
import { run } from './run.js';

run(dirname(process.execPath));
