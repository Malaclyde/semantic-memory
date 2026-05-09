# Bugfix: Duplicate libvips/Objective-C class warning

## Symptoms

On macOS, OpenCode console floods with:

```
objc[XXXX]: Class GNotificationCenterDelegate is implemented in both
  .../node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib (0x...)
and
  .../.config/opencode/node_modules/sharp/vendor/8.14.5/darwin-arm64v8/lib/libvips-cpp.42.dylib (0x...)
One of the duplicates must be removed or renamed.
```

## Root Cause

Two different versions of `sharp` (and its native `libvips` dependency) are loaded in the same process:

| Source | Package | libvips path |
|--------|---------|--------------|
| OpenCode itself | `sharp` (older, ~v0.32) | `sharp/vendor/` |
| Our plugin (via `@huggingface/transformers`) | `@img/sharp-libvips-*` (newer, v0.33+) | `@img/sharp-libvips-*/lib/` |

Starting with sharp v0.33, the libvips binaries were moved into platform-specific `@img/sharp-libvips-*` packages. OpenCode bundles an older sharp that vendors libvips the traditional way. Both dylibs get `dlopen`'d, and macOS's Objective-C runtime detects the duplicate `GNotificationCenterDelegate` class.

## Severity

**Low.** This is a macOS ObjC runtime diagnostic warning, not a crash or functional error. Both sharp instances operate independently. However, the message floods stderr on every opencode session.

## Options

| Option | Effort | Risk | Notes |
|--------|--------|------|-------|
| **A. Accept** | None | None | Warning only, no functional impact |
| **B. Dedupe via overrides** | Low | Medium | Add `overrides` in plugin `package.json` to force a single sharp version. Fragile — depends on OpenCode's exact sharp version. |
| **C. Mark sharp as external** | Low | Medium | Add sharp to plugin's `peerDependencies` so npm/bun hoists to OpenCode's version. May fail if API is incompatible. |
| **D. Bump plugin's huggingface transformers** | Low | Low | Newer versions may have updated their sharp dependency range to match modern versions. |

## Related Crash: Bun panic on exit

When closing OpenCode, Bun crashes with:

```
panic: NAPI FATAL ERROR: Error::New napi_create_error

napi.zig:1189: napi_fatal_error
napi.h:727: Zig::NapiRef::callFinalizer
napi.h:445: NapiEnv::BoundFinalizer::call(...)
napi.h:211: NapiEnv::cleanup
rare_data.zig:489: CleanupHook.execute
VirtualMachine.zig:893: onExit
```

### Root Cause

Same as the libvips duplicate above. The two conflicting `sharp`/`libvips` versions both register N-API native addons (`napi_module_register` is in the Bun "Features" list). On process exit, Bun runs N-API finalizers. The corrupted ObjC runtime state (from the duplicate `GNotificationCenterDelegate` class) causes the finalizer for one of the dylibs to trigger `napi_create_error`, which panics inside Bun's Zig runtime.

### Severity

**HIGH.** This is a hard crash, not a warning. OpenCode exits with a Bun panic instead of a clean shutdown. This can lose unsaved state.

### Connection

Both symptoms share the same root cause — two conflicting `sharp`/`libvips` versions in the same process. Fixing the duplicate (see options above) will resolve both the warning and the crash.

## Recommendation

Regardless of which option is chosen from the table above, this is no longer cosmetic. The duplicate libvips must be resolved to prevent the Bun crash on shutdown.
