# Native Windows Python worker

The upstream 0.0.21 Windows worker imports VCRUNTIME140.dll. Kissopen builds the pinned source in source.json with Rust's Windows GNU target and includes the worker and MIT license in the Windows executable. The Node native addon remains the upstream package; worker IPC is tested against that exact package version. macOS and Linux keep their upstream workers.

Run pnpm --filter @kissopen/kissopen-agent build:native:monty with the pinned Rust GNU toolchain and a GNU linker available, then pnpm --filter @kissopen/kissopen-agent test:native:monty. KISSOPEN_MONTY_SOURCE_DIR can reuse an existing clean checkout at the pinned commit. The build fails if imports require a non-system DLL. No compiler or Visual C++ redistributable is needed on the end user's machine for this worker.
