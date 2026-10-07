'use strict';
(() => {
const $ = id => document.getElementById(id);
const state = { projects: [], links: [], selected: new Set(), current: null, preview: null, run: null, broken: false, sourceBusy: false, sending: false, drafts: new Map(), requests: new Map(), actions: new Set(), approvalKey: '', epoch: 0, inventoryEpoch: 0, operation: '', previewKey: '', ready: false, hasHistory: false, statusError: false, lastHistory: 0, historyUpdateKey: '' };
function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
function notice(message = '') { $('notice').textContent = message; }
async function api(route, data) { const response = await fetch('/api/session-links' + route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(data) }); const result = await response.json(); if (!response.ok) throw Error(result.error || '操作失敗（' + response.status + '）'); return result; }
function selectionKey() { return JSON.stringify([...state.selected].sort()); }
function invalidatePreview() { state.preview = null; state.previewKey = ''; $('confirm').disabled = true; }
function count() { $('count').textContent = '已選 ' + state.selected.size + ' 項'; for (const id of ['link', 'json', 'markdown']) $(id).disabled = Boolean(state.operation) || !state.selected.size; $('refresh').disabled = Boolean(state.operation); $('cancel').disabled = state.operation === 'apply'; }
function operation(value) { state.operation = value; count(); for (const input of $('sources').querySelectorAll('input')) input.disabled = Boolean(value) || input.dataset.unavailable === 'true'; }
function renderSources() {
 const query = $('search').value.trim().toLocaleLowerCase(); $('sources').replaceChildren();
 const candidates = state.projects.flatMap(group => (group.sessions || []).filter(session => (group.name + ' ' + session.title + ' ' + session.provider).toLocaleLowerCase().includes(query)).map(session => ({ group, session }))).sort((a, b) => String(b.session.updatedAt || '').localeCompare(String(a.session.updatedAt || '')));
 if (candidates.length > 200) $('sources').append(node('p', '只顯示最近或符合搜尋的 200 段會話。仍可搜尋其他會話，改變搜尋不會清除選取。'));
 const groups = new Map(); for (const row of candidates.slice(0, 200)) { if (!groups.has(row.group)) groups.set(row.group, []); groups.get(row.group).push(row.session); }
 for (const [group, sessions] of groups) {
  const block = node('div', null, 'group'), title = node('h3', group.name + ' · ' + (group.provider || sessions[0]?.provider || '')); block.append(title);
  for (const session of sessions) {
   const row = node('label', null, 'source-row'), check = node('input'); check.type = 'checkbox'; check.checked = state.selected.has(session.id); check.dataset.unavailable = String(!session.hasTranscript); check.disabled = Boolean(state.operation) || !session.hasTranscript;
   check.addEventListener('change', () => { if (state.operation || check.disabled) return; if (check.checked && !state.selected.has(session.id) && state.selected.size >= 200) { check.checked = false; notice('一次最多選取 200 段會話。'); return; } check.checked ? state.selected.add(session.id) : state.selected.delete(session.id); invalidatePreview(); count(); });
   const source = session.isSubagent ? (session.sourceKind === 'guardian' ? '輔助會話' : '子會話') : ({Desktop:'桌面版',CLI:'命令列',IDE:'開發工具',unknown:'來源不明'})[session.source] || '';
   const label = node('span', session.title || '未命名會話'); label.append(node('span', (session.linked ? '已連結 · ' : '') + source + ' · ' + (session.hasTranscript ? (session.updatedAt || '') : '尚未找到本機文字紀錄'), 'meta')); row.append(check, label); block.append(row);
  } $('sources').append(block);
 } if (!$('sources').children.length) $('sources').append(node('p', '沒有符合的來源。請確認原 App 曾在本機儲存會話。')); count();
}
function renderLinks() { $('links').replaceChildren(); for (const link of state.links) { const button = node('button', (link.provider === 'codex' ? 'Codex' : 'Claude') + ' · ' + (link.title || '未命名會話')); button.addEventListener('click', () => openLink(link)); $('links').append(button); } if (!state.links.length) $('links').append(node('p', '尚未建立來源連結。')); }
async function refresh() {
 if (state.operation) return; const epoch = ++state.inventoryEpoch; operation('refresh'); invalidatePreview();
 try { const data = await api(''); if (epoch !== state.inventoryEpoch) return; state.projects = data.projects || []; state.links = data.links || []; const available = new Set(state.projects.flatMap(p => p.sessions || []).map(s => s.id)); state.selected = new Set([...state.selected].filter(id => available.has(id))); renderSources(); renderLinks(); notice((data.warnings || []).join('\n')); }
 finally { if (epoch === state.inventoryEpoch) operation(''); }
}
function controls() {
 const id = state.current?.id, request = state.requests.get(id), busy = Boolean(state.run?.busy || state.actions.has(id));
 $('send').disabled = !id || !state.ready || !state.hasHistory || state.statusError || state.broken || state.sourceBusy || busy || !$('message').value.trim() || Boolean(request?.uncertain && request.text !== $('message').value);
 $('send').textContent = request?.uncertain ? '重試同一則訊息' : '傳送到原 session'; $('message').disabled = !id; $('stop').hidden = !state.run?.busy; $('stop').disabled = state.actions.has(id); $('remove').disabled = busy;
}
function renderRun(run, id = state.current?.id) {
 if (!id || state.current?.id !== id || run.id && run.id !== id) return;
 const request = state.requests.get(id);
 if (request && run.requestId === request.requestId) { request.uncertain = false; if (run.verifiedSession && !request.cleared) { if ($('message').value === request.text) $('message').value = ''; request.cleared = true; state.drafts.set(id, $('message').value); } }
 state.run = run; state.ready = true; state.statusError = false; $('live').textContent = run.text || '';
 const labels = { preparing: '正在確認原 session', running: '原 session 執行中', approval: '等待你的許可', completed: '已完成', stopped: '已停止', failed: '執行失敗' };
 $('run-status').textContent = run.error || (run.phase === 'completed' && run.historyUpdated ? '已確認新訊息寫回原始紀錄。原 App 的畫面可能需要重新開啟該對話。' : labels[run.phase] || '');
 const key = JSON.stringify([id, (run.approvals || []).map(a => [a.id, a.detail])]); if (key !== state.approvalKey) {
  state.approvalKey = key; $('approvals').replaceChildren();
  for (const approval of run.approvals || []) {
   const box = node('div', null, 'approval'); box.append(node('strong', '原程式要求許可：' + approval.kind), node('pre', JSON.stringify(approval.detail, null, 2)));
   for (const [label, allow] of [['允許這一次', true], ['拒絕', false]]) { const button = node('button', label); button.addEventListener('click', async () => { if (state.current?.id !== id || state.actions.has(id) || !state.run?.approvals?.some(a => a.id === approval.id)) return; state.actions.add(id); for (const b of box.querySelectorAll('button')) b.disabled = true; controls(); try { const answer = await api('/answer', { id, approvalId: approval.id, allow }); if (state.current?.id === id) renderRun(answer, id); } catch (e) { if (state.current?.id === id) { notice(e.message); for (const b of box.querySelectorAll('button')) b.disabled = false; } } finally { state.actions.delete(id); controls(); } }); box.append(button); } $('approvals').append(box);
  }
 } controls();
}
async function history() {
 const id = state.current?.id, epoch = state.epoch; if (!id) return; const data = await api('/history?id=' + encodeURIComponent(id)); if (state.current?.id !== id || epoch !== state.epoch) return;
 const container = $('history'), bottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50, top = container.scrollTop;
 container.replaceChildren(); for (const message of data.messages || []) { const box = node('div', null, 'message ' + message.role); box.append(node('strong', message.role === 'user' ? '你' : (data.provider === 'codex' ? 'Codex' : 'Claude')), node('span', message.text)); container.append(box); }
 state.broken = Boolean(data.broken) || !data.signature; state.hasHistory = Boolean(data.signature); state.sourceBusy = data.active === true; state.lastHistory = Date.now();
 $('source-info').textContent = '來源：' + (data.provider === 'codex' ? 'Codex' : 'Claude') + ' · 續接原本的 session，不建立副本。' + (state.broken ? ' 原始紀錄目前無法讀取，暫停傳送。' : state.sourceBusy ? ' 原來源仍在執行，請等待。' : '');
 if (bottom) container.scrollTop = container.scrollHeight; else container.scrollTop = top;
 if (data.warnings?.length) notice(data.warnings.join('\n')); controls();
}
async function openLink(link) {
 if (state.current) state.drafts.set(state.current.id, $('message').value);
 const epoch = ++state.epoch; state.current = link; state.run = null; state.ready = false; state.hasHistory = false; state.statusError = false; state.broken = false; state.sourceBusy = false; state.lastHistory = 0; state.historyUpdateKey = ''; state.approvalKey = ''; $('history').replaceChildren(); $('approvals').replaceChildren(); $('live').textContent = ''; $('run-status').textContent = '正在確認原會話…'; $('title').textContent = link.title || '未命名會話'; $('message').value = state.drafts.get(link.id) || ''; $('inventory').hidden = true; $('conversation').hidden = false; controls();
 try { await history(); if (state.current?.id !== link.id || epoch !== state.epoch) return; const run = await api('/status?id=' + encodeURIComponent(link.id)); if (state.current?.id === link.id && epoch === state.epoch) renderRun(run, link.id); }
 catch (e) { if (state.current?.id === link.id && epoch === state.epoch) { state.broken = true; controls(); notice(e.message); } }
}
async function preview() {
 if (state.operation || !state.selected.size) return; const key = selectionKey(); operation('preview'); invalidatePreview();
 try { const data = await api('/preview', { selected: [...state.selected] }); if (key !== selectionKey()) return; state.preview = data.token; state.previewKey = key; $('preview-groups').replaceChildren(); for (const group of data.groups || []) $('preview-groups').append(node('p', group.name + '：' + group.sessionCount + ' 個會話（已連結 ' + (group.alreadyLinkedCount || 0) + ' 個）')); $('preview-warnings').textContent = [...(data.warnings || []), ...(data.blockers || [])].join('\n'); $('confirm').disabled = !data.token || !data.groups?.length || Boolean(data.blockers?.length); $('preview').showModal(); }
 catch (e) { invalidatePreview(); notice(e.message); } finally { operation(''); }
}
async function exportSelected(format) {
 if (state.operation || !state.selected.size) return; operation('export');
 try { const response = await fetch('/api/session-links/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify({ selected: [...state.selected], format }) }); if (!response.ok) { const data = await response.json(); throw Error(data.error || '匯出失敗'); } const blob = await response.blob(), url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = 'selected-sessions.' + (format === 'json' ? 'json' : 'md'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('已匯出你選擇的會話。'); } catch (e) { notice(e.message); } finally { operation(''); }
}
$('refresh').addEventListener('click', () => refresh().catch(e => notice(e.message)));
$('search').addEventListener('input', renderSources); $('link').addEventListener('click', preview); $('json').addEventListener('click', () => exportSelected('json')); $('markdown').addEventListener('click', () => exportSelected('markdown'));
$('cancel').addEventListener('click', () => { if (state.operation === 'apply') return; invalidatePreview(); $('preview').close(); });
$('preview').addEventListener('cancel', event => { if (state.operation === 'apply') { event.preventDefault(); return; } invalidatePreview(); });
$('confirm').addEventListener('click', async () => { if (state.operation || !state.preview || $('confirm').disabled || state.previewKey !== selectionKey()) return; const token = state.preview; invalidatePreview(); operation('apply'); try { const data = await api('/apply', { token, confirm: true }); $('preview').close(); state.selected.clear(); operation(''); await refresh(); notice('已建立 ' + (data.linkedCount || 0) + ' 個來源連結。'); } catch (e) { notice(e.message + '\n請重新預覽，再確認連結。'); } finally { operation(''); } });
$('browse').addEventListener('click', () => { if (state.current) state.drafts.set(state.current.id, $('message').value); state.epoch++; state.current = null; state.ready = false; $('conversation').hidden = true; $('inventory').hidden = false; });
$('history-refresh').addEventListener('click', async () => { const id = state.current?.id; try { await history(); } catch (e) { if (state.current?.id === id) { state.broken = true; controls(); notice(e.message); } } });
$('remove').addEventListener('click', async () => { const id = state.current?.id; if (!id || state.run?.busy || state.actions.has(id) || !confirm('只移除這個來源連結；原 App 的對話與檔案會保留。')) return; state.actions.add(id); controls(); try { await api('/remove', { id, confirm: true }); if (state.current?.id === id) $('browse').click(); await refresh(); } catch (e) { if (state.current?.id === id) notice(e.message); } finally { state.actions.delete(id); controls(); } });
$('message').addEventListener('input', () => { if (state.current) state.drafts.set(state.current.id, $('message').value); controls(); });
$('composer').addEventListener('submit', async event => {
 event.preventDefault(); if ($('send').disabled || !state.current || !$('message').value.trim()) return;
 const id = state.current.id, text = $('message').value, previous = state.requests.get(id), request = previous?.uncertain ? previous : { requestId: crypto.randomUUID(), text, uncertain: false, cleared: false };
 if (request.text !== text) return; state.requests.set(id, request); state.actions.add(id); controls();
 try { const run = await api('/send', { id, text, requestId: request.requestId }); request.uncertain = false; if (state.current?.id === id) renderRun(run, id); }
 catch (e) { request.uncertain = true; if (state.current?.id === id) notice(e.message + '\n無法確認是否送達，請重新讀取原紀錄，或只重試同一則訊息。工具不會自動重送。'); }
 finally { state.actions.delete(id); controls(); }
});
$('stop').addEventListener('click', async () => { const id = state.current?.id; if (!id || !state.run?.busy || state.actions.has(id)) return; state.actions.add(id); controls(); try { const run = await api('/stop', { id }); if (state.current?.id === id) renderRun(run, id); } catch (e) { if (state.current?.id === id) notice(e.message); } finally { state.actions.delete(id); controls(); } });
let polling = false;
setInterval(async () => { const id = state.current?.id, epoch = state.epoch; if (!id || polling || document.hidden) return; polling = true; try { const run = await api('/status?id=' + encodeURIComponent(id)); if (state.current?.id === id && epoch === state.epoch) { const wasBusy = state.run?.busy, key = JSON.stringify([run.requestId,run.phase,run.historyUpdated]); renderRun(run, id); if (wasBusy && !run.busy || Date.now() - state.lastHistory >= 10000 || run.historyUpdated && key !== state.historyUpdateKey) { await history(); if (state.current?.id === id && epoch === state.epoch) state.historyUpdateKey = key; } } } catch (e) { if (state.current?.id === id && epoch === state.epoch) { state.statusError = true; controls(); notice(e.message); } } finally { polling = false; } }, 1200);
count();
refresh().catch(e => notice(e.message));
})();
