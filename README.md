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
| `ADMIN_TOKEN` | Turns on `/admin` (reports page) and the admin endpoints. Use a long random value. |
| `SUPABASE_URL`, `SUPABASE_KEY` | Store accounts in Supabase (below). Use the **service_role** key and keep it secret. |
| `DATA_DIR` | Where `accounts.json` lives when Supabase is not used (default `./data`). |
| `EMAIL_API_KEY`, `EMAIL_FROM` | Send email through Resend (below). |
| `EMAIL_API_URL` | Another provider that accepts the same JSON (default `https://api.resend.com/emails`). |
| `MAIL_DEV=1` | No provider yet? Emails are printed in the log and shown at `/admin/outbox`. Testing only. |
| `ALLOWED_ORIGINS` | Comma separated list of sites allowed to connect, e.g. `https://excalibur.onrender.com`. Empty means any. |
| `ICE_SERVERS` | JSON list of WebRTC servers for voice (add a TURN server here, see Voice). |
| `TRUST_PROXY` | Leave on behind Render. `0` if the server is directly on the internet. |

## Saving accounts (Supabase)
Render's free plan wipes its disk on every restart, which would delete every account. Supabase's free plan fixes that.
1. Create a free project at supabase.com.
2. SQL Editor: paste and run `supabase.sql` (one table, locked to your server).
3. Project Settings > API: copy the **Project URL** into `SUPABASE_URL` and the **service_role** key into `SUPABASE_KEY`.
4. Redeploy. The log says `Accounts loaded from Supabase` on start.

The server saves a few seconds after any change. If Supabase cannot be reached when the server starts, it exits instead of running
on an empty database (which could overwrite your real data); Render then restarts it and tries again.
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

## Reports and moderation
Players report from the People list (or by clicking a name in global chat) with a reason and note; the recent chat is attached.
Three different reporters in an hour mute a player for 15 minutes automatically. Players can also Block someone, which hides their chat and mutes their voice on that device.
Open `/admin`, paste your `ADMIN_TOKEN`, and you can Dismiss, Mute for an hour, or Suspend for 24 hours. Other admin endpoints:

    GET  /admin/status?token=T                      accounts, who is online, rooms and their masters
    POST /admin/kick?token=T&id=PLAYER_ID           disconnect and block an address for 10 minutes
    POST /admin/mute?token=T&name=USER&minutes=10   silence an account
    POST /admin/ban?token=T&name=USER&hours=24      suspend an account (hours=0 lifts it)

## Voice chat
Peer to peer WebRTC; the server only passes the set-up messages, so audio never goes through it. Up to 8 people per room. The default uses Google's free STUN server,
and **strict networks (many schools and offices) need a TURN server**. Get one from Metered, Twilio or Cloudflare and set, for example:

    ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:YOUR.HOST:3478","username":"USER","credential":"PASS"}]

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
- Rooms and global chat history are in memory and reset on restart.
- There is no two-factor sign-in.
- Email and Supabase were tested against stand-in servers, so the first real email and first real Supabase connection are worth trying out before you rely on them.
- A free Render instance sleeps after about 15 minutes with no visitors; the first visit afterwards takes around half a minute.
