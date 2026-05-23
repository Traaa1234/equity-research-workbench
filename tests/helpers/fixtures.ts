import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../lib/providers/__fixtures__');

export function loadFixture<T = unknown>(name: string): T {
  const file = path.join(FIXTURE_DIR, name);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}
