import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router';
import {AdminError,documentsPath,request,validateText,type Document,type Session,type Version} from './api';
import './admin.css';

export default function Admin(){
 const [session,setSession]=useState<Session|null>(null),[checking,setChecking]=useState(true),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[docs,setDocs]=useState<Document[]>([]),[offset,setOffset]=useState(0);
 const [selected,setSelected]=useState<Document|null>(null),[history,setHistory]=useState<Version[]>([]),[historyOffset,setHistoryOffset]=useState(0),[past,setPast]=useState<Version|null>(null);
 const [editor,setEditor]=useState<'create'|'revise'|null>(null),[title,setTitle]=useState(''),[text,setText]=useState(''),[fictional,setFictional]=useState(true);
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[note,setNote]=useState(''),[confirm,setConfirm]=useState<'publish'|'archive'|null>(null);
 const locked=useRef(false);
 const grants=session?.departments.filter(d=>d.department_id==='transport').map(d=>d.permission)??[];
 const edit=grants.includes('edit'),publish=grants.includes('publish'),access=edit||publish;
 async function list(page=offset){const data=await request<{documents:Document[]}>(documentsPath+'?limit=25&offset='+page);setDocs(data.documents);setOffset(page);}
 async function load(id:string,page=0){
  const [data,versions]=await Promise.all([request<{document:Document}>(documentsPath+'/'+encodeURIComponent(id)),request<{versions:Version[]}>(documentsPath+'/'+encodeURIComponent(id)+'/versions?limit=25&offset='+page)]);
  setSelected(data.document);setHistory(versions.versions);setHistoryOffset(page);setPast(null);
 }
 async function perform(job:()=>Promise<void>){
  if(locked.current)return;locked.current=true;setBusy(true);setError('');setNotice('');
  try{await job();}catch(e){if(e instanceof AdminError&&e.status===401){setSession(null);setDocs([]);setSelected(null);setEditor(null);setText('');setTitle('');setConfirm(null);}
   setError(e instanceof Error?e.message:'Request failed.');}
  finally{locked.current=false;setBusy(false);}
 }
 useEffect(()=>{let active=true;request<Session>('/session').then(s=>{if(active)setSession(s);}).catch(e=>{if(active&&!(e instanceof AdminError&&e.status===401))setError(e.message);}).finally(()=>{if(active)setChecking(false);});return()=>{active=false;};},[]);
 useEffect(()=>{if(session&&access)void perform(()=>list(0));},[session]);
 function start(mode:'create'|'revise'){setEditor(mode);setTitle(mode==='revise'?selected!.latestVersion.title:'');setText(mode==='revise'?selected!.latestVersion.text??'':'');setError('');setNotice('');setConfirm(null);}
 async function save(){
  const validation=validateText(title,text);if(validation){setError(validation);return;}
  await perform(async()=>{
   const data=await request<{document:Document}>(editor==='create'?documentsPath:documentsPath+'/'+selected!.id+'/revisions',
    {body:editor==='create'?{title,text,fictional}:{title,text},csrf:session!.csrfToken,...(editor==='revise'?{etag:selected!.etag}:{})});
   setEditor(null);setText('');setTitle('');await load(data.document.id);await list();setNotice('Draft saved.');
  });
 }
 async function action(name:string){
  if(!selected)return;
  if(name==='reject'&&!note.trim()){setError('Provide a rejection reason.');return;}
  await perform(async()=>{
   const suffix=name==='archive'?'/archive':'/versions/'+selected.latestVersion.id+'/'+name;
   const ready=selected.latestVersion.indexes.find(i=>i.status==='ready');
   const body=name==='publish'?{indexId:ready!.id}:name==='reject'?{note}:name==='approve'&&note.trim()?{note}:{};
   const data=await request<{document:Document}>(documentsPath+'/'+selected.id+suffix,{body,csrf:session!.csrfToken,etag:selected.etag});
   setConfirm(null);setNote('');await load(data.document.id);await list();setNotice(name==='index'?'Index ready. Publish explicitly to make it available to students.':name==='publish'?'Version published to Department AI.':name==='archive'?'Document archived and withdrawn from Department AI.':'Review state updated.');
  });
 }
 const doc=selected,v=doc?.latestVersion,writable=doc&&!doc.readOnly&&!doc.archivedAt;
 return <div className="admin-page"><header className="admin-top"><Link to="/">? Student workspace</Link><span>Student OS / Department administration</span>{session&&<button disabled={busy} onClick={()=>void perform(async()=>{await request('/logout',{body:{},csrf:session.csrfToken});setSession(null);setSelected(null);setDocs([]);setEditor(null);setText('');setTitle('');setNotice('Signed out.');})}>Sign out</button>}</header>
 <main><p className="eyebrow">TRANSPORT DEPARTMENT</p><h1>Knowledge administration</h1><p className="admin-muted">Review knowledge before making it available to students.</p>
 {checking?<p role="status">Checking session?</p>:!session?<form className="admin-login" onSubmit={e=>{e.preventDefault();const secret=password;setPassword('');void perform(async()=>{const s=await request<Session>('/login',{body:{email,password:secret},login:true});setSession(s);});}}>
 <h2>Administrator sign in</h2><label>Email<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="admin-primary" disabled={busy}>Sign in</button></form>:!access?<p role="alert">Your account has no Transport edit or publish permission.</p>:<>
 <div className="admin-toolbar"><span>{edit?'Edit permission':''}{edit&&publish?' ? ':''}{publish?'Publish permission':''}</span><div><button disabled={busy} onClick={()=>void perform(async()=>{const s=await request<Session>('/session');setSession(s);await list();if(doc)await load(doc.id);})}>Refresh access & data</button>{edit&&<button className="admin-primary" disabled={busy} onClick={()=>start('create')}>New text document</button>}</div></div>
 <div className="admin-grid"><section className="admin-panel" aria-label="Documents"><h2>Documents</h2>{!docs.length&&<p>No documents on this page.</p>}
 {docs.map(d=><button className={'admin-doc '+(doc?.id===d.id?'active':'')} key={d.id} disabled={busy} onClick={()=>{if(editor&&!window.confirm('Discard unsaved text?'))return;setEditor(null);setConfirm(null);setNote('');void perform(()=>load(d.id));}}><strong>{d.latestVersion.title}</strong><span>v{d.latestVersion.versionNumber} ? {d.latestVersion.status.replace('_',' ')}</span><small>{d.archivedAt?'Archived':d.publication?'Published'+(d.publication.versionId!==d.latestVersion.id?' ? earlier version':''):'Unpublished'}{d.readOnly?' ? Read-only baseline':''}</small></button>)}
 <div className="admin-buttons"><button disabled={busy||offset===0} onClick={()=>void perform(()=>list(Math.max(0,offset-25)))}>Previous</button><span>Page {offset/25+1}</span><button disabled={busy||docs.length<25} onClick={()=>void perform(()=>list(offset+25))}>Next</button></div></section>
 <section className="admin-panel" aria-label="Document workspace">
 {editor?<form onSubmit={e=>{e.preventDefault();void save();}}><h2>{editor==='create'?'New knowledge':'Create a revision'}</h2><p>Revisions preserve earlier versions. Publication requires a separate review and action.</p><label>Title<input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Content<textarea required rows={12} maxLength={20000} value={text} onChange={e=>setText(e.target.value)}/></label><small>{text.length}/20,000 characters</small>{editor==='create'&&<label className="admin-check"><input type="checkbox" checked={fictional} onChange={e=>setFictional(e.target.checked)}/>Fictional demonstration content</label>}<div className="admin-buttons"><button className="admin-primary" disabled={busy}>Save draft</button><button type="button" disabled={busy} onClick={()=>{setEditor(null);setText('');}}>Cancel</button>{doc&&<button type="button" disabled={busy} onClick={()=>void perform(async()=>{await load(doc.id);setNotice('Latest document loaded. Review its state before resubmitting your preserved text.');})}>Reload document</button>}</div></form>:doc&&v?<>
 <div className="admin-toolbar"><h2>{v.title}</h2><button disabled={busy} onClick={()=>void perform(()=>load(doc.id))}>Reload</button></div>
 <p><span className="admin-tag">{doc.archivedAt?'Archived':v.status.replace('_',' ')}</span> <span className="admin-tag">{doc.publication?'Published version: '+(doc.publication.versionId===v.id?'current':'earlier'):'Unpublished'}</span></p>
 <p className="admin-muted">Version {v.versionNumber} ? {doc.fictional?'Fictional content':'Department content'} ? {doc.sourceKind}</p>
 {doc.readOnly&&<p className="notice">Imported prototype baseline. This document is read-only.</p>}
 <div className="admin-content">{v.text}</div>{v.reviewNote&&<p>Review note: {v.reviewNote}</p>}
 {writable&&<><div className="admin-buttons">{edit&&v.status!=='in_review'&&<button disabled={busy} onClick={()=>start('revise')}>Create revision</button>}{edit&&v.status==='draft'&&<button disabled={busy} onClick={()=>void action('submit')}>Submit for review</button>}</div>
 {publish&&v.status==='in_review'&&<div className="admin-review"><label>Review note (required to reject)<textarea rows={3} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label><div className="admin-buttons"><button disabled={busy} onClick={()=>void action('approve')}>Approve version</button><button disabled={busy||!note.trim()} onClick={()=>void action('reject')}>Reject version</button></div></div>}
 {publish&&v.indexingEligible&&<div className="admin-buttons"><button disabled={busy||v.indexes.some(i=>i.status==='pending')} onClick={()=>void action('index')}>Index approved version</button>{v.indexes.some(i=>i.status==='ready')&&<button className="admin-primary" disabled={busy} onClick={()=>setConfirm('publish')}>Publish version?</button>}</div>}
 {publish&&<button disabled={busy} onClick={()=>setConfirm('archive')}>Archive document?</button>}
 {confirm&&<div className="admin-confirm" role="group" aria-label={'Confirm '+confirm}><p>{confirm==='publish'?'Make this indexed version available to students in Department AI?':'Withdraw this document from Department AI? Version history will be retained.'}</p><button disabled={busy} onClick={()=>void action(confirm)}>Confirm {confirm}</button> <button disabled={busy} onClick={()=>setConfirm(null)}>Cancel</button></div>}</>}
 {v.indexes.length>0&&<div><h3>Recent indexes</h3>{v.indexes.map(i=><p key={i.id}><span className="admin-tag">{i.status}</span> <small>{i.id}</small></p>)}</div>}
 <h3>Version history</h3>{history.map(item=><button className="admin-history" disabled={busy} key={item.id} onClick={()=>void perform(async()=>{const data=await request<{version:Version}>(documentsPath+'/'+doc.id+'/versions/'+item.id);setPast(data.version);})}>Version {item.versionNumber} ? {item.status.replace('_',' ')} ? {new Date(item.createdAt).toLocaleDateString()}</button>)}
 <div className="admin-buttons"><button disabled={busy||historyOffset===0} onClick={()=>void perform(()=>load(doc.id,Math.max(0,historyOffset-25)))}>Earlier page</button><button disabled={busy||history.length<25} onClick={()=>void perform(()=>load(doc.id,historyOffset+25))}>More versions</button></div>
 {past&&<section><h3>Version {past.versionNumber}: {past.title}</h3><p>{past.status.replace('_',' ')}</p><div className="admin-content">{past.text}</div>{past.reviewNote&&<p>Review note: {past.reviewNote}</p>}</section>}
 </>:<p>Select a document or create new knowledge.</p>}
 </section></div></>}
 <div className="admin-feedback" aria-live="polite">{busy&&<p role="status">Working? Indexing may take several minutes. Keep this page open.</p>}{notice&&<p className="admin-success" role="status">{notice}</p>}{error&&<p className="admin-error" role="alert">{error}</p>}</div>
 </main></div>;
}
