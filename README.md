# Excalibur server

One small Node program (no dependencies) that serves the game page and runs everything online:
accounts, wallets and gifts, friends, global chat, rooms, voice signalling, reports and moderation,
the parties, Survival World servers and the host-run multiplayer for Parkour and the shooter modes.

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

## Multiplayer games
Every game opens an online intermission (up to 8 players, 12 for Battle Royale, 4 for Wave Survival). The room's **master client** is the host: the first player in. The host's browser runs the whole game and sends snapshots (about 20 a second); everyone else sends their inputs and draws what the host says. **If the host leaves, the game does not end:** the server hands the host role to the next player, whose browser takes over the bots, the clock and the world from what it was already showing. Empty slots are filled with bots when the timer runs out.

- **Parkour:** each player moves their own runner; the host runs the bots, the clock and the results.
- **Tournament:** a bracket of eight in a sandy coliseum with stands and banners. A storm closes in so every duel ends.
- **Capture the Flag:** Red vs Blue on a snowy floating island with a frozen pond. First to three, or the best score after seven minutes.
- **Battle Royale:** up to 20 fighters ride a bus over a green island, land in towns, loot chests and stay inside the shrinking storm.
- **Gun Game:** a warehouse of shipping containers. Every kill upgrades your gun; first to finish the 8-level ladder wins.
- **Wave Survival:** up to 4 players defend a crystal in a dark graveyard town against 15 waves of zombies (walkers, runners, tanks, spitters, a boss every fifth wave). Shop keys: Z ammo, X heal, C better gun, V turret.
- **Hide and Seek:** two fixed maps (a winter lobby island and a casino hall) chosen at random; they are identical every game. Hiders pick one object from the map (slot machine, snowman...) and cannot switch. Hiders must whistle (F) when their timer says so, or they are highlighted in red. Seekers lose a third of their health for shooting a decoy. Bots only know where a hider is after a whistle or a highlight, and can lose track.
- Bots in the gun modes are deliberately weak (poor aim, slow reactions, half damage, slower fire).
- Controls in the shooters: WASD to move, mouse to aim and shoot, R reload, E pick up, 1-4 or the wheel to switch guns. On phones the on-screen joystick and buttons are used.
- Rewards: coins for rounds won, captures, eliminations and the final result.

## Parties
In the lobby, open **Party**: create a party (you get a 5-letter code), join with a code, or invite an online friend by name. The party leader picks a game and starts it for everyone. Party members who find a match automatically land in the same room. Parties live on the server and need it to be running.

## Survival World
A big open world with three dimensions: the **Overworld**, the **Nether** and **the End** (`🌍 Survival World` in the Arena door menu). Mine, build, farm, fish, trade with villagers, sail boats, explore structures, survive the monsters that come out at night, and take on the Ender Dragon. It saves, it works alone, with friends or on a server, and it works on phones.

**Controls.** WASD or the arrow keys move; the mouse aims. Hold **G** or the left mouse button to mine and fight. Press **F** or right-click to use what you hold: place blocks, eat, shoot a bow, cast a fishing rod, light flint and steel, use a bed, open chests and doors, trade with villagers, get in a boat. **E** opens the backpack and crafting, **1-9** or the mouse wheel pick a hotbar slot, **H** shows advancements, **Esc** is the pause menu, **V** toggles flying in Creative. On phones there is a joystick plus **BAG**, **USE** and **HIT** buttons.

**Game modes and difficulty** (chosen when you create a world or request a server):
- **Survival** has hearts, a hunger bar and an armor bar, and monsters at night.
- **Creative** has no damage and no hunger, flying (V), and a palette with every item and block.
- Survival worlds are **Easy** (monsters are weaker and slower, you keep your things if you die, starving never takes you below 5 hearts), **Normal** (you drop a grave with your things; starving never kills you) or **Hard** (monsters hit 50% harder and move faster, starving can kill you). The host can change Easy/Normal/Hard from the pause menu.
- **Hardcore** is Hard with **one life**. When you die you can only watch. When everyone in the world is dead, the world is **locked for good**: it stays in your list with a 💀 badge and can never be opened again. Hosting a locked world is refused, and a locked server shows as "over" in the server list (its owner or staff can press *Start over (new world)* under *My requests*, which wipes it and gives it a new map).

**What there is to do:**
- *Dimensions.* Build an obsidian frame (4x5) and light it with flint and steel to open a Nether portal. The Nether has lava seas, soul sand, Nether fortresses, piglins, blazes and ghasts, and it is smaller than the Overworld, so a portal trip is a shortcut (one step there is about two back home). Find a stronghold, fill the End portal frames with Eyes of Ender, and jump in to fight the Ender Dragon (crystals heal it, so break them first). Beating it opens the exit portal home.
- *Structures.* Villages (houses, farms, wells, lamps, villagers who trade), dungeons with monster spawners and chests, ruined portals, desert pyramids, camps, strongholds, shipwrecks and treasure islands in the sea, Nether fortresses. Chests hold loot that depends on where they are.
- *Survival.* Hearts and hunger, tools in four tiers (wood, stone, iron, diamond) and armor in four (leather, iron, gold, diamond), all with durability, a workbench, furnace and campfire, a bow and arrows, buckets (water on lava makes obsidian), TNT and flint and steel, farming (hoe, seeds, wheat, carrots, potatoes, bread), fishing, cooking, and hunting cows, pigs, sheep and chickens for food and materials.
- *Night.* At night zombies, skeletons, spiders, creepers and endermen spawn near players (more on Hard, fewer on Easy). Zombies burn in daylight. Press F on a **bed** to set your respawn point, and at night to sleep and skip to morning (you cannot sleep with monsters nearby, and in multiplayer half of the players must be asleep). Beds explode in the Nether and the End.
- *Boats.* Craft a boat, press F on water, and sail across the sea to islands and shipwrecks.
- *Villagers.* Three kinds of villager (farmer, smith, hunter) trade in emeralds: they buy crops, coal, iron, string and bones, and sell food, iron tools and armor, bows and arrows, beds, boats, fishing rods, ender pearls and TNT. Press F on one to trade.
- *Advancements.* 28 of them (open **H**), each paying coins that count towards your site level.
- *Death.* On Normal and Hard your things stay in a grave where you died, so you can go back and take them.

**Playing with others**
- **Singleplayer:** create up to 12 worlds, each with its own seed and mode. They are saved in the browser (local storage) together with your backpack, position and advancements.
- **Host online:** press *Host online* on one of your worlds. Turn *Random joins* on to let strangers find it through *Join a random public world*; leave it off to share only the invite code shown in the game (or through your Friends list). Up to 8 players. **If the host leaves, the next player becomes host and the world keeps running** (mobs, boats, chests and the clock are handed over). A world hosted this way is only saved on the original owner's browser.
- **Servers:** any signed-in player can *Request a server* and pick its mode and difficulty. The owner or an admin approves or declines it under *Review server requests*. Approved servers appear in the *Server list* with mode badges; anyone can start one if it is offline. The world is stored on the server, compressed (gzip), up to about 450,000 characters of save data per world, so it survives restarts as long as your database does. A player can have 3 servers (pending or live), and can *Reset world* when nobody is playing on it.
- The host runs the simulation (mobs, projectiles, the dragon) for every dimension that has a player in it and sends snapshots; other players send what they do and see what the host says. Block and chest edits are batched and shared, new joiners get the whole world, and sleeping, hardcore deaths and time are kept in sync.

**For the server operator.** Rooms of kind `world` now carry `gm` (`s` or `c`) and `df` (`e`, `n`, `h`, `x`). `world.request` takes `gm` and `df`. `world.save` accepts up to 30 parts and gzip data (`z1:` prefix, checked on the server; plain JSON from older saves still works). `world.reset` wipes a live server that nobody is on (owner or staff only). A hardcore server whose players all died is marked `dead` and `world.start` refuses it until it is reset. The map generator is new, so worlds from the first Survival World release cannot be loaded as they were: a browser world from that release is rebuilt with the new map on the same seed the first time the menu opens (its old blocks are not kept), and a server whose stored save is from that release starts a fresh world on the same seed.

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

## Bans
A ban no longer locks the account. A banned player can still sign in, play offline and keep their coins and cosmetics, but every multiplayer room (lobby, casino, matches) and room chat refuse them until the ban runs out. They see a red banner with the time left, and it disappears by itself when the ban ends or an owner/admin lifts it. Banning someone who is online sends them straight back to the title screen.

## Staff tools inside games
Owner and admin accounts get a 🛠 button in every game. Pick who an action applies to (**Me**, **Everyone**, or your **Whitelist**) and for how long, then use:
- **Mods:** speed (x1-x5), fly, size (other players see it), aimbot (in the shooters), gold rush (items pay 5x), and a reset. **Casino jackpot** (owner only) makes slots, roulette, blackjack and Texas Hold'em always win.
- **Events:** rain presents and diamonds, gold rush, speed day, fly party, giant day, tiny day, bot party.
- **Items:** hold the mouse in the lobby to spawn diamonds and presents that fly to you; spawn or remove roaming bots.
- **Poll:** write a question and two options, choose what happens if A or B wins, and everyone sees a voting machine pop up in the lobby with live counts. The winning outcome is applied to everyone.
- **Players:** kick players in your room, and manage the whitelist.

Effects aimed at other players go through the server (`admin.fx`, `admin.poll`), which checks that the sender is staff. Admins can do everything except the casino jackpot.

## Chess
Chess against the bot, or against someone in your lobby: sit at the chess table, pick *Play someone in my lobby*, challenge a player and they get an accept/decline popup. Colors are random, moves are relayed through the lobby, and there is a Resign button.

## Slow devices
Parkour (especially Hardcore) has three quality tiers. It steps up by itself when the frame rate stays low: first no decoration, then a lower render resolution with flat backgrounds, light-weight opponents and fewer bot calculations.

## Reports and moderation
Players report from the People list (or by clicking a name in global chat) with a reason and note; the recent chat is attached.
Three different reporters in an hour mute a player for 15 minutes automatically. Players can also Block someone, which hides their chat and mutes their voice on that device.
Open `/admin`, paste your `ADMIN_TOKEN`, and you can Dismiss, Mute for an hour, or Ban from multiplayer for 24 hours. Other admin endpoints:

    GET  /admin/status?token=T                      accounts, who is online, rooms and their masters
    POST /admin/kick?token=T&id=PLAYER_ID           disconnect and block an address for 10 minutes
    POST /admin/mute?token=T&name=USER&minutes=10   silence an account
    POST /admin/ban?token=T&name=USER&hours=24      ban an account from multiplayer (hours=0 lifts it)

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
- In the shooters the host has the best connection to the game. Other players predict their own movement and are corrected by the host, but shots are decided on the host.
- Crumbling platforms in Parkour react to your own runner only.
- Voice and the Report button are not available inside matches yet, and the party system is still local to one browser.
- The Metered and Cloudflare TURN set-ups were tested against stand-in servers, not the real services (Cloudflare's request format is from memory), so check Admin > Overview after you set one.
- Rooms and global chat history are in memory and reset on restart.
- There is no two-factor sign-in.
- Email and Supabase were tested against stand-in servers, so the first real email and first real Supabase connection are worth trying out before you rely on them.
- A free Render instance sleeps after about 15 minutes with no visitors; the first visit afterwards takes around half a minute.
