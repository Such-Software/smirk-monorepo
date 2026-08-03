// @jsxRuntime automatic
// @jsxImportSource preact
/**
 * `BrowserTabStrip`: horizontal tab strip with close affordances.
 *
 * Renders the list of tabs as a row, highlights the active tab, and
 * exposes per-tab close + a trailing "new tab" button. When only one
 * tab exists the strip collapses to a single-row "current page"
 * affordance with no close button: keeps the chrome lean for the
 * common single-tab case.
 *
 * Like `BrowserUrlBar`, the component is presentational and stateless;
 * tab commands route back to the consumer through callbacks rather
 * than reaching into a controller.
 */

import type { JSX } from 'preact';
import type { BrowserTab, TabId } from '@smirk/dapp-browser';

export interface BrowserTabStripProps {
  readonly tabs: readonly BrowserTab[];
  readonly activeTab: TabId;

  readonly onSelectTab: (id: TabId) => void;
  readonly onCloseTab: (id: TabId) => void;
  readonly onNewTab: () => void;

  /**
   * Collapse to single-row indicator (no tabs visible) when only one
   * tab exists. Defaults to true: most users on small windows don't
   * need a one-tab strip eating vertical space.
   */
  readonly collapseSingleTab?: boolean;

  readonly class?: string;
}

/** See file header for behaviour. */
export function BrowserTabStrip(props: BrowserTabStripProps): JSX.Element | null {
  const collapse = props.collapseSingleTab ?? true;
  if (collapse && props.tabs.length <= 1) {
    return null;
  }

  return (
    <div
      class={['smirk-browser-tabstrip', props.class].filter(Boolean).join(' ')}
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 2,
        padding: '4px 4px 0',
        background: 'var(--smirk-bg, transparent)',
        borderBottom: '1px solid var(--smirk-border, rgba(255,255,255,0.08))',
      }}
    >
      {props.tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === props.activeTab}
          onSelect={() => props.onSelectTab(tab.id)}
          onClose={() => props.onCloseTab(tab.id)}
        />
      ))}
      <NewTabButton onClick={props.onNewTab} />
    </div>
  );
}

// ======================================================================
// Internals
// ======================================================================

interface TabPillProps {
  readonly tab: BrowserTab;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onClose: () => void;
}

function TabPill(props: TabPillProps): JSX.Element {
  const { state } = props.tab;
  const label = state.title || state.url || 'New tab';

  return (
    <div
      role="tab"
      aria-selected={props.active}
      onClick={(e) => {
        // Don't fire onSelect when the click was on the close button;
        // the close button stops propagation, but be defensive in case
        // a future child blocks it.
        if ((e.target as HTMLElement).dataset.role === 'close') return;
        props.onSelect();
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        maxWidth: 160,
        minWidth: 60,
        fontSize: 11,
        fontFamily: 'inherit',
        color: 'var(--smirk-fg, #f5f5f5)',
        background: props.active
          ? 'var(--smirk-bg-elevated, rgba(255,255,255,0.06))'
          : 'transparent',
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
        cursor: props.active ? 'default' : 'pointer',
        opacity: props.active ? 1 : 0.7,
      }}
    >
      {state.faviconUrl ? (
        <img
          src={state.faviconUrl}
          alt=""
          width={12}
          height={12}
          style={{ display: 'block', flexShrink: 0 }}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{ width: 12, height: 12, display: 'inline-block', flexShrink: 0 }}
        />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      <button
        type="button"
        data-role="close"
        aria-label="Close tab"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        style={{
          width: 16,
          height: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          opacity: 0.6,
          fontSize: 12,
          padding: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}

function NewTabButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label="New tab"
      title="New tab"
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        marginLeft: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        color: 'var(--smirk-fg, #f5f5f5)',
        cursor: 'pointer',
        opacity: 0.7,
        fontSize: 14,
      }}
    >
      +
    </button>
  );
}
