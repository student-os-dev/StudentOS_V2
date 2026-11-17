export interface SourceReference {
  id: string;
  title: string;
  passage: string;
  excerpt?: string;
  documentId?: string;
  versionId?: string;
}
export interface Answer {
  available: boolean;
  answer: string;
  sources: SourceReference[];
}
export interface RequestFailure {
  code: string;
  message: string;
  retryable: boolean;
}
export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  createdAt: string;
  status: 'pending' | 'complete' | 'failed' | 'interrupted';
  error?: RequestFailure;
}
export interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  createdAt: string;
  available: boolean;
  sources: SourceReference[];
  replyTo: string;
}
export type Message = UserMessage | AssistantMessage;
export interface Conversation {
  id: string;
  departmentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}
export interface ActiveRequest {
  conversationId: string;
  messageId: string;
}
export interface ConversationSnapshot {
  conversations: Conversation[];
  selected: Record<string, string | null>;
  active: ActiveRequest | null;
  storageNotice: string | null;
}

