import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'site');
const assets = ['index.html', 'styles.css', 'app.js', 'data.js', 'services'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) await cp(path.join(root, asset), path.join(output, asset), { recursive: true, force: true });
console.log(`CONecta V2 pronto para publicação: ${output}`);
