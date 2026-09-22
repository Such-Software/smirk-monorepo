/**
 * An npub (or any identifier) you can click to copy.
 *
 * Nostr identifiers are long, unmemorable and constantly needed elsewhere: to
 * message someone, to paste into another client, to check you are acting as the
 * identity you meant. They were rendered as plain text in most places, so the
 * only way to get one out of the wallet was to select a truncated string that
 * could not be selected, or to go and find the one screen that happened to
 * support copying.
 *
 * Wherever an npub is shown, it should be obtainable. This renders the short
 * form, copies the FULL value, and confirms it did.
 */

import { useState } from 'preact/hooks';

import { copyText } from '../clipboard';

export interface CopyableNpubProps {
  /** The full value placed on the clipboard. */
  value: string;
  /** What to show. Defaults to the full value. */
  display?: string;
  /** What this identifier is, for the tooltip: "npub", "address", … */
  label?: string;
  class?: string;
  style?: Record<string, string | number>;
  testid?: string;
}

export function CopyableNpub({
  value,
  display,
  label = 'npub',
  class: className,
  style,
  testid,
}: CopyableNpubProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = (e: Event) => {
    // These often sit inside a row that selects or navigates on click. Copying
    // is the user's intent here; doing both would switch identity behind them.
    e.stopPropagation();
    e.preventDefault();
    void copyText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // Clipboard can be refused (permissions, non-secure context). Say
        // nothing rather than claim a copy that did not happen.
      });
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? `${label} copied` : `Click to copy ${label}`}
      aria-label={`Copy ${label}`}
      data-testid={testid}
      class={className}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        // The affordance has to be visible without shouting: a dotted underline
        // reads as "this does something" where plain text reads as decoration.
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
        textUnderlineOffset: 2,
        ...style,
      }}
    >
      {copied ? 'copied' : (display ?? value)}
    </button>
  );
}
