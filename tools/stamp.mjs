// Stamps every file reference with one version number so a phone never mixes old and new files
// after an update. Run before each release: node tools/stamp.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const v = String(Date.now()).slice(0, 10);
const edit = (path, fn) => {
  const url = new URL(path, root);
  writeFileSync(url, fn(readFileSync(url, 'utf8')));
};

edit('index.html', (s) => s.replace(/((?:src|href)="(?:js\/app\.js|style\.css|vendor\/peerjs\.min\.js))(?:\?v=\d+)?"/g, `$1?v=${v}"`));
for (const f of readdirSync(new URL('js/', root))) {
  edit(`js/${f}`, (s) => s.replace(/(from '\.\/[\w-]+\.js)(?:\?v=\d+)?'/g, `$1?v=${v}'`));
}
console.log(`stamped v=${v}`);
