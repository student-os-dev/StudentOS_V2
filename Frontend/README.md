# Student OS V2 — Frontend Phase 1

React + TypeScript + Vite application using the existing Tailwind, React Router, Lucide React and locally bundled IBM Plex Sans installation. No dependencies were added for Phase 1.

## Run

```powershell
Set-Location 'D:\StudentOS_Frontend'
npm.cmd run dev
```

Open http://127.0.0.1:5173. Stop with Ctrl+C.

Start the existing backend separately in another PowerShell window:

```powershell
Set-Location 'D:\StudentOS_V2'
npm.cmd start
```

The frontend uses only /api/ask. The existing Vite development proxy forwards /api to http://127.0.0.1:3000 without rewriting paths. Production hosting is outside this phase.

```powershell
Set-Location 'D:\StudentOS_Frontend'
npm.cmd run build
npm.cmd run preview
```

Build runs TypeScript checking and emits dist/. Preview serves the static build at http://127.0.0.1:4173; use the development server for the configured API proxy.

## Implemented

- Home with two equally prominent assistant cards; My AI In Development preview; Transport department selection; Transport chat.
- Independently collapsible desktop application navigation and history. Separate mobile modal drawers, keyboard focus containment and Escape dismissal.
- Immediate suggested-question sends, plain-text backend answers, collapsed source references, normal unavailable outcomes and distinct retryable technical errors.
- Local browser history: automatic titles, New Chat, rename, confirmed deletion, saved questions and responses. No empty conversations are saved.
- Application-level request ownership survives route and conversation navigation. Only one request runs per frontend instance. Retry reuses the saved question. Refresh converts pending requests to unresolved questions without automatically resending.
- Corrupt history is left untouched with a visible warning and temporary in-memory use. Storage access/quota errors also show a warning; current-tab work remains usable.
- Fictional-data notice and independent-question guidance. No prior messages or conversation IDs are sent to the backend.

## Verification on 17 November 2026

- TypeScript check and production build passed.
- All four routes rendered in a headless Edge browser.
- Independent desktop collapse controls, separate mobile navigation/history drawers and dismissal, mobile width, and equal mobile card heights passed browser checks.
- Direct manager/service checks passed for immediate persistence, global request locking, response ownership while selecting another conversation, retry deduplication, interrupted-request recovery, deletion during a request, corrupt/full storage, exact API payload, and unavailable answers.
- Live backend integration remains **unverified**: the proxy targeted the configured backend but port 3000 refused the connection during this run. This is an unavailable backend, not a successful end-to-end test.
- No backend files or knowledge data were modified. No new dependencies were installed.

Full manual browser testing of successful backend responses, source expansion, and browser Back/Forward remains advisable when the backend is running. A mobile browser/device was not used; responsive checks used browser viewport emulation.

## Files

Changed: src/App.tsx, src/main.tsx, src/styles.css, tsconfig.json, README.md.

Added:
- src/types/conversation.ts
- src/services/api/ask.ts
- src/services/conversationStorage/storage.ts
- src/app/ConversationManager.ts
- src/app/Conversations.tsx

Temporary browser profiles and screenshots are in ignored .tmp/. Generated build output is in dist/.

## Limits

History is local to this browser with no account or cloud synchronization. Multiple tabs do not synchronize in-memory changes; each tab can make one request, while the backend may return BUSY. Refresh may terminate receipt of an answer even if the backend continues processing it. Retry is explicit. Each question is independent. Transport answers use fictional prototype information and are not verified college policy. My AI is only a preview. No production deployment was performed.