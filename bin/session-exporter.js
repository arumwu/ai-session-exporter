#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { sourcesFor, listSessions, exportSessions, formatExport } = require('../lib');
const { createServer } = require('../lib/server');
const HELP = `ai-session-exporter (Node >=22.13; no dependencies)
  list [--provider codex|claude]                         List metadata and stable IDs
  export --provider codex|claude --id ID [--id ID ...]  Export selected sessions only
         [--format json|markdown] [--output FILE]       Defaults: JSON, stdout
  serve [--port 4747] [--host 127.0.0.1|::1] [--data-dir DIRECTORY]
Source options: --codex-home DIR --codex-sqlite-home DIR
                --claude-desktop-dir DIR --claude-projects-dir DIR
Metadata directory: --data-dir or AI_SESSION_EXPORTER_HOME
No source credentials, permissions, or history are copied. No turn starts automatically.
`;
function parse(argv) {
  const command = argv[0] || 'help', options = {}, ids = [];
  const known = new Set(['provider', 'id', 'format', 'output', 'port', 'host', 'data-dir', 'codex-home', 'codex-sqlite-home', 'claude-desktop-dir', 'claude-projects-dir']);
  if (command === '--help' || command === '-h' || command === 'help') return { command: 'help', options, ids };
  if (!['list', 'export', 'serve'].includes(command)) throw Error('Unknown command. Use --help.');
  for (let n = 1; n < argv.length; n++) {
    if (!argv[n].startsWith('--') || !known.has(argv[n].slice(2)) || n + 1 >= argv.length || argv[n + 1].startsWith('--')) throw Error('Invalid or missing option. Use --help.');
    const key = argv[n].slice(2), value = argv[++n];
    if (key === 'id') ids.push(value);
    else { if (Object.hasOwn(options, key)) throw Error('Duplicate option: --' + key); options[key] = value; }
  }
  if (options.provider && !['codex', 'claude'].includes(options.provider)) throw Error('Choose --provider codex or claude.');
  if (command === 'export' && (!options.provider || !ids.length)) throw Error('Export requires an explicit provider and at least one --id.');
  if (options.format && !['json', 'markdown'].includes(options.format)) throw Error('Choose --format json or markdown.');
  const allowed = new Set(['codex-home', 'codex-sqlite-home', 'claude-desktop-dir', 'claude-projects-dir', ...(command === 'serve' ? ['host', 'port', 'data-dir'] : command === 'list' ? ['provider'] : ['provider', 'format', 'output'])]);
  if (Object.keys(options).some(key => !allowed.has(key)) || command !== 'export' && ids.length) throw Error('This option is not supported by the chosen command.');
  return { command, options, ids };
}
async function main(argv = process.argv.slice(2), io = process) {
  const { command, options, ids } = parse(argv);
  if (command === 'help') { io.stdout.write(HELP); return; }
  const sourceOptions = { codexHome: options['codex-home'], codexSqliteHome: options['codex-sqlite-home'], claudeDesktopDir: options['claude-desktop-dir'], claudeProjectsDir: options['claude-projects-dir'] };
  if (command === 'serve') {
    const port = options.port === undefined ? 4747 : Number(options.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Choose a port from 1 to 65535.');
    const app = await createServer({ ...sourceOptions, host: options.host, dataDir: options['data-dir'] });
    const address = await app.listen(port), host = address.family === 'IPv6' ? '[' + address.address + ']' : address.address;
    io.stdout.write('AI Session Exporter: http://' + host + ':' + address.port + '\n');
    return app;
  }
  const sources = sourcesFor(sourceOptions);
  if (command === 'list') { io.stdout.write(JSON.stringify(await listSessions(sources, options.provider), null, 2) + '\n'); return; }
  const output = formatExport(await exportSessions(sources, ids.map(id => ({ provider: options.provider, id }))), options.format || 'json');
  if (options.output) {
    const file = path.resolve(options.output), parent = fs.realpathSync(path.dirname(file)), actual = path.join(parent, path.basename(file));
    const sourceRoots = [sources.codex.configuredRoot, sources.codex.configuredSqliteRoot, sources.claude.desktop, sources.claude.cli];
    for (const value of sourceRoots) {
      let canonical; try { canonical = fs.realpathSync(value); } catch { continue; }
      if (actual === canonical || actual.startsWith(canonical + path.sep)) throw Error('Export output must be outside the source history directories.');
    }
    fs.writeFileSync(file, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  else io.stdout.write(output);
}
if (require.main === module) main().catch(error => { process.stderr.write((error.message || 'Operation failed.') + '\n'); process.exitCode = 1; });
module.exports = { main, parse };
