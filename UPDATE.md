# Updating the Excalibur repo

1. Copy these files into the repo, replacing `index.html`, `server.js`, `README.md` and `games.json`.
   `ExcaliburV2.html` is an old copy of index.html and can be deleted.

2. Add the game folders. They were never uploaded to this repo, which is why every game said "Not Found".
   Copy these folders from your Excalibur-V1 folder into this repo, next to server.js:
     gunmayhem  tinyfishing  drift-boss  geometrydash  btd6  lawson  Stickwar  polytrack  fnae  cookieclicker  realcookieclicker  js
   GitHub's "Add files via upload" stops at 100 files / 25 MB at a time, and btd6 alone is about 1,500 files and 300 MB,
   so push them from your computer with git (or GitHub Desktop):
     git clone https://github.com/Sleetzlol/Excalibur
     (copy the folders in)
     git add .
     git commit -m "Add game folders"
     git push
   No single file is over 100 MB, so plain git works (no Git LFS needed).

3. Render redeploys after the push. Open a game from the Games page to check.
