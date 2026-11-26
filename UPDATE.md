# Updating the Excalibur-V1 repo

1. Copy everything in this folder into the root of the repo (next to the game folders), replacing `index.html` and `server.js`.
   New files: `games.json`, `icons/` (your six tab icons, moved there), `package.json`, `README.md`.
2. These files are no longer used and can be deleted:
   `ExcaliburV2.html` (a copy of index.html), `games.html`, `apps.html`, `settings.html`, `sandstone.html`,
   and the six `.ico` files in the root (now in `icons/`). Keep `favicon.ico` and `js/` (nine game pages load `js/cloak.js`).
3. Commit and push. On Render the start command is `node server.js`; your environment variables stay the same.

To add a game later: put its folder in the repo and add a line to `games.json`.
