import type { Conversation, Message, RequestFailure } from '../../types/conversation.ts';
import { isSource } from '../api/ask.ts';

export const STORAGE_KEY = 'student-os-v2.conversations.v1';
export const INTERRUPTED: RequestFailure = {
  code: 'INTERRUPTED',
  message: 'The page closed or refreshed before an answer arrived. This question is unresolved. You can retry it.',
  retryable: true,
};
export interface HistoryStorage {
  load(): { conversations: Conversation[]; notice: string | null };
  save(conversations: Conversation[]): string | null;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max = Infinity): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function validMessage(value: unknown): value is Message {
  if (!object(value) || !text(value.id, 128) || !text(value.content) || !timestamp(value.createdAt)) return false;
  if (value.role === 'assistant') {
    return typeof value.available === 'boolean' && text(value.replyTo, 128) &&
      Array.isArray(value.sources) && value.sources.every(isSource);
  }
  if (value.role !== 'user' || !['pending', 'complete', 'failed', 'interrupted'].includes(String(value.status)) || value.content.length > 500) return false;
  return value.error === undefined || (object(value.error) && text(value.error.code, 100) &&
    text(value.error.message, 1000) && typeof value.error.retryable === 'boolean');
}
export function parseHistory(raw: string): Conversation[] {
  const parsed: unknown = JSON.parse(raw);
  if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.conversations)) throw new Error('Invalid history');
  const conversationIds = new Set<string>();
  return parsed.conversations.map((entry: unknown) => {
    if (!object(entry) || !text(entry.id, 128) || !text(entry.departmentId, 32) || !text(entry.title, 80) ||
        !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || !Array.isArray(entry.messages) ||
        !entry.messages.length || !entry.messages.every(validMessage) || conversationIds.has(entry.id)) throw new Error('Invalid conversation');
    conversationIds.add(entry.id);
    const messages = entry.messages as Message[];
    const ids = new Set(messages.map(m => m.id));
    if (ids.size !== messages.length) throw new Error('Duplicate message');
    const replies = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant') {
        if (replies.has(message.replyTo) || !messages.some(m => m.role === 'user' && m.id === message.replyTo)) throw new Error('Invalid reply');
        replies.add(message.replyTo);
      }
    }
    const recovered = messages.map((message): Message => {
      if (message.role !== 'user') return { ...message, sources: message.sources.map(s => ({ ...s })) };
      if (replies.has(message.id)) {
        const { error: _error, ...rest } = message;
        return { ...rest, status: 'complete' };
      }
      if (message.status === 'pending' || message.status === 'complete') {
        return { ...message, status: 'interrupted', error: { ...INTERRUPTED } };
      }
      if ((message.status === 'failed' || message.status === 'interrupted') && !message.error) {
        return { ...message, status: 'interrupted', error: { ...INTERRUPTED } };
      }
      return { ...message };
    });
    return {
      id: entry.id, departmentId: entry.departmentId, title: entry.title,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, messages: recovered,
    };
  });
}
export function createHistoryStorage(getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => window.localStorage): HistoryStorage {
  let corrupted = false;
  const unavailable = 'Conversation history cannot be saved in this browser right now. Changes will stay in this tab until it closes.';
  const corruptNotice = 'Saved conversation history could not be read. New conversations will stay in this tab for now; the existing stored data has been left untouched.';
  return {
    load() {
      let raw: string | null;
      try { raw = getStorage().getItem(STORAGE_KEY); }
      catch { return { conversations: [], notice: unavailable }; }
      if (raw === null) return { conversations: [], notice: null };
      try { return { conversations: parseHistory(raw), notice: null }; }
      catch {
        corrupted = true;
        return { conversations: [], notice: corruptNotice };
      }
    },
    save(conversations) {
      if (corrupted) return corruptNotice;
      try {
        getStorage().setItem(STORAGE_KEY, JSON.stringify({ version: 1, conversations }));
        return null;
      } catch { return unavailable; }
    },
  };
}

