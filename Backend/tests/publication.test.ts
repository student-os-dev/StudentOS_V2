import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fixture, base, create, result, transition, type Doc, type Fixture } from './helpers/admin-fixture.ts';
import { loadConfig, PROJECT_ROOT } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { InferenceGate } from '../src/inference-gate.ts';
import { createPublicationService, type PublicationService } from '../src/publishing/service.ts';
import { PublishedKnowledge } from '../src/publishing/published-knowledge.ts';
import { chunkText } from '../src/publishing/chunks.ts';
import { openDatabase } from '../src/database/database.ts';
import { evidenceSentences, type AskResponse } from '../src/rag.ts';
import type { ModelClient } from '../src/ollama.ts';

interface Runtime {
  directory:string; publication:PublicationService; source:PublishedKnowledge;
  onEmbed:(()=>Promise<void>)|undefined; onGenerate:(()=>Promise<void>)|undefined;
  digest:string; prompts:string[]; embedInputs:string[];
}
const model={name:'nomic-embed-text:latest',digest:'test-model-digest'};
const metrics={totalMs:1,loadMs:0,promptEvalMs:1,tokenGenerationMs:1,promptTokens:1,outputTokens:1};
async function withPublishing(run:(f:Fixture,r:Runtime)=>Promise<void>) {
  let runtime:Runtime;
  await fixture(f=>run(f,runtime),db=>{
    const root=join(PROJECT_ROOT,'.tmp');mkdirSync(root,{recursive:true});
    const directory=mkdtempSync(join(root,'publication-test-'));
    const gate=new InferenceGate();
    const client:ModelClient={
      async embed(inputs){runtime.embedInputs.push(...inputs);await runtime.onEmbed?.();return {embeddings:inputs.map(()=>[1,0]),metrics};},
      async generate(_system,user){
        runtime.prompts.push(user);await runtime.onGenerate?.();
        const evidence=(JSON.parse(user) as {evidence:{id:string;text:string}[]}).evidence[0]!;
        return {content:JSON.stringify({claims:[{sourceId:evidence.id,quote:evidenceSentences(evidence.text)[0]}]}),finishReason:'stop',metrics};
      },
    };
    const source=new PublishedKnowledge(db,directory,model);
    const publication=createPublicationService(db,client,gate,directory,model,async()=>({...model,digest:runtime.digest}));
    runtime={directory,publication,source,onEmbed:undefined,onGenerate:undefined,digest:model.digest,prompts:[],embedInputs:[]};
    return {publication,attach:app=>{app.use(createApp(loadConfig({}),source,client,gate));},
      close:()=>{
        const local=relative(root,directory);
        if(!local || local.startsWith('..') || isAbsolute(local)) throw Error('Unsafe cleanup');
        rmSync(directory,{recursive:true});
      }};
  });
}
async function approved(f:Fixture,text='The fictional shuttle leaves at 09:00.') {
  let doc=await create(f,text);doc=await transition(f,doc,'submit');return transition(f,doc,'approve');
}
const versionPath=(doc:Doc)=>base+'/'+doc.id+'/versions/'+doc.latestVersion.id;
async function build(f:Fixture,doc:Doc) {
  const response=await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag});
  const copy=await response.clone().json() as {index?:{id:string}};
  return {doc:await result(response),indexId:copy.index!.id};
}
async function publish(f:Fixture,doc:Doc,indexId:string) {
  return result(await f.request(versionPath(doc)+'/publish','POST',{indexId},'publisher',{'If-Match':doc.etag}));
}
async function ask(f:Fixture) {
  const response=await f.request('/api/ask','POST',{departmentId:'transport',question:'When does the shuttle leave?'},'none');
  assert.equal(response.status,200,await response.clone().text());
  return response.json() as Promise<AskResponse>;
}
async function live(f:Fixture,text?:string) {
  const doc=await approved(f,text);const indexed=await build(f,doc);
  return {doc:await publish(f,indexed.doc,indexed.indexId),indexId:indexed.indexId};
}
async function reload(f:Fixture,doc:Doc) {return result(await f.request(base+'/'+doc.id));}

test('publication: approval and ready indexes stay private until explicit publish; sources identify immutable versions',async()=>withPublishing(async(f,r)=>{
  let doc=await create(f);
  assert.equal((await ask(f)).available,false);
  assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,409);
  doc=await transition(f,doc,'submit');doc=await transition(f,doc,'approve');
  assert.equal((await ask(f)).available,false);
  const indexed=await build(f,doc);doc=indexed.doc;
  assert.equal((await ask(f)).available,false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM publication_pointers').get()!.n,0);
  doc=await publish(f,doc,indexed.indexId);
  const answer=await ask(f);
  assert.equal(answer.available,true);
  assert.equal(answer.answer,doc.latestVersion.text);
  assert.equal(answer.sources[0]!.documentId,doc.id);
  assert.equal(answer.sources[0]!.versionId,doc.latestVersion.id);
  assert.deepEqual(answer.sources[0]!.location,{start:0,end:doc.latestVersion.text.length});
  assert.ok(r.embedInputs.some(value=>value.startsWith('search_document: ')));
  assert.equal(f.db.prepare("SELECT actor_id FROM audit_events WHERE event_type='version_published'").get()!.actor_id,'publisher');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('publication: authentication, publish grant, CSRF, body validation and ETags protect index and publish',async()=>withPublishing(async(f)=>{
  const doc=await approved(f);
  for(const action of ['index','publish']) {
    const body=action==='index'?{}:{indexId:randomUUID()};
    assert.equal((await f.request(versionPath(doc)+'/'+action,'POST',body,'none',{'If-Match':doc.etag})).status,401);
    assert.equal((await f.request(versionPath(doc)+'/'+action,'POST',body,'editor',{'If-Match':doc.etag})).status,403);
    assert.equal((await f.request(versionPath(doc)+'/'+action,'POST',body,'outsider',{'If-Match':doc.etag})).status,403);
    assert.equal((await f.request(versionPath(doc)+'/'+action,'POST',body,'publisher',{'If-Match':doc.etag,'X-CSRF-Token':''})).status,403);
    assert.equal((await f.request(versionPath(doc)+'/'+action,'POST',body,'publisher')).status,428);
  }
  assert.equal((await f.request(versionPath(doc)+'/publish','POST',{indexId:randomUUID(),permission:'publish'},'publisher',{'If-Match':doc.etag})).status,400);
  const indexed=await build(f,doc);
  assert.equal((await f.request(versionPath(doc)+'/publish','POST',{indexId:indexed.indexId},'publisher',{'If-Match':doc.etag})).status,412);
  const another=await approved(f);
  assert.equal((await f.request(versionPath(another)+'/publish','POST',{indexId:indexed.indexId},'publisher',{'If-Match':another.etag})).status,404);
}));

test('publication: embedding failure and ready-audit failure leave no partial chunks, artifacts or publication; retry succeeds',async()=>withPublishing(async(f,r)=>{
  let doc=await approved(f);
  r.onEmbed=async()=>{throw Error('Synthetic model failure');};
  assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,503);
  assert.equal(f.db.prepare("SELECT status FROM indexing_metadata WHERE version_id=?").get(doc.latestVersion.id)!.status,'failed');
  assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_chunks WHERE version_id=?').get(doc.latestVersion.id)!.n,0);
  r.onEmbed=undefined;doc=await reload(f,doc);
  f.db.exec("CREATE TRIGGER fail_ready BEFORE INSERT ON audit_events WHEN NEW.event_type='index_ready' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,503);
  assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_chunks WHERE version_id=?').get(doc.latestVersion.id)!.n,0);
  assert.equal(readdirSync(r.directory).length,0);
  f.db.exec('DROP TRIGGER fail_ready');
  doc=await reload(f,doc);const indexed=await build(f,doc);
  const count=f.db.prepare('SELECT count(*) n FROM knowledge_chunks WHERE version_id=?').get(doc.latestVersion.id)!.n;
  const retry=await build(f,indexed.doc);
  assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_chunks WHERE version_id=?').get(doc.latestVersion.id)!.n,count);
  assert.notEqual(indexed.indexId,retry.indexId);
  assert.equal((await ask(f)).available,false);
}));

test('publication: drafts/rejections never leak, prior publication survives failed replacement, and archive removes it',async()=>withPublishing(async(f,r)=>{
  const first=await live(f,'The fictional shuttle leaves at 09:00.');
  let doc=await result(await f.request(base+'/'+first.doc.id+'/revisions','POST',{title:'Revision',text:'The fictional shuttle leaves at 10:00.'},'editor',{'If-Match':first.doc.etag}),201);
  assert.equal((await ask(f)).answer,first.doc.latestVersion.text);
  doc=await transition(f,doc,'submit');doc=await transition(f,doc,'reject',{note:'Test rejection.'});
  assert.equal((await ask(f)).answer,first.doc.latestVersion.text);
  assert.ok(r.prompts.every(prompt=>!prompt.includes('10:00')));
  doc=await result(await f.request(base+'/'+doc.id+'/revisions','POST',{title:'Approved revision',text:'The fictional shuttle leaves at 11:00.'},'editor',{'If-Match':doc.etag}),201);
  doc=await transition(f,doc,'submit');doc=await transition(f,doc,'approve');
  assert.equal((await ask(f)).answer,first.doc.latestVersion.text);
  const indexed=await build(f,doc);doc=indexed.doc;
  f.db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON audit_events WHEN NEW.event_type='version_published' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await f.request(versionPath(doc)+'/publish','POST',{indexId:indexed.indexId},'publisher',{'If-Match':doc.etag})).status,503);
  assert.equal((await ask(f)).answer,first.doc.latestVersion.text);
  assert.equal((await reload(f,doc)).etag,doc.etag);
  f.db.exec('DROP TRIGGER fail_publish');
  doc=await publish(f,doc,indexed.indexId);
  assert.equal((await ask(f)).answer,doc.latestVersion.text);
  doc=await result(await f.request(base+'/'+doc.id+'/archive','POST',{},'publisher',{'If-Match':doc.etag}));
  assert.equal((await ask(f)).available,false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM publication_pointers').get()!.n,0);
  assert.equal(f.db.prepare('SELECT content_text FROM document_versions WHERE id=?').get(first.doc.latestVersion.id)!.content_text,first.doc.latestVersion.text);
}));

test('publication: archiving during generation suppresses the in-flight answer and citations',async()=>withPublishing(async(f,r)=>{
  const {doc}=await live(f);
  r.onGenerate=async()=>{
    const response=await f.request(base+'/'+doc.id+'/archive','POST',{},'publisher',{'If-Match':doc.etag});
    assert.equal(response.status,200);
  };
  const answer=await ask(f);
  assert.equal(answer.available,false);assert.deepEqual(answer.sources,[]);
}));

test('publication: archive or permission revocation during embedding prevents a ready index',async()=>withPublishing(async(f,r)=>{
  let doc=await approved(f);
  r.onEmbed=async()=>{
    const current=await reload(f,doc);
    assert.equal((await f.request(base+'/'+doc.id+'/archive','POST',{},'publisher',{'If-Match':current.etag})).status,200);
  };
  assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,412);
  assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_chunks WHERE version_id=?').get(doc.latestVersion.id)!.n,0);
  assert.equal((await ask(f)).available,false);
  r.onEmbed=undefined;doc=await approved(f);
  r.onEmbed=async()=>{f.db.exec("DELETE FROM membership_permissions WHERE administrator_id='publisher'");};
  assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,403);
  assert.equal(f.db.prepare("SELECT count(*) n FROM indexing_metadata WHERE status='ready'").get()!.n,0);
}));

test('publication: corrupt/missing/wrong-model artifacts fail closed without JSON fallback',async()=>withPublishing(async(f,r)=>{
  const {indexId}=await live(f);
  const path=join(r.directory,indexId+'.json'),original=readFileSync(path);
  writeFileSync(path,'{}');
  assert.equal((await f.request('/api/ask','POST',{departmentId:'transport',question:'When?'},'none')).status,503);
  writeFileSync(path,original);
  assert.throws(()=>new PublishedKnowledge(f.db,r.directory,{...model,digest:'wrong'}).getIndex('transport'),/unavailable/);
  rmSync(path);
  assert.equal((await f.request('/api/ask','POST',{departmentId:'transport',question:'When?'},'none')).status,503);
}));

test('publication: persistent metadata/artifacts work after reopen and interrupted jobs recover as failed',async()=>withPublishing(async(f,r)=>{
  const {doc}=await live(f);
  const snapshot=join(r.directory,'restart.sqlite');
  await backup(f.db,snapshot);
  const reopened=openDatabase(snapshot,true);
  try {
    const source=new PublishedKnowledge(reopened,r.directory,model);
    assert.equal(source.getIndex('transport').passages[0]!.versionId,doc.latestVersion.id);
  } finally {reopened.close();}
  const id=randomUUID();
  f.db.prepare("INSERT INTO indexing_metadata(id,version_id,document_id,department_id,embedding_model,model_digest,dimensions,document_prefix,query_prefix,chunker_version) " +
    "VALUES (?,?,?,'transport',?,?,2,'search_document: ','search_query: ','complete-sentences-v1')").run(id,doc.latestVersion.id,doc.id,model.name,model.digest);
  assert.equal(r.publication.recoverInterrupted(),1);
  assert.equal(r.publication.recoverInterrupted(),0);
  assert.equal(f.db.prepare('SELECT status FROM indexing_metadata WHERE id=?').get(id)!.status,'failed');
  assert.equal((await ask(f)).answer,doc.latestVersion.text);
}));

test('publication: shared inference gate bounds concurrent chat and indexing work',async()=>withPublishing(async(f,r)=>{
  const doc=await approved(f);
  let unblock!:()=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const blocked=new Promise<void>(resolve=>{unblock=resolve;});
  r.onEmbed=async()=>{entered();await blocked;};
  const pending=f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag});
  await started;
  try {
    assert.equal((await f.request('/api/ask','POST',{departmentId:'transport',question:'When?'},'none')).status,503);
    assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,503);
  } finally {unblock();}
  assert.equal((await pending).status,200);
}));

test('publication: changed models and oversized sentences fail without truncation or publication',async()=>withPublishing(async(f,r)=>{
  let doc=await approved(f);
  r.digest='changed';
  assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,409);
  r.digest=model.digest;
  doc=await approved(f,'x'.repeat(501));
  assert.equal((await f.request(versionPath(doc)+'/index','POST',{},'publisher',{'If-Match':doc.etag})).status,422);
  assert.equal(f.db.prepare('SELECT count(*) n FROM publication_pointers').get()!.n,0);
  assert.throws(()=>chunkText('v','x'.repeat(501)),/500/);
  const text='A fee is charged only after approval. No refund is available without a receipt.';
  const chunks=chunkText('v',text);
  assert.equal(chunks.map(c=>c.text).join(''),text);
  assert.ok(chunks.every(c=>text.slice(c.location.start,c.location.end)===c.text));
}));

test('publication: seven-step answers require explicit publication and disappear after archive',async()=>withPublishing(async(f,r)=>{
  const text='This fictional bus pass procedure has seven steps.\n\n'+Array.from({length:7},(_,i)=>
    'Step '+(i+1)+': Fictional checkpoint '+(i+1)+'\nComplete checkpoint '+(i+1)+' and obtain its required signature before proceeding to the next checkpoint. Keep both fictional documents together during this required verification.').join('\n\n');
  const askSteps=async()=> {
    const response=await f.request('/api/ask','POST',{departmentId:'transport',question:'List all seven steps for the fictional bus pass procedure.'},'none');
    assert.equal(response.status,200);return response.json() as Promise<AskResponse>;
  };
  let doc=await create(f,text);
  assert.equal((await askSteps()).available,false);
  doc=await transition(f,doc,'submit');
  assert.equal((await askSteps()).available,false);
  doc=await transition(f,doc,'approve');
  assert.equal((await askSteps()).available,false);
  const indexed=await build(f,doc);
  assert.equal((await askSteps()).available,false);
  doc=await publish(f,indexed.doc,indexed.indexId);
  const answer=await askSteps();
  assert.equal(answer.available,true);
  for(let i=1;i<=7;i++) assert.match(answer.answer,new RegExp('Step '+i+':'));
  assert.ok(answer.sources.length>2);
  r.onGenerate=async()=>{
    assert.equal((await f.request(base+'/'+doc.id+'/archive','POST',{},'publisher',{'If-Match':doc.etag})).status,200);
  };
  assert.equal((await askSteps()).available,false);
  r.onGenerate=undefined;
  assert.equal((await askSteps()).available,false);
}));
