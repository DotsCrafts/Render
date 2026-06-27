import { useEffect, useRef, useState, type ReactElement } from 'react';

interface Props {
  busy: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /**
   * Delta 2: a seed prefill pushed from a result card's Refine/Ask-follow-up
   * action. The `nonce` makes repeated seeds (even the same text) re-apply and
   * re-focus, so the user can edit and send.
   */
  seed?: { text: string; nonce: number };
}

/**
 * The always-visible primary control, pinned bottom-center. Focused on mount and
 * re-focused after each submit so the user can keep talking to the agent.
 */
export function FloatingInput({ busy, onSubmit, onCancel, seed }: Props): ReactElement {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Apply a seeded prefill (Refine / Ask follow-up): set the text, focus, and put
  // the caret at the end so the user can keep typing.
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => {
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    }
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (): void => {
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
    inputRef.current?.focus();
  };

  return (
    <form
      className="floating"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span className="glyph" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M8 1.5l1.7 3.5 3.8.5-2.7 2.7.6 3.8L8 10.7 4.3 12l.6-3.8L2.2 5.5l3.8-.5z" />
        </svg>
      </span>
      <input
        ref={inputRef}
        value={text}
        placeholder="Ask Render to do something…"
        onChange={(e) => setText(e.target.value)}
      />
      {!busy && !text.trim() ? <span className="kbd">⌘ K</span> : null}
      {busy ? (
        <button type="button" className="cancel" onClick={onCancel} aria-label="stop" title="Stop">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
            <rect x="2" y="2" width="8" height="8" rx="1.5" />
          </svg>
        </button>
      ) : (
        <button type="submit" disabled={!text.trim()} aria-label="send" title="Send">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 8h9M8 4l4 4-4 4" />
          </svg>
        </button>
      )}
    </form>
  );
}
