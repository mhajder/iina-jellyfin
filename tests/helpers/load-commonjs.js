import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The plugin's lib files are CommonJS run by IINA, but package.json sets
// "type": "module", so Node cannot require them directly.
export function loadCommonJs(file) {
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, URL });
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  return module.exports;
}
