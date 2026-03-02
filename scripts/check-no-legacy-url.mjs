import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const patterns = [
  /\burl\.parse\s*\(/,
  /require\(\s*['\"]url['\"]\s*\)/,
  /from\s+['\"]url['\"]/
];

const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => !file.startsWith('.next/'));

const offenders = [];

for (const file of trackedFiles) {
  const source = readFileSync(file, 'utf8');
  if (patterns.some((pattern) => pattern.test(source))) {
    offenders.push(file);
  }
}

if (offenders.length > 0) {
  console.error('Legacy url.parse patterns detected in:');
  offenders.forEach((file) => console.error(` - ${file}`));
  process.exit(1);
}

console.log('No legacy url.parse usage found in tracked source files.');
