<!--
  Smirk Wallet: pull request template.

  Replace this comment block with a brief summary of the change. The
  checklists below set the bar; tick them off as you go, leave a
  note next to ones that don't apply.
-->

## Summary

<!-- 1–3 sentences. What changes, and why. Link to the issue if one
     exists. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (call out in `CHANGELOG.md` under "Compatibility")
- [ ] Documentation only
- [ ] Tooling / CI / build only

## Test plan

<!-- How did you verify this? List the manual + automated steps.
     "It compiles" is not a test plan. -->

- [ ] `npm run typecheck` clean across affected packages
- [ ] `npm test` clean (or new tests added when behaviour changes)
- [ ] `cargo check` clean if Rust changed
- [ ] Manual smoke test of the affected flow

## Accessibility checklist

Required for any PR that touches user-visible UI. See
[docs/ACCESSIBILITY.md](../docs/ACCESSIBILITY.md) for the full
standards reference.

- [ ] Semantic HTML used; ARIA only where HTML cannot express the
      concept.
- [ ] All interactive elements have accessible names (`<label>`,
      `alt`, `aria-label`, or `aria-labelledby`).
- [ ] Keyboard navigation works (Tab, Shift+Tab, Enter, Space,
      Escape, arrows where applicable). No focus traps without an
      escape.
- [ ] Touch targets meet platform minimums (44×44 pt iOS,
      48×48 dp Android).
- [ ] Color is never the sole signaling channel (icon AND text AND
      color).
- [ ] Animations respect `prefers-reduced-motion`.
- [ ] All visible text strings go through `t()` (i18n-ready, even
      for English-only ship).
- [ ] Dynamic announcements use a polite live region rather than
      ad-hoc DOM updates.
- [ ] If the change introduces a new interaction pattern, the
      pattern is documented in `docs/ACCESSIBILITY.md`.
- [ ] If the change introduces or alters a keyboard shortcut, the
      action is registered in `@smirk/keymap`, not bound directly.

## Security checklist

Required for any PR that touches signing, encryption, key handling,
auth, dapp surface, network egress, or storage.

- [ ] No private keys, mnemonics, or unencrypted secrets logged.
- [ ] Network egress targets are CSP-allowed in the relevant
      manifest (extension, Tauri config).
- [ ] User-provided inputs validated at trust boundaries.
- [ ] Cryptographic primitives use vetted libraries
      (`@noble/*`, `@scure/*`, monero-oxide, secp256k1zkp). No
      hand-rolled crypto.
- [ ] Errors do not leak secrets (timing, error messages, log
      strings).
- [ ] If the change is security-relevant, say so in the PR summary so a
      maintainer can record it.

## Cross-platform parity

For changes that affect `@smirk/ui`, `@smirk/core`, `@smirk/assets`,
`@such-software/smirk-dapp-api`, `@smirk/dapp-browser`, or `@smirk/keymap`:

- [ ] Behaviour is the same on extension, desktop, and mobile (or
      divergence is documented and intentional).
- [ ] Labels and screen-reader announcements are the same on all
      platforms (one `t()` key per concept).

## Documentation

- [ ] User-facing changes are in `CHANGELOG.md`.
- [ ] Internal architecture changes are in the relevant `docs/*.md`
      file or a `README.md`.
- [ ] Public API changes update the relevant package `README.md`.

## Screenshots / demos

<!-- Optional but appreciated for UI changes. Drag images here. -->
