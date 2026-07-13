import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useSpeechInput } from '../useSpeechInput.js';

interface Props {
  busy: boolean;
  onSubmit: (text: string) => void;
  /**
   * While a turn is running, Enter routes here instead of onSubmit — steering
   * the live agent ("also sort by price") rather than starting a competing
   * turn. The placeholder + a "steer ↵" hint make the mode switch visible.
   */
  onSteer?: (text: string) => void;
  onCancel: () => void;
  /** Esc — dismiss the input layer (the band collapses to the recall handle). */
  onDismiss?: () => void;
  /**
   * Delta 2: a seed prefill pushed from a result card's Refine/Ask-follow-up
   * action. The `nonce` makes repeated seeds (even the same text) re-apply and
   * re-focus, so the user can edit and send.
   */
  seed?: { text: string; nonce: number };
  /**
   * ⌘K focus signal: bump the nonce to pull focus back to the input (e.g. the
   * chrome-level Cmd/Ctrl+K listener). Unlike `seed` it PRESERVES any draft —
   * the text is selected so the user can overtype or keep it.
   */
  focusNonce?: number;
}

/**
 * The primary intent control of the summonable input layer, pinned
 * bottom-center. Focused on mount and re-focused after each submit so the user
 * can keep talking to the agent; it stays mounted while the layer is dismissed
 * so a draft survives hide/summon round-trips. Voice input appends final
 * transcripts to the draft (send stays an explicit action).
 */
export function FloatingInput({
  busy,
  onSubmit,
  onSteer,
  onCancel,
  onDismiss,
  seed,
  focusNonce,
}: Props): ReactElement {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const speech = useSpeechInput((spoken) =>
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${spoken}` : spoken)),
  );

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

  // ⌘K: focus without clobbering a draft — select it instead.
  useEffect(() => {
    if (!focusNonce) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusNonce]);

  const submit = (): void => {
    if (!text.trim()) return;
    // mid-run input steers the running agent; idle input starts a turn
    if (busy && onSteer) onSteer(text);
    else onSubmit(text);
    setText('');
    inputRef.current?.focus();
  };

  const steering = busy && !!onSteer;

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
        placeholder={
          speech.status === 'listening'
            ? 'Listening…'
            : steering
              ? 'Steer the running agent…'
              : 'Ask Render to do something…'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onDismiss) {
            e.preventDefault();
            if (speech.status === 'listening') speech.toggle();
            onDismiss();
          }
        }}
      />
      {!busy && !text.trim() ? <span className="kbd">⌘ K</span> : null}
      {steering && text.trim() ? <span className="kbd">steer ↵</span> : null}
      {speech.supported ? (
        <button
          type="button"
          className={`mic${speech.status === 'listening' ? ' listening' : ''}`}
          onClick={speech.toggle}
          disabled={speech.status === 'unavailable'}
          aria-label="voice input"
          aria-pressed={speech.status === 'listening'}
          title={
            speech.status === 'unavailable'
              ? 'Voice input is not available in this build'
              : speech.status === 'listening'
                ? 'Stop listening'
                : 'Voice input'
          }
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
            <rect x="5.6" y="1.8" width="4.8" height="7.6" rx="2.4" />
            <path d="M3.2 7.6a4.8 4.8 0 009.6 0M8 12.4v2" />
          </svg>
        </button>
      ) : null}
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
