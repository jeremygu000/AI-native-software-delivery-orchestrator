# Static Nx workspace fixture

This fixture defines a minimal Nx-shaped repository and a captured project-graph contract without
installing Nx. It is intentionally excluded from the root pnpm workspace.

Future `NxProjectGraphProvider` tests use two tiers:

1. Fast parser and mapping tests consume `project-graph.json` plus the static project files.
2. Live command integration tests create a temporary copy and install a separately pinned Nx
   toolchain only when invoking `nx graph` is the behaviour under test.

Do not add Nx to the root repository to make this fixture executable.
