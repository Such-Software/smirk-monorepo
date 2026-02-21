#!/usr/bin/env python3
"""Rename all monero-* package names to wownero-* for crates.io publishing.

Changes:
1. [package] name: monero-X -> wownero-X
2. Add [lib] name = "monero_X" to preserve Rust import names
3. Internal path deps: add package = "wownero-X" (and version if missing)
4. Repository URLs: monero-oxide/monero-oxide -> Such-Software/monero-oxide
5. Main crate version: 0.1.4-alpha -> 0.1.0
6. Workspace profile.dev.package: monero-X -> wownero-X
"""
import re
import os

ROOT = os.path.dirname(os.path.abspath(__file__))

# Internal crates and their versions (for adding missing version specs)
INTERNAL_CRATES = {
    "monero-io": "0.1",
    "monero-primitives": "0.1",
    "monero-ed25519": "0.1",
    "monero-mlsag": "0.1",
    "monero-clsag": "0.1",
    "monero-borromean": "0.1",
    "monero-bulletproofs-generators": "0.1",
    "monero-bulletproofs": "0.1",
    "monero-oxide": "0.1",
    "monero-base58": "0.1",
    "monero-address": "0.1",
    "monero-wallet": "0.1",
    "monero-epee": "0.2",
    "monero-interface": "0.1",
    "monero-daemon-rpc": "0.1",
    "monero-simple-request-rpc": "0.1",
}

def rename_pkg(name):
    return name.replace("monero-", "wownero-", 1)

def to_lib_name(pkg_name):
    """monero-oxide -> monero_oxide"""
    return pkg_name.replace("-", "_")

def transform_subcrate(filepath, add_lib=True):
    with open(filepath) as f:
        content = f.read()

    # 1. Package name
    m = re.search(r'^name = "(monero-[^"]+)"', content, re.MULTILINE)
    if m:
        old_pkg = m.group(1)
        new_pkg = rename_pkg(old_pkg)
        old_lib = to_lib_name(old_pkg)
        content = content[:m.start()] + f'name = "{new_pkg}"' + content[m.end():]

        # 2. Add [lib] section after rust-version line
        if add_lib:
            rv = re.search(r'^rust-version = "[^"]+"\n', content, re.MULTILINE)
            if rv:
                pos = rv.end()
            else:
                ed = re.search(r'^edition = "[^"]+"\n', content, re.MULTILINE)
                pos = ed.end() if ed else None
            if pos is not None:
                content = content[:pos] + f'\n[lib]\nname = "{old_lib}"\n' + content[pos:]

    # 3. Repository URLs
    content = content.replace(
        "github.com/monero-oxide/monero-oxide",
        "github.com/Such-Software/monero-oxide"
    )

    # 4. Internal path deps: add package = "wownero-X" (and version if missing)
    for crate_name, ver in INTERNAL_CRATES.items():
        wname = rename_pkg(crate_name)
        pat = r'^(' + re.escape(crate_name) + r'\s*=\s*\{)([^}]*path\s*=\s*"[^"]*"[^}]*)(\})'
        pattern = re.compile(pat, re.MULTILINE)
        def make_replacer(wn, v):
            def replacer(match):
                prefix = match.group(1)
                middle = match.group(2)
                suffix = match.group(3)
                if 'package =' in middle:
                    return match.group(0)
                additions = ""
                if 'version' not in middle:
                    additions += f', version = "{v}"'
                additions += f', package = "{wn}"'
                return f'{prefix}{middle}{additions}{suffix}'
            return replacer
        content = pattern.sub(make_replacer(wname, ver), content)

    # 5. Fix main crate version
    content = content.replace('version = "0.1.4-alpha"', 'version = "0.1.0"')

    with open(filepath, 'w') as f:
        f.write(content)
    print(f"  {filepath}")

def transform_workspace(filepath):
    with open(filepath) as f:
        content = f.read()

    for crate_name in INTERNAL_CRATES:
        wname = rename_pkg(crate_name)
        content = content.replace(
            f'{crate_name} = {{ opt-level = 3 }}',
            f'{wname} = {{ opt-level = 3 }}'
        )
        # Handle missing-space variant: monero-bulletproofs = {opt-level = 3 }
        content = content.replace(
            f'{crate_name} = {{opt-level = 3 }}',
            f'{wname} = {{opt-level = 3 }}'
        )

    with open(filepath, 'w') as f:
        f.write(content)
    print(f"  {filepath}")

# Published sub-crates
SUBCRATES = [
    "monero-oxide/io/Cargo.toml",
    "monero-oxide/primitives/Cargo.toml",
    "monero-oxide/ed25519/Cargo.toml",
    "monero-oxide/ringct/mlsag/Cargo.toml",
    "monero-oxide/ringct/clsag/Cargo.toml",
    "monero-oxide/ringct/borromean/Cargo.toml",
    "monero-oxide/ringct/bulletproofs/generators/Cargo.toml",
    "monero-oxide/ringct/bulletproofs/Cargo.toml",
    "monero-oxide/Cargo.toml",
    "monero-oxide/wallet/base58/Cargo.toml",
    "monero-oxide/wallet/address/Cargo.toml",
    "monero-oxide/wallet/Cargo.toml",
    "monero-oxide/epee/Cargo.toml",
    "monero-oxide/interface/Cargo.toml",
    "monero-oxide/interface/daemon/Cargo.toml",
    "monero-oxide/interface/daemon/simple-request/Cargo.toml",
]

TEST_CRATES = [
    "tests/no-std/Cargo.toml",
    "tests/verify-chain/Cargo.toml",
]

print("Renaming sub-crate Cargo.toml files:")
for f in SUBCRATES:
    transform_subcrate(os.path.join(ROOT, f), add_lib=True)

print("\nRenaming test crate Cargo.toml files:")
for f in TEST_CRATES:
    transform_subcrate(os.path.join(ROOT, f), add_lib=False)

print("\nUpdating workspace root:")
transform_workspace(os.path.join(ROOT, "Cargo.toml"))

print("\nDone!")
