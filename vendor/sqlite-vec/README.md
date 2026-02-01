# sqlite-vec Binaries

This directory contains prebuilt sqlite-vec binaries for vector similarity search.

## Installation Options

### Option 1: System Installation (Recommended)

**macOS (Homebrew):**
```bash
brew install asg017/sqlite-vec/sqlite-vec
```

**Linux:**
Download from [sqlite-vec releases](https://github.com/asg017/sqlite-vec/releases)
and place in `/usr/local/lib/vec0.so`

### Option 2: Bundled Binaries

Download the appropriate binary for your platform from the
[sqlite-vec releases page](https://github.com/asg017/sqlite-vec/releases)
and place it in the corresponding directory:

- `darwin-arm64/vec0.dylib` - macOS Apple Silicon
- `darwin-x64/vec0.dylib` - macOS Intel
- `linux-x64/vec0.so` - Linux x64
- `linux-arm64/vec0.so` - Linux ARM64

## Fallback Behavior

If sqlite-vec is not available:
1. The system will log a warning
2. Vector search will be disabled
3. Keyword search (Fase 2) will be used instead

This is graceful degradation - the system remains fully functional.

## Version Compatibility

The sqlite-vec version must be compatible with the better-sqlite3 version used.
If you encounter symbol errors, try:
1. Updating both packages
2. Using the system installation instead of bundled
3. Rebuilding sqlite-vec against your SQLite version
