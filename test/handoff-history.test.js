'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {historyPage}=require('../lib/history-page');
test('internal handoff retains all rows in one scan while ordinary pages stay bounded',()=>{
 const full=historyPage({page:true,handoff:true}),page=historyPage({page:true});
 for(let i=0;i<5940;i++){const row={role:'user',text:String(i)};full.add(row);page.add(row);}
 assert.equal(full.rows.length,5940);assert.equal(full.rows[0].text,'0');assert.equal(full.rows.at(-1).text,'5939');assert.equal(full.finish('a'.repeat(64)).hasMore,false);
 assert.equal(page.rows.length,120);assert.equal(page.finish('a'.repeat(64)).hasMore,true);
 assert.throws(()=>historyPage({page:true,handoff:true,before:10,pageSignature:'a'.repeat(64)}),{code:'input'});
});
test('complete handoff rejects rather than truncates transcripts beyond its byte or row limits',()=>{
 const bytes=historyPage({page:true,handoff:true}),row={role:'assistant',text:'x'.repeat(8*1024*1024)};
 for(let i=0;i<4;i++)bytes.add(row);assert.throws(()=>bytes.add({text:'x'}),{code:'limit'});
 const rows=historyPage({page:true,handoff:true});for(let i=0;i<100000;i++)rows.add({text:''});assert.throws(()=>rows.add({text:''}),{code:'limit'});
});
