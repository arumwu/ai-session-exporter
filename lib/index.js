'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFile } = require('node:child_process');
const { ClaudeSessionSource } = require('./claude-session-source');
const { CodexSessionSource } = require('./codex-session-source');
const { SessionLinks } = require('./session-links');
const { SessionLinkRunner, ERRORS } = require('./session-link-runner');
const VERSION = require('../package.json').version;
const failure = (code, status = 400) => Object.assign(Error({ selection: 'Select 1 to 200 unique discovered sessions.', missing: 'A selected source has no readable history.',
  stale: 'A source changed. Refresh the selection before exporting.', limit: 'The selection exceeds the reading limit.', format: 'The source could not be read safely.',
  guard: 'Storage Guard stopped this operation.', input: 'Invalid request.' }[code] || 'The operation failed.'), { code, status });
const MESSAGES = {
  input: '請檢查選取內容與輸入。', selection: '請選取 1 至 200 個不重複的既有會話。', missing: '選取的來源沒有可讀取的歷史記錄。',
  stale: '來源已變更，請重新取得清單再操作。', limit: '選取的內容超過讀取上限。', format: '無法安全讀取來源。', guard: 'Storage Guard 已停止此操作。',
  busy: '此會話正在執行，請等目前回合結束。', source: '來源會話已變更或無法讀取，請重新取得清單。',
  unsupported: '原工具無法接續此來源會話。', mismatch: '原工具回傳不同的會話 ID，已停止這一回合。',
  unknown: '無法確認上次訊息是否送達，請先查看原會話再決定是否重送。', protocol: '無法辨識原工具的協定，已停止這一回合。',
  stopped: '已停止這一回合。', unverified: '原工具已結束，但尚未確認原始歷史更新。',
};
const CLI_MESSAGES = {
  'The native provider CLI is not installed or is not on PATH.': '尚未安裝原工具 CLI，或 PATH 找不到它。',
  'The native provider could not start.': '原工具無法啟動。',
};
function messageFor(code, value, language = 'zh-TW') {
  if (language !== 'zh-TW') return value;
  // Localize messages owned by this program. Provider output stays verbatim.
  if (value === ERRORS[code] || value === failure(code).message) return MESSAGES[code] || value;
  return CLI_MESSAGES[value] || value;
}
function sourcesFor(options = {}) {
  const env = options.env || process.env;
  return options.sources || {
    claude: new ClaudeSessionSource({ desktopRoot: options.claudeDesktopDir, cliRoot: options.claudeProjectsDir, env, language: options.language || env.HUB_LANG || 'zh-TW' }),
    codex: new CodexSessionSource({ root: options.codexHome, sqliteRoot: options.codexSqliteHome, env }),
  };
}
async function listSessions(sources, provider) {
  if (provider && !Object.hasOwn(sources, provider)) throw failure('selection');
  const result = { version: VERSION, providers: [] };
  for (const [name, source] of Object.entries(sources)) {
    if (provider && provider !== name) continue;
    const found = await source.discover();
    result.providers.push({ provider: name, supported: found.supported !== false, warnings: found.warnings || [], sessions: found.sessions || [] });
  }
  return result;
}
function selectedRows(rows, budget) {
  if (!Array.isArray(rows)) throw failure('format');
  return rows.map(row => {
    if (!row || !['user', 'assistant'].includes(row.role) || typeof row.text !== 'string') throw failure('format');
    budget.keptText += Buffer.byteLength(row.text); budget.keptRows++;
    if (budget.keptText > 8 * 1024 * 1024 || budget.keptRows > 10000) throw failure('limit');
    return { role: row.role, text: row.text, ...(typeof row.at === 'string' ? { at: row.at } : {}) };
  });
}
async function exportSessions(sources, selections, options = {}) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 200 || selections.some(x => !x || !Object.hasOwn(sources, x.provider) || typeof x.id !== 'string') || new Set(selections.map(x => x.provider + ':' + x.id)).size !== selections.length) throw failure('selection');
  const discovered = new Map(), warnings = [], sessions = [], snapshots = [];
  const budget = { input: 0, text: 0, rows: 0, keptText: 0, keptRows: 0 };
  const locked = (provider, action) => options.withSource ? options.withSource(provider, action) : action(sources[provider]);
  for (const selection of selections) {
    const exported = await locked(selection.provider, async source => {
      if (!discovered.has(selection.provider)) {
        const found = await source.discover();
        discovered.set(selection.provider, new Map((found.sessions || []).map(entry => [entry.id, entry])));
        warnings.push(...(found.warnings || []));
      }
      const entry = discovered.get(selection.provider).get(selection.id);
      if (!entry) throw failure('selection');
      if (!entry.hasTranscript) throw failure('missing', 404);
      const before = await source.fingerprint(selection.id);
      if (typeof before !== 'string') throw failure('format');
      const history = await source.read(selection.id, { budget });
      if (await source.fingerprint(selection.id) !== before) throw failure('stale', 409);
      if (typeof history.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(history.signature)) throw failure('format');
      snapshots.push({ ...selection, fingerprint: before });
      warnings.push(...(history.warnings || []));
      return { provider: selection.provider, id: selection.id, title: entry.title, cwd: entry.cwd || '', rows: selectedRows(history.rows, budget) };
    });
    sessions.push(exported);
  }
  // A change to an earlier selected conversation while reading another one invalidates the whole export.
  for (const snapshot of snapshots) await locked(snapshot.provider, async source => {
    if (await source.fingerprint(snapshot.id) !== snapshot.fingerprint) throw failure('stale', 409);
  });
  return { version: VERSION, exportedAt: new Date().toISOString(), sessions, warnings: [...new Set(warnings)] };
}
function formatExport(value, format) {
  if (format === 'json') return JSON.stringify(value, null, 2) + '\n';
  if (format !== 'markdown') throw failure('input');
  const heading = value => String(value).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]<>#]/g, '\\$&');
  const chunks = ['# Selected AI conversations', ''];
  for (const session of value.sessions) {
    chunks.push('## ' + heading(session.title), '', 'Provider: ' + session.provider, '', 'Working directory: ' + heading(session.cwd), '');
    for (const row of session.rows) chunks.push('### ' + (row.role === 'user' ? 'User' : 'Assistant'), '', row.text, '');
  }
  if (value.warnings.length) chunks.push('## Reading warnings', '', ...value.warnings.map(value => '- ' + heading(value)), '');
  return chunks.join('\n');
}
function guardFor(env) {
  return () => new Promise(resolve => {
    if (!env.HUB_STORAGE_GUARD) return resolve(true);
    execFile(env.HUB_STORAGE_GUARD, [], { env, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => resolve(!error && String(stdout).includes('STATUS=OK')));
  });
}
async function createService(options = {}) {
  const env = { ...process.env, ...(options.env || {}) }, sources = sourcesFor({ ...options, env });
  const root = path.resolve(options.dataDir || env.AI_SESSION_EXPORTER_HOME || path.join(os.homedir(), '.config', 'ai-session-exporter'));
  const guard = options.guard || guardFor(env);
  if (!(await guard())) throw failure('guard', 409);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const links = new SessionLinks({ root, sources, env, guard, language: options.language || env.HUB_LANG || 'zh-TW' });
  const home = links.destination().home; fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const message = (code, value) => messageFor(code, value, options.language || env.HUB_LANG || 'zh-TW');
  const runner = options.runner || new SessionLinkRunner({ message, referenceFor: id => links.referenceFor(id), history: id => links.history(id),
    receiptsFile: path.join(home, 'session-link-deliveries.json'), env, guard, ...(options.runnerOptions || {}) });
  const exportSelected = async (selected, format) => {
    if (!['json', 'markdown'].includes(format)) throw failure('input');
    if (!Array.isArray(selected) || !selected.length || selected.length > 200 || new Set(selected).size !== selected.length) throw failure('selection');
    const scanned = await links.scan();
    if (selected.some(id => typeof id !== 'string' || !scanned.lookup.has(id))) throw failure('selection');
    const selections = selected.map(id => { const entry = scanned.lookup.get(id); return { provider: entry.provider, id: entry.sourceId }; });
    return formatExport(await exportSessions(sources, selections, { withSource: (provider, action) => links.withSource(provider, action) }), format);
  };
  return { root, sources, links, runner, exportSelected, message };
}
module.exports = { VERSION, ClaudeSessionSource, CodexSessionSource, SessionLinks, SessionLinkRunner, sourcesFor, listSessions, exportSessions, formatExport, createService, failure, messageFor };
