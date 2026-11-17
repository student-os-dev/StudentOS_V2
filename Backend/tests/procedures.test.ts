import test from 'node:test';
import assert from 'node:assert/strict';
import { askQuestion, evidenceSentences } from '../src/rag.ts';
import { expandProcedure, isProcedureQuestion } from '../src/procedures.ts';
import { chunkText } from '../src/publishing/chunks.ts';
import { loadConfig, DOCUMENT_PREFIX, QUERY_PREFIX } from '../src/config.ts';
import type { KnowledgeIndex, RetrievedPassage } from '../src/knowledge.ts';
import type { ModelClient } from '../src/ollama.ts';

const config = loadConfig({});
const text = 'This is a fictional college bus pass procedure.\n\n' + [
  'Collect the documents\nVisit the fictional Transport Section and collect the application form and physical pass card.',
  'Fill in the information\nComplete both documents and attach one photograph to each document, for two photographs in total.',
  'Route and fee details\nSubmit both documents to the Transport Section, where the administrator enters the route and fee.',
  'Pay the fee\nPay using the designated method and obtain a printed payment confirmation; do not discard the receipt.',
  'Accounts verification\nVisit Accounts with both documents and payment proof to obtain payment verification and a signature.',
  'Principal approval\nTake both documents to the Principal for verification and signature only after payment verification.',
  'Final Transport approval\nReturn both documents to Transport for the final signature after the required checks and approvals.'
].map((step,i) => 'Step ' + (i+1) + ': ' + step).join('\n\n') +
  '\n\nImportant: All signatures are required before this fictional process is complete.';
function makeIndex(value = text): KnowledgeIndex {
  return { schemaVersion:1,createdAt:'test',embeddingModel:'test',embeddingModelDigest:'test',
    documentPrefix:DOCUMENT_PREFIX,queryPrefix:QUERY_PREFIX,datasetHash:'published-only',dimensions:2,
    passages:chunkText('version',value).map((c,i)=>({id:c.id,text:c.text,location:c.location,
      departmentId:'transport',documentId:'document',versionId:'version',indexId:'index',
      title:'Fictional College Bus Pass Application',embedding:i === 0 ? [1,0] : [0,1]})) };
}
const metrics={totalMs:1,loadMs:0,promptEvalMs:1,tokenGenerationMs:1,promptTokens:1,outputTokens:1};
function client(mode='valid'): ModelClient {
  return {
    async embed(){return {embeddings:[[1,0]],metrics};},
    async generate(_system,user){
      const {evidence}=JSON.parse(user) as {evidence:RetrievedPassage[]};
      assert.ok(JSON.stringify(evidence).length <= config.maxContextChars);
      const p=evidence[0]!;
      const claims=mode==='empty'?[]:[{sourceId:p.id,quote:mode==='forged'?'The bus pass is free.':evidenceSentences(p.text)[0]}];
      return {content:JSON.stringify({claims}),finishReason:mode==='truncated'?'length':'stop',metrics};
    }
  };
}
const question='List all seven steps required to apply for a college bus pass.';
test('procedure: all seven steps and qualifiers survive multi-chunk expansion below retrieval threshold',async()=>{
  const index=makeIndex();
  assert.ok(index.passages.length>2);
  const answer=await askQuestion('transport',question,index,config,client());
  assert.equal(answer.available,true);
  assert.equal(answer.answer,index.passages.map(p=>p.text).join('\n\n'));
  for(let i=1;i<=7;i++) assert.match(answer.answer,new RegExp('Step '+i+':'));
  assert.match(answer.answer,/only after payment verification/);
  assert.match(answer.answer,/All signatures are required/);
  assert.equal(answer.sources.length,index.passages.length);
  for(const s of answer.sources) assert.equal(s.passage,index.passages.find(p=>p.id===s.id)!.text);
});
test('procedure: missing steps, wrong requested count, mixed versions and excessive context fail closed',async()=>{
  for(const value of [text.replace('Step 4:', 'Step 5:'),text.replace('Step 7:', 'Final:'),
    text+'\n'+('Additional fictional condition applies. '.repeat(200))]) {
    assert.equal((await askQuestion('transport',question,makeIndex(value),config,client())).available,false);
  }
  assert.equal((await askQuestion('transport',question.replace('seven','eight'),makeIndex(),config,client())).available,false);
  const index=makeIndex(), anchor={...index.passages[0]!,score:1};
  assert.equal(expandProcedure(index,[anchor,{...anchor,versionId:'different'}],question),null);
});
test('procedure: invalid model evidence, abstention and token truncation remain unavailable',async()=>{
  for(const mode of ['forged','empty','truncated'])
    assert.equal((await askQuestion('transport',question,makeIndex(),config,client(mode))).available,false);
});
test('procedure: expanded sources are rechecked for publication before returning',async()=>{
  const seen:number[]=[];
  const answer=await askQuestion('transport',question,makeIndex(),config,client(),performance.now(),p=>{
    seen.push(p.length);return p.length===1;
  });
  assert.equal(answer.available,false);assert.deepEqual(answer.sources,[]);
  assert.ok(seen.some(n=>n>2));
});
test('procedure: expansion never mixes another document, department or version',async()=>{
  const index=makeIndex();
  const foreign=index.passages.map(p=>({...p,departmentId:'foreign',text:'SECRET',embedding:[NaN]}));
  index.passages.push(...foreign,...index.passages.map(p=>({...p,versionId:'other',id:'other:'+p.id,embedding:[0,1]})));
  const answer=await askQuestion('transport',question,index,config,client());
  assert.equal(answer.available,true);assert.ok(!answer.answer.includes('SECRET'));
  assert.ok(answer.sources.every(p=>p.versionId==='version'));
  assert.equal(isProcedureQuestion('What is step 3?'),false);
  assert.equal(isProcedureQuestion('How much does the application process cost?'),false);
  assert.equal(isProcedureQuestion('How do I apply for a bus pass?'),true);
});

test('procedure: a step heading at the end of a chunk keeps its following instructions',async()=>{
  const index=makeIndex();
  const boundary=text.indexOf('\nSubmit both documents');
  assert.ok(boundary>0);
  const parts=[text.slice(0,boundary),...chunkText('tail',text.slice(boundary).trim()).map(c=>c.text)];
  let offset=0;
  index.passages=parts.map((part,i)=>{
    const start=text.indexOf(part,offset);offset=start+part.length;
    return {...makeIndex().passages[0]!,id:'version:'+i,text:part,location:{start,end:offset},embedding:i===0?[1,0]:[0,1]};
  });
  const answer=await askQuestion('transport',question,index,{...config,maxContextChars:1600},client());
  assert.equal(answer.available,true);
  assert.match(answer.answer,/Step 3: Route and fee details\s+Submit both documents/);
  assert.match(answer.answer,/Step 7:/);
});
