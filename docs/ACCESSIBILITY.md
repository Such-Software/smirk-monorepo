# Accessibility

Smirk Wallet's accessibility is not an after-ship project. It is a
property of the codebase, enforced at code review, test runs, and CI.
This document is the single source of truth for the standards, the
patterns, and the contribution workflow.

If you're adding a new component, screen, or interaction, read this
once and refer to it on every PR. The patterns referenced here
(dialog, tablist, live region, focus trap) are documented in full
exactly once — use them by name, don't reinvent them per component.

## Standards baseline

We target the following levels, in order of authority:

| Standard | Level | Scope |
| -------- | ----- | ----- |
| **WCAG 2.2 AA** | Required everywhere | Web content baseline. AAA where the design permits. |
| **ARIA Authoring Practices 1.2** | Required when ARIA is in use | Canonical interaction patterns. |
| **Apple HIG Accessibility** | Required on iOS | Native expectation; VoiceOver users assume HIG. |
| **Material Design Accessibility** | Required on Android | TalkBack users assume Material conventions. |
| **Section 508** | Required for institutional release | US federal procurement. |
| **EN 301 549** | Required for institutional release | EU public-sector procurement. |

Touch target minimums: **44×44 pt** on iOS, **48×48 dp** on Android.
Verify in code review for every interactive element.

OS-respecting defaults:

- iOS Dynamic Type, Android Font Scale — UI never overrides
- `prefers-reduced-motion` — animations gated
- `prefers-contrast` — contrast adjusted via theme tokens
- `prefers-color-scheme` — handled by the theme system

If an OS feature exists, we follow it. We do not override.

## Patterns

These patterns are referenced by name throughout the codebase. The
canonical spec lives here. Component-level docs say
*"Implements the [tablist pattern](docs/ACCESSIBILITY.md#tablist)"*
and link back — they do not re-document the pattern.

### Semantic HTML first

Use semantic HTML elements where they exist. Reach for ARIA only when
HTML cannot express the concept. A button is a `<button>`, not
`<div role="button">`. A nav is a `<nav>`. A heading is `<h1>`–`<h6>`.

### Live regions

A single `<LiveRegion>` component (planned for `@smirk/ui`) will
handle every dynamic-update announcement. Politeness levels map to
event severity:

| Event class | Politeness | Example |
| ----------- | ---------- | ------- |
| Background refresh, no user action needed | `off` (silent) | Polled balance update. |
| Confirmation of user action | `polite` | "Send broadcast — txid abc…". |
| Progress through a long operation | `polite` + step labels | "Building sweep… Broadcasting… Confirming…" |
| Critical condition the user must know now | `assertive` (`role="alert"`) | Failed claim, lock-window violation, fund-loss-adjacent message. |
| Modal opening that demands attention | `assertive` + focus management | Approval prompt opening. |

**Never use `aria-live` directly on a component**; always route through
`<LiveRegion>` so the politeness mapping is centralized.

### Dialog (modal)

Pattern: focus moves into the dialog on open, focus is trapped while
the dialog is open, Escape closes the dialog, focus returns to the
trigger element on close.

A `<Dialog>` component (planned for `@smirk/ui`) will implement this.
Build new modal interactions on top of `<Dialog>`. If you find
yourself wiring
focus manually, you're either extending `<Dialog>` (good — submit a
PR) or duplicating it (bad — use the component).

### Tablist

Pattern: `role="tablist"` on the strip, `role="tab"` with
`aria-selected` on each tab, `aria-controls` pointing to the
`role="tabpanel"` element, arrow keys move focus between tabs, Home /
End jump to first / last, Enter or Space activates focus-moved tab.

`@smirk/ui`'s `BottomNav` and `BrowserTabStrip` implement this. Build
new tab strips on those primitives.

### Focus trap

Used inside dialogs and wizards. A `useFocusTrap()` hook (planned
for `@smirk/ui`) will handle the mechanics. Apply when an interaction
must
not let focus escape until completed.

### Skip link

For surfaces with significant chrome (the wallet desktop window, the
embedded browser), provide a "Skip to content" link that becomes
visible on focus. First focusable element in DOM order. Bypasses
chrome for screen-reader and keyboard users.

### Form fields

Every input has an associated `<label>`, either wrapping the input or
via `for=`. Error messages are wired via `aria-describedby` and use a
live region. Validation state is communicated through both color AND
text (color blindness).

## Keyboard map

Keyboard shortcuts are centralized in **`@smirk/keymap`** so the
extension, desktop, and mobile builds map the same actions to
platform-appropriate bindings. Adding a new shortcut means:

1. Adding an action to the `KeymapAction` enum.
2. Adding per-platform bindings in the keymap manifest.
3. Hooking the action in the consuming component via `useKeymap()`.

Never bind keys directly with `addEventListener('keydown', ...)` —
that path leads to platform-divergent shortcuts and conflict bugs.

## Color, theme, motion

### Contrast

WCAG AA: **4.5:1 for text**, **3:1 for large text and UI components**.
AAA: 7:1 for text. Themes will be checked in CI via a planned
`packages/ui/src/themes/__tests__/contrast.test.ts` — a theme that
fails AA must either be fixed or accompanied by an HC ("High
Contrast") sibling variant.

Color is never the only signaling. A confirmation icon AND green AND
the word "Confirmed". An error icon AND red AND the word "Failed".

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  .smirk-spin, .smirk-progress-bar, .smirk-fade-in {
    animation: none !important;
  }
}
```

Components that introduce animation declare a reduced-motion
variant in their CSS. No exceptions.

### High contrast

```css
@media (prefers-contrast: more) {
  /* swap to high-contrast color tokens */
}
```

Every theme defines a high-contrast variant or documents the
exception in its theme file.

## Internationalization-ready labels

All `aria-label`, `aria-describedby` targets, and error message strings
go through `t()` (the i18n helper in `@smirk/core`). Even for
English-only builds, the indirection is mandatory — adds zero runtime
cost, makes the eventual Spanish / Japanese / etc. ship a translation
task instead of a refactor.

```tsx
// Required:
<button aria-label={t('browser.tab.close')}>×</button>

// Forbidden:
<button aria-label="Close tab">×</button>
```

## Cross-platform parity

When a component lives in `@smirk/ui` and ships on extension +
desktop + mobile, the same screen-reader announcement must fire on
each. Concretely:

- Labels are identical (one `t()` key, three platforms).
- Roles and ARIA states are identical (the HTML is identical).
- Focus order is identical (DOM order is identical).
- Keyboard shortcuts are equivalent under `@smirk/keymap`.

Platform divergence is permitted only where the platform expects it
(e.g. iOS uses VoiceOver gestures, no keyboard shortcuts; Android
uses TalkBack swipes). These divergences live in `@smirk/keymap`'s
per-platform overrides, NOT in component code.

## Testing matrix

### Automated (CI, every PR)

- **`eslint-plugin-jsx-a11y`** — catches the structural problems
  (`role="button"` on a div, missing `alt`, click-without-keypress,
  etc.). See "Toolchain — to be added" below.
- **`@axe-core/preact`** in component tests — runtime checks (contrast,
  focus order, ARIA validity). One axe assertion per significant
  interactive component.
- **Theme contrast tests** in
  `packages/ui/src/themes/__tests__/contrast.test.ts` — every theme
  satisfies WCAG AA or has a documented HC variant.

### Manual (pre-release, every minor version)

Run the full wallet flow (unlock, send, receive, swap, claim,
clawback, dapp connect, dapp request payment, dapp claim public tip)
under each of:

- **VoiceOver** on macOS desktop
- **VoiceOver** on iOS
- **NVDA** on Windows desktop
- **JAWS** on Windows desktop
- **TalkBack** on Android

Plus keyboard-only navigation (no mouse / no touch) on extension +
desktop builds.

Findings get recorded in `docs/ACCESSIBILITY_LOG.md` (parallel to
`docs/SECURITY_LOG.md`) — public, transparent, dated.

## Contribution checklist

The pull-request template (`.github/PULL_REQUEST_TEMPLATE.md`) ships a
checklist. The short version, for reference:

- [ ] Semantic HTML used; ARIA only where HTML cannot express the
      concept.
- [ ] All interactive elements have accessible names (label, alt,
      `aria-label`, or `aria-labelledby`).
- [ ] Keyboard navigation works (Tab, Shift+Tab, Enter, Space,
      Escape, arrow keys where applicable). No focus traps that lack
      escape.
- [ ] Touch targets meet platform minimums (44pt iOS, 48dp Android).
- [ ] Color is never the sole signaling channel.
- [ ] Animations respect `prefers-reduced-motion`.
- [ ] All visible text strings go through `t()`.
- [ ] If the change introduces a new interaction pattern, the pattern
      is added to this document.
- [ ] If the change introduces a new dynamic announcement, it routes
      through `<LiveRegion>`.
- [ ] axe-core sweep added to the component's tests.

## Toolchain — tracked for v0.3.x

v0.3.0 ships the conventions and the static patterns above; the
following supporting toolchain is the next pass. Tracked here so it
doesn't drift; each item should land in its own PR:

- **ESLint** with `@typescript-eslint`, `eslint-plugin-preact`, and
  `eslint-plugin-jsx-a11y`. Parser / plugin / rule-set choices
  warrant their own design pass.
- **`@axe-core/preact`** as a monorepo dev dep with example test in
  `packages/ui/src/components/browser/__tests__/a11y.test.ts`.
- **`<LiveRegion>` component** in `@smirk/ui` — central live-region
  router with politeness-level mapping.
- **`<Dialog>` component** in `@smirk/ui` — focus trap +
  return-focus pattern.
- **`useFocusTrap()` hook** in `@smirk/ui`.
- **`<SkipLink>` component** for the desktop wallet shell.
- **Theme contrast test** in
  `packages/ui/src/themes/__tests__/contrast.test.ts`.

Update this list (add new gaps, remove shipped items) in the same PR
that introduces or removes the toolchain piece.

## Public posture

Accessibility is a property worth telling users about. When v0.3.0
ships, the website's footer links to this document; the release notes
mention the standards we target. We document our gaps, we publish the
SR test log, we accept community-reported accessibility issues
through the same channel as security issues. A wallet that
non-disabled users can't tell is accessible is one that disabled
users can use — which is the point.
