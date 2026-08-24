// Fixture: only node builtins, which never touch the registry.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const readSelf = (dir: string): string => readFileSync(join(dir, 'package.json'), 'utf8');
