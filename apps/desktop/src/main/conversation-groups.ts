/**
 * Conversation groups — the per-conversation browser tab group allocator.
 *
 * Each agent CONVERSATION owns one distinct tab group; every browser tab the
 * agent mints during that conversation joins it. Starting a NEW conversation
 * allocates the NEXT group (new group ⟺ new conversation). The label/color make
 * concurrent conversations visually distinct in the tab strip.
 *
 * Pure + immutable: the allocator holds only a monotonic counter and hands back
 * a fresh `TabGroupInfo` each time — the runtime owns "which group is active".
 */

import type { TabGroupInfo } from '@render/protocol';

/**
 * A small, pleasant palette cycled per conversation so adjacent conversations
 * read as visually distinct. Index = (n - 1) mod palette length, so conv-1 is
 * the original agent indigo and the degenerate single-conversation case is
 * unchanged.
 */
export const CONVERSATION_COLORS = [
  '#7c93ff', // indigo (conv-1 — the original agent group color)
  '#4fd1c5', // teal
  '#f6ad55', // amber
  '#fc8181', // coral
  '#b794f4', // violet
  '#68d391', // green
] as const;

/** Build the group descriptor for the n-th conversation (1-based). */
export function conversationGroup(n: number): TabGroupInfo {
  const color = CONVERSATION_COLORS[(n - 1) % CONVERSATION_COLORS.length]!;
  return { id: `conv-${n}`, label: `Agent ${n}`, color };
}

export interface ConversationGroups {
  /** The conversation group tabs should currently join. */
  current(): TabGroupInfo;
  /** Allocate the NEXT conversation group and make it current. Returns it. */
  next(): TabGroupInfo;
}

/**
 * Create the allocator. Starts on conv-1 so the first conversation is the
 * degenerate single-group case (unchanged from the old fixed `agent` group).
 * `onActivate` fires whenever a group becomes current (including conv-1 at
 * construction) so the host can `tabs.ensureGroup` its label/color.
 */
export function createConversationGroups(onActivate: (group: TabGroupInfo) => void): ConversationGroups {
  let seq = 1;
  let group = conversationGroup(seq);
  onActivate(group);

  return {
    current: () => group,
    next: () => {
      seq += 1;
      group = conversationGroup(seq);
      onActivate(group);
      return group;
    },
  };
}
