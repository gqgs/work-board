# Agent instructions: gqgs/work-board

This public repository contains only the static work-board UI. Keep it small and dependency-free.

- Deploy `main:/docs` through GitHub Pages.
- Task data and task history stay in the private `gqgs/work` repository on `main` under `tasks/`. Never copy or merge its Git history into this repository.
- Review every published file. Never add task files, exports, credentials, cookies, screenshots of private tasks or other private content.
- Keep token handling in tab memory only. Never add token persistence or third-party script assets.
- The API target is `gqgs/work`, not this UI repository. Every task write creates one commit in the private repository and must use the current file SHA for conflict protection.
- Run `node --test tests/*.test.mjs` after changes. Test interrupted connection, disconnect, repeated saves, and conflict handling as relevant.
- Test fixtures must be synthetic and contain no real work items or access tokens.
- Do not automatically generate more PRs to improve the board. Prefer finishing requested work over adding tooling to maintain tooling.
