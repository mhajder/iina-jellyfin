import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Run a plugin source file in a vm context. Naming the script with its file
// URL lets `node --test --experimental-test-coverage` attribute it to the file.
export function runScript(file, context) {
  vm.runInContext(readFileSync(file, 'utf8'), context, {
    filename: pathToFileURL(resolve(file)).href,
  });
  return context;
}

// The plugin's lib files are CommonJS run by IINA, but package.json sets
// "type": "module", so Node cannot require them directly.
export function loadCommonJs(file) {
  const module = { exports: {} };
  runScript(file, vm.createContext({ module, exports: module.exports, URL }));
  return module.exports;
}
