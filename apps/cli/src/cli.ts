/** The npm bundle's entry: assets sit beside it in dist/. The build adds the shebang. */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run.js';

run(dirname(fileURLToPath(import.meta.url)));
