import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { ConversationManager } from './ConversationManager';
import { createHistoryStorage } from '../services/conversationStorage/storage';

const manager = new ConversationManager(createHistoryStorage());
const Context = createContext(manager);

export function ConversationsProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={manager}>{children}</Context.Provider>;
}
export function useConversations() {
  const manager = useContext(Context);
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  return { manager, state };
}

