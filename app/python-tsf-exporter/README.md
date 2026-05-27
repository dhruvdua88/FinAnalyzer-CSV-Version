# Python TSF Exporter

Standalone Windows-first TSF exporter that hides the bundled Tally loader behind a single launcher and reproduces the current desktop app's TSF SQLite structure.

## Goals

- Generate a `.tsf` file with the same SQLite structure as the current exporter.
- Keep staff away from the loader internals.
- Avoid loading full datasets into Python memory.
- Support both GUI launch and CLI execution.

## Runtime Layout

- `main.py`: development entry point.
- `tsf_exporter/`: application package.
- `vendor/tally-loader/`: private bundled loader root.
- `vendor/node/`: bundled Node runtime when required.
- `config/`: local config files for packaging.

## Developer Run

```bash
python3 main.py
python3 main.py --from 01/04/2025 --to 30/04/2025 --out-dir /tmp
python3 -m unittest discover -s tests -v
```

## Windows Packaging

The intended Windows delivery is a one-directory bundle with a visible `TSF Exporter.exe` launcher and hidden sidecar folders. Use `build_windows_bundle.py` on Windows after placing the real private loader inside `vendor/tally-loader/`.
