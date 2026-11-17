import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, base, create, result, transition } from './helpers/admin-fixture.ts';

test('knowledge: create, list and history preserve exact text and immutable source versions',async()=>fixture(async f=>{
  const doc=await create(f,'  Fictional Unicode bus ??.\r\nExact text.  ');
  assert.equal(doc.latestVersion.text,'  Fictional Unicode bus ??.\r\nExact text.  ');
  assert.equal(doc.latestVersion.status,'draft');
  assert.equal(doc.latestVersion.indexingEligible,false);
  const list=await f.request(base+'?limit=1');assert.equal(list.status,200);
  assert.equal((await list.json() as {documents:unknown[]}).documents.length,1);
  const revised=await result(await f.request(base+'/'+doc.id+'/revisions','POST',{title:'Revision',text:'New fictional route.'},'editor',{'If-Match':doc.etag}),201);
  assert.equal(revised.id,doc.id);assert.equal(revised.latestVersion.versionNumber,2);
  const past=await f.request(base+'/'+doc.id+'/versions/'+doc.latestVersion.id);
  assert.equal((await past.json() as {version:{text:string}}).version.text,doc.latestVersion.text);
  assert.throws(()=>f.db.prepare('UPDATE document_versions SET content_text=? WHERE id=?').run('changed',doc.latestVersion.id),/immutable/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM indexing_metadata').get()!.n,0);
}));

test('knowledge: submit, reject, revise and approve enforce transitions and actor audit',async()=>fixture(async f=>{
  let doc=await create(f);
  const action=(name:string,body:unknown={})=>f.request(base+'/'+doc.id+'/versions/'+doc.latestVersion.id+'/'+name,'POST',body,'publisher',{'If-Match':doc.etag});
  assert.equal((await action('approve')).status,409);
  doc=await transition(f,doc,'submit');assert.equal(doc.latestVersion.status,'in_review');
  assert.equal((await action('reject')).status,400);
  doc=await transition(f,doc,'reject',{note:'Correct the timetable.'});
  assert.equal(doc.latestVersion.indexingEligible,false);
  assert.equal((await f.request(base+'/'+doc.id+'/versions/'+doc.latestVersion.id+'/submit','POST',{},'editor',{'If-Match':doc.etag})).status,409);
  doc=await result(await f.request(base+'/'+doc.id+'/revisions','POST',{title:'Corrected',text:'A corrected fictional timetable.'},'editor',{'If-Match':doc.etag}),201);
  doc=await transition(f,doc,'submit');doc=await transition(f,doc,'approve');
  assert.equal(doc.latestVersion.indexingEligible,true);
  assert.equal((await action('approve')).status,409);
  const review=f.db.prepare('SELECT * FROM version_reviews WHERE version_id=?').get(doc.latestVersion.id)!;
  assert.equal(review.reviewed_by,'publisher');assert.ok(review.reviewed_at);
  assert.equal(f.db.prepare("SELECT actor_id FROM audit_events WHERE event_type='version_submitted' LIMIT 1").get()!.actor_id,'editor');
}));

test('knowledge: authentication, independent permissions and all mutation CSRF checks',async()=>fixture(async f=>{
  assert.equal((await f.request(base,'GET',undefined,'none')).status,401);
  assert.equal((await f.request(base,'GET',undefined,'outsider')).status,403);
  assert.equal((await f.request(base,'POST',{title:'x',text:'x'},'publisher')).status,403);
  const doc=await create(f);
  for(const [suffix,role,body] of [
    ['/revisions','editor',{title:'x',text:'x'}],
    ['/versions/'+doc.latestVersion.id+'/submit','editor',{}],
    ['/versions/'+doc.latestVersion.id+'/approve','publisher',{}],
    ['/versions/'+doc.latestVersion.id+'/reject','publisher',{note:'x'}],
    ['/archive','publisher',{}],
  ] as const) assert.equal((await f.request(base+'/'+doc.id+suffix,'POST',body,role,{'If-Match':doc.etag,'X-CSRF-Token':''})).status,403);
  assert.equal((await f.request(base,'POST',{title:'x',text:'x'},'editor',{'X-CSRF-Token':''})).status,403);
  assert.equal((await f.request(base+'/'+doc.id+'/archive','POST',{},'editor',{'If-Match':doc.etag})).status,403);
  assert.equal((await f.request(base,'POST',{title:'x',text:'x'},'editor',{Origin:'https://evil.example'})).status,403);
}));

test('knowledge: guessed documents and versions enforce department and document ownership',async()=>fixture(async f=>{
  f.db.exec("INSERT INTO documents(id,department_id,source_key,source_kind) VALUES ('other-doc','other-test','other','plain_text')");
  const a=await create(f),b=await create(f);
  assert.equal((await f.request(base+'/other-doc')).status,404);
  assert.equal((await f.request(base+'/other-doc/archive','POST',{},'publisher',{'If-Match':'"other-doc:0"'})).status,404);
  assert.equal((await f.request(base+'/'+a.id+'/versions/'+b.latestVersion.id)).status,404);
  assert.equal((await f.request(base+'/'+a.id+'/versions/'+b.latestVersion.id+'/submit','POST',{},'editor',{'If-Match':a.etag})).status,404);
  assert.equal((await f.request('/api/admin/departments/other-test/documents')).status,404);
  f.db.exec("DELETE FROM membership_permissions WHERE administrator_id='editor'");
  assert.equal((await f.request(base+'/'+a.id)).status,403);
}));

test('knowledge: validation bounds request bodies, types, text, Unicode and unsupported content',async()=>fixture(async f=>{
  for(const body of [null,[],{}, {title:' ',text:'x'}, {title:'x'.repeat(161),text:'x'},
    {title:'x',text:'x'.repeat(20001)}, {title:'x',text:'a\u0000b'}, {title:'x',text:'\ud800'},
    {title:'x',text:42}, {title:'x',text:'x',departmentId:'other-test'}, {title:'x',text:'x',file:'pdf'},
    {title:'x',text:'x',fictional:'true'}]) assert.equal((await f.request(base,'POST',body)).status,400);
  assert.equal((await f.raw(base,{method:'POST',headers:{...f.headers.editor,'Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal((await f.raw(base,{method:'POST',headers:{...f.headers.editor,'Content-Type':'application/json'},body:JSON.stringify({title:'x',text:'x'.repeat(100000)})})).status,413);
  assert.equal((await f.raw(base,{method:'POST',headers:{...f.headers.editor,'Content-Type':'text/plain'},body:'x'})).status,415);
  assert.equal((await f.request(base+'?limit=101')).status,400);
  assert.equal((await create(f,'x'.repeat(10000))).latestVersion.text.length,10000);
}));

test('knowledge: ETags prevent duplicate revisions and concurrent contradictory decisions',async()=>fixture(async f=>{
  let doc=await create(f);
  const input={title:'Revision',text:'Revised fictional text.'}, path=base+'/'+doc.id+'/revisions';
  assert.equal((await f.request(path,'POST',input)).status,428);
  assert.equal((await f.request(path,'POST',input,'editor',{'If-Match':'*'})).status,400);
  const requests=await Promise.all([f.request(path,'POST',input,'editor',{'If-Match':doc.etag}),f.request(path,'POST',input,'editor',{'If-Match':doc.etag})]);
  assert.deepEqual(requests.map(r=>r.status).sort(),[201,412]);
  doc=await result(await f.request(base+'/'+doc.id));
  doc=await transition(f,doc,'submit');
  assert.equal((await f.request(path,'POST',input,'editor',{'If-Match':doc.etag})).status,409);
  const prefix=base+'/'+doc.id+'/versions/'+doc.latestVersion.id;
  const decisions=await Promise.all([f.request(prefix+'/approve','POST',{},'publisher',{'If-Match':doc.etag}),f.request(prefix+'/reject','POST',{note:'No'},'publisher',{'If-Match':doc.etag})]);
  assert.deepEqual(decisions.map(r=>r.status).sort(),[200,412]);
}));

test('knowledge: archive removes publication pointers and indexing eligibility but preserves versions',async()=>fixture(async f=>{
  let doc=await create(f);doc=await transition(f,doc,'submit');doc=await transition(f,doc,'approve');
  const original=f.db.prepare('SELECT * FROM document_versions WHERE id=?').get(doc.latestVersion.id);
  doc=await result(await f.request(base+'/'+doc.id+'/archive','POST',{},'publisher',{'If-Match':doc.etag}));
  assert.ok(doc.archivedAt);assert.equal(doc.latestVersion.indexingEligible,false);
  assert.deepEqual(f.db.prepare('SELECT * FROM document_versions WHERE id=?').get(doc.latestVersion.id),original);
  assert.equal((await f.request(base+'/'+doc.id+'/archive','POST',{},'publisher',{'If-Match':doc.etag})).status,409);
  assert.equal(f.db.prepare('SELECT count(*) n FROM eligible_document_versions').get()!.n,0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
}));

test('knowledge: failed audits roll back creation, revisions, submission and archive',async()=>fixture(async f=>{
  const doc=await create(f),before=f.db.prepare('SELECT count(*) n FROM documents').get()!.n;
  f.db.exec("CREATE TRIGGER fail_workflow BEFORE INSERT ON audit_events WHEN NEW.event_type IN ('document_created','document_revised','version_submitted','document_archived') BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await f.request(base,'POST',{title:'x',text:'x'})).status,503);
  for(const [suffix,role,body] of [['/revisions','editor',{title:'x',text:'x'}],['/versions/'+doc.latestVersion.id+'/submit','editor',{}],['/archive','publisher',{}]] as const)
    assert.equal((await f.request(base+'/'+doc.id+suffix,'POST',body,role,{'If-Match':doc.etag})).status,503);
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n,before);
  assert.deepEqual(await result(await f.request(base+'/'+doc.id)),doc);
}));

test('knowledge: baseline imports remain read-only',async()=>fixture(async f=>{
  const before=f.db.prepare("SELECT * FROM document_versions WHERE id='TRN-001:v1'").get();
  const doc=await result(await f.request(base+'/TRN-001'));
  assert.equal((await f.request(base+'/TRN-001/revisions','POST',{title:'x',text:'x'},'editor',{'If-Match':doc.etag})).status,403);
  assert.equal((await f.request(base+'/TRN-001/archive','POST',{},'publisher',{'If-Match':doc.etag})).status,403);
  assert.deepEqual(f.db.prepare("SELECT * FROM document_versions WHERE id='TRN-001:v1'").get(),before);
}));
