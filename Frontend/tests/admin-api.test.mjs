import test from 'node:test';
import assert from 'node:assert/strict';
import {request,validateText,AdminError} from '../src/admin/api.ts';
test('admin requests send cookie credentials, CSRF and exact ETag without storing session tokens',async()=>{
 const original=globalThis.fetch;
 try{
  let captured;
  globalThis.fetch=async(path,options)=>{captured={path,options};return new Response(JSON.stringify({document:{id:'example'}}),{status:200,headers:{'Content-Type':'application/json'}});};
  await request('/departments/transport/documents/example/revisions',{body:{title:'Title',text:'Text'},csrf:'csrf-secret',etag:'"example:2"'});
  assert.equal(captured.path,'/api/admin/departments/transport/documents/example/revisions');
  assert.equal(captured.options.credentials,'same-origin');
  assert.equal(captured.options.headers['X-CSRF-Token'],'csrf-secret');
  assert.equal(captured.options.headers['If-Match'],'"example:2"');
  assert.equal(captured.options.method,'POST');
  await request('/login',{body:{email:'test@example.invalid',password:'synthetic'},login:true});
  assert.equal(captured.options.headers['X-Admin-Request'],'1');
  assert.equal(captured.options.headers['X-CSRF-Token'],undefined);
  await request('/session');
  assert.equal(captured.options.method,'GET');
  assert.equal(captured.options.body,undefined);
 }finally{globalThis.fetch=original;}
});
test('stale ETags give a reload message and never automatically retry mutations',async()=>{
 const original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:'stale'}}),{status:412});};
  await assert.rejects(request('/example',{body:{}}),e=>e instanceof AdminError&&e.status===412&&e.message.includes('unsaved text is preserved'));
  assert.equal(calls,1);
  globalThis.fetch=async()=>new Response(null,{status:204});
  assert.equal(await request('/logout',{body:{},csrf:'test'}),null);
  globalThis.fetch=async()=>{throw Error('offline');};
  await assert.rejects(request('/session'),e=>e.status===0&&e.message.includes('backend'));
 }finally{globalThis.fetch=original;}
});
test('text validation bounds titles, content and control characters',()=>{
 assert.equal(validateText('Fictional timetable','Bus leaves at 09:00.'),null);
 assert.ok(validateText(' ','Text'));
 assert.ok(validateText('x'.repeat(161),'Text'));
 assert.ok(validateText('Title','x'.repeat(20001)));
 assert.ok(validateText('Title','a\u0000b'));
 assert.equal(validateText('Title','First line.\nSecond line.'),null);
});
