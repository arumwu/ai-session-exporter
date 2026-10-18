'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {CodexSessionSource}=require('../lib/codex-session-source');
const sid='11111111-1111-4111-8111-111111111111';
const body=(count=250)=>[JSON.stringify({type:'session_meta',payload:{id:sid,cwd:'/synthetic',source:'cli'}}),...Array.from({length:count},(_,i)=>JSON.stringify({type:'response_item',payload:{type:'message',role:i%2?'assistant':'user',content:[{type:'output_text',text:'訊息 '+i}]}}))].join('\n')+'\n';
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cantus-zstd-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(root+'/sessions');return {root,file:root+'/sessions/rollout-'+sid+'.jsonl'};}
test('zstd-only discovery and all pages equal plain history; no file writes',async t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file,body());const source=new CodexSessionSource({root});let c=await source.discover();const plain=await source.read(c.sessions[0].id,{page:true});fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(fs.readFileSync(file)));fs.unlinkSync(file);const original=sha(file+'.zst');
 c=await source.discover();assert.equal(c.sessions[0].transcriptFormat,'zstd');const compressed=await source.read(c.sessions[0].id,{page:true});assert.deepEqual(compressed,plain);
 const older=await source.read(c.sessions[0].id,{page:true,before:compressed.nextBefore,pageSignature:compressed.pageSignature});assert.equal(older.rows.length,120);assert.equal(older.pageStart,10);assert.equal(sha(file+'.zst'),original);assert.equal(fs.existsSync(file),false);
 await assert.rejects(source.read(c.sessions[0].id,{page:true,before:120,pageSignature:'0'.repeat(64)}),e=>e.code==='stale');
});
test('Unicode line and paragraph separators inside JSON strings are not JSONL delimiters',async t=>{
 const {root,file}=fixture(t),text='前\u2028中\u2029後';
 const raw=body(0)+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
 fs.writeFileSync(file,raw);const source=new CodexSessionSource({root});let c=await source.discover();const plain=await source.read(c.sessions[0].id,{page:true});
 fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(raw));fs.unlinkSync(file);c=await source.discover();assert.deepEqual(await source.read(c.sessions[0].id,{page:true}),plain);assert.ok(JSON.stringify(plain).includes(text));
});
test('paged compressed history validates large internal tool results without returning them or relaxing export limits',async t=>{
 const {root,file}=fixture(t);
 for(const type of ['custom_tool_call_output','function_call_output']){
  const tool=JSON.stringify({type:'response_item',payload:{type,output:'x'.repeat(9*1024*1024)}});
  fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body(250)+tool+'\n'));
  const source=new CodexSessionSource({root}),c=await source.discover(),id=c.sessions[0].id;
  const latest=await source.read(id,{page:true});assert.equal(latest.totalRows,250);assert.equal(latest.rows.length,120);assert.equal(latest.pageStart,130);
  const older=await source.read(id,{page:true,before:latest.nextBefore,pageSignature:latest.pageSignature});assert.equal(older.pageStart,10);assert.equal(older.rows.length,120);
  assert.ok(latest.rows.every(r=>!r.text.includes('xxxx')));await assert.rejects(source.read(id),e=>e.code==='limit');
  fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body(1)+tool.slice(0,-1)+'\n'));await source.discover();await assert.rejects(source.read(id,{page:true}),e=>e.code==='format');
  const disguised=tool.slice(0,-1)+',"payload":{"type":"message","role":"user","content":[]}}';
  fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body(1)+disguised+'\n'));await source.discover();await assert.rejects(source.read(id,{page:true}),e=>e.code==='limit');
 }
});
test('plain native file wins over older compressed copy of same ID',async t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body(1)));fs.writeFileSync(file,body(2));const s=new CodexSessionSource({root}),c=await s.discover();assert.equal(c.sessions.length,1);assert.equal(c.sessions[0].transcriptFormat,'jsonl');assert.equal((await s.read(c.sessions[0].id,{page:true})).rows.length,2);
});
test('targeted discovery uses header ID even when filename has a different fork suffix',async t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body(1)));fs.writeFileSync(file.replace('.jsonl','_22222222-2222-4222-8222-222222222222.jsonl'),body(2));const s=new CodexSessionSource({root}),all=await s.discover(),c=await s.discover({ids:[all.sessions[0].id]});assert.equal(c.sessions[0].transcriptFormat,'jsonl');assert.equal((await s.read(c.sessions[0].id,{page:true})).rows.length,2);
});
test('changed compressed source is stale; malformed/truncated zstd is rejected',async t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body()));const s=new CodexSessionSource({root}),c=await s.discover();fs.appendFileSync(file+'.zst','broken');await assert.rejects(s.read(c.sessions[0].id,{page:true}),e=>e.code==='stale');
 fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body()).subarray(0,-2));await s.discover();await assert.rejects(s.read(c.sessions[0].id,{page:true}));
});
test('expanded-byte, line and header limits apply to compressed files',async t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body()));let s=new CodexSessionSource({root,limits:{fileBytes:2000}}),c=await s.discover();await assert.rejects(s.read(c.sessions[0].id),e=>e.code==='limit');
 fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body(1)+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'a'.repeat(9*1024*1024)}]}})+'\n'));s=new CodexSessionSource({root});c=await s.discover();await assert.rejects(s.read(c.sessions[0].id,{page:true}),e=>e.code==='limit');
 fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(JSON.stringify({type:'session_meta',payload:{id:sid,instructions:'a'.repeat(70000)}})+'\n'));c=await s.discover();assert.equal(c.sessions.length,0);assert.ok(c.warnings.some(x=>/limit/.test(x)));
});
test('compressed symlinks escaping root are not discovered',async t=>{
 const {root,file}=fixture(t);const outside=root+'/outside.zst';fs.writeFileSync(outside,zlib.zstdCompressSync(body()));fs.symlinkSync(outside,file+'.zst');const c=await new CodexSessionSource({root}).discover();assert.equal(c.sessions.length,0);assert.ok(c.warnings.some(x=>/Linked/.test(x)));
});
test('targeted discovery cannot expose unselected compressed sessions',async t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(body()));const s=new CodexSessionSource({root}),all=await s.discover();assert.equal((await s.discover({ids:['codex_not_selected']})).sessions.length,0);assert.equal((await s.discover({ids:[all.sessions[0].id]})).sessions.length,1);
});
