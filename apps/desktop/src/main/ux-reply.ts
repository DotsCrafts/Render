/**
 * Translate a renderer UxResult (what the human chose in the panel) into the
 * codex `result` payload the held HITL server-request expects.
 *
 *   confirm → { decision: 'accept' | 'cancel' }      (command / file approvals)
 *   form    → { value: … }                           (tool/requestUserInput)
 *
 * The decision vocabulary is codex 0.136.0's: the requestApproval frames carry
 * `availableDecisions: ["accept", …, "cancel"]`, so allow → 'accept' and
 * deny → 'cancel' (an 'approved'/'denied' reply fails to deserialize).
 *
 * Pure: returns a fresh object, never mutates the input.
 */

import type { UxConfirmResult, UxFormResult, UxKind, UxResult } from '@render/protocol';

/** Choice labels that mean "deny" — everything else under ux_confirm is allow. */
const DENY_CHOICES = new Set([
  '拒绝',
  '取消',
  'deny',
  'decline',
  'reject',
  'no',
  'cancel',
]);

export function uxResultToCodexReply(kind: UxKind, result: UxResult): unknown {
  if (kind === 'confirm') {
    const r = result as UxConfirmResult;
    const denied =
      r.action !== 'ux_confirm' || (typeof r.choice === 'string' && DENY_CHOICES.has(r.choice));
    return { decision: denied ? 'cancel' : 'accept' };
  }

  if (kind === 'form') {
    const r = result as UxFormResult;
    if (r.action !== 'ux_submit') return { decision: 'cancel' };
    const values = r.values ?? {};
    // The mapped tool-input form carries a single `value` field; pass it through
    // directly, else hand back the whole bag for richer elicitation schemas.
    return 'value' in values ? { value: values.value } : { value: values };
  }

  // login / render never round-trip through codex resolvePending.
  return { decision: 'cancel' };
}
