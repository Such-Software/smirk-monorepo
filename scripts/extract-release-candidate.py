#!/usr/bin/env python3
"""Extract a workflow candidate without links, traversal, or special files."""
import pathlib
import shutil
import sys
import tarfile
import zipfile


def destination(root, name):
    relative = pathlib.PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or '\\' in name:
        raise ValueError('Archive contains an unsafe path')
    target = root.joinpath(*relative.parts)
    if target.exists():
        raise ValueError('Archive contains duplicate paths')
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def extract(archive, root):
    root.mkdir(parents=True)
    total = 0
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for item in source.infolist():
                if item.is_dir():
                    continue
                mode = (item.external_attr >> 16) & 0o170000
                if mode not in (0, 0o100000):
                    raise ValueError('Archive contains a link or special file')
                total += item.file_size
                if total > 8 * 1024 ** 3:
                    raise ValueError('Archive exceeds candidate size limit')
                with source.open(item) as reader, destination(root, item.filename).open('xb') as writer:
                    shutil.copyfileobj(reader, writer)
    else:
        with tarfile.open(archive, 'r:gz') as source:
            for item in source:
                if item.isdir():
                    continue
                if not item.isfile():
                    raise ValueError('Archive contains a link or special file')
                total += item.size
                if total > 8 * 1024 ** 3:
                    raise ValueError('Archive exceeds candidate size limit')
                reader = source.extractfile(item)
                if reader is None:
                    raise ValueError('Archive member cannot be read')
                with reader, destination(root, item.name).open('xb') as writer:
                    shutil.copyfileobj(reader, writer)


if __name__ == '__main__':
    try:
        extract(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as failure:
        sys.exit(f'Candidate extraction refused: {failure}')
