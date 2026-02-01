# sqlite-vec Binaries (Legacy)

**Note:** sqlite-vec is now installed automatically via npm (`npm install sqlite-vec`).
This directory is only used as a fallback if the npm package fails to load.

## Automatic Installation

When you run `npm install`, the sqlite-vec package is installed with prebuilt binaries
for all supported platforms. No additional setup required.

## Fallback: Manual Installation

If the npm package fails, you can manually download binaries from the
[sqlite-vec releases page](https://github.com/asg017/sqlite-vec/releases).

Place the binary in the corresponding directory:
- `darwin-arm64/vec0.dylib` - macOS Apple Silicon
- `darwin-x64/vec0.dylib` - macOS Intel
- `linux-x64/vec0.so` - Linux x64
- `linux-arm64/vec0.so` - Linux ARM64

## Load Order

The system tries to load sqlite-vec in this order:
1. **npm package** (recommended, works out of the box)
2. **System paths** (Homebrew, /usr/local/lib, etc.)
3. **Bundled binaries** (this directory)

## Graceful Degradation

If sqlite-vec is not available:
1. Vector search will be disabled
2. Keyword search (Fase 2) will be used instead
3. The system remains fully functional
