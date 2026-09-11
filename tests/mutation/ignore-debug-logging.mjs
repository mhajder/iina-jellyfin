import { declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';

/**
 * Stryker ignorer: debug log calls carry no behaviour worth a test. Mutating
 * the text of `debugLog(...)` / `log(...)` / `console.log(...)` would only
 * force assertions on log wording, so mutants inside those calls are skipped.
 */
function calleeName(callee) {
  if (callee.type === 'Identifier') {
    return callee.name;
  }
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, 'debug-logging', {
    shouldIgnore(path) {
      const node = path.isExpressionStatement() ? path.node.expression : path.node;
      if (node.type === 'CallExpression') {
        const name = calleeName(node.callee);
        if (name === 'debugLog' || name === 'log') {
          return 'Debug logging is not behaviour under test';
        }
      }
      return undefined;
    },
  }),
];
