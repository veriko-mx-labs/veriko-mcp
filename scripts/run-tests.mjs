import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function findTests(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTests(path));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

const tests = findTests('test').sort();
if (tests.length === 0) {
  process.stderr.write('No se encontraron pruebas.\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--import', 'tsx', ...tests], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
