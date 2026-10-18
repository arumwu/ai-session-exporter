const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ClaudeSessionSource}=require('../lib/claude-session-source');
test('quota terminal event releases only completed rejected turn, not new work or unknown endings',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cantus-quota-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'session.jsonl'),s=new ClaudeSessionSource({});
 const user={type:'user',message:{role:'user',content:'request'}},quota={type:'assistant',isApiErrorMessage:true,error:'rate_limit',message:{role:'assistant',stop_reason:'stop_sequence',content:[{type:'text',text:"You've hit your session limit"}]}};
 const check=async(rows,active,event)=>{fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n'));const h=await s.history({cliRoot:root,transcript:file},{input:0,text:0,rows:0},{page:true});assert.equal(h.active,active);if(event)assert.equal(h.lifecycle.event,event);};
 await check([user,quota],false,'rate_limit');
 await check([user,quota,user],true,'user');
 await check([user,{...quota,isApiErrorMessage:false}],null);
 await check([user,{...quota,error:'other'}],null);
 await check([user,{...quota,message:{...quota.message,stop_reason:null}}],null);
 await check([user,{...quota,isSidechain:true}],true);
 await check([user,{...quota,isMeta:true}],true);
 await check([user],true);
 await check([{type:'assistant',message:{role:'assistant',stop_reason:'end_turn',content:'done'}}],false);
});
