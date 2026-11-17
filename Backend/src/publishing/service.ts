import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/database.ts';
import { DOCUMENT_PREFIX, QUERY_PREFIX } from '../config.ts';
import { validateVector } from '../knowledge.ts';
import type { ModelClient } from '../ollama.ts';
import type { InferenceGate } from '../inference-gate.ts';
import { KnowledgeError } from '../admin/knowledge-validation.ts';
import { createKnowledgeService, documentTag } from '../admin/knowledge-service.ts';
import { chunkText, CHUNKER_VERSION, hash } from './chunks.ts';
import { artifactPath, readArtifact, type Artifact, type ModelIdentity } from './artifacts.ts';

type Actor = () => string;
export function createPublicationService(db: DatabaseSync, client: ModelClient, gate: InferenceGate, directory: string,
  model: ModelIdentity, installedModel: () => Promise<ModelIdentity>) {
  const knowledge = createKnowledgeService(db);
  function scope(actor: Actor, documentId: string, versionId: string, expected: string): Record<string, unknown> & { administrator: string } {
    const administrator = actor();
    if (!db.prepare("SELECT 1 FROM membership_permissions p JOIN administrator_accounts a ON a.id=p.administrator_id AND a.disabled=0 " +
      "JOIN department_memberships m ON m.administrator_id=p.administrator_id AND m.department_id=p.department_id " +
      "WHERE p.administrator_id=? AND p.department_id='transport' AND p.permission='publish'").get(administrator)) {
      throw new KnowledgeError(403, 'FORBIDDEN', 'Access denied.');
    }
    const row = db.prepare("SELECT d.*,v.title,v.content_text FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.department_id=d.department_id " +
      "WHERE d.id=? AND d.department_id='transport' AND v.id=?").get(documentId, versionId);
    if (!row) throw new KnowledgeError(404, 'NOT_FOUND', 'Document or version not found.');
    if (row.source_kind !== 'plain_text') throw new KnowledgeError(403, 'READ_ONLY_BASELINE', 'Imported baseline documents are read-only.');
    if (documentTag(documentId, Number(row.lock_version)) !== expected) throw new KnowledgeError(412, 'STALE_DOCUMENT', 'The document changed. Reload it before retrying.');
    if (row.archived_at !== null || !db.prepare('SELECT 1 FROM eligible_document_versions WHERE document_id=? AND version_id=? AND department_id=?')
      .get(documentId, versionId, 'transport')) throw new KnowledgeError(409, 'NOT_APPROVED', 'An active approved version is required.');
    return { ...row, administrator };
  }
  function audit(event: string, actor: string | null, documentId: string, versionId: string, indexId: string) {
    db.prepare('INSERT INTO audit_events(id,department_id,document_id,version_id,actor_type,actor_id,event_type,details_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(),'transport',documentId,versionId,actor?'administrator':'system',actor,event,JSON.stringify({indexId}));
  }
  async function verifyModel() {
    const current = await installedModel();
    if (current.name !== model.name || current.digest !== model.digest) throw new KnowledgeError(409,'MODEL_CHANGED','Embedding model changed. Restart the backend before indexing.');
  }
  return {
    async index(actor: Actor, documentId: string, versionId: string, expected: string) {
      return gate.run(async () => {
        const id = randomUUID();
        const row = transaction(db, () => {
          const row = scope(actor, documentId, versionId, expected);
          if (db.prepare("SELECT 1 FROM indexing_metadata WHERE version_id=? AND status='pending'").get(versionId)) {
            throw new KnowledgeError(409,'INDEX_PENDING','This version already has a pending index.');
          }
          db.prepare('INSERT INTO indexing_metadata(id,version_id,document_id,department_id,embedding_model,model_digest,dimensions,document_prefix,query_prefix,chunker_version) ' +
            "VALUES (?,?,?,'transport',?,?,1,?,?,?)").run(id,versionId,documentId,model.name,model.digest,DOCUMENT_PREFIX,QUERY_PREFIX,CHUNKER_VERSION);
          db.prepare('UPDATE documents SET lock_version=lock_version+1 WHERE id=?').run(documentId);
          audit('index_started',row.administrator,documentId,versionId,id);
          return row;
        });
        const claimed = documentTag(documentId, Number(row.lock_version) + 1);
        const path = artifactPath(directory, id), temporary = path + '.tmp';
        try {
          await verifyModel();
          const chunks = chunkText(versionId,String(row.content_text));
          const passages: Artifact['passages'] = [];
          let dimensions = 0;
          for (let offset=0; offset<chunks.length; offset+=4) {
            const batch = chunks.slice(offset,offset+4);
            const result = await client.embed(batch.map(c=>DOCUMENT_PREFIX+String(row.title)+'\n'+c.text));
            if (result.embeddings.length !== batch.length) throw new Error('Invalid embedding count');
            for(const [position,chunk] of batch.entries()) {
              const embedding=result.embeddings[position]!;
              validateVector(embedding,dimensions || undefined); dimensions ||= embedding.length;
              passages.push({id:chunk.id,departmentId:'transport',title:String(row.title),text:chunk.text,embedding,
                documentId,versionId,indexId:id,location:chunk.location});
            }
          }
          await verifyModel();
          const artifact: Artifact={schemaVersion:1,indexId:id,documentId,versionId,departmentId:'transport',model,dimensions,
            documentPrefix:DOCUMENT_PREFIX,queryPrefix:QUERY_PREFIX,chunkerVersion:CHUNKER_VERSION,passages};
          const bytes=JSON.stringify(artifact)+'\n';
          await mkdir(directory,{recursive:true});
          await writeFile(temporary,bytes,{encoding:'utf8',flag:'wx'});
          await rename(temporary,path);
          transaction(db,()=>{
            const current=scope(actor,documentId,versionId,claimed);
            const existing=db.prepare('SELECT * FROM knowledge_chunks WHERE version_id=? ORDER BY ordinal').all(versionId);
            if(existing.length && existing.length!==chunks.length) throw new Error('Chunk mismatch');
            for(const chunk of chunks) {
              if(existing.length) {
                const stored=existing[chunk.ordinal]!;
                if(stored.id!==chunk.id || stored.text!==chunk.text || stored.content_sha256!==chunk.hash ||
                  stored.locator_json!==JSON.stringify(chunk.location) || stored.document_id!==documentId || stored.department_id!=='transport') throw new Error('Chunk mismatch');
              } else db.prepare('INSERT INTO knowledge_chunks(id,version_id,document_id,department_id,ordinal,text,content_sha256,locator_json) VALUES (?,?,?,?,?,?,?,?)')
                .run(chunk.id,versionId,documentId,'transport',chunk.ordinal,chunk.text,chunk.hash,JSON.stringify(chunk.location));
            }
            const updated=db.prepare("UPDATE indexing_metadata SET status='ready',dimensions=?,artifact_path=?,artifact_sha256=?,chunk_count=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
              "WHERE id=? AND status='pending'").run(dimensions,'indexes/'+id+'.json',hash(bytes),chunks.length,id);
            if(updated.changes!==1) throw new Error('Index no longer pending');
            db.prepare('UPDATE documents SET lock_version=lock_version+1 WHERE id=?').run(documentId);
            audit('index_ready',current.administrator,documentId,versionId,id);
          });
        } catch(error) {
          // These generated UUID paths are confined to the index directory; never remove user paths.
          await unlink(temporary).catch(()=>{});
          await unlink(path).catch(()=>{});
          transaction(db,()=>{
            db.prepare("UPDATE indexing_metadata SET status='failed',error_message='Indexing did not complete.',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='pending'").run(id);
            db.prepare('UPDATE documents SET lock_version=lock_version+1 WHERE id=? AND lock_version=?').run(documentId,Number(row.lock_version)+1);
            audit('index_failed',row.administrator,documentId,versionId,id);
          });
          if(error instanceof KnowledgeError) throw error;
          throw new KnowledgeError(503,'INDEXING_FAILED','Indexing failed. Existing publications are unchanged; reload and retry.');
        }
        return {...knowledge.view(actor,documentId),index:{id,status:'ready'}};
      });
    },
    publish(actor: Actor, documentId: string, versionId: string, expected: string, indexId: string) {
      transaction(db,()=>{
        const row=scope(actor,documentId,versionId,expected);
        let artifact: Artifact;
        try {artifact=readArtifact(db,directory,indexId,model);}
        catch {throw new KnowledgeError(409,'INDEX_NOT_READY','A valid, compatible ready index is required.');}
        if(artifact.documentId!==documentId || artifact.versionId!==versionId) throw new KnowledgeError(404,'NOT_FOUND','Index not found for this version.');
        db.prepare("INSERT INTO publication_pointers(document_id,department_id,version_id,index_id,published_by) VALUES (?,'transport',?,?,?) " +
          "ON CONFLICT(document_id) DO UPDATE SET version_id=excluded.version_id,index_id=excluded.index_id,published_by=excluded.published_by,published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
          .run(documentId,versionId,indexId,row.administrator);
        db.prepare('UPDATE documents SET lock_version=lock_version+1 WHERE id=?').run(documentId);
        audit('version_published',row.administrator,documentId,versionId,indexId);
      });
      return knowledge.view(actor,documentId);
    },
    recoverInterrupted() {
      return transaction(db,()=>{
        const pending=db.prepare("SELECT * FROM indexing_metadata WHERE status='pending' AND department_id='transport'").all();
        for(const row of pending) {
          db.prepare("UPDATE indexing_metadata SET status='failed',error_message='Interrupted by backend restart.',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(row.id!);
          db.prepare('UPDATE documents SET lock_version=lock_version+1 WHERE id=?').run(row.document_id!);
          audit('index_interrupted',null,String(row.document_id),String(row.version_id),String(row.id));
        }
        return pending.length;
      });
    },
  };
}
export type PublicationService = ReturnType<typeof createPublicationService>;
