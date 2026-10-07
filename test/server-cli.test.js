'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const exec = promisify(execFile);
const { sourcesFor, exportSessions, formatExport, createService } = require('../lib');
const { createServer } = require('../lib/server');
const { parse } = require('../bin/session-exporter');
const SID = '11111111-2222-4333-8444-555555555555';
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ai-exporter-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codex = path.join(dir, 'codex'), sessions = path.join(codex, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'rollout-' + SID + '.jsonl'), cwd = path.join(dir, 'working-directory'); fs.mkdirSync(cwd);
  const frame = (role, text, extra = {}) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'output_text', text }], ...extra } });
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: SID, cwd, originator: 'codex_desktop', source: 'appServer' } },
    frame('user', 'Selected fictional question'), frame('assistant', 'Selected fictional answer'),
    frame('assistant', 'hidden analysis', { channel: 'analysis' }), frame('system', 'hidden system'), frame('developer', 'hidden developer'),
    { type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate event' } },
    { type: 'response_item', payload: { type: 'function_call', arguments: 'hidden tool arguments' } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(codex, 'auth.json'), 'fictional credential sentinel; never read\n');
  const absentDesktop = path.join(dir, 'absent-desktop'), absentProjects = path.join(dir, 'absent-projects');
  const options = { codexHome: codex, claudeDesktopDir: absentDesktop, claudeProjectsDir: absentProjects, env: {} };
  return { dir, codex, file, options, before: digest(file), authBefore: digest(path.join(codex, 'auth.json')) };
}
function request(app, route, options = {}) {
  return new Promise((resolve, reject) => {
    const data = options.raw === undefined ? options.body === undefined ? null : JSON.stringify(options.body) : options.raw;
    const port = app.server.address().port;
    const req = http.request({ host: '127.0.0.1', port, path: route, method: options.method || 'GET', headers: {
      Host: '127.0.0.1:' + port, ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Hub': '1' }), ...options.headers,
    } }, res => { const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })); });
    req.on('error', reject); req.end(data);
  });
}
async function appFixture(t, options = {}) {
  const f = fixture(t), service = await createService({ ...f.options, dataDir: path.join(f.dir, 'metadata'), guard: async () => true, ...options });
  const app = await createServer({ service }); await app.listen(0); t.after(() => new Promise(resolve => app.server.close(resolve)));
  return { ...f, service, app };
}
test('selected export keeps human/assistant text only and leaves source and credentials byte-identical', async t => {
  const f = fixture(t), sources = sourcesFor(f.options), found = await sources.codex.discover();
  assert.equal(found.sessions.length, 1); const selected = [{ provider: 'codex', id: found.sessions[0].id }];
  const value = await exportSessions(sources, selected);
  assert.deepEqual(value.sessions[0].rows.map(row => row.text), ['Selected fictional question', 'Selected fictional answer']);
  const json = formatExport(value, 'json');
  for (const hidden of ['hidden analysis', 'hidden system', 'hidden developer', 'hidden tool', 'duplicate event', 'credential sentinel']) assert.equal(json.includes(hidden), false);
  assert.ok(formatExport(value, 'markdown').includes('Selected fictional answer'));
  assert.equal(digest(f.file), f.before); assert.equal(digest(path.join(f.codex, 'auth.json')), f.authBefore);
});
test('invalid, duplicate, missing and oversized selections are rejected without exporting all', async t => {
  const f = fixture(t), sources = sourcesFor(f.options);
  for (const selected of [[], [{ provider: 'codex', id: 'not-discovered' }], [{ provider: 'evil', id: 'x' }], Array.from({ length: 201 }, (_, n) => ({ provider: 'codex', id: String(n) }))]) await assert.rejects(exportSessions(sources, selected), e => e.code === 'selection');
  const found = await sources.codex.discover(), item = { provider: 'codex', id: found.sessions[0].id };
  await assert.rejects(exportSessions(sources, [item, item]), e => e.code === 'selection');
  assert.equal(digest(f.file), f.before);
});
test('a changing selected source invalidates the entire export', async () => {
  let fingerprint = 'before';
  const source = { discover: () => ({ sessions: [{ id: 'one', title: 'Fixture', hasTranscript: true }] }), fingerprint: () => fingerprint,
    read: () => { fingerprint = 'after'; return { rows: [], signature: 'a'.repeat(64) }; } };
  await assert.rejects(exportSessions({ codex: source }, [{ provider: 'codex', id: 'one' }]), e => e.code === 'stale' && e.status === 409);
});
test('an earlier selection changing during a later read invalidates a multi-session export', async () => {
  let changed = false;
  const source = { discover: () => ({ sessions: ['one', 'two'].map(id => ({ id, title: id, hasTranscript: true })) }), fingerprint: id => id === 'one' && changed ? 'changed' : id,
    read: id => { if (id === 'two') changed = true; return { rows: [], signature: 'a'.repeat(64) }; } };
  await assert.rejects(exportSessions({ codex: source }, ['one', 'two'].map(id => ({ provider: 'codex', id }))), e => e.code === 'stale');
});
test('metadata creation fails closed when the configured Storage Guard refuses it', async t => {
  const f = fixture(t), dataDir = path.join(f.dir, 'must-not-exist');
  await assert.rejects(createService({ ...f.options, dataDir, guard: async () => false }), e => e.code === 'guard');
  assert.equal(fs.existsSync(dataDir), false);
});
test('HTTP links preview/apply remain metadata-only and export only explicitly selected opaque IDs', async t => {
  const f = await appFixture(t), inventory = JSON.parse((await request(f.app, '/api/session-links')).text), id = inventory.projects[0].sessions[0].id;
  const preview = JSON.parse((await request(f.app, '/api/session-links/preview', { method: 'POST', body: { selected: [id] } })).text);
  const applied = JSON.parse((await request(f.app, '/api/session-links/apply', { method: 'POST', body: { token: preview.token, confirm: true } })).text);
  assert.equal(applied.linkedCount, 1); assert.equal(fs.existsSync(path.join(f.service.root, 'Product')), false);
  const download = await request(f.app, '/api/session-links/export', { method: 'POST', body: { selected: [id], format: 'json' } });
  assert.equal(download.status, 200); assert.ok(download.headers['content-disposition'].includes('attachment'));
  assert.equal(JSON.parse(download.text).sessions.length, 1);
  const invalid = await request(f.app, '/api/session-links/export', { method: 'POST', body: { selected: [], format: 'json' } }); assert.equal(invalid.status, 400);
  const unknown = await request(f.app, '/api/session-links/export', { method: 'POST', body: { selected: [applied.links[0].id], format: 'json' } }); assert.equal(unknown.status, 400);
  const manifest = fs.readFileSync(path.join(f.service.root, '_hub/session-links.json'), 'utf8'); assert.equal(manifest.includes('Selected fictional'), false);
  assert.equal(digest(f.file), f.before);
});
test('DNS rebinding, cross-origin reads, CSRF writes and malformed JSON fail closed', async t => {
  const f = await appFixture(t);
  for (const options of [{ headers: { Host: 'evil.example:' + f.app.server.address().port } }, { headers: { Origin: 'https://evil.example' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }]) assert.equal((await request(f.app, '/api/session-links', options)).status, 403);
  assert.equal((await request(f.app, '/api/session-links/preview', { method: 'POST', body: { selected: [] }, headers: { 'X-Hub': '' } })).status, 403);
  assert.equal((await request(f.app, '/api/session-links/preview', { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await request(f.app, '/api/session-links/preview', { method: 'POST', raw: 'x'.repeat(256 * 1024 + 1) })).status, 413);
  assert.equal((await request(f.app, '/api/session-links/preview', { method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(f.app, '/api/session-links')).headers['access-control-allow-origin'], undefined);
});
test('HTTP cannot configure a source root; static paths are allowlisted and non-loopback binding is rejected', async t => {
  const f = await appFixture(t);
  assert.equal((await request(f.app, '/api/session-links?codexHome=/outside')).status, 200);
  for (const route of ['/../package.json', '/%2e%2e/package.json', '/lib/server.js', '/auth.json']) assert.equal((await request(f.app, route)).status, 404);
  await assert.rejects(createServer({ service: f.service, host: '0.0.0.0' }), e => e.code === 'input');
});
test('HTTP send/approval/stop invoke the shared native runner only with explicit action', async t => {
  const calls = [], runner = { status: id => ({ id, busy: false }), send: body => { calls.push(['send', body]); return { phase: 'running' }; },
    answer: body => { calls.push(['answer', body]); return {}; }, stop: id => { calls.push(['stop', id]); return {}; } };
  const f = await appFixture(t, { runner }); await request(f.app, '/api/session-links'); assert.equal(calls.length, 0);
  for (const [action, body] of [['send', { id: 'link', text: 'fixture', requestId: 'request' }], ['answer', { id: 'link', approvalId: 'approval', allow: false }], ['stop', { id: 'link' }]]) assert.equal((await request(f.app, '/api/session-links/' + action, { method: 'POST', body })).status, 200);
  assert.deepEqual(calls.map(x => x[0]), ['send', 'answer', 'stop']);
});
test('CLI list and selected export use stable IDs; explicit output cannot replace source history', async t => {
  const f = fixture(t), bin = path.join(__dirname, '../bin/session-exporter.js');
  const args = ['--codex-home', f.codex, '--claude-desktop-dir', f.options.claudeDesktopDir, '--claude-projects-dir', f.options.claudeProjectsDir];
  const listed = await exec(process.execPath, [bin, 'list', '--provider', 'codex', ...args]);
  const id = JSON.parse(listed.stdout).providers[0].sessions[0].id;
  const exported = await exec(process.execPath, [bin, 'export', '--provider', 'codex', '--id', id, ...args]);
  assert.equal(JSON.parse(exported.stdout).sessions.length, 1);
  const file = path.join(f.dir, 'selected.md'); await exec(process.execPath, [bin, 'export', '--provider', 'codex', '--id', id, '--format', 'markdown', '--output', file, ...args]);
  assert.ok(fs.readFileSync(file, 'utf8').includes('Selected fictional answer'));
  await assert.rejects(exec(process.execPath, [bin, 'export', '--provider', 'codex', '--id', id, '--output', f.file, ...args]));
  const newSourceFile = path.join(f.codex, 'must-not-create.json');
  await assert.rejects(exec(process.execPath, [bin, 'export', '--provider', 'codex', '--id', id, '--output', newSourceFile, ...args]));
  assert.equal(fs.existsSync(newSourceFile), false); assert.equal(digest(f.file), f.before);
});
test('CLI refuses implicit all-session export, invalid flags, unsafe provider options and duplicate options', () => {
  for (const argv of [['export'], ['export', '--provider', 'codex'], ['export', '--provider', 'claude', '--id', 'x', '--fork'], ['serve', '--dangerously-skip-permissions'], ['list', '--provider', 'codex', '--provider', 'claude'], ['list', '--output', 'x']]) assert.throws(() => parse(argv));
  assert.deepEqual(parse(['export', '--provider', 'codex', '--id', 'one', '--id', 'two']).ids, ['one', 'two']);
});

test('local API localizes owned errors while preserving exact native provider errors', async t => {
  let native = false;
  const runner = { status: id => ({ id, busy: false }), send: () => { throw Object.assign(Error(native ? 'Provider quota/error EXACT 429' : 'The source session changed or is unavailable. Refresh before continuing.'), { code: native ? 'provider' : 'source', status: 409 }); } };
  const f = await appFixture(t, { runner });
  const args = { method: 'POST', body: { id: 'fixture', text: 'fixture', requestId: 'fixture' } };
  const owned = JSON.parse((await request(f.app, '/api/session-links/send', args)).text);
  assert.equal(owned.code, 'source'); assert.equal(owned.error, '來源會話已變更或無法讀取，請重新取得清單。');
  native = true;
  const raw = JSON.parse((await request(f.app, '/api/session-links/send', args)).text);
  assert.equal(raw.code, 'provider'); assert.equal(raw.error, 'Provider quota/error EXACT 429');
});
