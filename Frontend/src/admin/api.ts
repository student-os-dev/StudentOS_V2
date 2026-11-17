export interface Session { csrfToken:string; administrator:{id:string}; departments:{department_id:string;permission:string|null}[] }
export interface Version { id:string;versionNumber:number;title:string;text?:string;status:string;indexingEligible:boolean;reviewNote:string|null;createdAt:string;indexes:{id:string;status:string}[] }
export interface Document { id:string;etag:string;readOnly:boolean;fictional:boolean;archivedAt:string|null;sourceKind:string;latestVersion:Version;publication:{versionId:string;indexId:string;publishedAt:string}|null }
export class AdminError extends Error {
  status:number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
export async function request<T>(path:string,options:{body?:unknown;csrf?:string;etag?:string;login?:boolean}={}):Promise<T>{
 let response:Response;
 try {response=await fetch('/api/admin'+path,{method:options.body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
 headers:{...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(options.csrf?{'X-CSRF-Token':options.csrf}:{}),...(options.etag?{'If-Match':options.etag}:{}),...(options.login?{'X-Admin-Request':'1'}:{})},
 ...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});}
 catch {throw new AdminError(0,'Cannot reach the administrator service. Check that the backend is running.');}
 const body=response.status===204?null:await response.json().catch(()=>null);
 if(!response.ok)throw new AdminError(response.status,response.status===412?'This document changed elsewhere. Reload it, review the changes, then retry. Your unsaved text is preserved.':body?.error?.message??'The request could not be completed.');
 return body as T;
}
export const documentsPath='/departments/transport/documents';
export function validateText(title:string,text:string):string|null{
 if(!title.trim()||title.length>160||/[\r\n\t]/.test(title))return 'Enter a title of 1?160 characters on one line.';
 if(!text.trim()||text.length>20000||new TextEncoder().encode(text).length>65536)return 'Enter content of up to 20,000 characters and 64 KB.';
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(title+text))return 'Remove unsupported control characters.';
 return null;
}
