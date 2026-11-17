import express from 'express';
import type { PublicationService } from '../../src/publishing/service.ts';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { openDatabase } from '../../src/database/database.ts';
import { migrate } from '../../src/database/migrate.ts';
import { importTransport } from '../../src/database/import-transport.ts';
import { loadDataset } from '../../src/knowledge.ts';
import { loadAdminConfig } from '../../src/admin/config.ts';
import { createAdminSecurity } from '../../src/admin/security.ts';

export const base = '/api/admin/departments/transport/documents';
export interface Doc { id: string; etag: string; lockVersion: number; archivedAt: string | null;
  latestVersion: { id: string; status: string; title: string; text: string; versionNumber: number; indexingEligible: boolean } }
export type DB = ReturnType<typeof openDatabase>;
export async function fixture(run: (f: Fixture) => Promise<void>, setup?: (db: DB) => { publication?: PublicationService; attach?: (app: express.Express) => void; close?: () => void }) {
  const db = openDatabase(':memory:');
  try {
    migrate(db); importTransport(db, await loadDataset());
    db.exec("INSERT INTO departments(id,name) VALUES ('other-test','Test fixture only')");
    const headers: Record<string, Record<string,string>> = {};
    for (const [id, department, permissions] of [
      ['editor','transport',['edit']], ['publisher','transport',['publish']], ['outsider','other-test',['edit','publish']],
    ] as const) {
      db.prepare('INSERT INTO administrator_accounts(id,email,password_hash) VALUES (?,?,?)')
        .run(id,id+'@example.invalid','$scrypt$'+randomBytes(32).toString('hex'));
      db.prepare('INSERT INTO department_memberships VALUES (?,?)').run(department,id);
      for(const p of permissions) db.prepare('INSERT INTO membership_permissions VALUES (?,?,?)').run(department,id,p);
      const token=randomBytes(32).toString('base64url'), time=Date.now();
      db.prepare('INSERT INTO administrator_sessions VALUES (?,?,?,?,?)')
        .run(createHash('sha256').update(token).digest('hex'),id,time,time,time+3600000);
      headers[id]={Cookie:'student_os_admin_dev='+token,Origin:'http://127.0.0.1:3000',
        'X-CSRF-Token':createHmac('sha256',token).update('student-os-admin-csrf-v1').digest('hex')};
    }
    const extensions=setup?.(db);
    const app=express();
    app.use('/api/admin',createAdminSecurity(db,loadAdminConfig({}),Date.now,extensions?.publication).router);
    extensions?.attach?.(app);
    const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
    const url='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    const request: Fixture['request']=(path,method='GET',body,role='editor',extra={})=>fetch(url+path,{
      method,headers:{...headers[role],'Content-Type':'application/json',...extra},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    try { await run({db,headers,request,raw:(path,init)=>fetch(url+path,init)}); }
    finally {await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});extensions?.close?.();}
  } finally {db.close();}
}
export interface Fixture { db: DB; headers:Record<string,Record<string,string>>;
  request:(path:string,method?:string,body?:unknown,role?:string,extra?:Record<string,string>)=>Promise<Response>;
  raw:(path:string,init:RequestInit)=>Promise<Response> }
export async function result(response:Response, expected=200):Promise<Doc> {
  const text=await response.text();
  if(response.status!==expected) throw new Error('Expected '+expected+', got '+response.status+': '+text);
  const doc=(JSON.parse(text) as {document:Doc}).document;
  if(response.headers.get('etag')!==doc.etag) throw new Error('Missing matching ETag');
  return doc;
}
export async function create(f:Fixture,text='Fictional shuttle departs at 09:00.') {
  return result(await f.request(base,'POST',{title:'Fictional shuttle',text,fictional:true}),201);
}
export async function transition(f:Fixture,doc:Doc,action:string,body:unknown={}) {
  return result(await f.request(base+'/'+doc.id+'/versions/'+doc.latestVersion.id+'/'+action,'POST',body,
    action==='submit'?'editor':'publisher',{'If-Match':doc.etag}));
}
