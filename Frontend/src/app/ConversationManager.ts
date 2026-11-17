import { askTransport, AssistantError } from '../services/api/ask.ts';
import type { HistoryStorage } from '../services/conversationStorage/storage.ts';
import type { Answer, Conversation, ConversationSnapshot, Message, UserMessage } from '../types/conversation.ts';

export function conversationTitle(question: string): string {
  const title = question.trim().replace(/\s+/g, ' ');
  return title.length <= 60 ? title : title.slice(0, 57).trimEnd() + '…';
}
export function orderedConversations(conversations: Conversation[], departmentId: string): Conversation[] {
  return conversations.filter(c => c.departmentId === departmentId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}
export class ConversationManager {
  private snapshot: ConversationSnapshot;
  private listeners = new Set<() => void>();
  private storage: HistoryStorage;
  private ask: (question: string) => Promise<Answer>;
  private id: () => string;
  private now: () => string;
  constructor(storage: HistoryStorage, ask = askTransport, id = () => crypto.randomUUID(), now = () => new Date().toISOString()) {
    this.storage = storage;
    this.ask = ask;
    this.id = id;
    this.now = now;
    const loaded = storage.load();
    const selected: Record<string, string | null> = {};
    for (const conversation of [...loaded.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      selected[conversation.departmentId] ??= conversation.id;
    }
    this.snapshot = { conversations: loaded.conversations, selected, active: null, storageNotice: loaded.notice };
  }
  getSnapshot = (): ConversationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: ConversationSnapshot, persist = false) {
    this.snapshot = persist ? { ...next, storageNotice: this.storage.save(next.conversations) } : next;
    for (const listener of this.listeners) listener();
  }
  select(departmentId: string, id: string | null) {
    if (id !== null && !this.snapshot.conversations.some(c => c.id === id && c.departmentId === departmentId)) return;
    this.publish({ ...this.snapshot, selected: { ...this.snapshot.selected, [departmentId]: id } });
  }
  send(departmentId: string, input: string, conversationId: string | null): string | null {
    if (this.snapshot.active) return null; // Synchronous lock also guards double clicks.
    const question = input.trim();
    if (departmentId !== 'transport') throw new Error('Only Transport is available.');
    if (!question || question.length > 500) throw new Error('Enter a question of 1–500 characters.');
    let conversation = conversationId === null ? undefined :
      this.snapshot.conversations.find(c => c.id === conversationId && c.departmentId === departmentId);
    if (conversationId !== null && !conversation) throw new Error('This conversation is no longer available. Start a new chat.');
    const at = this.now();
    conversation ??= { id: this.id(), departmentId, title: conversationTitle(question), createdAt: at, updatedAt: at, messages: [] };
    const message: UserMessage = { id: this.id(), role: 'user', content: question, createdAt: at, status: 'pending' };
    const updated = { ...conversation, updatedAt: at, messages: [...conversation.messages, message] };
    const exists = this.snapshot.conversations.some(c => c.id === updated.id);
    this.publish({
      ...this.snapshot,
      conversations: exists ? this.snapshot.conversations.map(c => c.id === updated.id ? updated : c) : [updated, ...this.snapshot.conversations],
      selected: { ...this.snapshot.selected, [departmentId]: updated.id },
      active: { conversationId: updated.id, messageId: message.id },
    }, true);
    void this.perform(updated.id, message);
    return updated.id;
  }
  retry(conversationId: string, messageId: string): boolean {
    if (this.snapshot.active) return false;
    const conversation = this.snapshot.conversations.find(c => c.id === conversationId && c.departmentId === 'transport');
    const message = conversation?.messages.find(m => m.id === messageId);
    if (!conversation || !message || message.role !== 'user' || !['failed', 'interrupted'].includes(message.status) ||
        !message.error?.retryable || conversation.messages.some(m => m.role === 'assistant' && m.replyTo === messageId)) return false;
    const { error: _error, ...rest } = message;
    const pending: UserMessage = { ...rest, status: 'pending' };
    this.publish({
      ...this.snapshot, active: { conversationId, messageId },
      conversations: this.snapshot.conversations.map(c => c.id === conversationId ?
        { ...c, updatedAt: this.now(), messages: c.messages.map(m => m.id === messageId ? pending : m) } : c),
    }, true);
    void this.perform(conversationId, pending);
    return true;
  }
  rename(conversationId: string, input: string) {
    const title = input.trim();
    if (!title || title.length > 80) return false;
    this.publish({
      ...this.snapshot,
      conversations: this.snapshot.conversations.map(c => c.id === conversationId ? { ...c, title, updatedAt: this.now() } : c),
    }, true);
    return true;
  }
  remove(conversationId: string) {
    const selected = Object.fromEntries(Object.entries(this.snapshot.selected).map(([department, id]) =>
      [department, id === conversationId ? null : id]));
    // An in-flight request continues, but a deleted conversation is never resurrected.
    this.publish({ ...this.snapshot, selected, conversations: this.snapshot.conversations.filter(c => c.id !== conversationId) }, true);
  }
  private async perform(conversationId: string, original: UserMessage) {
    try {
      const answer = await this.ask(original.content);
      this.finish(conversationId, original.id, message => ({
        user: { ...message, status: 'complete', error: undefined },
        assistant: {
          id: this.id(), role: 'assistant', content: answer.answer, createdAt: this.now(),
          available: answer.available, sources: answer.sources, replyTo: message.id,
        },
      }));
    } catch (error) {
      const failure = error instanceof AssistantError ? error : new AssistantError('UNEXPECTED', 'The answer could not be completed. Your question is saved. Please try again.');
      this.finish(conversationId, original.id, message => ({
        user: { ...message, status: 'failed', error: { code: failure.code, message: failure.message, retryable: failure.retryable } },
      }));
    }
  }
  private finish(conversationId: string, messageId: string, update: (message: UserMessage) => { user: UserMessage; assistant?: Message }) {
    if (this.snapshot.active?.conversationId !== conversationId || this.snapshot.active.messageId !== messageId) return;
    const conversations = this.snapshot.conversations.map(conversation => {
      if (conversation.id !== conversationId) return conversation;
      const position = conversation.messages.findIndex(m => m.id === messageId && m.role === 'user');
      if (position < 0) return conversation;
      const result = update(conversation.messages[position] as UserMessage);
      const messages = [...conversation.messages];
      messages[position] = result.user;
      if (result.assistant) messages.splice(position + 1, 0, result.assistant);
      return { ...conversation, messages, updatedAt: this.now() };
    });
    this.publish({ ...this.snapshot, conversations, active: null }, true);
  }
}

