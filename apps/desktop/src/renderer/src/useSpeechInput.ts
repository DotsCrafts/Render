/**
 * useSpeechInput — voice input for the floating input layer, built on the
 * Chromium Web Speech API (webkitSpeechRecognition).
 *
 * Electron ships the API surface but not always a speech service behind it
 * (cloud recognition needs vendor keys), so this hook treats "unsupported" and
 * "service unavailable at runtime" as first-class states: the mic button can
 * render disabled with an honest tooltip instead of silently doing nothing.
 * Final transcripts stream out through `onText`; interim results are ignored so
 * the caller only ever appends confirmed words.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Minimal structural types for the prefixed Web Speech API. */
interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  isFinal: boolean;
  0: SpeechAlternativeLike;
}
interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}
interface SpeechErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEventLike) => void) | null;
  onerror: ((e: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function resolveCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Errors that mean "no speech service in this build" — not a user mistake. */
const SERVICE_ERRORS = new Set(['service-not-allowed', 'not-allowed', 'language-not-supported']);
/**
 * 'network' is ambiguous: it's both what a build WITHOUT a speech backend
 * reports and what a transient connectivity blip reports. One strike is
 * forgiven (back to idle, user may retry); two consecutive means "no backend
 * here" and the control goes honestly unavailable.
 */
const NETWORK_STRIKES_TO_UNAVAILABLE = 2;

export type SpeechStatus = 'idle' | 'listening' | 'unavailable';

export interface SpeechInput {
  /** false when the API is missing entirely (button can hide or disable). */
  supported: boolean;
  status: SpeechStatus;
  /** Start/stop listening. No-op while unavailable. */
  toggle: () => void;
}

export function useSpeechInput(onText: (text: string) => void): SpeechInput {
  const [status, setStatus] = useState<SpeechStatus>('idle');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const networkStrikes = useRef(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const supported = resolveCtor() !== null;

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const toggle = useCallback(() => {
    if (status === 'unavailable') return;
    // The ref is the synchronous truth — React state lags a render, so a rapid
    // double-toggle could otherwise construct two live recognizers.
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const Ctor = resolveCtor();
    if (!Ctor) {
      setStatus('unavailable');
      return;
    }
    try {
      const recognition = new Ctor();
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (e) => {
        networkStrikes.current = 0; // real results ⇒ the service is reachable
        const finals: string[] = [];
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const result = e.results[i];
          if (result?.isFinal && result[0]?.transcript) finals.push(result[0].transcript);
        }
        const text = finals.join(' ').trim();
        if (text) onTextRef.current(text);
      };
      recognition.onerror = (e) => {
        // `aborted`/`no-speech` are normal stop paths; service errors are terminal.
        if (SERVICE_ERRORS.has(e.error)) setStatus('unavailable');
        else if (e.error === 'network') {
          networkStrikes.current += 1;
          if (networkStrikes.current >= NETWORK_STRIKES_TO_UNAVAILABLE) setStatus('unavailable');
        }
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        setStatus((prev) => (prev === 'unavailable' ? prev : 'idle'));
      };
      recognitionRef.current = recognition;
      recognition.start();
      setStatus('listening');
    } catch {
      setStatus('unavailable');
    }
  }, [status]);

  return { supported, status, toggle };
}
