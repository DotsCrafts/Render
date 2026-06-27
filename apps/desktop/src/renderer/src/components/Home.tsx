import type { ReactElement } from 'react';

interface Props {
  /** Run an example prompt straight through the agent. */
  onPrompt: (text: string) => void;
  /** True before the first tab (e.g. the home portal) has finished opening. */
  loading?: boolean;
}

const EXAMPLES = [
  'Find 3 coffee shops nearby and compare them',
  'Summarize the latest arXiv cs.AI papers',
  'What is the weather in Shanghai right now?',
  'Search the web for OpenCLI and open the top result',
];

/**
 * First-run / empty-stage identity. Shown in `.stage` when no page view occupies
 * it (tabs still opening). Gives Render an identity, a few runnable example
 * prompts, and a graceful "portal opening" affordance instead of a blank well.
 */
export function Home({ onPrompt, loading }: Props): ReactElement {
  return (
    <div className={`rd-home${loading ? ' loading' : ''}`}>
      <div className="rd-home-mark">
        <span className="rd-home-logo" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l2.5 5.2 5.5.8-4 3.9.9 5.6L12 21l-5.4 2.5.9-5.6-4-3.9 5.5-.8z" />
          </svg>
        </span>
        <span className="rd-home-wordmark">Render</span>
      </div>

      <p className="rd-home-tag">
        {loading
          ? 'Opening your home portal'
          : 'A native browser with an always-on agent. Ask it to find, compare, or do something — it works in the panel and brings back a result, not a log.'}
      </p>

      <div className="rd-home-prompts">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            className="rd-home-prompt"
            onClick={() => onPrompt(ex)}
          >
            <span className="ic" aria-hidden>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8h9M8 4l4 4-4 4" />
              </svg>
            </span>
            {ex}
          </button>
        ))}
      </div>

      <span className="rd-home-hint">Type below, or pick an example to begin.</span>
    </div>
  );
}
