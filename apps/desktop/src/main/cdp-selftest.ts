/**
 * CDP self-test — the brief's concrete proof that the human-hand attaches and
 * drives a real tab: navigate to example.com, attach CDP, evaluate
 * `document.title`, log the result. Runs once at startup; never throws into the
 * app (failures are logged, not fatal).
 */

import type { HumanHandHandle } from '@render/cdp-human-hand';
import type { TabManager } from './tabs.js';

interface EvalResult {
  result?: { value?: unknown };
}

export async function runCdpSelfTest(humanHand: HumanHandHandle, tabs: TabManager): Promise<void> {
  try {
    const tabId = tabs.create('https://example.com', { activate: false });
    const target = tabs.getTarget(tabId);
    if (!target) throw new Error('self-test tab vanished');

    await new Promise<void>((resolve) => {
      const wc = target;
      if (!wc.isLoading()) return resolve();
      wc.once('did-stop-loading', () => resolve());
      // hard cap so a hung load never blocks the test
      setTimeout(resolve, 8000);
    });

    await humanHand.attach(tabId);
    const evaluated = await humanHand.send<EvalResult>(tabId, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const title = evaluated?.result?.value;
    console.log(`[render] CDP self-test OK — example.com document.title = ${JSON.stringify(title)}`);
  } catch (err) {
    console.error('[render] CDP self-test FAILED:', err instanceof Error ? err.message : err);
  }
}
