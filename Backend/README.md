# Student OS V2 — Phase 1

A minimal Node.js, TypeScript, and Express backend for a Department Knowledge Assistant. All ten passages describe the **entirely fictional Cedarbridge Institute Transport Department**. They do not represent a real institution, transport service, price, schedule, or policy.

The student endpoint is **POST /api/ask**. Administrator authentication, Transport knowledge management, indexing and explicit publication are under **/api/admin**. Normal server answers use only approved, indexed and published SQLite knowledge with immutable JSON artifacts. The original ten-passage JSON corpus remains a legacy fixture, not a live fallback. See the Transport knowledge management and live publication section below for the current workflow. This backend contains no frontend, additional department dataset, external database server, container, or hosted service.

## Model compatibility on this laptop

The existing Ollama server at http://localhost:11434 reports that the installed qwen3:4b is **Qwen3-4B-Thinking-2507**, with thinking.values containing only true. A direct chat request with think:false still produced reasoning.

With your approval, this prototype uses **GENERATION_MODE=qwen3-prefill**: a raw /api/generate request supplies Qwen's role template with an already-closed, empty thinking block, sets think:false, and constrains the output to evidence sentences through a JSON schema. All 18 live acceptance cases passed with this workaround and no returned thinking text.

**This is a tested prompt workaround, not native non-thinking support.** It does not establish anything about the model's internal computation. If a response contains thinking, the adapter rejects it. No model was downloaded, retagged, edited, or replaced, and no Ollama server setting was changed. GENERATION_MODE=chat is available for an installed model that supports think:false; it explicitly rejects this installed thinking-only variant.

References: [Ollama generation API](https://docs.ollama.com/api/generate), [thinking controls](https://docs.ollama.com/capabilities/thinking), [Qwen model card](https://huggingface.co/Qwen/Qwen3-4B-Thinking-2507).

## Files

~~~text
D:\StudentOS_V2\Backend\
├── package.json
├── package-lock.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── data\
│   ├── transport.json
│   └── embeddings.json          # Generated; ignored by Git
├── scripts\
│   └── index-knowledge.ts
├── src\
│   ├── config.ts
│   ├── ollama.ts
│   ├── knowledge.ts
│   ├── rag.ts
│   ├── app.ts
│   └── server.ts
└── tests\
    ├── rag.test.ts
    └── api.test.ts
~~~

Generated working folders are node_modules, dist, .npm-cache, and .tmp. The live test transcript is .tmp/live-tests.txt. All project files, build output, dependency files, npm cache, and test artifacts are kept inside D:\StudentOS_V2\Backend. The existing Ollama process manages its own normal runtime state.

The sole direct runtime dependency is **express 5.3.0**. Development dependencies are **typescript 5.9.3**, **@types/node 24.19.2**, and **@types/express 5.0.6**. Their transitive dependencies are recorded in package-lock.json. Node 24 provides fetch, environment-file loading, TypeScript stripping for development, and the test runner; no Ollama SDK, dotenv, tsx, or additional testing package is needed.

## PowerShell setup

Use the existing Node.js 24+ and Ollama installation. Both qwen3:4b and nomic-embed-text must already appear in ollama list. These commands do not install or download models.

~~~powershell
Set-Location 'D:\StudentOS_V2\Backend'
node --version
ollama list
Invoke-RestMethod 'http://localhost:11434/api/version'

# Keep npm's working files in this project.
$env:npm_config_cache = Join-Path (Get-Location) '.npm-cache'
$taskTemp = Join-Path (Get-Location) '.tmp'
New-Item -ItemType Directory -Path $taskTemp -Force | Out-Null
$env:TEMP = $taskTemp
$env:TMP = $taskTemp

npm.cmd ci --ignore-scripts --no-audit --no-fund
Copy-Item '.env.example' '.env'
npm.cmd run index
npm.cmd run db:import-transport
npm.cmd run build
npm.cmd start
~~~

If an .env already exists, edit it instead of overwriting it. The implementation also works with its defaults when .env is absent; Node prints a harmless notice.

For development, use npm.cmd run dev instead of npm.cmd start. Stop with Ctrl+C. The default listener is http://127.0.0.1:3000. No background server is installed.

For the legacy JSON prototype/test fixture only: after editing transport.json or changing the embedding model, run npm.cmd run index and restart the backend. Indexing embeds four passages per batch, writes a temporary file, and renames it to data/embeddings.json after validation. Startup checks the dataset fingerprint, exact stored passages, embedding model name and digest, prefix scheme, and vector dimensions. A missing or stale index produces an actionable startup error rather than silently re-embedding.

## Historical prototype API examples

These examples describe the original fixture. The current server requires corresponding content to be explicitly approved, indexed and published first; importing the JSON baseline alone does not make it live.

~~~powershell
$uri = 'http://127.0.0.1:3000/api/ask'

# Supported fact: Form T-02 and INR 100, from TRN-007.
$body = @{
    departmentId = 'transport'
    question = 'How do I replace a lost bus pass?'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body |
    ConvertTo-Json -Depth 10

# Two relevant passages: Route A 07:40, Route B 07:30.
$body = @{
    departmentId = 'transport'
    question = 'At what times do Route A and Route B depart in the morning?'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body |
    ConvertTo-Json -Depth 10

# Related evidence exists, but no refund policy is provided.
$body = @{
    departmentId = 'transport'
    question = 'What is the refund policy for the INR 1,800 semester bus pass?'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body |
    ConvertTo-Json -Depth 10

# Unknown department: unavailable, empty sources, zero Ollama calls.
$body = @{
    departmentId = 'unknown'
    question = 'What is the pass fee?'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body |
    ConvertTo-Json -Depth 10

# Invalid request: HTTP 400.
try {
    Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body '{}'
} catch {
    $_.ErrorDetails.Message
}
~~~

Successful HTTP responses contain:

- available: whether a supported answer was produced.
- answer: one or two complete evidence sentences, or "This information is unavailable in the provided department knowledge base."
- sources: only the cited retrieved passages, each with id, title, and passage.
- timings: measured embeddingMs, retrievalMs, generationMs, and totalMs.
- ollama: separately reported embedding and generation metrics, including model loading, prompt evaluation, token generation, and token counts when available.

All durations are in milliseconds. timings measures application wall time using a monotonic clock. totalMs includes request processing and validation but excludes final response transfer to the caller. Ollama durations are converted from nanoseconds; these overlap with the wall-clock stages and must not be added to them. Unreported Ollama fields are null, not invented zeros. Skipped stages are zero with null Ollama metrics.

HTTP 200 with available:false represents missing or rejected evidence. HTTP 400/413/415 represents invalid input. HTTP 503 represents a busy backend, an unreachable server, or a missing model; HTTP 504 represents an Ollama timeout; HTTP 502 represents a failed or invalid Ollama response. Errors include an error.code and message. There is no automatic retry or model download.

## Retrieval and factual support

1. Check that the requested department exists. An unknown department causes no model calls.
2. Embed only the question with the search_query: prefix. Indexed passages use search_document:, as recommended by the [Nomic model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5).
3. Filter passages by department **before** computing cosine similarity. Apply the configurable threshold, rank scores, and select at most two complete passages.
4. Limit the serialized evidence, including IDs and titles, to 1,200 characters. Never truncate a fact to fit the budget. No reranker, lexical retrieval, conversation history, or answer cache is used.
5. Ask Qwen for at most two sourceId/quote claims. The schema permits only retrieved IDs and complete evidence sentences. Missing requested facts should produce an empty claims array.
6. Independently verify every claim against a **complete sentence** in its cited retrieved passage. Return only those verified sentences. Altered amounts, dates, negation, qualifications, extra claims, and uncited free text are rejected. Valid IDs alone are insufficient.

If no passage passes retrieval, generation is skipped. Empty, malformed, unsupported, or token-truncated model output returns unavailable with empty references. If a multipart question lacks a requested fact, the prompt instructs the model to abstain from the whole question.

The threshold was calibrated on ten answerable questions (top similarities 0.7355–0.8432) and unsupported questions. Weather and scholarship questions scored 0.5379 and 0.5982. The initial threshold is 0.70. Related missing information can still score higher, so live tests also verify model abstention with relevant passages present.

## Configuration

Edit .env or set process environment variables. Defaults are intentionally small for an 8 GB RAM laptop with a GTX 1650 4 GB GPU.

| Setting | Default | Purpose |
|---|---|---|
| HOST / PORT | 127.0.0.1 / 3000 | Local Express listener |
| OLLAMA_BASE_URL | http://localhost:11434 | Existing Ollama server |
| ANSWER_MODEL | qwen3:4b | Already-installed answer model |
| GENERATION_MODE | qwen3-prefill | Approved workaround; chat requires compatible non-thinking support |
| EMBEDDING_MODEL | nomic-embed-text | Already-installed embedding model |
| RELEVANCE_THRESHOLD | 0.70 | Minimum cosine similarity, from 0 to 1 |
| TOP_K | 2 | Maximum passages, from 1 to 2 |
| MAX_CONTEXT_CHARS | 1200 | Serialized evidence limit, from 200 to 1600 |
| NUM_CTX | 2048 | Model context window |
| MAX_OUTPUT_TOKENS | 160 | Maximum generated tokens, including JSON |
| TEMPERATURE | 0 | Deterministic starting setting |
| NUM_THREAD / NUM_BATCH | 4 / 128 | Bound CPU and prompt-batch use |
| KEEP_ALIVE | 2m | Answer model residency |
| EMBED_NUM_GPU | 0 | CPU embeddings reserve GPU memory for Qwen |
| EMBED_KEEP_ALIVE | 2m | Embedding model residency |
| OLLAMA_TIMEOUT_MS | 120000 | Per Ollama request timeout |
| MAX_QUESTION_CHARS | 500 | Input limit, with a 4 KB JSON body cap |

Only one application request is processed at a time. A concurrent request receives HTTP 503 BUSY and Retry-After: 2; it is not queued. Embedding and generation run sequentially. GPU placement for Qwen remains under the existing Ollama scheduler. Configuration is per request or per application process; no system environment variables or Ollama installation files are changed.

Keeping models loaded avoids repeated cold-start costs but consumes memory. Lower keep-alive durations release them sooner at the cost of load time. Threshold tuning can change recall, and increasing the context or output limits increases memory use or latency.

## Verification and actual timings

Measured on **2026-11-16, Asia/Kolkata**, with Node 24.14.1, Ollama 0.40.16, approximately 7.68 GiB usable system RAM, and a GTX 1650 with 4,096 MiB VRAM.

- TypeScript build: passed.
- Automated tests: **27 passed**, zero failures; the opt-in live suite is skipped during the ordinary test run.
- Live acceptance suite: **18 HTTP cases passed**, zero failures (19 test-runner entries including the parent).
- Indexing: **1,589.236 ms** for ten passages and 768 dimensions. Three embedding batches took 1,082.679 ms, 265.502 ms, and 138.060 ms.
- Live cases check all ten source topics, two-source retrieval, missing telephone information, live bus status, missing refunds, a partially answerable question, an unrelated question, unknown-department isolation, and a fabricated-price prompt.

Representative actual application timings:

| Live request | Embedding ms | Retrieval ms | Generation ms | Total ms |
|---|---:|---:|---:|---:|
| Office, first request after unload | 579.742 | 1.327 | 13229.561 | 13820.223 |
| Route A, model loaded | 99.913 | 2.392 | 3131.268 | 3234.098 |
| Semester pass fee, model loaded | 40.155 | 0.072 | 2832.247 | 2872.899 |
| Lost pass, model loaded | 44.629 | 0.077 | 3368.085 | 3413.203 |
| Two route passages | 44.537 | 0.244 | 7122.730 | 7167.837 |
| Missing refund policy | 54.411 | 0.055 | 766.854 | 821.473 |
| Unrelated weather question | 33.230 | 0.048 | 0 | 33.522 |
| Unknown department | 0 | 0.001 | 0 | 0.193 |

For the first request, Ollama reported 9,330.788 ms of answer-model loading, 1,735.143 ms of prompt evaluation, and 2,124.475 ms of token generation. The measured external HTTP round trip was 13,835.090 ms. Supported single-passage requests after loading took 2.873–3.413 seconds in this run. These are observations, not latency guarantees.

Run deterministic checks:

~~~powershell
Set-Location 'D:\StudentOS_V2\Backend'
$env:npm_config_cache = Join-Path (Get-Location) '.npm-cache'
npm.cmd run build
npm.cmd test
~~~

Run live tests against the existing Ollama server (the test creates and closes its own local Express listener; a separate backend is not required):

~~~powershell
$env:LIVE_OLLAMA = '1'
try {
    node --env-file-if-exists=.env --test --test-name-pattern='live Ollama' tests/api.test.ts
} finally {
    Remove-Item Env:LIVE_OLLAMA -ErrorAction SilentlyContinue
}
~~~

The live suite prints one LIVE_MEASUREMENT JSON record per case. It verifies actual answer text, known expected values, full sentence support, and abstention, rather than merely checking that citations exist.

## Prototype limits

- The installed model needs the approved prompt workaround described above; native thinking-off support was not available.
- Answers intentionally copy up to two complete evidence sentences. They are concise and auditable, but do not offer free-form paraphrasing.
- Sentence verification prevents invented returned facts. It does **not** prove that a selected sentence answers every possible phrasing correctly. Retrieval and semantic abstention can still make mistakes; the live cases are a bounded evaluation.
- The tiny fictional corpus provides no real-time status or real institutional knowledge. A conservative threshold can reject answerable paraphrases.
- Data or model changes require explicit reindexing and a server restart. The JSON index is intended for a small prototype.
- Hardware load and model residency affect latency. No frontend or network deployment is provided by this backend. Administrator authentication is documented in Step 11 below.



## Step 10: local SQLite database foundation

This database is a separate foundation for future department administration.
At Step 10, the running endpoint used transport.json and embeddings.json. The current server uses the publication workflow documented below.
Initializing/importing this database does not publish knowledge, call Ollama,
rebuild embeddings, or alter chat behavior.

The implementation uses Node's built-in node:sqlite module: **no dependency was
added**. It was checked on Node 24.14.1, which emits an ExperimentalWarning for
SQLite. Use the installed Node 24 runtime; recheck compatibility before a Node
upgrade. See the [Node SQLite documentation](https://nodejs.org/api/sqlite.html).

### Initialize, import, and inspect (PowerShell)

~~~powershell
Set-Location 'D:\StudentOS_V2\Backend'
$env:npm_config_cache = Join-Path (Get-Location) '.npm-cache'

# Creates data/student-os.sqlite and applies pending numbered migrations.
npm.cmd run db:migrate

# Also applies pending migrations, then imports the ten baseline passages.
npm.cmd run db:import-transport

# Safe to repeat: no duplicate versions, chunks, accounts, or audit events.
npm.cmd run db:migrate
npm.cmd run db:import-transport

# Read-only; prints migration history, integrity checks, counts and version states.
# Fails rather than creating a missing database.
npm.cmd run db:inspect

npm.cmd run test:database
npm.cmd test
npm.cmd run build

# Compiled tools work after the build, from the same project directory.
node dist/scripts/inspect-database.js
~~~

The fixed database location is D:\StudentOS_V2\Backend\data\student-os.sqlite, independent
of the shell's working directory. The connection helper explicitly enables
foreign keys and recursive triggers, with a five-second busy timeout. It uses
SQLite's ordinary rollback journal; no server, WAL service, ORM or vector
database is required. Database files and journal/WAL/SHM sidecars are ignored by
Git and are never placed in the frontend public directory.

For manual inspection in a SQLite viewer, open that file read-only. Useful SQL:

~~~sql
SELECT * FROM schema_migrations ORDER BY version;
SELECT id, name FROM departments;
SELECT v.id, v.document_id, v.version_number, v.title, r.status
FROM document_versions v JOIN version_reviews r ON r.version_id = v.id
ORDER BY v.document_id, v.version_number;
SELECT id, version_id, text, locator_json FROM knowledge_chunks ORDER BY id;
PRAGMA integrity_check;
PRAGMA foreign_key_check;
~~~

Avoid editing records directly. Future application connections must use
openDatabase() so foreign keys and recursive-trigger protections stay enabled.

### Schema and publication boundary

| Tables | Purpose |
|---|---|
| departments | Department identity |
| administrator_accounts | Account metadata and encoded password-hash field; no accounts seeded |
| department_memberships, membership_permissions | Department-scoped edit/review/publish/archive grants; no grants seeded |
| documents | Stable document identity, source key/type, fictional flag, optional archive timestamp |
| document_versions | Immutable numbered content snapshots, title, SHA-256, original-file metadata and author |
| version_reviews | Mutable draft/in_review/approved/rejected metadata, separate from immutable content |
| knowledge_chunks | Immutable version-linked passages with stable IDs, hash and JSON source location |
| indexing_metadata | Version, embedding model/digest, dimensions, prefixes, chunker version, pending/ready/failed state, future artifact path/hash |
| publication_pointers | One approved, ready, unarchived version/index pair per published document |
| audit_events | Append-only actor, event, department, document/version, timestamp and JSON details |
| schema_migrations | Applied version, name, SQL checksum and timestamp |

Composite foreign keys prevent cross-document and cross-department version,
chunk, index and publication references. Uniqueness constraints prevent duplicate
source keys within a department, version numbers within a document, chunk
ordinals within a version, and permission grants.

Triggers reject updates/deletes of version content, chunks and audit events,
including INSERT OR REPLACE through the configured connection. A content edit
will require a new version snapshot, even for a draft. Review status can change
independently. Publishing requires an approved version and ready index.
Unpublish before archiving or changing a published review; published index
metadata cannot be changed. These are data-integrity guards, not authentication.
Step 10 did not build admin sessions or permission-enforcing APIs. Step 11 adds
these authentication foundations below. Publication services, document-management
APIs, ingestion workers and file-upload handling remain unimplemented.

The password_hash column accepts only an encoded Argon2id/scrypt-shaped value,
not an ordinary plaintext password. This is a format guard, not cryptographic
verification. Future authentication must generate/validate real hashes and enforce
membership permissions. No passwords or default credentials are generated.
SQLite file ownership is a local trust boundary: someone with direct file access
can change the schema; triggers do not make the database tamper-proof.

### Baseline import behavior

Each original passage becomes one document (TRN-001 through TRN-010), version
TRN-001:v1 through TRN-010:v1, and one chunk retaining the original TRN identifier.
Titles and text are copied exactly, without normalization. All are explicitly
fictional. Each chunk records transport.json and its original passage ID; each
version records a content hash. A system audit event records the dataset hash.

Expected first import: 1 department, 10 documents, 10 versions, 10 draft reviews,
10 chunks, 10 audit events, and zero administrator accounts, memberships,
permissions, indexing records or publication pointers. No existing embedding
file is imported, copied or replaced. Draft import is not a claim of human
approval.

The import is one transaction. Repeating it verifies existing content and
provenance and skips matching records; timestamps and audit entries stay
unchanged. Conflicting text, IDs or incomplete baseline records fail the whole
import instead of overwriting history or partially inserting the other passages.
Later versions, review states and archive states are preserved by a repeat import.

### Migrations, backups and tests

The migration runner applies pending migrations and records their checksums in
one transaction under BEGIN IMMEDIATE. A failure rolls back pending schema
changes and history together. Repeat runs are no-ops. Changed applied migrations,
gaps, and histories newer than the code are rejected. Add a new numbered module
under src/database/migrations and register it in migrate.ts; never edit an applied
migration. SQL is compiled with TypeScript, so production scripts need no separate
SQL-file copy step. Migrations are forward-only; take a backup before upgrades.

For this unused-by-server database, close database tools/connections before
copying data/student-os.sqlite to a dated backup inside the backend. Do not copy
an actively written database file by itself; use SQLite's backup facilities when
online backups become necessary. Future backups must also include referenced
immutable index artifacts and original documents.

The focused tests use in-memory databases and a temporary file under .tmp, never
the working database. They cover migration repetition/history drift/rollback,
persistence, read-only inspection, exact import/idempotency/conflict rollback,
foreign keys, uniqueness, password-format rejection, immutable content/audits,
and publication integrity. Existing RAG/API tests remain unchanged. Live Ollama
tests remain opt-in and are not required for this database-only milestone.

New source files:
- src/database/database.ts
- src/database/migrate.ts
- src/database/migrations/001-foundation.ts
- src/database/import-transport.ts
- scripts/migrate-database.ts
- scripts/import-transport.ts
- scripts/inspect-database.ts
- tests/database.test.ts


## Step 11: administrator authentication and authorization

Authentication is available. Transport backend document management and publication are now implemented below; admin UI is not.
The frontend and existing /api/ask, RAG, Ollama settings and knowledge files are
unchanged. No real administrator was provisioned during implementation.

| Endpoint | Requirements / response |
|---|---|
| POST /api/admin/login | JSON email/password, allowed Origin, X-Admin-Request: 1; sets session cookie |
| GET /api/admin/session | Valid cookie; returns account ID, current department grants, absolute expiry and CSRF token |
| POST /api/admin/logout | Valid cookie, allowed Origin and X-CSRF-Token; revokes session and clears cookie |

### Upgrade and provision locally

~~~powershell
Set-Location 'D:\StudentOS_V2\Backend'
$env:npm_config_cache = Join-Path (Get-Location) '.npm-cache'
npm.cmd run db:migrate
npm.cmd run db:inspect
npm.cmd run build
npm.cmd start
~~~

Migration 2 adds administrator_sessions and login_rate_limits and permits
department-neutral authentication events in audit_events. It preserves existing
audit rows and append-only triggers. Startup requires the latest registered migration; it does not
silently migrate or repair the database. Restart existing processes to load the
new code.

Provision an administrator **only after explicit approval**. This local operator
command requires an interactive terminal and an existing department:

~~~powershell
# Run only when authorized to create this particular administrator.
$adminEmail = Read-Host 'Administrator email'
npm.cmd run admin:provision -- --email $adminEmail --department transport --permissions edit
~~~

The command prompts twice for a password with terminal echo disabled. Passwords
cannot be passed as arguments, environment variables, files or piped input.
Use --permissions edit,publish only when both grants are authorized. Additional
explicit permissions are review and archive. No permission implies another.
The command creates the account and grants atomically and refuses to overwrite
an existing account. It does not reset passwords or modify existing memberships.

Passwords must contain 15?128 characters (at most 512 UTF-8 bytes). Spaces and
Unicode are preserved. Node-native scrypt uses a random 16-byte salt, a 32-byte
derived key, N=32768, r=8, p=3, and a 64 MiB allocation limit. This 32 MiB profile
is one of the profiles in [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
Verification uses constant-time comparison. Unknown accounts, disabled accounts
and malformed/unsupported hashes still perform the same expensive hashing work.
Only the encoded salt/hash is stored. No dependency was added.

### PowerShell login test

Use this only after an approved account has been provisioned. The password is
prompted securely, not written as a literal into shell history. Keep the cookie
container and CSRF token in process memory; do not export or print them.

~~~powershell
$base = 'http://127.0.0.1:3000'
$credentials = Get-Credential -Message 'Student OS administrator sign-in'
$browserSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginHeaders = @{ Origin = $base; 'X-Admin-Request' = '1' }
try {
    $loginBody = @{
        email = $credentials.UserName
        password = $credentials.GetNetworkCredential().Password
    } | ConvertTo-Json -Compress
    $loginRequest = @{
        Uri = "$base/api/admin/login"
        Method = 'Post'
        ContentType = 'application/json'
        Headers = $loginHeaders
        WebSession = $browserSession
        Body = $loginBody
    }
    $login = Invoke-RestMethod @loginRequest
} finally {
    Remove-Variable loginBody, loginRequest, credentials -ErrorAction SilentlyContinue
}

$current = Invoke-RestMethod "$base/api/admin/session" -WebSession $browserSession
$current | Select-Object authenticated, administrator, expiresAt, departments

# Missing/incorrect X-CSRF-Token returns 403 and does not log out.
$logoutHeaders = @{ Origin = $base; 'X-CSRF-Token' = $current.csrfToken }
Invoke-RestMethod "$base/api/admin/logout" -Method Post -Headers $logoutHeaders -WebSession $browserSession

# Now expect HTTP 401.
try {
    Invoke-RestMethod "$base/api/admin/session" -WebSession $browserSession
} catch {
    Write-Host 'Session is no longer authenticated.'
}
Remove-Variable login, current, logoutHeaders, browserSession -ErrorAction SilentlyContinue
~~~

### Session and CSRF policy

Session cookies contain random 256-bit opaque tokens. SQLite stores only SHA-256
token hashes and timestamps; there are no JWTs or localStorage tokens. Cookies
are host-only, HttpOnly and SameSite=Strict. Sessions expire after 30 minutes idle
or 8 hours absolute. Login rotates both the session and session-bound CSRF token,
revoking earlier sessions for that account (one active session per account).
Logout deletes the server record. Updating password_hash or disabled revokes
sessions through a database trigger. Account state and grants are checked live.

All authenticated mutations require an exact allowed Origin and a constant-time
checked, session-bound X-CSRF-Token. Login separately requires JSON, exact Origin
and X-Admin-Request: 1 to protect against login CSRF. No CORS access is enabled.
Responses use Cache-Control: no-store. Tokens are never accepted in URLs.
The CSRF token is intentionally returned to authenticated clients; it is not a
session credential. Keep it in memory, never in URLs or logs.

| Configuration | Rule |
|---|---|
| ADMIN_ORIGINS | Defaults to http://127.0.0.1:3000,http://localhost:3000; exact origins only |
| ADMIN_TRUST_LOOPBACK_PROXY | Defaults to 0; set 1 only for an explicitly trusted local HTTPS reverse proxy |
| NODE_ENV=production | Requires explicit HTTPS ADMIN_ORIGINS; HTTP origins are rejected |

HTTP development requires loopback HOST, origins and incoming connections.
The student_os_admin_dev cookie uses Path=/api/admin and omits Secure for local
HTTP. Do not expose this mode over a network. A future proxied development client
must have its exact origin added explicitly; this step does not change Vite.

HTTPS mode uses __Host-student_os_admin with Secure, HttpOnly, SameSite=Strict,
Path=/ and no Domain. Requests must arrive via HTTPS, or from an explicitly
trusted loopback proxy with X-Forwarded-Proto: https. Production example:
NODE_ENV=production, ADMIN_ORIGINS=https://your-admin-host, and
ADMIN_TRUST_LOOPBACK_PROXY=1 only if the TLS proxy actually runs locally.
The proxy must terminate TLS, overwrite forwarded headers and block public direct
access to the backend. This step does not install TLS infrastructure.
Global Express trust proxy is unchanged. Login rate limits never trust
X-Forwarded-For: behind a local proxy, clients share its conservative IP limit.

See [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### Authorization, audit and rate limits

requirePermission accepts a permission fixed in server code and a department
resolver. Resolve existing resources from their stored document department.
A route department ID is only a selector; a matching current DB membership and
explicit grant are always required. Never use a browser-supplied permission as
the required permission. New mutation routes must use authentication, CSRF and
the department-permission guard together. Transport production routes now use these guards; test-only probes also verify the guards in isolation.

Login limits: 5 attempts per normalized email and 30 per socket IP per 15-minute
fixed window, including successful attempts and unknown accounts. Counters
persist in SQLite and expire on later login attempts; successful login does not
reset them. Counter keys are hashed, not logged (hashing is not encryption).
One password verification runs at a time to bound memory; simultaneous attempts
receive 429. Expired sessions are removed on access or subsequent login.

Unknown email, wrong password, disabled account and unsupported hash return the
same generic 401. Missing sessions return 401; denied permissions, origins and
CSRF return 403; throttling returns 429 plus Retry-After; storage/audit failures
return generic 503. API responses never return passwords, password hashes or
session-token body fields.

Audit events cover provisioning, login success/failure/throttling, rejected and
expired sessions, logout, Origin/CSRF rejection and permission grants/denials.
Only fixed event/permission names and server-resolved IDs are recorded. Passwords,
cookies, session hashes, tokens, bodies and raw headers are never logged.
Unknown-actor authentication events use a department-neutral system event.
Provisioning/login/logout commit audit events atomically with their state changes.
Audit or database errors deny access; they are not ignored. Automatic audit
retention/deletion is not implemented.

This remains a single-machine prototype with a local operator/file-access trust
boundary. MFA, password recovery, account-management APIs/UI, document management,
identity providers and distributed limits are outside this step. Node 24.14.1's
existing experimental SQLite warning still applies.

### Verification

~~~powershell
npm.cmd run test:admin
npm.cmd test
npm.cmd run build
~~~

Tests use isolated in-memory databases and synthetic accounts, never the working
administrator database or Ollama. Coverage includes migration preservation,
hashing/salts, provisioning, login/logout, cookies, rotation, expiry, CSRF, rate
limits, disabled accounts, forged headers/tokens, edit/publish separation,
cross-department resource checks, fail-closed audit/storage errors, HTTPS policy
and anonymous chat compatibility.


## Transport knowledge management and live publication

The normal server now uses **published SQLite knowledge only** for POST /api/ask.
The original transport.json and embeddings.json remain intact as legacy fixtures;
they are not a runtime fallback. Imported baseline documents remain read-only
drafts and are not automatically approved or published. With no publications,
Department AI correctly returns unavailable. No administrator is automatically
created by migration or startup.

The current repository has Backend/ and Frontend/ beneath D:\StudentOS_V2.
Run backend commands inside D:\StudentOS_V2\Backend. The frontend is unchanged.

### Initialize or upgrade

~~~powershell
Set-Location 'D:\StudentOS_V2\Backend'
$env:npm_config_cache = Join-Path (Get-Location) '.npm-cache'
npm.cmd run db:migrate
npm.cmd run db:inspect
npm.cmd test
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
npm.cmd start
~~~

Migration 3 was already present in the interrupted implementation. It adds the
document concurrency counter and eligible_document_versions view, and restricts
index metadata to eligible approved versions. No applied migration was rewritten.
Run migrations before starting the server. The existing Node/Ollama models and
configuration are reused; no models or dependencies are downloaded.

### Routes and permissions

All paths below start with /api/admin/departments/transport.
All mutations require an authenticated session, allowed Origin, CSRF header and
application/json. Indexing and publication also require publish permission.

| Method | Path | Permission |
|---|---|---|
| GET | /documents | edit or publish |
| GET | /documents/:documentId | edit or publish |
| GET | /documents/:documentId/versions | edit or publish |
| GET | /documents/:documentId/versions/:versionId | edit or publish |
| POST | /documents | edit |
| POST | /documents/:documentId/revisions | edit |
| POST | /documents/:documentId/versions/:versionId/submit | edit |
| POST | /documents/:documentId/versions/:versionId/approve | publish |
| POST | /documents/:documentId/versions/:versionId/reject | publish |
| POST | /documents/:documentId/versions/:versionId/index | publish |
| POST | /documents/:documentId/versions/:versionId/publish | publish |
| POST | /documents/:documentId/archive | publish |

List routes accept limit (1?100, default 25) and offset (0?1,000,000).
Document responses return an ETag header and document.etag. Every mutation of an
existing document requires that exact quoted value in If-Match. Missing
preconditions return 428, stale ETags 412, and invalid transitions 409.
Foreign or guessed document/version IDs return 404 after department authorization;
missing grants return 403. Browser-supplied department, status and permission
fields cannot grant authority.

Create accepts {title,text,fictional?}; revisions accept {title,text}. The server
assigns IDs, source metadata, department, authors and timestamps. Source content
is immutable, including draft versions: corrections create new numbered versions.
The original baseline documents cannot be revised, reviewed or archived through
these routes.

Titles: 1?160 UTF-16 code units. Text: 1?20,000 code units and at most 64 KiB UTF-8.
Requests: at most 96 KiB JSON. Whitespace-only values, malformed Unicode, binary
control characters, extra fields, non-JSON media and compressed uploads are
rejected. Text is stored exactly as accepted; it is never executed or rendered
as HTML. Review notes are limited to 1,000 code units. Reject requires a note;
approve accepts an optional note. Submit, index and archive take {}. Publish
takes {indexId}.

The workflow is draft -> in_review -> approved or rejected. Only the latest
version can be submitted/reviewed. Rejected content needs a new revision before
resubmission. Revisions are blocked while the latest version is in review.
Approval and rejection require independent publish permission; a person explicitly
granted both edit and publish can perform both roles. A two-person rule is not
implicitly imposed.

### Example using an explicitly authorized administrator

First use the Step 11 login example to establish $browserSession and $current.
The following example requires edit and publish grants, or a deliberate account
switch before the review step. It does not provision an account.

~~~powershell
$base = 'http://127.0.0.1:3000'
$documents = '/api/admin/departments/transport/documents'
function Send-Knowledge($path, $body, $etag) {
    $headers = @{ Origin = $base; 'X-CSRF-Token' = $current.csrfToken }
    if ($etag) { $headers['If-Match'] = $etag }
    $request = @{
        Uri = "$base$path"
        Method = 'Post'
        ContentType = 'application/json'
        Headers = $headers
        WebSession = $browserSession
        Body = ($body | ConvertTo-Json -Compress)
    }
    Invoke-RestMethod @request
}

$created = Send-Knowledge $documents @{
    title = 'Fictional shuttle timetable'
    text = 'The fictional campus shuttle leaves at 09:00.'
    fictional = $true
} $null
$doc = $created.document
$versionPath = "$documents/$($doc.id)/versions/$($doc.latestVersion.id)"

$submitted = Send-Knowledge "$versionPath/submit" @{} $doc.etag
$approved = Send-Knowledge "$versionPath/approve" @{} $submitted.document.etag

# Approval alone is not visible to students.
$indexed = Send-Knowledge "$versionPath/index" @{} $approved.document.etag

# A ready index alone is also not visible.
$published = Send-Knowledge "$versionPath/publish" @{
    indexId = $indexed.index.id
} $indexed.document.etag

# Archive withdraws this document immediately, preserving its immutable history.
# Send-Knowledge "$documents/$($doc.id)/archive" @{} $published.document.etag
~~~

After an indexing failure or stale ETag, GET the document again before retrying.
Its latestVersion.indexes contains the latest ten build IDs and states. Its
publication field identifies the current publication independently of the latest
draft. An index request holds a new document revision while it runs; ready/failed
completion advances the ETag again.

### Indexing and publication guarantees

Indexing is explicit and runs within the HTTP request; there is no new queue,
service or background worker. It segments complete sentences into passages of at
most 500 characters and embeds small sequential batches of four. A single sentence
over 500 characters is rejected with 422 rather than split and stripped of
qualifications. Source locations retain exact character offsets in the immutable
version. Embeddings use the existing Nomic prefixes and model.

Chunks are inserted only after successful embedding. Index metadata stores the
model name/digest, dimensions, chunker version, prefixes, artifact hash, status and
timestamps. The immutable JSON artifact is written via a temporary file and rename
under Backend/data/indexes/<indexId>.json. It is not the prototype embeddings.json.
Generated indexes are ignored by Git and never served as public static files.

Finalization rechecks session, permissions, ETag, approval and archival state in a
transaction. Stale changes or failures leave no partially ready index/publication.
Retries create a new build ID and reuse matching immutable version chunks.
An audit failure rolls back the corresponding state transition.

Publication validates the complete artifact, checksum, source chunks and model
identity, then atomically switches the document's publication pointer. Publication
and its audit event commit together. A newer draft/rejection/approval or a failed
replacement never silently replaces the previous approved publication. A new
approval must be explicitly indexed and published.

Retrieval reads only publication pointers joined to approved versions, ready
indexes and unarchived documents. It validates artifact contents against SQLite
and rechecks publication status before generation and before returning an answer.
Archival removes publication pointers transactionally. An in-flight answer that
references withdrawn/replaced content is suppressed rather than returned.
Missing/corrupt/incompatible artifacts fail closed with 503; there is no fallback
to private versions or the old JSON baseline.

The existing concise, sentence-verified answers, department filter, cosine
threshold, context limits and timing fields remain. Sources keep id/title/passage
and add documentId, versionId and character location for historical provenance.
No frontend change is required to tolerate these additive fields.

### Operations and limitations

- Run one backend process for this prototype. Chat and indexing share one inference
  gate; concurrent inference receives 503 BUSY with Retry-After.
- Startup marks interrupted pending indexes failed and records system audit events.
  Retry explicitly after reloading the document. Startup does not publish anything.
- A crash between file rename and database commit can leave an unreferenced artifact.
  It is never retrieved. Automatic artifact/history garbage collection is deferred.
- Back up the SQLite database and referenced index artifacts together. Keep the
  original JSON fixtures separately. Filesystem access remains a trusted-operator
  boundary.
- Restart after changing embedding models. Existing artifacts with incompatible
  digests/dimensions are refused; rebuild and republish affected approved versions.
- The whole small published corpus is validated/read for an ask. This favors
  correctness on a single-machine prototype; large-corpus caching/search is deferred.
- No uploads, PDF/DOCX/OCR, additional departments, frontend administration, MFA or
  external deployment infrastructure were added.
- Automated workflow/publication tests use fake model responses and isolated
  synthetic administrators. They prove isolation and pipeline behavior, not live
  Ollama latency or semantic relevance. The older LIVE_OLLAMA suite remains opt-in
  and exercises the legacy fixture. Node 24's experimental SQLite warning remains.

### Complete numbered procedures

Ordinary questions retain the two-passage, 1,200-character model context and exact
sentence verification. For procedure questions, a verified relevant model quote
anchors a single published document version. The server expands that version in
source order (maximum 12 chunks / 6,000 serialized evidence characters), checks
contiguous step numbers and any requested step count, and returns its exact text
with complete step bodies, preconditions and final notes. This avoids regenerating
long procedures within the 160-token model limit. All expanded sources undergo the
final publication check. Missing steps, mixed versions, oversized documents and
invalid or truncated model output fail closed. No stored text or indexes change.

This bounded extractive path supports explicitly numbered procedures in a single
document; it does not synthesize unnumbered or multi-document procedures. Sources
include a verified excerpt alongside the unchanged full passage and version IDs.
Run `node --test tests/procedures.test.ts tests/rag.test.ts tests/publication.test.ts`
for focused regression coverage.
