# Excalibur server

One small Node program (no dependencies) that serves the game page and runs everything online:
accounts, wallets and gifts, friends, global chat, rooms, voice signalling, reports and moderation,
and the host-run multiplayer for Bedwars and Parkour.

    node server.js          # then open http://localhost:8080 in two browsers

## Put it on Render
1. Put this folder in a GitHub repository (the folder is the repo root).
2. Render: **New > Web Service**, connect the repository. Runtime **Node**, build command empty, start command `node server.js`, health check path `/healthz`.
3. Add the environment variables below (at least `ADMIN_TOKEN`, and Supabase if you want accounts to survive restarts).
4. Open your `.onrender.com` address. The dot in the room bar turns green when you are online.

## Environment variables
| Name | What it does |
| --- | --- |
| `OWNER_PASSWORD` | Creates the account named `Owner` with this password (12+ characters) and turns on the in-game **Admin** tab for that account only. |
| `OWNER_USERNAME` | Optional: use a different name for the owner account (default `Owner`). |
| `ADMIN_TOKEN` | Turns on the web page `/admin` (reports) and the token endpoints. Use a long random value. |
| `SUPABASE_URL`, `SUPABASE_KEY` | Store accounts in Supabase (below). Use the **service_role** key and keep it secret. |
| `DATA_DIR` | Where `accounts.json` lives when Supabase is not used (default `./data`). |
| `EMAIL_API_KEY`, `EMAIL_FROM` | Send email through Resend (below). |
| `EMAIL_API_URL` | Another provider that accepts the same JSON (default `https://api.resend.com/emails`). |
| `MAIL_DEV=1` | No provider yet? Emails are printed in the log and shown at `/admin/outbox`. Testing only. |
| `ALLOWED_ORIGINS` | Comma separated list of sites allowed to connect, e.g. `https://excalibur.onrender.com`. Empty means any. |
| `METERED_DOMAIN`, `METERED_API_KEY` | Free TURN servers for voice from metered.ca (see Voice). |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Or Cloudflare's TURN service. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Or any TURN server you run or rent. `TURN_URL` can hold several addresses separated by commas. |
| `ICE_SERVERS` | Advanced: a full JSON list of WebRTC servers. |
| `TRUST_PROXY` | Leave on behind Render. `0` if the server is directly on the internet. |

## Changing environment variables on Render
1. dashboard.render.com, click your service.
2. Left sidebar: **Environment**.
3. **Add Environment Variable**, type the name in **Key** and the value in **Value** (repeat for more).
4. **Save Changes**. Render redeploys automatically; watch the **Logs** tab for the startup lines.

## The Owner admin panel
Set `OWNER_PASSWORD` (12+ characters). On the next start the log says `Admin panel: on`. Sign in on the Account page with the username `Owner` and that password, and an **Admin** tab appears.
Only that account sees it, nobody else can register the name `Owner`, and requests from anyone else get no answer at all.
- **Overview:** live status (saving, email, voice), give coins to anyone including yourself, send an announcement, and see who is connected (with Kick).
- **Players:** look up an account, add or set coins, unlock every cosmetic, ban (1 hour up to permanent) or lift a ban, mute or unmute.
- **Chat:** delete single messages or clear a global channel; everyone sees it disappear live.
- **Reports:** read the evidence and Dismiss, Mute for an hour, or Ban for a day.
- **Audit log:** a record of everything you did.

The owner account cannot be banned, muted or kicked. If you change `OWNER_PASSWORD`, the owner's password changes at the next restart. If an account called Owner already existed
(someone registered it before this feature), it is taken over: its password is reset and its email removed. There is no two-factor sign-in, so use a long password; five wrong guesses lock the account for five minutes.

### Admins and rainbow nametags
The owner can make anyone an admin: Admin tab > Players > look the person up > **Make admin** (and **Remove admin** to undo it; it takes effect live, no reload).
- The owner and every admin get an **animated rainbow nametag** in the lobby and casino, in the People list, in global chat and in the sidebar (the owner has a 👑, admins a ⭐).
- Admins get a limited Admin tab: they can see who is online, look up players, **mute, ban and kick** normal players, **delete or clear chat messages**, and handle reports.
- Admins **cannot** give coins, unlock cosmetics, send announcements or make other admins, cannot see IP addresses or emails, and cannot moderate the owner or other admins. Only the owner can ban an admin.
- The audit log records who did what.

## Saving accounts (Supabase)
Render's free plan wipes its disk on every restart, which would delete every account. Supabase's free plan fixes that.
1. Create a free project at supabase.com.
2. SQL Editor: paste and run `supabase.sql` (one table, locked to your server).
3. Project Settings > API: copy the **Project URL** into `SUPABASE_URL` and the **service_role** key into `SUPABASE_KEY`.
4. Redeploy. The log says `Accounts loaded from Supabase` on start.

The server saves a few seconds after any change. If Supabase cannot be reached when the server starts, it exits instead of running
on an empty database (which could overwrite your real data); Render then restarts it and tries again.
**If it does not start,** open the **Logs** tab: the line after `Supabase load failed:` says what is wrong.
- *rejected the key*: use the **service_role** (or "secret", `sb_secret_...`) key from Project Settings > API, not the anon/publishable key. Paste it with no spaces.
- *kv table was not found*: run `supabase.sql` in the SQL Editor, then restart.
- *host could not be found*: `SUPABASE_URL` has a typo; it should look like `https://abcdxyz.supabase.co`.
After it is running, the Admin overview shows whether saving is working, and shows the reason in red if it stops.
Supabase free projects pause after about a week with no activity; restore the project from its dashboard if that happens.

Without Supabase, accounts are kept in `accounts.json`, which only survives on a paid Render plan with a Persistent Disk (set `DATA_DIR` to its mount path).

## Email (verification, sign in, password reset)
1. Create an account at resend.com and an API key. For quick tests you can send from `onboarding@resend.dev` (it only delivers to your own address);
   to email everyone, verify a domain with Resend.
2. Set `EMAIL_API_KEY` and `EMAIL_FROM` (for example `Excalibur <noreply@yourdomain.com>`).
3. Players add an email on the Account page, type the 6-digit code they receive, and from then on can sign in with it and use **Forgot password?**.

Codes work for 15 minutes and 5 tries. A reset signs out every session and emails a "your password was changed" notice. The reset form gives the same answer
whether or not the account exists, so it cannot be used to look up usernames. If no email provider is configured the Account page says so.

## Multiplayer Bedwars and Parkour
Both open an online intermission (up to 16 players for Bedwars, 8 for Parkour). The room's **master client** is the host: the first player in, handed to the longest-standing player
if they leave. When the host starts the match, the room locks, empty slots fill with bots, and:
- **Bedwars:** the host's browser runs the whole game. Everyone else sends inputs and draws snapshots (about 15 a second).
- **Parkour:** everyone moves their own runner; the host runs the bots, the clock, finish places and eliminations.
- A player who leaves is replaced by a bot. If the host leaves, everyone gets a "match ended" screen and a few coins.
- The host must keep their tab open and visible; a hidden tab pauses the match for everybody.
You can build your own games on the same pieces: `session.rpc(name, args, target)` (`'others'`, `'all'`, `'master'` or a player id), `session.on(name, fn)`,
`session.isMaster()`, `session.onMaster`, `session.onJoin`, `session.onLeave`, and a `lock` message from the master that closes the room.

## Parkour: Classic and Hardcore
Both modes are in the Parkour lobby (online, the host picks; offline, you pick). The choice is remembered.
- **Classic:** eight runners on a random course that gets harder every round. The last runner to finish each round is out.
- **Hardcore:** nobody is eliminated for finishing last. Instead a **wall of fire** sweeps through the level after a few seconds and eliminates anyone it catches. Its speed is a share of a runner's top speed: 50% in round 1, about 70% by round 5, 88% by round 10, 97% by round 15 and 100% from round 18 or so, so it gains fast at first and then more slowly. The speed stays the same within a round.
  Runners are 80% faster than in classic (414 px/s instead of 230 px/s). **Everyone has exactly the same speed, bots included.** The maps are much longer (about 9,000 px in round 1, over 40,000 px in round 20) and use a harsher mix of obstacles. Each of the 20 rounds has its own background, and the whole look is dark red. The game ends after round 20. If the last survivors are all caught in the same round, or several clear round 20, a **tiebreaker round** decides it (first to the finish wins, otherwise whoever got furthest).
  New blocks: **spikes**, **phantom** floors that give way almost at once, **dash** pads (a burst of extra speed), **float** pads (a super-jump), and **saws** (moving circular saws that kill on touch). Lava platforms and spike platforms always leave room to take off after you land.
  Coins: 30 per round cleared, plus 400 for winning and 300 for clearing all 20.
- **Classic bots** no longer step backwards for a run-up. Each has its own habits: some hop a lot even on flat ground, and skilled bots tend to hop across backwards conveyors while others walk through. Weaker classic bots run a bit slower than you.
- **Hardcore bots** are much stronger than classic ones: very high skill, almost no mistakes, and half the random hopping. They run at exactly the same speed as you. The one thing they get that you do not is a faster respawn (0.35 s instead of 0.9 s). In simulated games (one course per round) they cleared rounds 3, 6 and 9 with all seven bots, round 12 with five, round 14 with six, round 17 with three and round 20 with two, so roughly half are still running in round 15. These are single samples, so expect variation.
- Online, the host's browser runs the bots, the clock, the fire and the results (same as before); every player sees the same map and fire.

Hardcore maps were tuned with simulated bot runs, and the later rounds get steadily harder (round 20 is meant to be brutal).
Very rarely a generated stretch is nastier than it should be; reporting the round number helps.

## Reports and moderation
Players report from the People list (or by clicking a name in global chat) with a reason and note; the recent chat is attached.
Three different reporters in an hour mute a player for 15 minutes automatically. Players can also Block someone, which hides their chat and mutes their voice on that device.
Open `/admin`, paste your `ADMIN_TOKEN`, and you can Dismiss, Mute for an hour, or Suspend for 24 hours. Other admin endpoints:

    GET  /admin/status?token=T                      accounts, who is online, rooms and their masters
    POST /admin/kick?token=T&id=PLAYER_ID           disconnect and block an address for 10 minutes
    POST /admin/mute?token=T&name=USER&minutes=10   silence an account
    POST /admin/ban?token=T&name=USER&hours=24      suspend an account (hours=0 lifts it)

## Voice chat
Peer to peer WebRTC; the server only passes the set-up messages, so audio never goes through it. Up to 8 people per room.
By default only Google's free **STUN** server is used, which works on many home connections but **not on strict networks (many schools, offices and mobile carriers)**. Those need a **TURN** server to relay the audio.

Easiest free option, Metered:
1. Make a free account at metered.ca and create an app.
2. Copy the app's domain (like `yourapp.metered.live`) and its API key from the dashboard.
3. On Render set `METERED_DOMAIN` and `METERED_API_KEY`. `METERED_DOMAIN` is just your app's domain, like `yourapp.metered.live`. (A bare `yourapp` or a pasted `https://yourapp.metered.live/dashboard` also works.)
   If the log says `could not look up the address`, the domain is misspelled; `Metered rejected the API key` means the key is wrong.
4. Admin > Overview should now say `Voice: Metered TURN`. If it says `STUN only`, check the Logs for `Voice: could not get TURN servers`.

Cloudflare's TURN service (`CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`) and your own server (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) work too.
In a room, the People list shows each voice connection's state, and if one fails you get a message saying why.
You need to allow the microphone in the browser, and the site must be on https (Render does this for you). Headphones avoid echo.

## Limits the server enforces
8 connections per address, 400 in all, 200 rooms, 5,000 accounts. Messages over 8 KB are refused; players sending far too many are slowed and then removed.
Sign-in, email and reset attempts are limited to 10 a minute per address; five wrong passwords lock an account for five minutes.
Gifts are 1 to 5,000 coins, 5,000 a day per sender. Chat is trimmed, stripped of markup, filtered (extend `BAD` in `server.js`) and rate limited.
Names, colors, positions, RPC names and sizes are validated.

## Honest limits
- The games run in players' browsers, so a determined player can change their own coins. The server caps how fast a balance can rise and checks gifts against its own copy,
  but real protection means running the games on the server.
- In Bedwars the host has the best connection to the game; others feel their network delay, and there is no movement prediction.
- Crumbling platforms in Parkour react to your own runner only.
- Voice and the Report button are not available inside Bedwars and Parkour matches yet, and the party system is still local to one browser.
- The Metered and Cloudflare TURN set-ups were tested against stand-in servers, not the real services (Cloudflare's request format is from memory), so check Admin > Overview after you set one.
- Rooms and global chat history are in memory and reset on restart.
- There is no two-factor sign-in.
- Email and Supabase were tested against stand-in servers, so the first real email and first real Supabase connection are worth trying out before you rely on them.
- A free Render instance sleeps after about 15 minutes with no visitors; the first visit afterwards takes around half a minute.
