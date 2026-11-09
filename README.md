# work-board

Static Kanban UI for a private, Git-backed work queue.

**Board:** https://gqgs.github.io/work-board/ (available after GitHub Pages is enabled)

## Public UI, private tasks

- This public repository contains only the static UI, tests and setup instructions. It has fresh history, separate from the private task repository.
- `gqgs/work` remains private. Its `main` branch and `tasks/*.md` files remain the source of truth.
- The browser reads and writes tasks directly through `https://api.github.com/repos/gqgs/work`. Each create, edit or status move creates one commit in the private repository.
- No task files, task exports, private Git history or credentials belong in this repository. Task edits do not redeploy the UI.
- There is no backend, database, build step, dependency download or third-party script.

## Enable GitHub Pages

Open [Settings → Pages](https://github.com/gqgs/work-board/settings/pages), select **Deploy from a branch**, choose **main** and **/docs**, then save. After deployment, open [the board](https://gqgs.github.io/work-board/).

## Enter your token

1. Open the board and select **Connect GitHub**.
2. Paste your fine-grained personal access token into **GitHub access token** and select **Connect**.
3. The token must be limited to **gqgs/work** with **Contents: Read and write**. Metadata read access is included automatically. It does not need access to this public UI repository.

Enter the token only in the board's connection dialog. Do not put it in source code, a URL, chat, repository secrets, or a GitHub Actions variable. No server-side token is needed.

The app holds the token only in this tab's memory. It sends the token only to GitHub's REST API and discards it on refresh, disconnect, or canceled connection. It does not use localStorage, sessionStorage, cookies or a service worker to persist credentials. You will need to reconnect after reloading the page.

A token with write access can change files in the selected private repository. Use an expiry, keep it private, and only enter it on a copy of the UI you trust. The UI code runs in your browser; anyone who can change the published UI can change that code.

Without a token, visitors can see the empty interface but cannot load the private tasks.

## Development

The deployable site is the four files in `docs/`, plus `.nojekyll`. Keep `REPO = "gqgs/work"` and `BRANCH = "main"` in `docs/app.mjs` unless deliberately changing the private data destination.

Run the dependency-free tests with Node.js:

```sh
node --test tests/*.test.mjs
```

Serve locally:

```sh
python -m http.server 8000
# Open http://localhost:8000/docs/
```

The tests use synthetic fixtures and fake tokens. They never read or write live tasks. Conflicts must be surfaced rather than silently overwriting concurrent edits.
