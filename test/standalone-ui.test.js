'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const clone=value=>JSON.parse(JSON.stringify(value)),later=()=>new Promise(setImmediate);
async function fixture(){
 const ids=new Map(),calls=[],timers=[],doc={hidden:false};
 class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.value='';this.disabled=false;this.hidden=false;this.checked=false;this.textContent='';this.scrollTop=0;this.scrollHeight=500;this.clientHeight=100;}
  set innerHTML(_value){throw Error('user text must never become HTML');}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
  querySelectorAll(selector){return this.children.flatMap(node=>[...(node.tag===selector?[node]:[]),...node.querySelectorAll(selector)]);}
  async emit(name,extra={}){const event={target:this,preventDefault(){this.prevented=true;},...extra};for(const fn of this.listeners[name]||[])await fn(event);return event;}
  click(){return this.emit('click');}
  showModal(){this.open=true;}
  close(){this.open=false;}
 }
 for(const match of fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8').matchAll(/id="([^"]*)"/g))ids.set(match[1],new Element());
 doc.getElementById=id=>ids.get(id);doc.createElement=tag=>new Element(tag);
 const a={id:'11111111-1111-4111-8111-111111111111',provider:'codex',title:'Codex <script>A</script>'},b={id:'22222222-2222-4222-8222-222222222222',provider:'claude',title:'Claude B'};
 const inventory={projects:[{id:'p',name:'Selected <img src=x>',provider:'codex',sessions:[{id:'source-a',title:'Source A',provider:'codex',hasTranscript:true,linked:false},{id:'source-b',title:'Source B',provider:'claude',hasTranscript:true,linked:false}]}],links:[a,b],warnings:[]};
 const histories=new Map([[a.id,{id:a.id,provider:'codex',messages:[{role:'user',text:'原文そのまま <script>text</script>'}],signature:'a-signature',broken:false,active:false,warnings:[]}],[b.id,{id:b.id,provider:'claude',messages:[{role:'assistant',text:'B answer'}],signature:'b-signature',broken:false,active:false,warnings:[]}]]),runs=new Map([[a.id,{id:a.id,phase:'idle',busy:false,approvals:[]}],[b.id,{id:b.id,phase:'idle',busy:false,approvals:[]}]]);
 let handler=async(route,body)=>{
  if(route==='/api/session-links')return inventory;
  if(route.startsWith('/api/session-links/history?'))return histories.get(new URL(route,'http://fixture').searchParams.get('id'));
  if(route.startsWith('/api/session-links/status?'))return runs.get(new URL(route,'http://fixture').searchParams.get('id'));
  if(route.endsWith('/preview'))return{token:'preview-one',groups:[{name:'Chosen only',sessionCount:body.selected.length,alreadyLinkedCount:0}],warnings:[],blockers:[]};
  if(route.endsWith('/apply'))return{links:[a,b],linkedCount:1};
  if(route.endsWith('/send'))return{...runs.get(body.id),requestId:body.requestId,phase:'preparing',busy:true,verifiedSession:false};
  if(route.endsWith('/answer'))return{...runs.get(body.id),phase:'running',busy:true,approvals:[]};
  if(route.endsWith('/stop'))return{...runs.get(body.id),phase:'stopped',busy:false};
  if(route.endsWith('/remove'))return{removed:true,links:[b]};
  if(route.endsWith('/export'))return{export:true};
  throw Error('unexpected '+route);
 };
 const context={Date,document:doc,crypto:require('node:crypto'),URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},confirm:()=>true,setTimeout(){},setInterval(fn){timers.push(fn);},
  fetch:async(route,opt={})=>{const body=opt.body?JSON.parse(opt.body):undefined;calls.push({route,body,headers:opt.headers});const value=await handler(route,body);return{ok:true,status:200,json:async()=>clone(value),blob:async()=>({})};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);await later();calls.length=0;
 const el=id=>ids.get(id),open=async index=>{await el('links').children[index].click();};
 return{calls,timers,el,a,b,inventory,histories,runs,handler:fn=>{handler=fn;},normal:(route,body)=>{
  if(route.includes('/history?'))return histories.get(new URL(route,'http://fixture').searchParams.get('id'));
  if(route.includes('/status?'))return runs.get(new URL(route,'http://fixture').searchParams.get('id'));
  if(route==='/api/session-links')return inventory;return{};
 },open,input:async text=>{el('message').value=text;await el('message').emit('input');},submit:()=>el('composer').emit('submit'),poll:()=>timers[0](),checks:()=>el('sources').querySelectorAll('input')};
}
test('Only explicitly selected opaque IDs are previewed/exported; default unchecked and pending preview/apply are locked',async()=>{
 const f=await fixture();assert.ok(f.checks().every(input=>!input.checked));assert.equal(f.el('link').disabled,true);await f.el('link').click();assert.equal(f.calls.length,0);
 f.checks()[0].checked=true;await f.checks()[0].emit('change');await f.el('link').click();assert.deepEqual(f.calls.at(-1).body,{selected:['source-a']});assert.equal(f.el('preview').open,true);
 let release;f.handler((route,body)=>route.endsWith('/apply')?new Promise(resolve=>{release=resolve;}):f.normal(route,body));const pending=f.el('confirm').click();await f.el('confirm').click();assert.equal(f.calls.filter(call=>call.route.endsWith('/apply')).length,1);release({linkedCount:1,links:[f.a,f.b]});await pending;
 f.checks()[0].checked=true;await f.checks()[0].emit('change');f.handler((route,body)=>route.endsWith('/export')?{}:f.normal(route,body));await f.el('json').click();const exported=f.calls.findLast(call=>call.route.endsWith('/export'));assert.deepEqual(exported.body,{selected:['source-a'],format:'json'});assert.equal(exported.headers['X-Hub'],'1');
});
test('A stale link preview is consumed on apply failure and cannot be retried without a fresh preview',async()=>{
 const f=await fixture();f.checks()[0].checked=true;await f.checks()[0].emit('change');await f.el('link').click();f.handler(async()=>{throw Error('source changed');});await f.el('confirm').click();assert.equal(f.el('confirm').disabled,true);await f.el('confirm').click();assert.equal(f.calls.filter(call=>call.route.endsWith('/apply')).length,1);assert.ok(f.checks()[0].checked);assert.match(f.el('notice').textContent,/重新預覽/);
});
test('Opening a session waits for source/status validation and an old failed history cannot break the newly selected session',async()=>{
 const f=await fixture();let reject;f.handler((route,body)=>route.includes('history?id='+f.a.id)?new Promise((_resolve,fail)=>{reject=fail;}):f.normal(route,body));const old=f.open(0);assert.equal(f.el('send').disabled,true);await f.open(1);await f.input('New B instruction');assert.equal(f.el('send').disabled,false);reject(Error('A late history error'));await old;assert.equal(f.el('send').disabled,false);assert.equal(f.el('message').value,'New B instruction');assert.doesNotMatch(f.el('notice').textContent,/A late/);
});
test('A preparing response keeps the draft and same-session verification never clears newly edited text',async()=>{
 const f=await fixture();await f.open(0);await f.input('First instruction');let release;f.handler((route,body)=>route.endsWith('/send')?new Promise(resolve=>{release=()=>resolve({id:f.a.id,requestId:body.requestId,busy:true,phase:'preparing',verifiedSession:false,approvals:[]});}):f.normal(route,body));const pending=f.submit();await f.submit();assert.equal(f.calls.filter(call=>call.route.endsWith('/send')).length,1);await f.input('Edited next draft');release();await pending;assert.equal(f.el('message').value,'Edited next draft');
 const request=f.calls.find(call=>call.route.endsWith('/send')).body;f.runs.set(f.a.id,{id:f.a.id,requestId:request.requestId,busy:false,phase:'completed',verifiedSession:true,historyUpdated:true,approvals:[]});await f.poll();assert.equal(f.el('message').value,'Edited next draft');await f.input('First instruction');await f.poll();assert.equal(f.el('message').value,'First instruction');
});
test('A delayed send response belongs to its original session and does not erase either session’s draft',async()=>{
 const f=await fixture();await f.open(0);await f.input('A original');let release;f.handler((route,body)=>route.endsWith('/send')?new Promise(resolve=>{release=()=>resolve({id:f.a.id,requestId:body.requestId,busy:true,phase:'running',verifiedSession:true,approvals:[]});}):f.normal(route,body));const pending=f.submit();await f.input('A revised');await f.open(1);await f.input('B unsent');release();await pending;assert.equal(f.el('message').value,'B unsent');assert.equal(f.el('title').textContent,f.b.title);await f.open(0);assert.equal(f.el('message').value,'A revised');
});
test('Lost responses only retry manually with the same request ID and changed text cannot reuse that request',async()=>{
 const f=await fixture();await f.open(0);await f.input('Exact text');f.handler(async()=>{throw Error('connection lost');});await f.submit();const first=f.calls.find(call=>call.route.endsWith('/send')).body;assert.equal(f.el('message').value,'Exact text');assert.equal(f.calls.filter(call=>call.route.endsWith('/send')).length,1);await f.input('Different');assert.equal(f.el('send').disabled,true);await f.submit();assert.equal(f.calls.filter(call=>call.route.endsWith('/send')).length,1);await f.input('Exact text');await f.submit();const second=f.calls.filter(call=>call.route.endsWith('/send'))[1].body;assert.equal(second.requestId,first.requestId);assert.equal(second.text,first.text);
});
test('Queued and delayed approvals are bound to their source and never approve a newly selected session',async()=>{
 const f=await fixture();f.runs.set(f.a.id,{id:f.a.id,busy:true,phase:'approval',approvals:[{id:'approval-a',kind:'command',detail:{command:'echo <script>literal</script>'}}]});await f.open(0);const box=f.el('approvals').children[0],button=box.querySelectorAll('button')[0];assert.equal(box.children[1].textContent,'{"command":"echo <script>literal</script>"}'.replace('{"command":','{\n  "command": ').replace('"}','"\n}'));
 await f.open(1);await button.click();assert.equal(f.calls.filter(call=>call.route.endsWith('/answer')).length,0);await f.open(0);let release;f.handler((route,body)=>route.endsWith('/answer')?new Promise(resolve=>{release=()=>resolve({id:f.a.id,busy:true,phase:'running',approvals:[]});}):f.normal(route,body));const pending=f.el('approvals').children[0].querySelectorAll('button')[1].click();await f.open(1);release();await pending;assert.equal(f.el('title').textContent,f.b.title);assert.equal(f.el('approvals').children.length,0);assert.deepEqual(f.calls.find(call=>call.route.endsWith('/answer')).body,{id:f.a.id,approvalId:'approval-a',allow:false});
});
test('Native source busy changes refresh while the tool is idle; missing history cannot send and Stop targets only an owned turn',async()=>{
 const f=await fixture();await f.open(0);await f.input('Waiting draft');f.histories.get(f.a.id).active=true;const now=Date.now;Date.now=()=>now()+15000;try{await f.poll();}finally{Date.now=now;}assert.equal(f.el('send').disabled,true);assert.equal(f.el('message').value,'Waiting draft');assert.equal(f.el('stop').hidden,true);await f.el('stop').click();assert.equal(f.calls.filter(call=>call.route.endsWith('/stop')).length,0);
 f.histories.get(f.a.id).active=false;delete f.histories.get(f.a.id).signature;await f.el('history-refresh').click();assert.equal(f.el('send').disabled,true);
});
test('Removing a link while switching sessions removes only the captured reference and leaves the new conversation open',async()=>{
 const f=await fixture();await f.open(0);let release;f.handler((route,body)=>route.endsWith('/remove')?new Promise(resolve=>{release=()=>resolve({removed:true});}):f.normal(route,body));const pending=f.el('remove').click();await f.open(1);await f.input('B remains');release();await pending;assert.equal(f.el('conversation').hidden,false);assert.equal(f.el('message').value,'B remains');assert.deepEqual(f.calls.find(call=>call.route.endsWith('/remove')).body,{id:f.a.id,confirm:true});assert.ok(f.calls.every(call=>!call.route.includes('/delete')&&!call.route.includes('/import')));
});

test('Thousands of metadata rows render at most 200 recent choices; searching older sessions preserves explicit selections',async()=>{
 const f=await fixture();f.inventory.projects=[{id:'large',name:'Large group',provider:'codex',sessions:Array.from({length:3000},(_,i)=>({id:'source-'+i,title:'Session '+String(i).padStart(4,'0'),provider:'codex',hasTranscript:true,linked:false,updatedAt:new Date(1700000000000+i*1000).toISOString(),source:'Desktop',sourceKind:i===2999?'guardian':'cli',isSubagent:i===2999}))}];await f.el('refresh').click();
 assert.equal(f.checks().length,200);assert.ok(f.checks().every(input=>!input.checked));assert.match(f.el('sources').children[0].textContent,/只顯示最近或符合搜尋的 200 段會話/);const labels=f.el('sources').querySelectorAll('span');assert.ok(labels.some(label=>label.textContent.includes('輔助會話')));assert.ok(labels.some(label=>label.textContent==='Session 2999'));assert.ok(!labels.some(label=>label.textContent==='Session 0000'));
 f.checks()[0].checked=true;await f.checks()[0].emit('change');f.el('search').value='Session 0000';await f.el('search').emit('input');assert.equal(f.checks().length,1);f.checks()[0].checked=true;await f.checks()[0].emit('change');assert.equal(f.el('count').textContent,'已選 2 項');
 f.el('search').value='';await f.el('search').emit('input');assert.equal(f.checks().length,200);assert.equal(f.checks()[0].checked,true);assert.equal(f.el('count').textContent,'已選 2 項');
 for(const input of f.checks()){input.checked=true;await input.emit('change');}assert.equal(f.el('count').textContent,'已選 200 項');
 f.el('search').value='Session 0001';await f.el('search').emit('input');f.checks()[0].checked=true;await f.checks()[0].emit('change');assert.equal(f.checks()[0].checked,false);assert.equal(f.el('count').textContent,'已選 200 項');assert.match(f.el('notice').textContent,/一次最多選取 200 段會話/);
 let chosen;f.handler((route,body)=>{if(route.endsWith('/preview')){chosen=body.selected;return{token:'bounded',groups:[{name:'Chosen',sessionCount:body.selected.length}],warnings:[],blockers:[]};}return f.normal(route,body);});await f.el('link').click();assert.equal(chosen.length,200);assert.ok(chosen.includes('source-0'));assert.ok(chosen.includes('source-2999'));assert.ok(!chosen.includes('source-1'));
});
