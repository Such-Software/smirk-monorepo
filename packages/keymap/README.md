# @smirk/keymap

Cross-platform keyboard-shortcut registry for Smirk Wallet.

This package answers a narrow question:

> What key combination on this platform triggers which logical action,
> consistently across browser extension, desktop, and mobile?

Without it, every surface ships its own `addEventListener('keydown')`
calls and the wallet's shortcut model drifts platform by platform.
With it, shortcuts are defined once and platform-shaped through one
manifest.

If you're new, read
[docs/ACCESSIBILITY.md#keyboard-map](../../docs/ACCESSIBILITY.md#keyboard-map)
first for context.

## Add a new shortcut

1. Append the action name to `KeymapAction` in `src/types.ts`. The
   string value is persisted in user preferences if the user remaps,
   so once shipped it does not change.
2. Append a `KeymapEntry` to `DEFAULT_KEYMAP` in `src/keymap.ts` with
   the platform bindings. Use `desktopTrio()` and `extensionTrio()`
   when the same key works on all three desktop OSes / extension
   hosts.
3. In the consuming component, call `actionsFromEvent(event, platform)`
   on the `keydown` handler; dispatch on the returned actions.

## Conventions

- **Mac uses Cmd, Win / Linux use Ctrl.** They are not shared
  bindings — each platform gets its own.
- **Mobile platforms have no keyboard bindings** in the default
  keymap. Mobile equivalents are gestures or in-app buttons, declared
  by the mobile-platform glue.
- **F-keys (F5, etc.)** are added as additional bindings, not
  replacements, when the user's mental model expects them
  (`browser:reload` accepts both `Cmd+R` and `F5`).
- **Modifier-bearing keys** never collide with OS-reserved shortcuts.
  `Cmd+Tab` belongs to the OS; we use `Cmd+Alt+Right` for tab
  navigation on macOS.

## Conventions enforced in review

- No `addEventListener('keydown', ...)` outside `@smirk/keymap` glue.
- No hardcoded chord literals like `if (event.metaKey && event.key === 'l')`
  in component code. Always route through the keymap.
- Action names follow `domain:verb-noun`. Domain choices: `browser:`,
  `wallet:`, `tip:`, `swap:`, `dapp:`. Add a new domain only when
  none of the existing ones fit.

## License

MIT OR Apache-2.0.
