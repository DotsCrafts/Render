import { useEffect, useRef, useState, type ReactElement } from 'react';

interface Props {
  busy: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

/**
 * The always-visible primary control, pinned bottom-center. Focused on mount and
 * re-focused after each submit so the user can keep talking to the agent.
 */
export function FloatingInput({ busy, onSubmit, onCancel }: Props): ReactElement {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
      <span className="glyph">✦</span>
      <input
        ref={inputRef}
        value={text}
        placeholder="Ask Render to do something…"
        onChange={(e) => setText(e.target.value)}
      />
      {busy ? (
        <button type="button" className="cancel" onClick={onCancel}>
          Stop
        </button>
      ) : (
        <button type="submit" disabled={!text.trim()}>
          Send
        </button>
      )}
    </form>
  );
}
