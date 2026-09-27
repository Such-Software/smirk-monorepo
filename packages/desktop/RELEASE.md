# Desktop release navigation

> Status: stable · Updated 2026-09-27 · Applies to: Smirk desktop release operators

The app repository owns desktop build inputs. Follow the
[build guide](../../docs/BUILD.md) for prerequisites and the
[desktop packaging and release evidence](README.md#packaging-and-release-evidence)
for the candidate, signing, and verification procedure. Those are the owners;
this page provides navigation only.

CI stages candidates by exact source commit. It does not publish or replace
public release assets. A release requires the complete candidate set, matching
source provenance, macOS signing and notarization, Windows Authenticode, and
detached release signatures. Credential values stay in the enrolled custody
lane. Installation and wallet-operation checks remain required on each platform.

The client currently updates through manual download and reinstall. Plugin
configuration and an updater manifest do not establish automatic updates.

Before release, confirm the linked owners describe the source commit, candidate
collection, signatures, platform verification, and reviewed publication target.
Record release evidence and any unresolved checks in `~/journal`.

## Navigation checklist

- [ ] Build and platform owners are current and linked above.
- [ ] Shared release evidence is complete before publication.
- [ ] Private release receipts remain in the journal.
