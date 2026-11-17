import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSources } from '../src/sourcePresentation.ts';
import { isSource } from '../src/services/api/ask.ts';

test('source cards group chunks by document version and deduplicate evidence',()=>{
 const source={id:'v:0',documentId:'d',versionId:'v',title:'Bus application',passage:'Collect the form.',excerpt:'Collect the form.'};
 const groups=groupSources([source,source,{...source,id:'v:1',passage:'Submit the form.',excerpt:'Submit the form.'}], 'Collect the form.');
 assert.equal(groups.length,1);assert.equal(groups[0].evidence.length,2);
 assert.equal(groups[0].excerpt,'Collect the form.');
 assert.equal(groupSources([source,{...source,versionId:'new',id:'new:0'}],'').length,2);
 assert.equal(groupSources([source,{...source,documentId:'other',id:'other:0'}],'').length,2);
});
test('source previews are bounded, relevant, and compatible with saved legacy sources',()=>{
 const legacy={id:'legacy',title:'Policy',passage:'A first sentence. The relevant condition applies.'};
 assert.equal(groupSources([legacy],'The relevant condition applies.')[0].excerpt,'The relevant condition applies.');
 const long={...legacy,passage:'Full evidence remains intact. '.repeat(50)};
 const group=groupSources([long],'')[0];
 assert.ok(group.excerpt.length<=240);assert.equal(group.evidence[0].passage,long.passage);
 assert.equal(isSource(legacy),true);assert.equal(isSource({...legacy,excerpt:42}),false);
});
