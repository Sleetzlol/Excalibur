'use strict';
/* Excalibur server: serves the game page and runs accounts, wallets, friends, global chat and rooms over WebSockets.
   No dependencies. Node 18 or newer.  Start with:  node server.js
   Environment (all optional):
     PORT             port to listen on (Render sets this for you)
     DATA_DIR         where accounts.json is kept. On Render, attach a Persistent Disk and point this at its mount path (for example /var/data)
     ALLOWED_ORIGINS  comma separated list, e.g. https://my-game.onrender.com. Empty means any origin.
     ADMIN_TOKEN      enables /admin/status, /admin/kick and /admin/mute
     ICE_SERVERS      JSON array of WebRTC servers for voice chat, e.g. [{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:...","username":"..","credential":".."}]
     SUPABASE_URL / SUPABASE_KEY   keep accounts in a Supabase table instead of a file (survives Render's free plan, see README)
     EMAIL_API_KEY / EMAIL_FROM    send verification and password-reset email through Resend (https://resend.com)
     EMAIL_API_URL    use another provider that accepts the same JSON (default https://api.resend.com/emails)
     MAIL_DEV=1       no provider yet? print emails to the log and show them at /admin/outbox (testing only)
     OWNER_PASSWORD   password for the account named Owner (12+ characters). Turns on the in-game Admin panel for that account only
     OWNER_USERNAME   change the owner's name (default Owner)
     METERED_DOMAIN / METERED_API_KEY   free TURN server for voice chat from metered.ca (see README)
     CF_TURN_KEY_ID / CF_TURN_API_TOKEN  or Cloudflare's TURN service
     TURN_URL / TURN_USERNAME / TURN_CREDENTIAL   or any other TURN server you run or rent
     TRUST_PROXY      set to 0 if you are NOT behind a proxy (Render is, so the default is on)      */
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path'),zlib=require('zlib');
const PORT=+process.env.PORT||8080;
const ALLOWED=(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
const ADMIN=process.env.ADMIN_TOKEN||'';
const TRUST=process.env.TRUST_PROXY!=='0';
let ICE=[{urls:'stun:stun.l.google.com:19302'}];try{if(process.env.ICE_SERVERS)ICE=JSON.parse(process.env.ICE_SERVERS)}catch(e){console.error('ICE_SERVERS is not valid JSON')}
if(process.env.TURN_URL)ICE=ICE.concat([{urls:process.env.TURN_URL.split(',').map(x=>x.trim()).filter(Boolean),username:(process.env.TURN_USERNAME||'').trim(),credential:(process.env.TURN_CREDENTIAL||'').trim()}]);
let iceCache={list:ICE,at:0,src:(process.env.TURN_URL||process.env.ICE_SERVERS)?'custom TURN/ICE servers':'STUN only (no TURN: strict networks will not connect)'};
const METERED_DOMAIN=(process.env.METERED_DOMAIN||'').trim(),METERED_KEY=(process.env.METERED_API_KEY||'').trim(),CF_ID=(process.env.CF_TURN_KEY_ID||'').trim(),CF_TOKEN=(process.env.CF_TURN_API_TOKEN||'').trim();
const mBase=(()=>{   /* accepts yourapp, yourapp.metered.live, or a pasted https://yourapp.metered.live/anything */
  const d=METERED_DOMAIN.trim().replace(/^["']|["']$/g,'');if(!d)return'';const m=d.match(/^(https?:\/\/)?([^\/\s]+)/);if(!m)return'';
  let host=m[2];if(!host.includes('.')&&!host.includes(':'))host+='.metered.live';return(m[1]||'https://')+host})();
function netWhy(e,what){
  const c=e&&e.cause,code=String(c&&c.code||'');
  if(/ENOTFOUND|EAI_AGAIN/.test(code))return 'could not look up the address '+what+'. Check the setting: for Metered it must be just the domain from your Metered dashboard, like yourapp.metered.live (no https://, no path).';
  if(/ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|UND_ERR/.test(code))return 'could not connect to '+what+' ('+code+').';
  return (e&&e.message||'error')+(c?' ('+(code||c.message)+')':'');
}
async function refreshIce(){
  try{
    if(METERED_DOMAIN&&METERED_KEY){
      if(!mBase)throw new Error('METERED_DOMAIN is empty or not understood');
      let r;try{r=await fetch(mBase+'/api/v1/turn/credentials?apiKey='+encodeURIComponent(METERED_KEY))}catch(e){throw new Error(netWhy(e,mBase))}
      if(r.status===401||r.status===403)throw new Error('Metered rejected the API key (HTTP '+r.status+') at '+mBase+'. METERED_API_KEY must be the "API Key" that belongs to a TURN credential in your Metered dashboard (TURN Server > Credentials): not your account secret key, and not the credential username or password. To test a key, open '+mBase+'/api/v1/turn/credentials?apiKey=YOURKEY in a browser: you should see a list of servers.');
      if(r.status===404)throw new Error('Metered answered HTTP 404 at '+mBase+'. The app name in METERED_DOMAIN is probably wrong; copy it from your Metered dashboard (it looks like yourapp.metered.live).');
      if(!r.ok)throw new Error('Metered answered HTTP '+r.status+' at '+mBase);
      const l=await r.json();if(!Array.isArray(l)||!l.length)throw new Error('Metered returned no servers');iceCache={list:l,at:Date.now(),src:'Metered TURN'};console.log('Voice: Metered TURN ready ('+l.length+' servers from '+mBase+')');
    }else if(CF_ID&&CF_TOKEN){
      const cfBase=process.env.CF_TURN_API_BASE||'https://rtc.live.cloudflare.com';let r;
      try{r=await fetch(cfBase+'/v1/turn/keys/'+encodeURIComponent(CF_ID)+'/credentials/generate',{method:'POST',headers:{Authorization:'Bearer '+CF_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({ttl:86400})})}catch(e){throw new Error(netWhy(e,cfBase))}
      if(!r.ok)throw new Error('Cloudflare answered HTTP '+r.status);const j=await r.json();if(!j.iceServers)throw new Error('Cloudflare returned no servers');
      iceCache={list:[].concat(j.iceServers),at:Date.now(),src:'Cloudflare TURN'};console.log('Voice: Cloudflare TURN ready');
    }
  }catch(e){console.error('Voice: could not get TURN servers: '+e.message)}
}
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KINDS={hub:{label:'Main Hub',max:16},casino:{label:'Casino',max:12},parkour:{label:'Parkour',max:8},tournament:{label:'Tournament',max:8},ctf:{label:'Capture the Flag',max:8},royale:{label:'Battle Royale',max:12},survival:{label:'Wave Survival',max:4},gungame:{label:'Gun Game',max:8},hideseek:{label:'Hide and Seek',max:8},world:{label:'Survival World',max:8},event:{label:'Wheel of Fortune',max:40}};
const GCH=['general','lfg','casino'];
const LIM={maxPayload:32768,rpcMax:24000,perIp:+process.env.PER_IP||8,global:400,msgPerSec:80,chatPerSec:1,chatBurst:3,strikes:60,banMs:10*60*1000,
  accounts:5000,authPerMin:+process.env.AUTH_PER_MIN||10,giftMax:5000,giftDay:5000,tokenDays:30,startCoinsMax:20000};
const BAD=['fuck','shit','bitch','asshole','cunt','nigg','fag'];   /* tiny starter filter, extend as you like */
const RESERVED=new Set(['admin','administrator','moderator','mod','system','server','excalibur','support','staff','guest','null','undefined']);
const OWNER_NAME=((process.env.OWNER_USERNAME||'Owner').trim().replace(/[^A-Za-z0-9_]/g,'')||'Owner'),OWNER_KEY=OWNER_NAME.toLowerCase(),OWNER_PW=process.env.OWNER_PASSWORD||'';
RESERVED.add(OWNER_KEY);   /* nobody can register the owner's name; the account is created from OWNER_PASSWORD */
const conns=new Map(),rooms=new Map(),bans=new Map(),perIp=new Map(),online=new Map(),authLog=new Map(),reportLog=new Map();

/* ---------- storage: a JSON file, or one row in Supabase. Swap loadDb/flush for any other database. ---------- */
const DATA=process.env.DATA_DIR||path.join(__dirname,'data');
try{fs.mkdirSync(DATA,{recursive:true})}catch(e){}
const DB_FILE=path.join(DATA,'accounts.json');
const SB_URL=(process.env.SUPABASE_URL||'').trim().replace(/\/+$/,'').replace(/\/rest\/v1$/,''),SB_KEY=(process.env.SUPABASE_KEY||'').trim().replace(/^["']|["']$/g,''),useSB=!!(SB_URL&&SB_KEY);
const sbH={apikey:SB_KEY,'Content-Type':'application/json'};if(SB_KEY&&!SB_KEY.startsWith('sb_'))sbH.Authorization='Bearer '+SB_KEY;   /* new-style sb_secret_ keys go in the apikey header only */
const storage={mode:useSB?'supabase':'file',ok:null,at:0,err:''};
let db={v:1,accounts:{},tokens:{},reports:[],audit:[]};
const emailIndex=new Map();
const indexEmails=()=>{emailIndex.clear();for(const k in db.accounts){const a=db.accounts[k];if(a.email&&a.emailVerified)emailIndex.set(a.email,k)}};
function describeKey(){   /* says what kind of key this is without printing it */
  const k=SB_KEY,urlRef=(SB_URL.match(/^https?:\/\/([^.\/]+)\./)||[])[1]||'?';
  if(k.startsWith('sb_publishable_'))return 'KEY CHECK: this is a PUBLISHABLE key, which is the wrong one. Use the secret key (sb_secret_...).';
  if(k.startsWith('sb_secret_'))return 'KEY CHECK: new-style secret key ('+k.length+' characters); URL project is '+urlRef+'. If it still fails, make sure this secret key was created in that same project.';
  const parts=k.split('.');
  if(parts.length===3){try{const j=JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
      let m='KEY CHECK: legacy key, role='+j.role+(j.ref?', project='+j.ref:'')+'; URL project is '+urlRef+'.';
      if(j.role!=='service_role')m+=' WRONG ROLE: this must be the service_role key.';
      if(j.ref&&urlRef!=='?'&&j.ref!==urlRef)m+=' WRONG PROJECT: the key belongs to a different project than SUPABASE_URL.';
      return m}catch(e){}}
  return 'KEY CHECK: this does not look like a Supabase key (expected sb_secret_... or a long key starting eyJ). It is '+k.length+' characters.';
}
function sbExplain(status,body,err){
  if(err){const code=String(err.cause&&err.cause.code||'');return/ENOTFOUND|EAI_AGAIN/.test(code)?'The SUPABASE_URL host could not be found. Check it for typos; it should look like https://abcdxyz.supabase.co':'Could not reach Supabase: '+(err.cause&&err.cause.message||err.message)}
  if((status===401||status===403)&&/42501|permission denied/i.test(body))return 'Supabase says "permission denied" for the kv table (HTTP '+status+'). The key is accepted but the table has not been opened to it: open Supabase > SQL Editor, paste the WHOLE supabase.sql file, run it, then restart. ('+String(body).slice(0,160)+')';
  if(status===401||status===403)return 'Supabase rejected the key or the request (HTTP '+status+'). Supabase said: '+String(body).slice(0,300)+'  |  '+describeKey()+'  |  Checklist: the key must be the secret (sb_secret_...) or legacy service_role key, never publishable/anon; SUPABASE_URL and the key must be from the SAME project; run supabase.sql; and in Supabase Project Settings > Data API make sure the Data API is enabled.';
  if(status===404||/PGRST205|PGRST106|does not exist|schema cache/i.test(body))return 'The kv table was not found (HTTP '+status+'). Open Supabase > SQL Editor, run the contents of supabase.sql, then restart the server. Also check SUPABASE_URL is your Project URL.';
  return 'Supabase answered HTTP '+status+': '+String(body).slice(0,200);
}
async function sbCall(method,pathq,body,extra){
  try{const r=await fetch(SB_URL+pathq,{method,headers:{...sbH,...(extra||{})},body});return{ok:r.ok,status:r.status,text:await r.text()}}
  catch(e){return{ok:false,status:0,text:'',err:e}}
}
async function loadDb(){
  if(useSB){
    console.log('Supabase: connecting to '+SB_URL);console.log(describeKey());
    for(let i=0;;i++){
      const r=await sbCall('GET','/rest/v1/kv?key=eq.db&select=value');
      if(r.ok){let rows=[];try{rows=JSON.parse(r.text)}catch(e){}if(rows[0]&&rows[0].value)db=Object.assign(db,rows[0].value);storage.ok=true;storage.at=Date.now();
        console.log('Accounts loaded from Supabase ('+Object.keys(db.accounts||{}).length+' accounts)');break}
      storage.ok=false;storage.err=sbExplain(r.status,r.text,r.err);console.error('Supabase load failed: '+storage.err);
      if(i>=3){console.error('Refusing to start without the database (running on an empty one could overwrite your real data). Fix the problem above, or delete SUPABASE_URL and SUPABASE_KEY to run without Supabase.');process.exit(1)}
      await new Promise(r=>setTimeout(r,2000));
    }
  }else{try{db=Object.assign(db,JSON.parse(fs.readFileSync(DB_FILE,'utf8')));storage.ok=true;storage.at=Date.now()}catch(e){}}
  db.reports=db.reports||[];db.tokens=db.tokens||{};db.accounts=db.accounts||{};db.audit=db.audit||[];db.worlds=Array.isArray(db.worlds)?db.worlds:[];db.dm=db.dm&&typeof db.dm==='object'?db.dm:{};db.ac=Array.isArray(db.ac)?db.ac:[];db.gc=db.gc&&typeof db.gc==='object'?db.gc:{};
  /* accounts made by older versions may be missing fields: fill them in so nothing downstream ever sees undefined */
  for(const a of Object.values(db.accounts)){
    if(!Array.isArray(a.owned)||!a.owned.length)a.owned=cosList(a.owned);
    if(!a.eq||typeof a.eq!=='object')a.eq=eqObj(a.eq);
    if(!Array.isArray(a.ledger))a.ledger=[];
    if(!a.friends||typeof a.friends!=='object')a.friends={};
    if(!a.gift||typeof a.gift!=='object')a.gift={d:'',n:0};
    if(typeof a.coins!=='number'||!isFinite(a.coins))a.coins=0;
    if(typeof a.xp!=='number'||!isFinite(a.xp))a.xp=0;
  }
  indexEmails();
}
let dirty=false,saving=false;const touch=()=>{dirty=true};
async function flush(){
  if(!dirty||saving)return;dirty=false;saving=true;
  if(useSB){
    const r=await sbCall('POST','/rest/v1/kv?on_conflict=key',JSON.stringify([{key:'db',value:db}]),{Prefer:'resolution=merge-duplicates,return=minimal'});
    if(r.ok){storage.ok=true;storage.at=Date.now();storage.err=''}else{dirty=true;storage.ok=false;storage.err=sbExplain(r.status,r.text,r.err);console.error('Supabase save failed: '+storage.err)}
  }else{
    try{const tmp=DB_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DB_FILE);storage.ok=true;storage.at=Date.now()}catch(e){dirty=true;storage.ok=false;storage.err=e.message;console.error('save failed:',e.message)}
  }
  saving=false;
}
setInterval(flush,useSB?4000:2000).unref();

/* ---------- email (verification codes and password reset) ---------- */
const MAIL={key:process.env.EMAIL_API_KEY||'',from:process.env.EMAIL_FROM||'Excalibur <onboarding@resend.dev>',url:process.env.EMAIL_API_URL||'https://api.resend.com/emails',dev:process.env.MAIL_DEV==='1'};
const mailMode=MAIL.key?'api':MAIL.dev?'log':'off',outbox=[];
async function sendMail(to,subject,text){
  if(mailMode==='off')throw new Error('mail is off');
  if(mailMode==='log'){console.log('[mail] to '+to+' | '+subject+'\n'+text);outbox.push({to,subject,text,ts:Date.now()});if(outbox.length>50)outbox.shift();return}
  const r=await fetch(MAIL.url,{method:'POST',headers:{Authorization:'Bearer '+MAIL.key,'Content-Type':'application/json'},body:JSON.stringify({from:MAIL.from,to:[to],subject,text})});
  if(!r.ok)throw new Error('mail provider answered '+r.status);
}

/* ---------- helpers ---------- */
const clean=(s,n)=>String(s==null?'':s).replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,n);
const sName=n=>clean(String(n||'').replace(/[^\w \-.]/g,''),20)||'Player';
const sChat=t=>{let x=clean(t,60);for(const w of BAD)x=x.replace(new RegExp(w,'ig'),m=>'*'.repeat(m.length));return x};
const code=()=>{let c;do{c=crypto.randomBytes(4).toString('hex').slice(0,5).toUpperCase()}while([...rooms.values()].some(r=>r.code===c));return c};
const num=(v,lo,hi)=>Math.max(lo,Math.min(hi,Number.isFinite(+v)?+v:0));
const int=(v,lo,hi,d)=>Number.isFinite(+v)?Math.floor(num(v,lo,hi)):d;
const key=n=>String(n||'').toLowerCase();
const validName=n=>/^[A-Za-z0-9_]{3,16}$/.test(n)&&!RESERVED.has(n.toLowerCase());
const cosList=a=>Array.isArray(a)?[...new Set(a.filter(x=>typeof x==='string'&&/^[a-z]_[a-z0-9]{1,16}$/.test(x)))].slice(0,200):['s_blue','h_none','h_cap','t_none','k_none'];
const eqObj=e=>{const o={skin:'s_blue',hat:'h_cap',trail:'t_none',kill:'k_none'};if(e&&typeof e==='object')for(const k in o)if(typeof e[k]==='string'&&/^[a-z]_[a-z0-9]{1,16}$/.test(e[k]))o[k]=e[k];return o};
/* staff disguise: a staff account can hide its rainbow name, or look like one of the game's bots (bot name, bot look, blue name, BOT tag) */
const BOT_NAMES=['Nova','Rift','Kilo','Pixel','Juno','Echo','Zed','Mika','Ace','Blip','Rook','Vex','Onyx','Jax','Luna','Finch','Taro','Skye'];
const disgOf=a=>a&&staffOf(a)&&a.disg&&typeof a.disg==='object'?a.disg:null;
const shownStaff=a=>{const d=disgOf(a);return d&&(d.bot||d.rb===false)?'':staffOf(a)};
const lookFields=p=>({skin:/^#[0-9a-f]{6}$/i.test(p&&p.skin)?p.skin:'#4f8cff',rain:!!(p&&p.rain),hat:/^h_[a-z]{2,12}$/.test(p&&p.hat)?p.hat:'h_none',
  pat:/^[a-z]{2,10}$/.test(p&&p.pat)?p.pat:'',tr:/^t_[a-z]{2,12}$/.test(p&&p.tr)?p.tr:'t_none',kf:/^k_[a-z]{2,12}$/.test(p&&p.kf)?p.kf:'k_none'});
const profile=(c,p)=>{const d=disgOf(c.acct);if(d&&d.bot)return{id:c.id,name:d.bot.name,acct:false,staff:'',bot:true,...lookFields(d.bot.look),pt:''};return profile0(c,p)};
const profile0=(c,p)=>({id:c.id,name:c.acct?c.acct.name:sName(p&&p.name),acct:!!c.acct,staff:shownStaff(c.acct),skin:/^#[0-9a-f]{6}$/i.test(p&&p.skin)?p.skin:'#4f8cff',rain:!!(p&&p.rain),hat:/^h_[a-z]{2,12}$/.test(p&&p.hat)?p.hat:'h_none',
  pat:/^[a-z]{2,10}$/.test(p&&p.pat)?p.pat:'',tr:/^t_[a-z]{2,12}$/.test(p&&p.tr)?p.tr:'t_none',kf:/^k_[a-z]{2,12}$/.test(p&&p.kf)?p.kf:'k_none',
  pt:c.party?sha('pt:'+c.party).slice(0,8):''});   /* pt: a tag shared by party members (not the join code) so games can put them on one team */
const pub=r=>({id:r.id,kind:r.kind,name:r.name,max:r.max,priv:false,count:r.members.size});
const open=r=>!r.priv&&!r.locked&&r.members.size<r.max;
const clientIp=req=>{const f=TRUST&&req.headers['x-forwarded-for'];return f?String(f).split(',')[0].trim():req.socket.remoteAddress};
const today=()=>new Date().toISOString().slice(0,10);
function authOk(ip){const now=Date.now(),l=(authLog.get(ip)||[]).filter(t=>now-t<60000);if(l.length>=LIM.authPerMin){authLog.set(ip,l);return false}l.push(now);authLog.set(ip,l);return true}
const pwHash=(p,salt)=>new Promise((res,rej)=>crypto.scrypt(p,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024},(e,k)=>e?rej(e):res(k)));
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
const EMAIL_RE=/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const maskEmail=e=>{if(!e)return'';const[u,d]=e.split('@');return u[0]+'***@'+d};
const mkCode=()=>String(crypto.randomInt(0,1000000)).padStart(6,'0');
const hCode=(c,salt)=>sha(c+':'+salt);
const timingEq=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const userView=a=>({disg:disgOf(a)||null,rew:rewView(a),ban:a.ban>Date.now()?a.ban:0,banInfo:banView(a),name:a.name,coins:a.coins,xp:a.xp,owned:a.owned,eq:a.eq,created:a.created,owner:a.key===OWNER_KEY&&OWNER_PW.length>=12,admin:!!a.admin,staff:staffOf(a),email:maskEmail(a.email),emailVerified:!!a.emailVerified,mail:mailMode!=='off'});
const revokeTokens=a=>{for(const h in db.tokens)if(db.tokens[h].k===a.key)delete db.tokens[h]};
const kickAccount=(a,reason)=>{const oc=online.get(a.key);if(oc){oc.send({t:'kicked',reason});oc.kill(1000,'signed out')}};
function ledger(a,text){a.ledger.push({t:Date.now(),text});if(a.ledger.length>50)a.ledger.shift()}

/* ---------- websocket frames ---------- */
function frame(op,payload){
  const len=payload.length;let h;
  if(len<126)h=Buffer.from([128|op,len]);
  else if(len<65536){h=Buffer.alloc(4);h[0]=128|op;h[1]=126;h.writeUInt16BE(len,2)}
  else{h=Buffer.alloc(10);h[0]=128|op;h[1]=127;h.writeUInt32BE(0,2);h.writeUInt32BE(len,6)}
  return Buffer.concat([h,payload]);
}
function parse(b){
  if(b.length<2)return null;
  const fin=!!(b[0]&128),op=b[0]&15,masked=!!(b[1]&128);let len=b[1]&127,off=2;
  if(len===126){if(b.length<4)return null;len=b.readUInt16BE(2);off=4}
  else if(len===127){if(b.length<10)return null;if(b.readUInt32BE(2))return{bad:1009};len=b.readUInt32BE(6);off=10}
  if(!masked)return{bad:1002};
  if(len>LIM.maxPayload)return{bad:1009};
  if(b.length<off+4+len)return null;
  const mask=b.subarray(off,off+4),data=Buffer.from(b.subarray(off+4,off+4+len));
  for(let i=0;i<len;i++)data[i]^=mask[i&3];
  return{fin,op,data,used:off+4+len};
}

class Conn{
  constructor(sock,ip){
    this.s=sock;this.ip=ip;this.id='p'+crypto.randomBytes(5).toString('hex');this.buf=Buffer.alloc(0);this.frag=null;this.alive=true;this.pong=true;
    this.room=null;this.p=null;this.acct=null;this.gch=new Set();this.tok=LIM.msgPerSec;this.ctok=LIM.chatBurst;this.last=Date.now();this.clast=Date.now();this.strikes=0;
    sock.on('data',d=>this.data(d));sock.on('close',()=>this.drop());sock.on('error',()=>this.drop());
  }
  send(o){if(this.alive)try{this.s.write(frame(1,Buffer.from(JSON.stringify(o))))}catch(e){}}
  kill(c,reason){if(!this.alive)return;try{const r=Buffer.from(String(reason||'').slice(0,100));const b=Buffer.alloc(2+r.length);b.writeUInt16BE(c||1000,0);r.copy(b,2);this.s.write(frame(8,b))}catch(e){}try{this.s.end()}catch(e){}this.drop()}
  drop(){if(!this.alive)return;this.alive=false;try{callLeave(this)}catch(e){}leaveRoom(this);partyLeave(this);unbind(this);conns.delete(this.id);perIp.set(this.ip,Math.max(0,(perIp.get(this.ip)||1)-1))}
  data(d){
    this.buf=Buffer.concat([this.buf,d]);
    for(;;){
      const f=parse(this.buf);if(!f)break;
      if(f.bad)return this.kill(f.bad,'protocol');
      this.buf=this.buf.subarray(f.used);
      if(f.op===8)return this.kill(1000);
      if(f.op===9){try{this.s.write(frame(10,f.data))}catch(e){}continue}
      if(f.op===10){this.pong=true;continue}
      if(f.op===2)return this.kill(1003,'text only');
      if(f.op===1||f.op===0){
        if(f.op===1){this.frag=f.fin?null:[f.data]}else{if(!this.frag)return this.kill(1002,'protocol');this.frag.push(f.data)}
        if(this.frag&&this.frag.reduce((a,x)=>a+x.length,0)>LIM.maxPayload)return this.kill(1009,'too large');
        if(f.fin){const whole=f.op===0?Buffer.concat(this.frag):f.data;this.frag=null;this.text(whole.toString('utf8'))}
      }
    }
    if(this.alive&&this.buf.length>LIM.maxPayload+16)this.kill(1009,'too large');
  }
  text(t){
    const now=Date.now();this.tok=Math.min(LIM.msgPerSec*2,this.tok+(now-this.last)/1000*LIM.msgPerSec);this.last=now;
    if(this.tok<1){if(++this.strikes>LIM.strikes)this.kill(1008,'slow down');return}
    this.tok--;let m;try{m=JSON.parse(t)}catch(e){return}
    if(!m||typeof m!=='object'||typeof m.t!=='string')return;
    Promise.resolve().then(()=>handle(this,m)).catch(e=>console.error('handler error:',e&&e.message));
  }
}

/* ---------- rooms (with a master client, like Photon) ---------- */
function broadcast(room,o,except){for(const c of room.members)if(c!==except)c.send(o)}
function leaveRoom(c){
  const r=c.room&&rooms.get(c.room);c.room=null;if(!r)return;
  r.members.delete(c);broadcast(r,{t:'leave',room:r.id,from:c.id});
  if(r.recs){recPush(r,c,'l',0);for(const R of r.recs.slice())if(R.sus===c.id||!r.members.size)recEnd(r,R)}
  if(r===eventRoom&&c.acct&&c.acct.key===r.ownerKey){for(const x of r.members)x.send({t:'user.eventend'});eventRoom=null}
  if(r.master===c){r.master=r.members.values().next().value||null;if(r.master)broadcast(r,{t:'master',room:r.id,id:r.master.id})}   /* the longest-standing member takes over */
  if(!r.members.size)rooms.delete(r.id);
  if(c.acct)presence(c.acct.key);
}
function enter(c,room,p,req){
  if(c.room)leaveRoom(c);
  if(room.locked){c.send({t:'deny',room:room.id,req,err:'That match has already started.'});return false}
  if(room.members.size>=room.max){c.send({t:'deny',room:room.id,req,err:'That room is full.'});return false}
  c.lastP=p;c.p=profile(c,p);
  const others=[...room.members].map(x=>x.p);
  room.members.add(c);c.room=room.id;if(!room.master)room.master=c;
  if(room.ownerKey&&c.acct&&c.acct.key===room.ownerKey&&room.master!==c){room.master=c;broadcast(room,{t:'master',room:room.id,id:c.id},c)}
  const meta=room.priv?{id:room.id,kind:room.kind,name:room.name,max:room.max,priv:true,code:room.code}:{id:room.id,kind:room.kind,name:room.name,max:room.max,priv:false};
  if(room.wseed!=null){meta.wseed=room.wseed;meta.srv=room.srv||'';meta.gm=room.gm||'s';meta.df=room.df||'n'}
  c.send({t:'roster',room:room.id,req,meta,players:others,master:room.master.id});
  broadcast(room,{t:'join',room:room.id,p:c.p},c);recPush(room,c,'j',pview(c));
  if(c.recWait){const w=c.recWait,f=db.ac.find(x=>x.id===w.id);if(f&&Date.now()<w.until)recStart(f,c);else c.recWait=null}
  if(c.acct)presence(c.acct.key);
  return true;
}

/* ---------- accounts, wallet, gifts ---------- */
function unbind(c){const a=c.acct;if(!a)return;try{callLeave(c)}catch(e){}c.acct=null;if(online.get(a.key)===c){online.delete(a.key);presence(a.key)}}
function banLeft(ms){const m=Math.max(1,Math.ceil(ms/60000));if(m<60)return m+' minute'+(m===1?'':'s');const h=Math.floor(m/60),r=m%60;if(h<48)return h+'h'+(r?' '+r+'m':'');return Math.ceil(h/24)+' days'}
/* a ban no longer locks the account: you can sign in, but multiplayer rooms refuse you until it runs out */
const BAN_CATS=['Cheating','Harassment','Inappropriate language','Scamming','Spam','Ban evasion','Other'],PERM=8.64e15;
const BAN_DEFAULT='You have violated this sites rules, and have been banned. If you would like to appeal this ban, click the button below.';
/* what a banned player sees: category, reason, when it ends, and where their appeal stands */
const banView=a=>a.ban>Date.now()?{until:a.ban,perm:a.ban>=PERM,cat:a.banCat||'Other',reason:a.banReason||BAN_DEFAULT,appeal:a.appeal?{text:a.appeal.text,at:a.appeal.at,status:a.appeal.status,reply:a.appeal.reply||''}:null}:null;
function applyBan(a,until,cat,reason){a.ban=until>Date.now()?until:0;
  if(a.ban){a.banCat=BAN_CATS.includes(cat)?cat:(a.banCat&&cat==null?a.banCat:'Other');if(reason!=null)a.banReason=clean(reason,300)||BAN_DEFAULT;else if(!a.banReason)a.banReason=BAN_DEFAULT}
  else{a.banCat='';a.banReason='';if(a.appeal&&a.appeal.status==='open')a.appeal.status='lifted'}
  touch();const c=online.get(a.key);if(c){if(a.ban&&c.room)leaveRoom(c);if(a.ban&&c.party)partyLeave(c);c.send({t:'user.ban',ban:a.ban,info:banView(a)})}}
function appealMsg(c,m){const a=c.acct,reply=(ok,err)=>c.send({t:'appeal.res',req:m.req,ok,err,info:a?banView(a):null});
  if(!a||!(a.ban>Date.now()))return reply(false,'You are not banned.');
  const text=clean(m.text,800);if(text.length<5)return reply(false,'Write a little more about why the ban should be lifted.');
  if(a.appeal&&a.appeal.status==='open')return reply(false,'Your appeal is waiting for a staff member.');
  if(a.appeal&&Date.now()-a.appeal.at<864e5)return reply(false,'You can appeal again 24 hours after your last appeal.');
  a.appeal={text,at:Date.now(),status:'open',reply:'',cat:a.banCat,reason:a.banReason};audit('appeal',a.name,text.slice(0,80));touch();
  for(const x of conns.values())if(staffLevel(x))x.send({t:'notice',text:a.name+' sent a ban appeal. See Admin > Appeals.'});reply(true)}
/* ---------- anti-cheat: something looks wrong, so the player's game screen is recorded for up to 30 s for staff to review ---------- */
const CLIPS=path.join(DATA,'clips');try{fs.mkdirSync(CLIPS,{recursive:true})}catch(e){}
if(!Array.isArray(db.ac))db.ac=[];
const clipTickets=new Map(),clipMem=new Map(),acLast=new Map(),acSusp=new Map();
function acReport(c,why,detail,force){
  if(!c||!c.alive)return null;const now=Date.now(),who=c.acct?c.acct.key:'ip:'+c.ip;if(c.acct&&staffOf(c.acct)&&!force)return null;
  if(!Array.isArray(db.ac))db.ac=[];let f=db.ac.find(x=>x.who===who&&x.open&&now-x.ts<600e3);
  if(f){f.n++;const w=clean(why,40);if(!f.whys)f.whys=[f.why];if(!f.whys.includes(w)){f.whys.push(w);f.why=f.whys.join(', ')}if(f.detail.length<20)f.detail.push(clean(detail,160));touch();if(!force)return f}
  else{f={id:crypto.randomBytes(5).toString('hex'),ts:now,who,name:c.acct?c.acct.name:(c.p&&c.p.name)||'guest',acct:!!c.acct,why:clean(why,40),detail:[clean(detail,160)],n:1,room:c.room&&rooms.get(c.room)?rooms.get(c.room).name:'',clip:null,open:true};
    db.ac.push(f);if(db.ac.length>200)db.ac.splice(0,db.ac.length-200);touch()}
  /* one recording per player every 10 minutes, at most 30 kept */
  if(force||now-(acLast.get(who)||0)>600e3){acLast.set(who,now);recStart(f,c)}
  for(const x of conns.values())if(staffLevel(x))x.send({t:'ac.new',id:f.id,name:f.name,why:f.why});
  return f}
/* ---------- replays: what the room saw, recorded on the server ----------
   Everything a room relays (positions, game messages, chat, who joined or left) for 30 seconds is saved, gzipped, as a replay.
   The suspect's browser is never asked to do anything, so it cannot notice, block or fake it. Staff watch it as a video in the admin page. */
const REC_MS=30e3,REC_MAX=5e6;
const HOST_ONLY=new Set(['sn','go','round','bs','fin2','hend','pend','burn','pgo','botify','e.go','clock','mode']);   /* only the room's host sends these */
const pview=x=>x.p?{name:x.p.name,acct:x.p.acct,staff:x.p.staff,skin:x.p.skin,rain:x.p.rain,hat:x.p.hat,pat:x.p.pat,tr:x.p.tr,kf:x.p.kf}:{name:'Player'};
function recStart(f,c){const now=Date.now(),r=c.room&&rooms.get(c.room);
  if(!r){f.rec='waiting for a game';c.recWait={id:f.id,until:now+600e3};touch();return}
  if((r.recs||[]).some(R=>R.sus===c.id))return;c.recWait=null;
  const R={id:f.id,sus:c.id,susName:f.name,t0:now,kind:r.kind,room:r.name,players:{},init:Object.assign({},r.lastRpc||{}),master:r.master?r.master.id:null,ev:[],size:0,lastBig:{}};
  for(const x of r.members)R.players[x.id]=pview(x);
  (r.recs||(r.recs=[])).push(R);R.timer=setTimeout(()=>recEnd(r,R),REC_MS);f.rec='recording';touch()}
function recPush(r,c,type,payload,big){if(!r.recs||!r.recs.length)return;const now=Date.now();
  for(const R of r.recs){if(R.size>REC_MAX)continue;
    if(big){const k=c.id+type;if(now-(R.lastBig[k]||0)<90)continue;R.lastBig[k]=now}   /* big snapshots: at most ~11 a second */
    const e=[now-R.t0,c.id,type,payload];R.ev.push(e);R.size+=big||60}}
function recEnd(r,R){clearTimeout(R.timer);if(r.recs){r.recs=r.recs.filter(x=>x!==R)}const f=db.ac.find(x=>x.id===R.id);if(!f)return;
  const data={v:1,kind:R.kind,room:R.room,t0:R.t0,secs:(Date.now()-R.t0)/1000,sus:R.sus,susName:R.susName,master:R.master,players:R.players,init:R.init,ev:R.ev};
  zlib.gzip(Buffer.from(JSON.stringify(data)),(e,buf)=>{if(e){f.rec='failed';touch();return}
    f.clip=f.id+'.json.gz';f.rec='ok';f.secs=data.secs;f.bytes=buf.length;f.kind=R.kind;clipMem.set(f.clip,buf);fs.writeFile(path.join(CLIPS,f.clip),buf,()=>{});
    const withClip=db.ac.filter(x=>x.clip);while(withClip.length>30){const o=withClip.shift();fs.unlink(path.join(CLIPS,o.clip),()=>{});clipMem.delete(o.clip);o.clip=null;o.rec='deleted (old)'}
    while(clipMem.size>12)clipMem.delete(clipMem.keys().next().value);touch();
    for(const x of conns.values())if(staffLevel(x))x.send({t:'ac.new',id:f.id,name:f.name,why:f.why,ready:true})})}
/* ---------- staff item spawns in the lobby, made and paid on the server ----------
   The page asks for items while the staff effect is on; the server makes each one (id, place, value), and pays only for
   items it made, once, within 35 seconds. A page cannot invent items or claim more than were made. */
const SP_DAY=20000;
function spawnMsg(c,m){const now=Date.now(),a=c.acct;if(!a)return;const r=c.room&&rooms.get(c.room);if(!r||r.kind!=='hub')return;
  const S=c.spItems||(c.spItems=new Map());for(const[id,it]of S)if(now-it.at>35e3)S.delete(id);
  const val=g=>(g?15:3)*((c.gold||0)>now?5:1);
  if(m.t==='spawn.req'){const hold=m.mode==='hold';
    if(hold?!(c.spawnFx&&c.spawnFx.until>now):!((c.rainFx||0)>now))return;
    const W=c.spW||(c.spW=[]);while(W.length&&now-W[0]>1000)W.shift();if(W.length>=(hold?12:3))return;W.push(now);
    const x=num(m.x,0,2400),y=num(m.y,-100,1800),w=num(m.w||0,0,2400),out=[];
    for(let i=0;i<(hold?2:5)&&S.size<400;i++){const gift=hold?(c.spawnFx.v==='both'?Math.random()<.5:c.spawnFx.v==='gift'):Math.random()<.4;
      const id=(c.spN=(c.spN||0)+1),it={at:now,gift,v:val(gift),x:hold?x+(Math.random()-.5)*34:x+Math.random()*w,y:hold?y+(Math.random()-.5)*34:y};S.set(id,it);out.push([id,Math.round(it.x),Math.round(it.y),gift?1:0])}
    if(out.length)c.send({t:'spawn.items',mode:hold?'hold':'rain',items:out});return}
  if(m.t==='spawn.take'){const ids=Array.isArray(m.ids)?m.ids.slice(0,60):[];let sum=0;for(const id of ids){const it=S.get(+id);if(it){sum+=it.v;S.delete(+id)}}
    if(!sum)return;const rw=rewOf(a);rw.by.spawn=(rw.by.spawn|0);if(rw.by.spawn>=SP_DAY)return c.send({t:'notice',text:'That is all the coins spawned items can give today.'});
    sum=Math.min(sum,SP_DAY-rw.by.spawn);rw.by.spawn+=sum;addCoins(a,sum);walletPush(c,a);return}
}
function acMsg(c,m){const now=Date.now();
  if(m.t==='ac.self'){   /* the page's own integrity checks: console tampering, replaced functions, injected scripts */
    const why=clean(m.why,40)||'client',k='self:'+(c.acct?c.acct.key:'ip:'+c.ip)+':'+why;if(now-(acSusp.get(k)||0)<120e3)return;acSusp.set(k,now);acReport(c,why,clean(m.detail,160));return}
  if(m.t==='ac.suspect'){   /* another player's game saw something impossible (speed, teleport, aim). It only starts a recording. */
    const tc=conns.get(String(m.target||''));if(!tc||tc===c||!c.room||tc.room!==c.room)return;
    if(tc.fxAt&&now-tc.fxAt<36e5)return;   /* staff gave them speed or flying */
    const k=c.id+'>'+tc.id;if(now-(acSusp.get(k)||0)<600e3)return;acSusp.set(k,now);acReport(tc,clean(m.why,40)||'gameplay','seen by '+((c.p&&c.p.name)||'a player')+': '+clean(m.detail,120));return}
}
function clipServe(res,ticket){const t=clipTickets.get(ticket);if(!t||t.exp<Date.now()){res.writeHead(403);return res.end('expired')}
  const send=b=>{res.writeHead(200,{'Content-Type':'application/json','Content-Encoding':'gzip','Content-Length':b.length,'Cache-Control':'private, no-store','Access-Control-Allow-Origin':'*'});res.end(b)};
  const b=clipMem.get(t.file);if(b)return send(b);fs.readFile(path.join(CLIPS,t.file),(e,d)=>{if(e){res.writeHead(404);return res.end('gone')}send(d)})}
function bind(c,a,req,token){
  unbind(c);const old=online.get(a.key);
  if(old&&old!==c){old.send({t:'kicked',reason:'You signed in from another place.'});old.acct=null;online.delete(a.key);old.kill(1000,'signed in elsewhere')}
  c.acct=a;online.set(a.key,c);
  const o={t:'auth.ok',req,user:userView(a),friends:friendList(a),ledger:a.ledger.slice(-20)};if(token)o.token=token;
  c.send(o);presence(a.key);try{gcSendList(c);callsFor(c)}catch(e){}
}
function newToken(a){const t=crypto.randomBytes(32).toString('hex');db.tokens[sha(t)]={k:a.key,exp:Date.now()+LIM.tokenDays*864e5};
  const now=Date.now();for(const h in db.tokens)if(db.tokens[h].exp<now)delete db.tokens[h];touch();return t}
async function authMsg(c,m){
  const fail=e=>c.send({t:'auth.err',req:m.req,err:e});
  if(m.t==='auth.logout'){const a=c.acct;if(a){for(const h in db.tokens)if(db.tokens[h].k===a.key&&m.token&&h===sha(String(m.token)))delete db.tokens[h];touch()}unbind(c);return c.send({t:'auth.out'})}
  if(m.t==='auth.token'){
    if(!authOk(c.ip))return fail('Too many attempts. Wait a minute.');
    const r=db.tokens[sha(String(m.token||''))];if(!r||r.exp<Date.now())return fail('Please sign in again.');
    const a=db.accounts[r.k];if(!a)return fail('Please sign in again.');return bind(c,a,m.req,null);
  }
  const u=String(m.u||'').trim(),p=String(m.p||'');
  if(!authOk(c.ip))return fail('Too many attempts. Wait a minute.');
  if(m.t==='auth.register'){
    if(!validName(u))return fail('Usernames are 3 to 16 letters, numbers or underscores.');
    if(p.length<8||p.length>72)return fail('Passwords need 8 to 72 characters.');
    if(db.accounts[key(u)])return fail('That username is taken.');
    if(Object.keys(db.accounts).length>=LIM.accounts)return fail('Sign ups are closed right now.');
    const salt=crypto.randomBytes(16),hash=await pwHash(p,salt);
    if(db.accounts[key(u)])return fail('That username is taken.');
    /* a new account always starts fresh: coins, XP and items a guest had in the browser are never carried over */
    const a={name:u,key:key(u),salt:salt.toString('hex'),hash:hash.toString('hex'),created:Date.now(),coins:100,xp:0,owned:cosList(null),eq:eqObj(null),
      friends:{},ledger:[],gift:{d:'',n:0},lastSync:Date.now(),fails:0,lock:0,muted:0,email:'',emailVerified:false,ban:0};
    db.accounts[a.key]=a;touch();return bind(c,a,m.req,newToken(a));
  }
  if(m.t==='auth.login'){
    const a=u.includes('@')?db.accounts[emailIndex.get(key(u))]:db.accounts[key(u)];if(!a)return fail('Wrong username or password.');
    if(a.lock>Date.now())return fail('Too many wrong passwords. Try again in a few minutes.');
    const h=await pwHash(p,Buffer.from(a.salt,'hex')),good=crypto.timingSafeEqual(h,Buffer.from(a.hash,'hex'));
    if(!good){if(++a.fails>=5){a.lock=Date.now()+5*60000;a.fails=0}touch();return fail('Wrong username or password.')}
    a.fails=0;return bind(c,a,m.req,newToken(a));
  }
}
function walletSync(c,m){   /* the browser may only change what you wear, and only to things you own; coins, XP and items live here */
  const a=c.acct;if(!a)return;const e=eqObj(m.eq);for(const k in e)if(!a.owned.includes(e[k])){if(m.eq&&m.eq[k]===e[k])acFlag(c,'economy','tried to wear '+e[k]+' without owning it');e[k]=a.eq[k]}a.eq=e;a.lastSync=Date.now();touch();
}
/* ---------- the economy: every coin an account gets or spends goes through here ----------
   Games run in the browser, so earnings are asked for, never set: each kind of reward has a most-per-event, a shortest gap
   between claims and a daily cap. Shop items, crates and the casino are decided on the server. */
const COSP={"s_blue": 0, "s_mint": 60, "s_rose": 60, "s_sun": 80, "s_grape": 80, "s_ember": 100, "s_lime": 120, "s_frost": 150, "s_coral": 180, "s_cloud": 200, "s_slate": 200, "s_obsidian": 250, "s_forest": 280, "s_bubblegum": 300, "s_gold": 350, "s_rosegold": 350, "s_neon": 400, "s_midnight": 450, "s_toxic": 450, "s_camo": 550, "s_tiger": 650, "s_carbon": 700, "s_marble": 750, "s_lava": 900, "s_galaxy": 1200, "s_circuit": 1500, "s_rainbow": 5000, "h_none": 0, "h_cap": 0, "h_beanie": 60, "h_shades": 100, "h_band": 120, "h_flower": 140, "h_halo": 150, "h_bucket": 150, "h_hardhat": 160, "h_beret": 170, "h_cone": 180, "h_earmuffs": 190, "h_headphones": 200, "h_top": 200, "h_grad": 220, "h_pirate": 240, "h_ninja": 250, "h_party": 260, "h_wizard": 280, "h_chef": 300, "h_cowboy": 320, "h_viking": 420, "h_crown": 500, "h_knight": 650, "h_astro": 900, "h_rainbow": 3500, "t_none": 0, "t_spark": 120, "t_dots": 150, "t_bubbles": 180, "t_leaves": 200, "t_snow": 210, "t_hearts": 220, "t_notes": 240, "t_stars": 260, "t_smoke": 280, "t_bolt": 300, "t_fire": 300, "t_coins": 350, "t_skull": 400, "t_rainbow": 800, "k_none": 0, "k_pop": 100, "k_confetti": 250, "k_stars": 350, "k_ghost": 400, "k_fire": 500, "k_lightning": 600, "k_coins": 750, "k_void": 1000, "k_rainbow": 1500};
const ECON={play:{max:2,gap:25e3},match:{max:600,gap:20e3},pk:{max:1200,gap:25e3},chess:{max:50,gap:45e3},gem:{max:15,gap:400,day:800},adv:{max:300,gap:0},quest:{max:200,gap:2e3,cnt:3}};
const EARN_DAY=6000,STREAK=[50,75,100,150,200,250,400],lvOf=x=>Math.floor(Math.sqrt(x/40))+1;
const dayStr=t=>{const d=new Date(t||Date.now());return d.getUTCFullYear()+'-'+(d.getUTCMonth()+1)+'-'+d.getUTCDate()};
function rewOf(a){if(!a.rew||typeof a.rew!=='object')a.rew={};const r=a.rew;if(r.day!==today()){r.day=today();r.earned=0;r.by={};r.quests=0}r.by=r.by||{};r.crates=r.crates|0;r.lv=r.lv|0;r.advs=Array.isArray(r.advs)?r.advs:[];r.streak=r.streak||{last:'',n:0};r.poker=r.poker||{d:'',p:0};return r}
const rewView=a=>{const r=rewOf(a),d=dayStr(),y=dayStr(Date.now()-864e5);return{crates:r.crates,lv:r.lv,quests:r.quests,daily:r.streak.last!==d,sn:r.streak.last===d||r.streak.last===y?r.streak.n:0,advs:r.advs,earned:r.earned|0,cap:EARN_DAY}};
function walletPush(c,a,extra){c.send({t:'wallet.set',coins:a.coins,xp:a.xp,owned:a.owned,rew:rewView(a),...extra})}
function addCoins(a,n,note){a.coins=Math.max(0,Math.min(1e9,a.coins+n));if(n>0)a.xp=Math.min(1e7,(a.xp||0)+n);if(note)ledger(a,note);touch()}
function acFlag(c,why,detail){try{acReport(c,why,detail)}catch(e){console.log('acFlag',e)}}
const SLOT=[['🍒',5,30],['🍋',8,26],['🔔',12,20],['⭐',20,14],['7️⃣',50,7],['💎',100,3]],SLOTP=SLOT.flatMap(([x,,w])=>Array(w).fill(x));
const RED=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36],ROUT={red:[n=>RED.includes(n),1],black:[n=>n>0&&!RED.includes(n),1],even:[n=>n>0&&n%2===0,1],odd:[n=>n%2===1,1],low:[n=>n>=1&&n<=18,1],high:[n=>n>=19,1],d1:[n=>n>=1&&n<=12,2],d2:[n=>n>=13&&n<=24,2],d3:[n=>n>=25,2]};
const rnd=n=>crypto.randomInt(n);
const mkDeck=()=>{const d=[];for(let s=0;s<4;s++)for(let r=2;r<=14;r++)d.push({r,s});for(let i=d.length-1;i>0;i--){const j=rnd(i+1);[d[i],d[j]]=[d[j],d[i]]}return d};
const bjv=h=>{let t=0,x=0;for(const q of h){if(q.r===14){x++;t+=11}else t+=Math.min(10,q.r)}while(t>21&&x){t-=10;x--}return t};
function econMsg(c,m){
  const a=c.acct,reply=(ok,err,extra)=>c.send({t:'econ.res',req:m.req,ok,err,...extra});
  if(!a)return reply(false,'Sign in first.');
  if(m.jack&&!staffOf(a)&&!((c.jack||0)>Date.now()))acFlag(c,'economy','asked the casino for a jackpot staff did not give');
  const r=rewOf(a),now=Date.now(),staff=staffOf(a),jack=(c.jack||0)>now||(!!m.jack&&!!staff);   /* a jackpot only counts when staff turned it on for this player */
  const ok=(extra)=>reply(true,null,{coins:a.coins,xp:a.xp,owned:a.owned,rew:rewView(a),...extra});
  switch(m.t){
    case'econ.earn':{const why=String(m.why),R=ECON[why];if(!R)return reply(false,'Unknown reward.');
      let n=Math.floor(+m.n);const cap=why==='gem'&&(staff||(c.gold||0)>now)?R.max*5:R.max;
      if(!(n>0))return reply(false,'Nothing to add.');
      if(n>cap){acFlag(c,'economy','asked for '+n+' coins from "'+why+'" (most is '+cap+')');n=cap}
      const last=(c.earnT||(c.earnT={}))[why]||0;if(now-last<R.gap){if(now-last<R.gap/3)acFlag(c,'economy','"'+why+'" rewards claimed too fast');return reply(false,'Too soon.')}
      if(R.cnt&&(r.quests|0)>=R.cnt)return reply(false,'All of today\'s quest rewards are claimed.');
      if(why==='adv'){const id=String(m.ref||'').slice(0,24);if(!id||r.advs.includes(id))return reply(false,'Already claimed.');r.advs.push(id);if(r.advs.length>80)r.advs.shift()}
      if(R.day){r.by[why]=(r.by[why]|0)+n;if(r.by[why]>R.day)return reply(false,'Daily limit reached for this reward.')}
      if((r.earned|0)+n>EARN_DAY){n=Math.max(0,EARN_DAY-(r.earned|0));if(!n)return reply(false,'You have earned the most coins from games for today. More tomorrow!')}
      c.earnT[why]=now;r.earned=(r.earned|0)+n;if(why==='quest'){r.quests=(r.quests|0)+1;if(r.quests===3)r.crates++}
      addCoins(a,n);return ok({n})}
    case'econ.daily':{const y=dayStr(now-864e5),d=dayStr(now);if(r.streak.last===d)return reply(false,'Already claimed today.');
      const n=r.streak.last===y?r.streak.n+1:1,amt=STREAK[(n-1)%7];r.streak={last:d,n};if(n%7===0)r.crates++;addCoins(a,amt,'Daily reward (day '+n+')');return ok({n:amt,day:n})}
    case'econ.level':{const L=Math.floor(+m.L);if(L%5||L>lvOf(a.xp)||L<=r.lv||L!==r.lv-(r.lv%5)+5)return reply(false,'Not yet.');r.lv=L;r.crates++;addCoins(a,100*L,'Level '+L+' reward');return ok({n:100*L})}
    case'econ.spend':{const n=Math.floor(+m.n);if(!(n>0&&n<=1e7))return reply(false,'Bad amount.');if(a.coins<n)return reply(false,'Not enough coins.');addCoins(a,-n);return ok({})}
    case'econ.buy':{const id=String(m.id);const p=COSP[id];if(p==null)return reply(false,'No such item.');if(a.owned.includes(id))return reply(false,'You already own it.');
      if(a.coins<p)return reply(false,'Not enough coins.');addCoins(a,-p,'Bought '+id);a.owned.push(id);touch();return ok({id})}
    case'econ.crate':{const free=!!m.free;if(free){if(r.crates<1)return reply(false,'No free crates.')}else if(a.coins<300)return reply(false,'Not enough coins (a crate is 300).');
      const left=Object.keys(COSP).filter(id=>COSP[id]>0&&!a.owned.includes(id));
      if(!left.length){if(free){r.crates--;addCoins(a,200,'Crate refund')}return ok({id:null})}
      const tier=p=>p>=1000?3:p>=400?2:p>=200?1:0,x=rnd(1000)/1000,want=x<.02?3:x<.12?2:x<.4?1:0;let pick=null;
      for(let t=want;t>=0&&!pick;t--){const pool=left.filter(id=>tier(COSP[id])===t);if(pool.length)pick=pool[rnd(pool.length)]}if(!pick)pick=left[rnd(left.length)];
      if(free)r.crates--;else addCoins(a,-300);a.owned.push(pick);touch();return ok({id:pick})}
    case'econ.eventwin':{   /* only the owner running the Wheel of Fortune can pay its winner, and only to someone in the event */
      if(a.key!==OWNER_KEY||!eventRoom||c.room!==eventRoom.id)return reply(false,'Not allowed.');const w=[...eventRoom.members].find(x=>x.id===m.pid);
      if(!w||!w.acct||w.acct.ewin===eventRoom.id)return reply(false,'No account to pay.');w.acct.ewin=eventRoom.id;addCoins(w.acct,1500,'Won the Wheel of Fortune');walletPush(w,w.acct);return reply(true)}
    /* ---- casino: the server deals, spins and flips ---- */
    case'casino.slots':{const bet=Math.floor(+m.bet);if(![10,50,100,500].includes(bet))return reply(false,'Bad bet.');if(a.coins<bet)return reply(false,'Not enough coins');
      const res=jack?['💎','💎','💎']:[0,1,2].map(()=>SLOTP[rnd(SLOTP.length)]);let mul=0;if(res[0]===res[1]&&res[1]===res[2])mul=SLOT.find(x=>x[0]===res[0])[1];else if(res.filter(x=>x==='🍒').length===2)mul=2;
      addCoins(a,-bet);if(mul)addCoins(a,bet*mul);return ok({res,mul,win:bet*mul})}
    case'casino.flip':{const bet=Math.floor(+m.bet);if(!(bet>0&&bet<=5000))return reply(false,'Bad bet.');if(a.coins<bet)return reply(false,'Not enough coins');
      const out=rnd(2)?'Heads':'Tails',win=out===m.pick;addCoins(a,win?bet:-bet);return ok({out,win})}
    case'casino.roulette':{const bets=Array.isArray(m.bets)?m.bets.slice(0,60):[];let tot=0;for(const b of bets){b.a=Math.floor(+b.a);if(!(b.a>0)||!(typeof b.k==='number'?b.k>=0&&b.k<=36&&Number.isInteger(b.k):ROUT[b.k]))return reply(false,'Bad bet.');tot+=b.a}
      if(!tot||tot>10000)return reply(false,'Bad bet.');if(a.coins<tot)return reply(false,'Not enough coins');
      const payOf=n=>bets.reduce((s,b)=>s+(typeof b.k==='number'?(b.k===n?b.a*36:0):(ROUT[b.k][0](n)?b.a*(ROUT[b.k][1]+1):0)),0);
      let num=rnd(37);if(jack){let bp=-1;for(let n=0;n<37;n++){const p=payOf(n);if(p>bp){bp=p;num=n}}}
      const pay=payOf(num);addCoins(a,pay-tot);return ok({num,pay,total:tot})}
    case'casino.bj':{const B=c.bj||(c.bj={phase:'bet'}),act=String(m.act);
      const view=(extra)=>({phase:B.phase,ph:B.ph,dh:B.phase==='play'?[B.dh[0]]:B.dh,dhn:B.dh?B.dh.length:0,bet:B.bet,...extra});
      const end=(mul,txt)=>{B.phase='done';if(mul)addCoins(a,Math.floor(B.bet*mul));return ok(view({mul,txt}))};
      const stand=()=>{while(bjv(B.dh)<17)B.dh.push(B.deck.pop());const p=bjv(B.ph),d=bjv(B.dh);return d>21?end(2,'Dealer busts. You win '+B.bet+' coins.'):p>d?end(2,'You win '+B.bet+' coins.'):p===d?end(1,'Push. Your bet is returned.'):end(0,'Dealer wins.')};
      if(act==='deal'){if(B.phase==='play')return reply(false,'Finish this hand first.');const bet=Math.floor(+m.bet);if(![10,50,100,500,1000].includes(bet))return reply(false,'Bad bet.');if(a.coins<bet)return reply(false,'Not enough coins');
        addCoins(a,-bet);B.bet=bet;B.deck=mkDeck();B.ph=[B.deck.pop(),B.deck.pop()];B.dh=[B.deck.pop(),B.deck.pop()];if(jack){B.ph=[{r:14,s:0},{r:13,s:0}];B.dh=[{r:9,s:1},{r:7,s:2}]}B.phase='play';
        if(bjv(B.ph)===21)return bjv(B.dh)===21?end(1,'Both have blackjack. Push.'):end(2.5,'Blackjack! You win '+Math.floor(B.bet*1.5)+' coins.');return ok(view())}
      if(B.phase!=='play')return reply(false,'Deal first.');
      if(act==='hit'){B.ph.push(B.deck.pop());if(bjv(B.ph)>21)return end(0,'Bust. Dealer wins.');return ok(view())}
      if(act==='stand')return stand();
      if(act==='double'){if(B.ph.length!==2||a.coins<B.bet)return reply(false,'You cannot double now.');addCoins(a,-B.bet);B.bet*=2;B.ph.push(B.deck.pop());if(bjv(B.ph)>21)return end(0,'Bust. Dealer wins.');return stand()}
      return reply(false,'Bad move.')}
    case'casino.poker':{   /* poker is against bots in the browser, so a table can pay back at most 4x what you sat down with (all four stacks), and 2000 coins of winnings a day */
      const P=r.poker.d===today()?r.poker:(r.poker={d:today(),p:0});
      if(m.act==='buyin'){const n=Math.floor(+m.n);if(!(n>0&&n<=5000))return reply(false,'Bad amount.');if(a.coins<n)return reply(false,'Not enough coins');addCoins(a,-n);c.pk={buy:n,at:now};return ok({})}
      if(m.act==='cashout'){const B=c.pk;if(!B)return reply(false,'Nothing to cash out.');let n=Math.max(0,Math.min(Math.floor(+m.n)||0,B.buy*4));const prof=n-B.buy;
        if(prof>0&&P.p+prof>2000){n=B.buy+Math.max(0,2000-P.p);acFlag(c,'economy','poker winnings over the daily cap')}P.p+=Math.max(0,n-B.buy);c.pk=null;addCoins(a,n);return ok({n})}
      return reply(false,'Bad move.')}
  }
}
function gift(c,m){
  const reply=(ok,err,extra)=>c.send({t:'gift.res',req:m.req,ok,err,...extra});
  const a=c.acct;if(!a)return reply(false,'Sign in to send gifts.');
  const to=db.accounts[key(m.to)];if(!to)return reply(false,'No player with that username.');
  if(to===a)return reply(false,'You cannot gift yourself.');
  const amt=int(m.amount,0,LIM.giftMax,0);if(amt<1)return reply(false,'Pick an amount from 1 to '+LIM.giftMax+'.');
  if(Date.now()-a.created<3*864e5&&!staffOf(a))return reply(false,'New accounts can send gifts after 3 days.');
  if(lvOf(a.xp||0)<5&&!staffOf(a))return reply(false,'You can send gifts from level 5.');
  if(a.coins<amt)return reply(false,'You do not have that many coins.');
  if(a.gift.d!==today())a.gift={d:today(),n:0};
  if(a.gift.n+amt>LIM.giftDay)return reply(false,'Daily gift limit reached ('+LIM.giftDay+' coins a day). You can still send '+Math.max(0,LIM.giftDay-a.gift.n)+'.');
  const nowT=Date.now();if(a.lastGift&&nowT-a.lastGift<2000)return reply(false,'Slow down a moment.');
  a.lastGift=nowT;a.coins-=amt;a.gift.n+=amt;to.coins+=amt;
  ledger(a,'Gifted '+amt+' coins to '+to.name);ledger(to,'Received '+amt+' coins from '+a.name);touch();
  reply(true,null,{balance:a.coins,left:LIM.giftDay-a.gift.n});walletPush(c,a);
  const oc=online.get(to.key);if(oc)oc.send({t:'gift.in',from:a.name,amount:amt,balance:to.coins});
}

/* ---------- friends ---------- */
function roomInfo(c){const r=c&&c.room&&rooms.get(c.room);return r?{id:r.id,kind:r.kind,name:r.name,count:r.members.size,max:r.max,priv:r.priv}:null}
function friendList(a){
  const out=[];for(const k in a.friends){const o=db.accounts[k];if(!o)continue;const c=online.get(k);const pa=c&&c.party&&parties.get(c.party);out.push({name:o.name,status:a.friends[k],online:!!c,room:a.friends[k]==='friend'?roomInfo(c):null,party:a.friends[k]==='friend'&&pa&&pa.open?pa.members.size:0,unread:dmUnread(a,o)})}
  return out;
}
const pend=new Map();
function pushFriends(k){const c=online.get(k);if(c&&c.acct)c.send({t:'friends',list:friendList(c.acct)})}
function presence(k){   /* tell this player's friends something changed */
  const a=db.accounts[k];if(!a)return;pushFriends(k);
  for(const f in a.friends)if(a.friends[f]==='friend'&&online.get(f)&&!pend.has(f))pend.set(f,setTimeout(()=>{pend.delete(f);pushFriends(f)},250));
}
function friendMsg(c,m){
  const a=c.acct,reply=(ok,err)=>c.send({t:'friend.res',req:m.req,ok,err});
  if(!a)return reply(false,'Sign in to use friends.');
  if(m.t==='friend.list'){pushFriends(a.key);return}
  const o=db.accounts[key(m.name)];if(!o)return reply(false,'No player with that username.');
  if(o===a)return reply(false,'That is you.');
  const st=a.friends[o.key];
  if(m.t==='friend.add'){
    if(st==='friend')return reply(false,'You are already friends.');
    if(st==='out')return reply(false,'Request already sent.');
    if(Object.keys(a.friends).length>=100)return reply(false,'Your friends list is full.');
    if(st==='in'){a.friends[o.key]='friend';o.friends[a.key]='friend'}else{a.friends[o.key]='out';o.friends[a.key]='in'}
  }else if(m.t==='friend.accept'){if(st!=='in')return reply(false,'No request from that player.');a.friends[o.key]='friend';o.friends[a.key]='friend'}
  else if(m.t==='friend.decline'||m.t==='friend.remove'){delete a.friends[o.key];delete o.friends[a.key]}
  else if(m.t==='friend.join'){
    if(st!=='friend')return reply(false,'You are not friends with that player.');
    const oc=online.get(o.key),r=oc&&oc.room&&rooms.get(oc.room);if(!r)return reply(false,o.name+' is not in a room right now.');
    enter(c,r,m.p,m.req);return;
  }
  touch();reply(true);pushFriends(a.key);pushFriends(o.key);
}

/* ---------- direct messages between friends (kept on the server so staff can review them for safety) ---------- */
const DM_KEEP=60,DM_CONVOS=800;
const dmKey=(a,b)=>[a.key,b.key].sort().join('|');
function dmUnread(a,o){const cv=db.dm[dmKey(a,o)];if(!cv)return 0;const seen=(cv.seen&&cv.seen[a.key])||0;let n=0;for(const x of cv.m)if(x.ts>seen&&x.f!==a.key)n++;return n}
function dmPush(a,o,msg){
  const k=dmKey(a,o);let cv=db.dm[k];if(!cv){cv=db.dm[k]={a:[a.key,o.key].sort(),m:[],seen:{},at:0};
    const keys=Object.keys(db.dm);if(keys.length>DM_CONVOS){keys.sort((x,y)=>db.dm[x].at-db.dm[y].at);for(const x of keys.slice(0,keys.length-DM_CONVOS))delete db.dm[x]}}
  cv.m.push(msg);if(cv.m.length>DM_KEEP)cv.m.splice(0,cv.m.length-DM_KEEP);cv.at=msg.ts;cv.seen[a.key]=msg.ts;touch();
  const out={t:'dm.msg',with:o.name,m:{...msg,f:a.name}},inn={t:'dm.msg',with:a.name,m:{...msg,f:a.name}};
  const ac=online.get(a.key),oc=online.get(o.key);if(ac)ac.send(out);if(oc){oc.send(inn);pushFriends(o.key)}
}
const dmView=(cv,a)=>cv.m.map(x=>({...x,f:(db.accounts[x.f]||{}).name||x.f}));
function dmMsg(c,m){
  const a=c.acct;if(!a)return c.send({t:'notice',text:'Sign in to send messages.'});
  const o=m.with?db.accounts[key(clean(m.with,24))]:null;
  if(m.t==='dm.list'){const list=[];for(const k in db.dm){const cv=db.dm[k];if(!cv.a.includes(a.key))continue;const ok=cv.a[0]===a.key?cv.a[1]:cv.a[0],ob=db.accounts[ok];if(!ob)continue;const last=cv.m[cv.m.length-1];list.push({with:ob.name,last:last?{f:(db.accounts[last.f]||{}).name,t:last.k==='party'?'🎉 Party invite':last.t,ts:last.ts}:null,unread:dmUnread(a,ob)})}
    list.sort((x,y)=>(y.last?y.last.ts:0)-(x.last?x.last.ts:0));return c.send({t:'dm.list',list})}
  if(!o)return c.send({t:'notice',text:'No player with that username.'});
  if(o===a)return;
  if(m.t==='dm.history'){const cv=db.dm[dmKey(a,o)];return c.send({t:'dm.history',with:o.name,msgs:cv?dmView(cv,a):[]})}
  if(m.t==='dm.read'){const cv=db.dm[dmKey(a,o)];if(cv){cv.seen[a.key]=Date.now();touch();pushFriends(a.key)}return}
  if(a.friends[o.key]!=='friend')return c.send({t:'notice',text:'You can only message friends.'});
  if(a.muted>Date.now()||c.muteUntil>Date.now())return c.send({t:'notice',text:'You are muted.'});
  const now=Date.now();c.dmT=(c.dmT||[]).filter(x=>now-x<10000);if(c.dmT.length>=6)return c.send({t:'notice',text:'Slow down a little.'});c.dmT.push(now);
  if(m.t==='dm.send'){let text=clean(m.text,300);for(const w of BAD)text=text.replace(new RegExp(w,'ig'),x=>'*'.repeat(x.length));if(!text)return;dmPush(a,o,{f:a.key,t:text,ts:now});return}
  if(m.t==='dm.invite'){const pa=c.party&&parties.get(c.party);if(!pa)return c.send({t:'notice',text:'Make a party first.'});dmPush(a,o,{f:a.key,t:'Join my party!',k:'party',code:pa.code,ts:now});return}
}
/* ---------- group chats: up to 12 friends, kept on the server like DMs ---------- */
const GC_MAX=12,GC_KEEP=100,GC_PER=30;
const gcName=k=>(db.accounts[k]||{}).name||k;
function gcUnread(g,a){const seen=(g.seen&&g.seen[a.key])||0;let n=0;for(const x of g.m)if(x.ts>seen&&x.f&&x.f!==a.key)n++;return n}
const gcView=(g,a)=>{const last=g.m[g.m.length-1];return{id:g.id,name:g.name,owner:gcName(g.owner),members:g.members.map(gcName),unread:gcUnread(g,a),
  last:last?{f:last.f?gcName(last.f):'',t:last.k==='party'?'🎉 Party invite':last.t,ts:last.ts}:null,call:callOf('gc:'+g.id)?callInfo(callOf('gc:'+g.id)):null}};
function gcLists(g){for(const k of g.members){const x=online.get(k);if(x&&x.acct)gcSendList(x)}}
function gcSendList(c){const a=c.acct;if(!a)return;const list=Object.values(db.gc).filter(g=>g.members.includes(a.key)).map(g=>gcView(g,a)).sort((x,y)=>(y.last?y.last.ts:0)-(x.last?x.last.ts:0));c.send({t:'gc.list',list})}
function gcPush(g,msg){g.m.push(msg);if(g.m.length>GC_KEEP)g.m.splice(0,g.m.length-GC_KEEP);g.at=msg.ts;if(msg.f)g.seen[msg.f]=msg.ts;touch();
  const out={t:'gc.msg',id:g.id,m:{...msg,f:msg.f?gcName(msg.f):''}};for(const k of g.members){const x=online.get(k);if(x)x.send(out)}gcLists(g)}
function gcMsg(c,m){
  const a=c.acct;if(!a)return c.send({t:'notice',text:'Sign in to use group chats.'});
  const now=Date.now(),reply=(ok,err,extra)=>c.send({t:'gc.res',req:m.req,ok,err,...extra});
  if(m.t==='gc.list')return gcSendList(c);
  if(m.t==='gc.create'){const name=clean(m.name,32)||'Group chat',names=Array.isArray(m.members)?m.members.slice(0,GC_MAX):[];
    if(Object.values(db.gc).filter(g=>g.members.includes(a.key)).length>=GC_PER)return reply(false,'You are in too many group chats. Leave one first.');
    const keys=[...new Set(names.map(n=>key(clean(n,24))))].filter(k=>k!==a.key&&db.accounts[k]&&a.friends[k]==='friend');
    if(!keys.length)return reply(false,'Pick at least one friend.');
    const g={id:crypto.randomBytes(5).toString('hex'),name,owner:a.key,members:[a.key,...keys].slice(0,GC_MAX),m:[],seen:{},at:now,created:now};db.gc[g.id]=g;
    gcPush(g,{f:'',t:a.name+' made the group',k:'sys',ts:now});audit('group chat made',a.name,name+' ('+g.members.length+')');return reply(true,null,{id:g.id})}
  const g=db.gc[String(m.id||'')];if(!g||!g.members.includes(a.key))return reply(false,'That group chat is gone.');
  if(m.t==='gc.history'){g.seen[a.key]=now;touch();return c.send({t:'gc.history',id:g.id,msgs:g.m.map(x=>({...x,f:x.f?gcName(x.f):''}))})}
  if(m.t==='gc.read'){g.seen[a.key]=now;touch();return gcSendList(c)}
  if(m.t==='gc.leave'){g.members=g.members.filter(k=>k!==a.key);if(!g.members.length){delete db.gc[g.id];touch();return gcSendList(c)}
    if(g.owner===a.key)g.owner=g.members[0];gcPush(g,{f:'',t:a.name+' left',k:'sys',ts:now});gcSendList(c);return reply(true)}
  if(a.muted>now||c.muteUntil>now)return reply(false,'You are muted.');
  c.gcT=(c.gcT||[]).filter(x=>now-x<10000);if(c.gcT.length>=8)return reply(false,'Slow down a little.');c.gcT.push(now);
  if(m.t==='gc.send'){let text=clean(m.text,300);for(const w of BAD)text=text.replace(new RegExp(w,'ig'),x=>'*'.repeat(x.length));if(!text)return;gcPush(g,{f:a.key,t:text,ts:now});return}
  if(m.t==='gc.invite'){const pa=c.party&&parties.get(c.party);if(!pa)return reply(false,'Make a party first.');gcPush(g,{f:a.key,t:'Join my party!',k:'party',code:pa.code,ts:now});return reply(true)}
  if(m.t==='gc.add'){const o=db.accounts[key(clean(m.name,24))];if(!o||a.friends[o.key]!=='friend')return reply(false,'You can only add your friends.');
    if(g.members.includes(o.key))return reply(false,o.name+' is already in the group.');if(g.members.length>=GC_MAX)return reply(false,'A group chat holds '+GC_MAX+' people.');
    g.members.push(o.key);gcPush(g,{f:'',t:a.name+' added '+o.name,k:'sys',ts:now});return reply(true)}
  if(m.t==='gc.rename'){const name=clean(m.name,32);if(!name)return reply(false,'Type a name.');g.name=name;gcPush(g,{f:'',t:a.name+' renamed the group to '+name,k:'sys',ts:now});return reply(true)}
  if(m.t==='gc.kick'){if(g.owner!==a.key)return reply(false,'Only the group owner can remove people.');const o=db.accounts[key(clean(m.name,24))];if(!o||!g.members.includes(o.key)||o===a)return reply(false,'Not in this group.');
    g.members=g.members.filter(k=>k!==o.key);gcPush(g,{f:'',t:a.name+' removed '+o.name,k:'sys',ts:now});const oc=online.get(o.key);if(oc)gcSendList(oc);return reply(true)}
}
/* ---------- calls: DM and group chat voice calls with screen sharing. The server rings people and passes connection
   messages between them; voice and video go directly between the players (WebRTC), like the game voice chat. ---------- */
const calls=new Map();
const callOf=chat=>{for(const C of calls.values())if(C.chat===chat)return C;return null};
function chatKeys(chat){if(chat.startsWith('dm:'))return chat.slice(3).split('|');const g=db.gc[chat.slice(3)];return g?g.members.slice():[]}
function chatTitle(chat,forKey){if(chat.startsWith('dm:')){const k=chat.slice(3).split('|').find(x=>x!==forKey);return gcName(k)}const g=db.gc[chat.slice(3)];return g?g.name:'Call'}
const callInfo=C=>({id:C.id,n:C.members.size,started:C.at});
function callState(C){const members=[...C.members.values()].map(x=>({id:x.c.id,name:x.c.acct.name,muted:!!x.muted,share:!!x.share}));
  for(const x of C.members.values())x.c.send({t:'call.state',id:C.id,chat:C.chat.startsWith('gc:')?{kind:'gc',id:C.chat.slice(3)}:{kind:'dm'},title:chatTitle(C.chat,x.c.acct.key),members,ring:[...C.ring].map(gcName),started:C.at,by:gcName(C.by)})}
function callStatus(C,ended){for(const k of chatKeys(C.chat)){const x=online.get(k);if(x)x.send({t:'call.status',chat:C.chat.startsWith('gc:')?{kind:'gc',id:C.chat.slice(3)}:{kind:'dm',with:chatTitle(C.chat,k)},id:C.id,active:!ended,n:ended?0:C.members.size})}}
function callEnd(C){calls.delete(C.id);clearTimeout(C.rt);for(const x of C.members.values()){x.c.call=null;x.c.send({t:'call.end',id:C.id})}for(const k of C.ring){const x=online.get(k);if(x)x.send({t:'call.ringend',id:C.id})}C.members.clear();callStatus(C,true)}
function callLeave(c){const C=c.call&&calls.get(c.call);c.call=null;if(!C)return;C.members.delete(c.id);
  for(const x of C.members.values())x.c.send({t:'call.left',id:C.id,peer:c.id});
  if(!C.members.size||(C.chat.startsWith('dm:')&&C.members.size<2&&!C.ring.size))return callEnd(C);callState(C);callStatus(C)}
function callJoin(c,C){if(c.call&&c.call!==C.id)callLeave(c);if(C.members.size>=GC_MAX)return c.send({t:'notice',text:'This call is full.'});
  C.members.set(c.id,{c,muted:false,share:false});c.call=C.id;C.ring.delete(c.acct.key);
  for(const x of C.members.values())if(x.c!==c)x.c.send({t:'call.joined',id:C.id,peer:c.id,name:c.acct.name});callState(C);callStatus(C)}
function callMsg(c,m){
  const a=c.acct;if(!a)return c.send({t:'notice',text:'Sign in to make calls.'});const now=Date.now();
  if(m.t==='call.start'){let chat;
    if(m.gc){const g=db.gc[String(m.gc)];if(!g||!g.members.includes(a.key))return;chat='gc:'+g.id}
    else{const o=db.accounts[key(clean(m.dm,24))];if(!o||o===a||a.friends[o.key]!=='friend')return c.send({t:'notice',text:'You can only call friends.'});chat='dm:'+[a.key,o.key].sort().join('|')}
    let C=callOf(chat);if(C)return callJoin(c,C);
    C={id:'c'+crypto.randomBytes(5).toString('hex'),chat,by:a.key,at:now,members:new Map(),ring:new Set()};calls.set(C.id,C);
    for(const k of chatKeys(chat))if(k!==a.key){const x=online.get(k);if(x){C.ring.add(k);x.send({t:'call.ring',id:C.id,from:a.name,title:chatTitle(chat,k),kind:chat.slice(0,2)})}}
    C.rt=setTimeout(()=>{for(const k of C.ring){const x=online.get(k);if(x)x.send({t:'call.ringend',id:C.id})}C.ring.clear();if(calls.has(C.id)){if(C.chat.startsWith('dm:')&&C.members.size<2)callEnd(C);else callState(C)}},30000);
    callJoin(c,C);if(!C.ring.size&&chat.startsWith('dm:'))c.send({t:'notice',text:chatTitle(chat,a.key)+' is offline. They will see the call if they come online in the next 30 seconds.'});return}
  const C=calls.get(String(m.id||''));if(!C)return c.send({t:'call.end',id:m.id});
  if(!chatKeys(C.chat).includes(a.key))return;
  if(m.t==='call.join')return callJoin(c,C);
  if(m.t==='call.decline'){C.ring.delete(a.key);for(const x of C.members.values())x.c.send({t:'call.declined',id:C.id,name:a.name});
    if(C.chat.startsWith('dm:')&&C.members.size<2&&!C.ring.size)return callEnd(C);return callState(C)}
  if(c.call!==C.id)return;
  if(m.t==='call.leave')return callLeave(c);
  if(m.t==='call.signal'){const to=C.members.get(String(m.to||''));if(!to||to.c===c)return;if(JSON.stringify(m.data||null).length>LIM.rpcMax)return;to.c.send({t:'call.signal',id:C.id,from:c.id,data:m.data});return}
  const me=C.members.get(c.id);
  if(m.t==='call.mute'){me.muted=!!m.muted;return callState(C)}
  if(m.t==='call.share'){me.share=!!m.on;return callState(C)}
  if(m.t==='call.ring'){   /* ring the people in the chat who are not in the call yet */
    for(const k of chatKeys(C.chat)){if([...C.members.values()].some(x=>x.c.acct.key===k))continue;const x=online.get(k);if(x){C.ring.add(k);x.send({t:'call.ring',id:C.id,from:a.name,title:chatTitle(C.chat,k),kind:C.chat.slice(0,2)})}}
    clearTimeout(C.rt);C.rt=setTimeout(()=>{for(const k of C.ring){const x=online.get(k);if(x)x.send({t:'call.ringend',id:C.id})}C.ring.clear();if(calls.has(C.id))callState(C)},30000);return callState(C)}
}
function callsFor(c){const a=c.acct;if(!a)return;for(const C of calls.values())if(chatKeys(C.chat).includes(a.key))c.send({t:'call.status',chat:C.chat.startsWith('gc:')?{kind:'gc',id:C.chat.slice(3)}:{kind:'dm',with:chatTitle(C.chat,a.key)},id:C.id,active:true,n:C.members.size})}
/* ---------- the Wheel of Fortune event: the owner pulls everyone online into one room ---------- */
let eventRoom=null;
function eventInvite(x){if(eventRoom&&rooms.has(eventRoom.id)&&!eventRoom.members.has(x))x.send({t:'user.event',code:eventRoom.code,by:eventRoom.by})}

/* ---------- global chat channels ---------- */
const ghist={};for(const ch of GCH)ghist[ch]=[];
const gcount=ch=>{let n=0;for(const c of conns.values())if(c.gch.has(ch))n++;return n};
function globalMsg(c,m){
  const ch=String(m.ch||'');if(!GCH.includes(ch))return;
  if(m.t==='g.join'){c.gch.add(ch);c.send({t:'g.history',ch,msgs:ghist[ch]||[]});for(const x of conns.values())if(x.gch.has(ch))x.send({t:'g.count',ch,n:gcount(ch)});return}
  if(m.t==='g.leave'){c.gch.delete(ch);return}
  if(m.t==='g.say'){
    const a=c.acct;if(!a)return c.send({t:'notice',text:'Sign in to chat in global channels.'});
    if(a.muted>Date.now()||c.muteUntil>Date.now())return c.send({t:'notice',text:'You are muted.'});
    const now=Date.now();c.ctok=Math.min(LIM.chatBurst,c.ctok+(now-c.clast)/1000*LIM.chatPerSec);c.clast=now;
    if(c.ctok<1)return c.send({t:'notice',text:'You are chatting too fast.'});
    const text=sChat(m.text);if(!text)return;c.ctok--;
    const msg={from:a.name,text,ts:now,staff:shownStaff(a)};ghist[ch].push(msg);if(ghist[ch].length>50)ghist[ch].shift();
    for(const x of conns.values())if(x.gch.has(ch))x.send({t:'g.msg',ch,...msg});
  }
}

/* ---------- email verification and password reset ---------- */
async function emailMsg(c,m){
  const a=c.acct,reply=(ok,err,x)=>c.send({t:'email.res',req:m.req,ok,err,...x});
  if(!a)return reply(false,'Sign in first.');
  if(m.t==='email.remove'){
    const h=await pwHash(String(m.pw||''),Buffer.from(a.salt,'hex'));if(!timingEq(h.toString('hex'),a.hash))return reply(false,'Wrong password.');
    if(a.email)emailIndex.delete(a.email);a.email='';a.emailVerified=false;a.pending=null;touch();c.send({t:'user.update',user:userView(a)});return reply(true);
  }
  if(mailMode==='off')return reply(false,'Email is not set up on this server yet.');
  if(m.t==='email.set'){
    const em=key(clean(m.email,120));if(!EMAIL_RE.test(em))return reply(false,'That email address does not look right.');
    if(emailIndex.has(em)&&emailIndex.get(em)!==a.key)return reply(false,'That email is already used by another account.');
    if(a.pending&&Date.now()-a.pending.sent<60000)return reply(false,'Wait a minute before asking for another code.');
    if(!authOk(c.ip))return reply(false,'Too many attempts. Wait a minute.');
    const code=mkCode(),salt=crypto.randomBytes(8).toString('hex');
    a.pending={email:em,h:hCode(code,salt),salt,exp:Date.now()+15*60000,tries:0,sent:Date.now()};touch();
    try{await sendMail(em,'Your Excalibur verification code','Your verification code is '+code+'. It expires in 15 minutes.\nIf you did not ask for this, you can ignore this email.')}
    catch(e){a.pending=null;console.error('mail failed:',e.message);return reply(false,'Could not send the email. Try again later.')}
    return reply(true,null,{sent:true});
  }
  if(m.t==='email.verify'){
    const p=a.pending;if(!p||p.exp<Date.now())return reply(false,'That code has expired. Ask for a new one.');
    if(++p.tries>5){a.pending=null;touch();return reply(false,'Too many wrong codes. Ask for a new one.')}
    if(!timingEq(hCode(String(m.code||'').trim(),p.salt),p.h)){touch();return reply(false,'Wrong code.')}
    if(emailIndex.has(p.email)&&emailIndex.get(p.email)!==a.key){a.pending=null;return reply(false,'That email is already used by another account.')}
    if(a.email)emailIndex.delete(a.email);a.email=p.email;a.emailVerified=true;a.pending=null;emailIndex.set(a.email,a.key);touch();
    c.send({t:'user.update',user:userView(a)});return reply(true);
  }
}
async function resetMsg(c,m){
  const reply=(ok,err)=>c.send({t:'reset.res',req:m.req,ok,err});
  if(!authOk(c.ip))return reply(false,'Too many attempts. Wait a minute.');
  const id=key(clean(m.id,120)),a=id.includes('@')?db.accounts[emailIndex.get(id)]:db.accounts[id];
  if(m.t==='reset.request'){
    if(mailMode==='off')return reply(false,'Password reset by email is not set up on this server yet.');
    reply(true);   /* the answer is the same whether or not the account exists, so nobody can use this to find usernames */
    if(!a||!a.emailVerified)return;
    const now=Date.now();if(a.reset&&now-a.reset.sent<60000)return;
    a.resetLog=(a.resetLog||[]).filter(t=>now-t<3600e3);if(a.resetLog.length>=3)return;a.resetLog.push(now);
    const code=mkCode(),salt=crypto.randomBytes(8).toString('hex');a.reset={h:hCode(code,salt),salt,exp:now+15*60000,tries:0,sent:now};touch();
    try{await sendMail(a.email,'Reset your Excalibur password','Hi '+a.name+',\nyour password reset code is '+code+'. It expires in 15 minutes.\nIf you did not ask for this, ignore this email: your password has not changed.')}catch(e){console.error('mail failed:',e.message)}
    return;
  }
  if(m.t==='reset.confirm'){
    const pw=String(m.pw||'');if(pw.length<8||pw.length>72)return reply(false,'Passwords need 8 to 72 characters.');
    const r=a&&a.reset;if(!r||r.exp<Date.now())return reply(false,'That code is wrong or has expired.');
    if(++r.tries>5){a.reset=null;touch();return reply(false,'Too many wrong codes. Ask for a new one.')}
    if(!timingEq(hCode(String(m.code||'').trim(),r.salt),r.h)){touch();return reply(false,'That code is wrong or has expired.')}
    const salt=crypto.randomBytes(16),hash=await pwHash(pw,salt);
    a.salt=salt.toString('hex');a.hash=hash.toString('hex');a.reset=null;a.fails=0;a.lock=0;revokeTokens(a);touch();
    kickAccount(a,'Your password was changed. Please sign in again.');
    sendMail(a.email,'Your Excalibur password was changed','Your password was just changed. If this was not you, reset it again right away.').catch(()=>{});
    return reply(true);
  }
}

/* ---------- reports and moderation ---------- */
const REASONS=['cheating','harassment','name','spam','other'];
function reportMsg(c,m){
  const reply=(ok,err)=>c.send({t:'report.res',req:m.req,ok,err}),now=Date.now();
  const reason=String(m.reason||'');if(!REASONS.includes(reason))return reply(false,'Pick a reason.');
  const who=c.acct?c.acct.key:'ip:'+c.ip,log=(reportLog.get(who)||[]).filter(t=>now-t<3600e3);
  if(log.length>=5)return reply(false,'You have sent a lot of reports. Try again later.');
  let tn,tAcct=null,tc=m.target?conns.get(String(m.target)):null,evidence=[],room=null;
  if(tc){
    if(tc===c)return reply(false,'You cannot report yourself.');
    tn=tc.p?tc.p.name:'Player';tAcct=tc.acct;
    const r=tc.room&&tc.room===c.room&&rooms.get(c.room);if(r){room={id:r.id,kind:r.kind,name:r.name};evidence=(r.chat||[]).slice(-15)}
  }else if(m.name){
    const a=db.accounts[key(m.name)];if(!a)return reply(false,'Player not found.');if(c.acct===a)return reply(false,'You cannot report yourself.');
    tn=a.name;tAcct=a;if(GCH.includes(m.ch))evidence=ghist[m.ch].slice(-15);
  }else return reply(false,'Player not found.');
  const tk=tAcct?tAcct.key:'conn:'+(tc&&tc.ip);
  if(db.reports.some(r=>r.by===who&&r.tk===tk&&now-r.ts<600e3))return reply(false,'You already reported this player a moment ago.');
  log.push(now);reportLog.set(who,log);
  db.reports.push({id:crypto.randomBytes(4).toString('hex'),ts:now,by:who,byName:c.acct?c.acct.name:(c.p&&c.p.name)||'guest',tk,target:tn,acct:!!tAcct,reason,note:clean(m.note,200),room,evidence,open:true});
  if(db.reports.length>500)db.reports.splice(0,db.reports.length-500);touch();
  const people=new Set(db.reports.filter(r=>r.tk===tk&&r.open&&now-r.ts<3600e3).map(r=>r.by));
  if(people.size>=3&&!(tAcct&&tAcct.key===OWNER_KEY)){const until=now+15*60000;if(tAcct)tAcct.muted=Math.max(tAcct.muted||0,until);if(tc)tc.muteUntil=until;touch();console.log('[auto-mute] '+tn+' after '+people.size+' reports')}
  if(reason==='cheating'&&tc)acReport(tc,'reported for cheating','by '+(c.acct?c.acct.name:'a guest')+(m.note?': '+clean(m.note,80):''));
  reply(true);
}

/* ---------- owner admin panel: only the account named OWNER_USERNAME (default Owner), and only when OWNER_PASSWORD is set ---------- */
async function ensureOwner(){
  if(!OWNER_PW){console.log('Admin panel: off. Set OWNER_PASSWORD (12+ characters) to create the "'+OWNER_NAME+'" account.');return}
  if(OWNER_PW.length<12){console.error('Admin panel: OFF because OWNER_PASSWORD is shorter than 12 characters.');return}
  const sig=sha('owner:'+OWNER_PW);let a=db.accounts[OWNER_KEY];
  if(a&&a.envSig===sig){console.log('Admin panel: on (account "'+a.name+'")');return}
  const salt=crypto.randomBytes(16),hash=await pwHash(OWNER_PW,salt);
  if(!a){a={name:OWNER_NAME,key:OWNER_KEY,created:Date.now(),coins:1000,xp:0,owned:cosList(null),eq:eqObj(null),friends:{},ledger:[],gift:{d:'',n:0},lastSync:Date.now(),fails:0,lock:0,muted:0,email:'',emailVerified:false,ban:0};db.accounts[OWNER_KEY]=a}
  else if(!a.envSig){if(a.email)emailIndex.delete(a.email);a.email='';a.emailVerified=false;console.log('Admin panel: an account named "'+a.name+'" already existed, so it was taken over (password reset, email removed).')}
  a.salt=salt.toString('hex');a.hash=hash.toString('hex');a.envSig=sig;a.fails=0;a.lock=0;a.ban=0;a.muted=0;revokeTokens(a);touch();
  console.log('Admin panel: on (account "'+a.name+'" now uses OWNER_PASSWORD)');
}
function staffOf(a){return a?((a.key===OWNER_KEY&&OWNER_PW.length>=12)?'owner':(a.admin?'admin':'')):''}
const staffLevel=c=>!c.acct?0:staffOf(c.acct)==='owner'?2:(c.acct.admin?1:0);   /* 2 = owner, 1 = admin (moderation only) */
let curActor='';
function audit(action,target,detail){db.audit.push({t:Date.now(),a:action,x:String(target||''),d:String(detail||''),by:curActor});if(db.audit.length>300)db.audit.splice(0,db.audit.length-300);touch()}
const pushTo=(a,o)=>{const c=online.get(a.key);if(c)c.send(o)};
/* ---------- Survival World: hosted worlds, the server list and staff review ---------- */
const WORLD_MAX=450000;   /* characters of (usually gzip + base64) save data per world */
const WGM=v=>v==='c'?'c':'s',WDF=(v,gm)=>gm==='c'?'n':(['e','n','h','x'].includes(v)?v:'n');
function newWorldRoom(o){const id='r'+crypto.randomBytes(5).toString('hex'),room={id,kind:'world',name:o.name,max:8,priv:!!o.priv,code:code(),members:new Set(),master:null,chat:[],wseed:o.seed,srv:o.srv||'',rand:!!o.rand,gm:WGM(o.gm),df:WDF(o.df,WGM(o.gm))};rooms.set(id,room);return room}
const worldPub=w=>{const r=[...rooms.values()].find(x=>x.srv===w.id);return{id:w.id,name:w.name,desc:w.desc,owner:w.owner,seed:w.seed,gm:WGM(w.gm),df:WDF(w.df,WGM(w.gm)),dead:!!w.dead,count:r?r.members.size:0,max:8,online:!!r}};
function worldMsg(c,m,t){
  const a=c.acct,res=(ok,msg)=>c.send({t:'world.res',ok,msg});
  if(t==='world.list')return c.send({t:'world.servers',list:db.worlds.filter(w=>w.status==='live').map(worldPub)});
  if(t==='world.mine')return c.send({t:'world.mine',list:a?db.worlds.filter(w=>w.ownerKey===a.key).map(w=>({id:w.id,name:w.name,status:w.status,note:w.note||'',gm:WGM(w.gm),df:WDF(w.df,WGM(w.gm)),dead:!!w.dead})):[]});
  if(t==='world.request'){
    if(!a)return res(false,'Sign in to request a server.');
    const name=clean(m.name,24),desc=clean(m.desc,120);
    if(name.length<3)return res(false,'Give your server a name (at least 3 letters).');
    const low=(name+' '+desc).toLowerCase();if(BAD.some(b=>low.includes(b)))return res(false,'Please keep the name and description friendly.');
    if(db.worlds.filter(w=>w.ownerKey===a.key&&w.status!=='denied').length>=3)return res(false,'You can have up to 3 servers (pending or live). Remove one first.');
    if(db.worlds.filter(w=>w.status==='pending').length>=60)return res(false,'Too many requests are waiting. Try again later.');
    db.worlds.push({id:'w'+crypto.randomBytes(4).toString('hex'),name,desc,owner:a.name,ownerKey:a.key,seed:crypto.randomInt(1,2e9),status:'pending',note:'',created:Date.now(),data:'',gm:WGM(m.gm),df:WDF(m.df,WGM(m.gm)),dead:false});touch();
    res(true,'Request sent! An admin will review it. Check "My requests" for the answer.');return worldMsg(c,m,'world.mine');
  }
  if(t==='world.remove'){const w=db.worlds.find(x=>x.id===String(m.id||''));if(!w||!a)return;if(w.ownerKey!==a.key&&!staffOf(a))return;db.worlds.splice(db.worlds.indexOf(w),1);touch();res(true,'Server removed.');return worldMsg(c,m,'world.mine')}
  if(t==='world.reset'){const w=db.worlds.find(x=>x.id===String(m.id||'')&&x.status==='live');if(!w||!a)return;if(w.ownerKey!==a.key&&!staffOf(a))return;
    if([...rooms.values()].some(x=>x.srv===w.id))return res(false,'People are playing on it right now. Try again when everyone has left.');
    w.data='';w.dead=false;w.seed=crypto.randomInt(1,2e9);touch();res(true,'The world was reset with a brand new map.');return worldMsg(c,m,'world.mine')}
  if(t==='world.pending'){if(!staffOf(a))return;return c.send({t:'world.pending',list:db.worlds.filter(w=>w.status==='pending').map(w=>({id:w.id,name:w.name,desc:w.desc,owner:w.owner,created:w.created,gm:WGM(w.gm),df:WDF(w.df,WGM(w.gm))}))})}
  if(t==='world.review'){
    if(!staffOf(a))return;const w=db.worlds.find(x=>x.id===String(m.id||'')&&x.status==='pending');if(!w)return res(false,'That request is already handled.');
    const yes=!!m.ok;w.status=yes?'live':'denied';w.note=clean(m.note,80);curActor=a.name;audit(yes?'world approved':'world denied',w.name,w.owner);touch();
    const oc=online.get(w.ownerKey);if(oc)oc.send({t:'notice',text:yes?'Your server "'+w.name+'" was approved and is now in the server list!':'Your server request "'+w.name+'" was declined'+(w.note?': '+w.note:'.')});
    res(true,yes?'Approved.':'Declined.');return worldMsg(c,m,'world.pending');
  }
  if(c.acct&&c.acct.ban>Date.now()&&/^world\.(host|random|start)$/.test(t))return c.send({t:'deny',req:m.req,ban:c.acct.ban,err:'You are banned from multiplayer for '+banLeft(c.acct.ban-Date.now())+'.'});
  if(t==='world.host'){
    if(rooms.size>=200)return c.send({t:'deny',req:m.req,err:'The server is busy. Try again soon.'});
    const rand=!!m.rand,room=newWorldRoom({name:clean(m.name,24)||'World',seed:Math.floor(num(m.seed,1,2e9))||1,priv:!rand,rand,gm:m.gm,df:m.df});enter(c,room,m.p,m.req);return;
  }
  if(t==='world.random'){
    const r=[...rooms.values()].filter(x=>x.kind==='world'&&x.rand&&open(x)).sort((p,q)=>q.members.size-p.members.size)[0];
    if(!r)return c.send({t:'deny',req:m.req,err:'No public worlds are open right now. Host one with "random joins" on, or try again soon.'});
    enter(c,r,m.p,m.req);return;
  }
  if(t==='world.start'){
    const w=db.worlds.find(x=>x.id===String(m.id||'')&&x.status==='live');if(!w)return c.send({t:'deny',req:m.req,err:'That server is not available.'});
    let r=[...rooms.values()].find(x=>x.srv===w.id);
    if(!r&&w.dead)return c.send({t:'deny',req:m.req,err:'This hardcore server is over. The owner can start it over from "My requests".'});
    if(!r){if(rooms.size>=200)return c.send({t:'deny',req:m.req,err:'The server is busy. Try again soon.'});r=newWorldRoom({name:w.name,seed:w.seed,srv:w.id,priv:false,gm:w.gm,df:w.df})}
    enter(c,r,m.p,m.req);return;
  }
  const room=c.room&&rooms.get(c.room);if(!room||room.kind!=='world'||!room.srv)return;
  const w=db.worlds.find(x=>x.id===room.srv);if(!w)return;
  if(t==='world.get'){if(room.master!==c)return;return c.send({t:'world.data',id:w.id,data:w.data||''})}
  if(t==='world.save'){
    if(room.master!==c)return;const n=Math.floor(num(m.n,1,30)),i=Math.floor(num(m.i,0,29)),rid=clean(m.rid,10),d=typeof m.d==='string'?m.d.slice(0,20000):'';
    if(!c.wbuf||c.wbuf.rid!==rid)c.wbuf={rid,n,parts:[],at:Date.now()};c.wbuf.parts[i]=d;
    if(c.wbuf.parts.filter(x=>x!=null).length===n){const all=c.wbuf.parts.join('');c.wbuf=null;if(all.length>WORLD_MAX)return c.send({t:'notice',text:'This world is too big to save on the server.'});
      try{/* new saves are gzip + base64 ("z1:"); old ones are plain JSON. Either way it must be this server's world. */
        const txt=all.slice(0,3)==='z1:'?zlib.gunzipSync(Buffer.from(all.slice(3),'base64'),{maxOutputLength:12e6}).toString('utf8'):all;
        const o=JSON.parse(txt);if(!o||o.seed!==w.seed||!Array.isArray(o.d))return;
        w.data=all;w.v=2;if(o.dead)w.dead=true;if(!w.dead&&['e','n','h'].includes(o.df)&&o.gm!=='c')w.df=o.df;touch()}catch(e){}}
    return;
  }
}
/* ---------- parties: a group that plays together ---------- */
const parties=new Map();
function pcode(){let s;do{s=Array.from({length:5},()=>'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('')}while(parties.has(s));return s}
const partyView=pa=>({code:pa.code,tag:sha('pt:'+pa.code).slice(0,8),open:!!pa.open,leader:pa.leader,members:[...pa.members].map(([id,mm])=>({id,name:mm.name}))});
function partyPresence(pa){for(const id of pa.members.keys()){const x=conns.get(id);if(x&&x.acct)presence(x.acct.key)}}
function partySend(pa){const vw=partyView(pa);for(const id of pa.members.keys()){const x=conns.get(id);if(x)x.send({t:'user.party',party:vw})}}
function partyLeave(c){const pa=c.party&&parties.get(c.party);c.party=null;if(!pa)return;pa.members.delete(c.id);try{c.send({t:'user.party',party:null})}catch(e){}
  if(!pa.members.size){parties.delete(pa.code);return}if(pa.leader===c.id)pa.leader=pa.members.keys().next().value;partySend(pa)}
/* ---------- staff tools: live effects and polls ---------- */
const FXOK=new Set(['speed','fly','size','jackpot','aimbot','spawn','bots','clearbots','rain','clear','gold','god']);
function cleanFx(f){if(!f||typeof f!=='object'||!FXOK.has(String(f.k)))return null;
  const o={k:String(f.k)};if(typeof f.v==='number')o.v=num(f.v,0,50);else if(typeof f.v==='boolean')o.v=f.v;else if(f.v!==undefined)o.v=String(f.v).slice(0,12);
  if(f.dur!==undefined)o.dur=num(f.dur,0,3600);if(f.n!==undefined)o.n=Math.floor(num(f.n,0,60));return o}
let poll=null;
function pollCounts(){let a=0,b=0;if(poll)for(const x of poll.votes.values())x==='a'?a++:b++;return{a,b}}
function endPoll(){if(!poll)return;const p=poll;poll=null;clearTimeout(p.timer);clearInterval(p.iv);const n=((x)=>({a:x.a,b:x.b}))(pollCountsOf(p));
  const w=n.a>n.b?'a':n.b>n.a?'b':'tie';for(const x of conns.values())x.send({t:'user.pollend',id:p.id,counts:n,winner:w});
  const eff=w==='a'?p.effA:w==='b'?p.effB:null;if(eff)for(const x of conns.values())x.send({t:'user.fx',fx:{...eff,by:'poll'}})}
function pollCountsOf(p){let a=0,b=0;for(const x of p.votes.values())x==='a'?a++:b++;return{a,b}}
function adminMsg(c,m){
  const lvl=staffLevel(c);if(!lvl){if(m.t!=='admin.eventend')acFlag(c,'staff command','sent '+clean(m.t,30)+' without being staff');return}   /* anyone who is not staff is ignored without an answer */
  curActor=c.acct.name;
  const ok=x=>c.send({t:'admin.res',req:m.req,ok:true,...x}),no=e=>c.send({t:'admin.res',req:m.req,ok:false,err:e});
  const acct=()=>db.accounts[key(m.name)]||null,notOwner=a=>a.key!==OWNER_KEY;
  const ownerOnly=()=>{if(lvl<2){no('Only the owner can do that.');return true}return false};
  const guard=a=>{if(a.key===OWNER_KEY){no('The owner account cannot be moderated.');return true}if(lvl<2&&a.admin){no('Admins cannot moderate other admins.');return true}return false};
  switch(m.t){
    case'admin.state':return ok({s:{connections:conns.size,accounts:Object.keys(db.accounts).length,rooms:rooms.size,openReports:db.reports.filter(r=>r.open).length,mail:mailMode,turn:iceCache.src,
      storage:{mode:storage.mode,ok:storage.ok,at:storage.at,err:storage.err},
      lvl,staff:Object.values(db.accounts).filter(a=>a.admin).map(a=>a.name),
      players:[...conns.values()].map(x=>({id:x.id,name:x.p?x.p.name:(x.acct?x.acct.name:'(browsing)'),acct:x.acct?x.acct.name:'',staff:staffOf(x.acct),room:x.room&&rooms.get(x.room)?rooms.get(x.room).name:'',ip:lvl>=2?x.ip:''})).slice(0,200)}});
    case'admin.lookup':{const a=acct();if(!a)return no('No account with that name.');const now=Date.now();
      return ok({u:{name:a.name,coins:a.coins,xp:a.xp,created:a.created,online:!!online.get(a.key),email:lvl>=2&&a.email?maskEmail(a.email):'',admin:!!a.admin,verified:!!a.emailVerified,ban:a.ban>now?a.ban:0,perm:a.ban>=PERM,banCat:a.ban>now?a.banCat||'':'',banReason:a.ban>now?a.banReason||'':'',muted:a.muted>now?a.muted:0,friends:Object.keys(a.friends||{}).length,owned:(a.owned||[]).length,ledger:(a.ledger||[]).slice(-5),owner:!notOwner(a)}})}
    case'admin.coins':{if(ownerOnly())return;const a=acct();if(!a)return no('No account with that name.');const amt=Math.floor(+m.amount);
      if(!Number.isFinite(amt)||Math.abs(amt)>1e9)return no('Use a whole number up to 1,000,000,000.');
      const n=m.mode==='set'?amt:a.coins+amt;a.coins=Math.max(0,Math.min(1e9,n));a.lastSync=Date.now();
      ledger(a,m.mode==='set'?'The owner set your balance to '+a.coins:'The owner '+(amt>=0?'added ':'removed ')+Math.abs(amt)+' coins');audit('coins',a.name,(m.mode==='set'?'set to ':'add ')+amt);touch();
      pushTo(a,{t:'acct.push',coins:a.coins});return ok({coins:a.coins})}
    case'admin.unlockall':{if(ownerOnly())return;const a=acct();if(!a)return no('No account with that name.');a.owned=cosList([...(a.owned||[]),...(Array.isArray(m.ids)?m.ids:[])]);audit('unlock cosmetics',a.name,a.owned.length+' items');touch();pushTo(a,{t:'acct.push',owned:a.owned});return ok({owned:a.owned.length})}
    case'admin.ban':{const a=acct();if(!a)return no('No account with that name.');if(guard(a))return;
      const perm=!!m.perm,h=+m.hours;if(!perm&&(!(h>=0)||h>87600))return no('Hours must be between 0 (lifts a ban) and 87600.');
      const on=perm||h>0;applyBan(a,perm?PERM:h>0?Date.now()+h*3600e3:0,m.cat,on?(clean(m.reason,300)||BAN_DEFAULT):null);
      if(on&&m.ac){const f=db.ac.find(x=>x.id===m.ac);if(f){f.open=false;f.action='banned';f.by=c.acct.name}}
      if(on&&m.rep){const r=db.reports.find(x=>x.id===m.rep);if(r){r.open=false;r.action='ban';r.by=c.acct.name}}
      audit(on?'ban':'unban',a.name,on?(perm?'permanent':h+'h')+' · '+a.banCat+' · '+clean(m.reason,80):'');touch();return ok({})}
    case'admin.appeals':{const now=Date.now();const list=Object.values(db.accounts).filter(a=>a.appeal&&(m.all?now-a.appeal.at<30*864e5:a.appeal.status==='open')).sort((x,y)=>y.appeal.at-x.appeal.at).slice(0,100)
        .map(a=>({name:a.name,ban:a.ban>now?a.ban:0,perm:a.ban>=PERM,cat:a.banCat||'',reason:a.banReason||'',appeal:a.appeal}));return ok({list,cats:BAN_CATS,def:BAN_DEFAULT})}
    case'admin.appeal':{const a=acct();if(!a||!a.appeal)return no('No appeal from that player.');if(guard(a))return;const act=m.act;
      a.appeal.by=c.acct.name;a.appeal.done=Date.now();
      if(act==='lift'){a.appeal.status='lifted';a.appeal.reply=clean(m.reply,300);applyBan(a,0);audit('appeal: lifted ban',a.name,'');touch();return ok({})}
      if(act==='keep'){a.appeal.status='kept';a.appeal.reply=clean(m.reply,300);applyBan(a,a.ban,BAN_CATS.includes(m.cat)?m.cat:a.banCat,m.reason!=null&&String(m.reason).trim()?m.reason:a.banReason);
        audit('appeal: kept ban',a.name,a.banCat+' · '+String(a.banReason).slice(0,60));touch();return ok({})}
      return no('Pick lift or keep.')}
    case'admin.disguise':{const a=c.acct,d=a.disg&&typeof a.disg==='object'?a.disg:(a.disg={rb:true,bot:null});
      if(typeof m.rb==='boolean')d.rb=m.rb;
      if(m.bot==='off')d.bot=null;
      else if(m.bot&&typeof m.bot==='object'){const name=String(m.bot.name||'');if(!BOT_NAMES.includes(name))return no('Pick one of the bot names.');d.bot={name,look:lookFields(m.bot.look)}}
      touch();audit('disguise',a.name,d.bot?'as bot '+d.bot.name:'off'+(d.rb===false?', rainbow hidden':''));
      /* everyone in the room sees the change right away */
      if(c.room){const r=rooms.get(c.room);c.p=profile(c,c.lastP);if(r)for(const x of r.members)x.send({t:'pupd',room:r.id,p:c.p})}
      c.send({t:'acct.push',disg:disgOf(a)});return ok({disg:disgOf(a),bots:BOT_NAMES})}
    case'admin.ac':return ok({list:db.ac.filter(f=>m.all||f.open).slice(-100).reverse()});
    case'admin.acclip':{const f=db.ac.find(x=>x.id===m.id);if(!f||!f.clip)return no('There is no recording for this one.');const tk=crypto.randomBytes(16).toString('hex');
      clipTickets.set(tk,{file:f.clip,exp:Date.now()+15*60e3});for(const [k,v] of clipTickets)if(v.exp<Date.now())clipTickets.delete(k);return ok({path:'/clip/'+tk})}
    case'admin.acdismiss':{const f=db.ac.find(x=>x.id===m.id);if(!f)return no('Not found.');f.open=false;f.action='looks fine';f.by=c.acct.name;
      if(f.clip){fs.unlink(path.join(CLIPS,f.clip),()=>{});clipMem.delete(f.clip);f.clip=null}audit('anti-cheat: dismissed',f.name,f.why);touch();return ok({})}
    case'admin.acrecord':{const t=conns.get(String(m.id||''));if(!t)return no('That player left.');const f=acReport(t,'staff request','asked by '+c.acct.name,true);return ok({id:f&&f.id})}
    case'admin.mute':{const a=acct();if(!a)return no('No account with that name.');if(guard(a))return;
      const mi=+m.minutes;if(!(mi>=0)||mi>525600)return no('Minutes must be between 0 (unmute) and 525600.');
      a.muted=mi>0?Date.now()+mi*60000:0;const oc=online.get(a.key);if(oc)oc.muteUntil=a.muted;audit(mi>0?'mute':'unmute',a.name,mi>0?mi+' min':'');touch();return ok({})}
    case'admin.fx':{const f=cleanFx(m.fx);if(!f)return no('Unknown effect.');if(f.k==='jackpot'&&lvl<2)return no('Only the owner can set jackpots.');
      const names=new Set((Array.isArray(m.names)?m.names:[]).slice(0,60).map(x=>key(x))),list=m.scope==='list';let n=0;
      for(const x of conns.values()){if(list){const a1=x.p?key(x.p.name):'',a2=x.acct?key(x.acct.name):'';if(!names.has(a1)&&!names.has(a2))continue}if(f.k==='jackpot'||f.k==='gold'){const until=f.v===false?0:Date.now()+(f.dur?f.dur*1000:6*36e5);if(f.k==='jackpot')x.jack=until;else x.gold=until}
        if(f.k==='spawn')x.spawnFx=['gem','gift','both'].includes(f.v)?{v:f.v,until:Date.now()+(f.dur?f.dur*1000:6*36e5)}:null;if(f.k==='rain')x.rainFx=Date.now()+(f.dur?f.dur*1000:30e3);if(f.k==='clear'){x.jack=0;x.gold=0;x.spawnFx=null;x.rainFx=0}if(f.k==='clear'){x.jack=0;x.gold=0}if(['speed','fly','size','god'].includes(f.k))x.fxAt=Date.now();
        x.send({t:'user.fx',fx:{...f,by:c.acct.name}});n++}
      audit('effect',list?'whitelist':'everyone',f.k+(f.v!==undefined?' '+f.v:''));return ok({n})}
    case'admin.poll':{if(poll)return no('A poll is already running.');const q=clean(m.q,90),a=clean(m.a,28),b=clean(m.b,28);if(!q||!a||!b)return no('Fill in the question and both options.');
      const secs=Math.floor(num(m.secs||30,10,180));
      poll={id:crypto.randomBytes(3).toString('hex'),q,a,b,by:c.acct.name,end:Date.now()+secs*1000,votes:new Map(),effA:cleanFx(m.effA),effB:cleanFx(m.effB)};
      poll.timer=setTimeout(endPoll,secs*1000);poll.iv=setInterval(()=>{const k=pollCounts();for(const x of conns.values())x.send({t:'user.pollcount',id:poll&&poll.id,counts:k})},1000);
      for(const x of conns.values())x.send({t:'user.poll',poll:{id:poll.id,q,a,b,by:poll.by,secs,left:secs}});audit('poll',q,a+' / '+b);return ok({})}
    case'admin.endpoll':{endPoll();return ok({})}
    case'admin.kick':{const t=conns.get(String(m.id||''));if(!t)return no('That player already left.');if(t.acct&&(t.acct.key===OWNER_KEY||(lvl<2&&t.acct.admin)))return no(t.acct.key===OWNER_KEY?'The owner cannot be kicked.':'Admins cannot kick other admins.');
      if(m.ban)bans.set(t.ip,Date.now()+LIM.banMs);audit('kick',t.p?t.p.name:t.id,m.ban?'address blocked 10 min':'');t.kill(1008,'removed');return ok({})}
    case'admin.delmsg':{const ch=String(m.ch||'');if(!GCH.includes(ch))return no('Unknown channel.');const i=ghist[ch].findIndex(x=>x.ts===m.ts&&x.from===m.from);if(i<0)return no('That message is already gone.');
      ghist[ch].splice(i,1);for(const x of conns.values())if(x.gch.has(ch))x.send({t:'g.del',ch,ts:m.ts,from:m.from});audit('delete message',m.from,'#'+ch);return ok({})}
    case'admin.clear':{const ch=String(m.ch||'');if(!GCH.includes(ch))return no('Unknown channel.');ghist[ch].length=0;for(const x of conns.values())if(x.gch.has(ch))x.send({t:'g.clear',ch});audit('clear channel','#'+ch,'');return ok({})}
    case'admin.announce':{if(ownerOnly())return;const text=clean(m.text,200);if(!text)return no('Type a message first.');const secs=int(m.secs,5,60,15);for(const x of conns.values())x.send({t:'user.announce',text,by:c.acct.name,secs});audit('announce','',text);return ok({})}
    case'admin.reports':return ok({reports:db.reports.filter(r=>m.all||r.open).slice(-100).reverse()});
    case'admin.resolve':{const r=db.reports.find(x=>x.id===m.id);if(!r)return no('That report is gone.');const a0=db.accounts[r.tk],a=a0&&notOwner(a0)&&!(lvl<2&&a0.admin)?a0:null;
      if(m.action==='mute'&&a){a.muted=Date.now()+60*60000;const oc=online.get(a.key);if(oc)oc.muteUntil=a.muted}
      if(m.action==='ban'&&a){applyBan(a,Date.now()+24*3600e3,{cheating:'Cheating',harassment:'Harassment',name:'Inappropriate language',spam:'Spam'}[r.reason]||'Other',r.note||null)}
      r.open=false;r.action=String(m.action||'dismiss');audit('report '+r.action,r.target,r.reason);touch();return ok({})}
    case'admin.setadmin':{if(ownerOnly())return;const a=acct();if(!a)return no('No account with that name.');if(!notOwner(a))return no('The owner is already the owner.');
      a.admin=!!m.on;audit(a.admin?'make admin':'remove admin',a.name,'');touch();pushTo(a,{t:'user.update',user:userView(a)});return ok({admin:a.admin})}
    case'admin.audit':return ok({log:db.audit.slice(-100).reverse()});
    case'admin.dms':{const who=m.name?db.accounts[key(clean(m.name,24))]:null;if(m.name&&!who)return no('No account with that name.');const out=[];
      for(const k in db.dm){const cv=db.dm[k];if(who&&!cv.a.includes(who.key))continue;const last=cv.m[cv.m.length-1];out.push({a:(db.accounts[cv.a[0]]||{}).name||cv.a[0],b:(db.accounts[cv.a[1]]||{}).name||cv.a[1],n:cv.m.length,at:cv.at,last:last?last.t:''})}
      out.sort((x,y)=>y.at-x.at);return ok({list:out.slice(0,150)})}
    case'admin.dmlog':{const A=db.accounts[key(clean(m.a,24))],B=db.accounts[key(clean(m.b,24))];if(!A||!B)return no('No such conversation.');const cv=db.dm[dmKey(A,B)];if(!cv)return no('No such conversation.');
      audit('read dms',A.name+' / '+B.name,'');touch();return ok({msgs:dmView(cv,A)})}
    case'admin.event':{if(ownerOnly())return;if(eventRoom&&rooms.has(eventRoom.id))return ok({code:eventRoom.code,again:true});
      const id='r'+crypto.randomBytes(5).toString('hex');eventRoom={id,kind:'event',name:'Wheel of Fortune',max:KINDS.event.max,priv:true,code:code(),members:new Set(),master:null,locked:false,ownerKey:c.acct.key,by:c.acct.name};
      rooms.set(id,eventRoom);audit('event','','start');
      setTimeout(()=>{for(const x of conns.values())if(x!==c)eventInvite(x)},1500);return ok({code:eventRoom.code})}
    case'admin.eventend':{if(ownerOnly())return;if(eventRoom){for(const x of eventRoom.members)x.send({t:'user.eventend'});eventRoom=null}return ok({})}
  }
}

/* ---------- message router ---------- */
async function handle(c,m){
  const t=m.t;
  if(t.startsWith('auth.'))return authMsg(c,m);
  if(t==='wallet.sync')return walletSync(c,m);
  if(t.startsWith('econ.')||t.startsWith('casino.'))return econMsg(c,m);
  if(t.startsWith('ac.'))return acMsg(c,m);
  if(t.startsWith('spawn.'))return spawnMsg(c,m);
  if(t==='ban.appeal')return appealMsg(c,m);
  if(t==='gift')return gift(c,m);
  if(t==='poll.vote'){if(poll&&Date.now()<poll.end&&(m.c==='a'||m.c==='b'))poll.votes.set(c.acct?'a:'+c.acct.key:'c:'+c.id,m.c);return}
  if(t.startsWith('admin.'))return adminMsg(c,m);
  if(t.startsWith('email.'))return emailMsg(c,m);
  if(t.startsWith('reset.'))return resetMsg(c,m);
  if(t==='report')return reportMsg(c,m);
  if(t.startsWith('friend.'))return friendMsg(c,m);
  if(t.startsWith('dm.'))return dmMsg(c,m);
  if(t.startsWith('gc.'))return gcMsg(c,m);
  if(t.startsWith('call.'))return callMsg(c,m);
  if(t.startsWith('g.'))return globalMsg(c,m);
  if(t==='who'){c.send({t:'rooms',rooms:[...rooms.values()].filter(r=>!r.priv&&!r.locked).map(pub)});return}
  if(t.startsWith('world.')){worldMsg(c,m,t);return}
  if(t==='party.create'){partyLeave(c);const pa={code:pcode(),leader:c.id,members:new Map([[c.id,{name:clean(m.name,20)||'Player'}]]),room:null};parties.set(pa.code,pa);c.party=pa.code;partySend(pa);return}
  if(t==='party.join'){const pa=parties.get(clean(m.code,5).toUpperCase());if(!pa)return c.send({t:'notice',text:'There is no party with that code.'});if(pa.members.has(c.id))return;if(pa.members.size>=8)return c.send({t:'notice',text:'That party is full.'});partyLeave(c);pa.members.set(c.id,{name:clean(m.name,20)||'Player'});c.party=pa.code;partySend(pa);return}
  if(t==='party.leave'){partyLeave(c);return}
  if(t==='party.open'){const pa=c.party&&parties.get(c.party);if(!pa||pa.leader!==c.id)return;pa.open=!!m.v;partySend(pa);partyPresence(pa);return}
  if(t==='party.joinfriend'){   /* join a friend's party when they allow friends in, or with an invite they sent you */
    const a=c.acct;if(!a)return c.send({t:'notice',text:'Sign in to join a friend\'s party.'});const o=db.accounts[key(clean(m.name,24))];
    if(!o||a.friends[o.key]!=='friend')return c.send({t:'notice',text:'You can only join a friend\'s party.'});
    const oc=online.get(o.key),pa=oc&&oc.party&&parties.get(oc.party);if(!pa)return c.send({t:'notice',text:o.name+' is not in a party right now.'});
    const invited=m.code&&clean(m.code,5).toUpperCase()===pa.code;if(!pa.open&&!invited)return c.send({t:'notice',text:o.name+'\'s party is not open to friends.'});
    if(pa.members.has(c.id))return;if(pa.members.size>=8)return c.send({t:'notice',text:'That party is full.'});
    partyLeave(c);pa.members.set(c.id,{name:a.name});c.party=pa.code;partySend(pa);partyPresence(pa);return}
  if(t==='party.invite'){const pa=c.party&&parties.get(c.party);if(!pa||!pa.members.has(c.id))return;const nm=key(clean(m.target,24));
    for(const x of conns.values()){if(x===c||x.party===pa.code)continue;const n1=x.acct?key(x.acct.name):'',n2=x.p?key(x.p.name):'';if(nm&&(n1===nm||n2===nm)){x.send({t:'user.partyinv',from:pa.members.get(c.id).name,code:pa.code});return c.send({t:'notice',text:'Invite sent.'})}}
    return c.send({t:'notice',text:'That player is not online.'})}
  if(t==='party.go'){const pa=c.party&&parties.get(c.party);if(!pa||pa.leader!==c.id)return;const g=clean(m.game,24);pa.room=null;for(const id of pa.members.keys()){const x=conns.get(id);if(x)x.send({t:'user.partygo',game:g,code:pa.code,leader:pa.members.get(c.id).name})}return}
  if((t==='join'||t==='quick'||t==='joincode')&&c.acct&&c.acct.ban>Date.now())return c.send({t:'deny',room:m.room,req:m.req,ban:c.acct.ban,err:'You are banned from multiplayer for '+banLeft(c.acct.ban-Date.now())+'.'});
  if(t==='join'){
    const id=String(m.room||'');if(!/^r[a-z0-9]{4,12}$/.test(id))return;
    let room=rooms.get(id);
    if(!room){
      const me=m.meta||{};if(!KINDS[me.kind])return;
      if(rooms.size>=200)return c.send({t:'deny',room:id,err:'The server is busy. Try again soon.'});
      const K=KINDS[me.kind];
      room={id,kind:me.kind,name:clean(me.name,24)||K.label,max:Math.floor(num(me.max||K.max,2,K.max)),priv:!!me.priv,code:code(),members:new Set(),master:null,chat:[]};
      rooms.set(id,room);
    }
    enter(c,room,m.p,null);return;
  }
  if(t==='quick'){   /* atomic: the server picks the fullest open room, or opens a new one, so two people arriving together always meet */
    const K=KINDS[m.kind];if(!K)return;
    const pa=m.party?parties.get(clean(m.party,5).toUpperCase()):null;let room=null;   /* a party always lands in the same room */
    if(pa&&pa.members.has(c.id)&&pa.room){const pr=rooms.get(pa.room);if(pr&&pr.kind===m.kind&&open(pr))room=pr}
    if(!room)room=[...rooms.values()].filter(r=>r.kind===m.kind&&open(r)).sort((a,b)=>b.members.size-a.members.size)[0];
    if(!room){
      if(rooms.size>=200)return c.send({t:'deny',req:m.req,err:'The server is busy. Try again soon.'});
      const used=new Set([...rooms.values()].map(r=>r.name));let n=1;while(used.has(K.label+' '+n))n++;
      room={id:'r'+crypto.randomBytes(5).toString('hex'),kind:m.kind,name:K.label+' '+n,max:K.max,priv:false,code:code(),members:new Set(),master:null,chat:[]};rooms.set(room.id,room);
    }
    if(enter(c,room,m.p,m.req)!==false&&pa&&pa.members.has(c.id))pa.room=room.id;return;
  }
  if(t==='joincode'){
    const cd=clean(m.code,5).toUpperCase(),room=[...rooms.values()].find(r=>r.code===cd);
    if(!room)return c.send({t:'deny',req:m.req,err:'No room with that code.'});
    enter(c,room,m.p,m.req);return;
  }
  if(!c.room)return;const room=rooms.get(c.room);if(!room)return;
  if(t==='leave'){leaveRoom(c);return}
  if(t==='lock'){if(room.master===c)room.locked=true;return}   /* the master closes the room when a match starts */
  if(t==='state'&&m.s){
    const s=m.s,o={x:Math.round(num(s.x,-200,2600)),y:Math.round(num(s.y,-200,2600)),dir:Math.round(num(s.dir,0,3)),mv:!!s.mv,wk:+num(s.wk,0,100).toFixed(2),sz:+num(s.sz||1,0.3,4).toFixed(2)};
    broadcast(room,{t:'state',room:room.id,from:c.id,s:o},c);if(room.recs)recPush(room,c,'s',[o.x,o.y,o.dir,o.mv?1:0,o.sz]);return;
  }
  if(t==='chat'){
    const now=Date.now();c.ctok=Math.min(LIM.chatBurst,c.ctok+(now-c.clast)/1000*LIM.chatPerSec);c.clast=now;
    if(c.ctok<1){c.send({t:'notice',text:'You are chatting too fast.'});return}
    if(c.muteUntil>now||(c.acct&&c.acct.muted>now)){c.send({t:'notice',text:'You are muted.'});return}
    if(c.acct&&c.acct.ban>now){c.send({t:'notice',text:'You are banned from chat for '+banLeft(c.acct.ban-now)+'.'});return}
    const text=sChat(m.text);if(!text)return;c.ctok--;
    room.chat.push({from:c.p?c.p.name:'?',text,ts:now});if(room.chat.length>30)room.chat.shift();recPush(room,c,'c',text);
    broadcast(room,{t:'chat',room:room.id,from:c.id,text},c);return;
  }
  if(t==='rpc'){   /* remote procedure calls inside a room: target is 'all', 'others', 'master' or a player id */
    const name=String(m.name||'');if(!/^[a-z][\w.]{0,30}$/.test(name))return;
    let args=m.args;const len=args===undefined?0:JSON.stringify(args).length;if(len>LIM.rpcMax)return;
    const out={t:'rpc',room:room.id,from:c.id,name,args},tg=String(m.target||'others');
    /* the latest copy of each message kind (match roster, settings...) so a replay that starts mid-game knows who is who */
    if(HOST_ONLY.has(name)&&room.master!==c){const h=c.fakeHost||(c.fakeHost=[]);h.push(Date.now());while(h.length&&Date.now()-h[0]>10e3)h.shift();
      if(h.length>=3)acFlag(c,'fake host messages','sent "'+name+'" '+h.length+' times while not the host')}
    if(len<12000){const L=room.lastRpc||(room.lastRpc={});if(name in L||Object.keys(L).length<40)L[name]=args}
    if(room.recs)recPush(room,c,'r',[name,tg.length>12?'p':tg,args],len>1500?len:0);
    if(tg==='master'){if(room.master&&room.master!==c)room.master.send(out)}
    else if(tg==='others'||tg==='all')broadcast(room,out,c);
    else{for(const x of room.members)if(x.id===tg&&x!==c)x.send(out)}
    return;
  }
}

/* ---------- http ---------- */
const PUB=path.join(__dirname,'public');
const ADMIN_PAGE=`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Excalibur admin</title>
<style>body{font:15px system-ui;background:#0b1230;color:#e8ecf6;margin:0;padding:20px;max-width:900px;margin:auto}input,button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #33407a;background:#16204a;color:#fff}button{cursor:pointer}
.r{background:#121a3d;border:1px solid #2a3770;border-radius:12px;padding:12px;margin:10px 0}.m{color:#9aa6cf;font-size:13px}pre{white-space:pre-wrap;background:#0a0f26;padding:8px;border-radius:8px;font-size:12px}</style>
<h1>Reports</h1><p><input id=t type=password placeholder="Admin token" size=36> <button onclick=load()>Load</button> <label class=m><input type=checkbox id=a> include closed</label></p><div id=o></div>
<script>
const q=(s)=>document.querySelector(s);
async function load(){const t=q('#t').value,r=await fetch('/admin/reports?token='+encodeURIComponent(t)+(q('#a').checked?'&all=1':''));const o=q('#o');o.textContent='';
if(!r.ok){o.textContent='Wrong token.';return}const l=await r.json();if(!l.length)o.textContent='No open reports.';
for(const x of l){const d=document.createElement('div');d.className='r';const h=document.createElement('b');h.textContent=x.target+(x.acct?' (account)':' (guest)')+'  -  '+x.reason;const m=document.createElement('div');m.className='m';
m.textContent='reported by '+x.byName+' at '+new Date(x.ts).toLocaleString()+(x.room?'  in '+x.room.name:'')+(x.open?'':'  [closed: '+x.action+']');d.append(h,m);
if(x.note){const n=document.createElement('div');n.textContent='"'+x.note+'"';d.append(n)}
if(x.evidence&&x.evidence.length){const p=document.createElement('pre');p.textContent=x.evidence.map(e=>e.from+': '+e.text).join('\\n');d.append(p)}
if(x.open)for(const[a,l2]of[['dismiss','Dismiss'],['mute','Mute 1h'],['ban','Suspend 24h']]){const b=document.createElement('button');b.textContent=l2;b.style.marginRight='6px';
b.onclick=async()=>{await fetch('/admin/report?token='+encodeURIComponent(t)+'&id='+x.id+'&action='+a,{method:'POST'});load()};d.append(b)}
o.append(d)}}
</script>`;
/* ---------- the game library: game folders, thumbnails and tab icons, served from the site ----------
   games.json (next to server.js, or in GAMES_DIR) lists the games. Only the folders it names and the icons folder are served,
   so server.js, the data folder and everything else stay private. */
const LIB=path.resolve(process.env.GAMES_DIR||__dirname);
const MIME={html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json; charset=utf-8',
  txt:'text/plain; charset=utf-8',xml:'application/xml',csv:'text/csv',md:'text/plain; charset=utf-8',webmanifest:'application/manifest+json',
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml',ico:'image/x-icon',bmp:'image/bmp',
  mp3:'audio/mpeg',ogg:'audio/ogg',oga:'audio/ogg',wav:'audio/wav',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac',mp4:'video/mp4',webm:'video/webm',ogv:'video/ogg',
  wasm:'application/wasm',swf:'application/x-shockwave-flash',ttf:'font/ttf',otf:'font/otf',woff:'font/woff',woff2:'font/woff2',glb:'model/gltf-binary',gltf:'model/gltf+json'};
const NEVER=new Set(['data','.git','node_modules','server.js','package.json','package-lock.json','.env','render.yaml','supabase.sql','README.md']);
let libCache={at:0,games:[],dirs:new Set(['icons'])};
function library(){
  if(Date.now()-libCache.at<15e3)return libCache;
  const dirs=new Set(['icons']);let games=[],err='';
  try{const j=JSON.parse(fs.readFileSync(path.join(LIB,'games.json'),'utf8'));
    games=(Array.isArray(j)?j:j.games||[]).filter(x=>x&&typeof x.path==='string'&&typeof x.name==='string').slice(0,500).map(x=>({
      id:String(x.id||x.name).toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40),name:String(x.name).slice(0,60),path:String(x.path).replace(/^\/+/,''),
      thumb:typeof x.thumb==='string'?x.thumb.replace(/^\/+/,''):'',desc:typeof x.desc==='string'?x.desc.slice(0,200):'',cat:typeof x.cat==='string'?x.cat.slice(0,24):'Arcade',tags:Array.isArray(x.tags)?x.tags.slice(0,10).map(String):[]}));
    for(const f of Array.isArray(j.folders)?j.folders.slice(0,50):[]){const top=String(f).replace(/^\/+|\/+$/g,'').split('/')[0];if(top&&!NEVER.has(top)&&!top.startsWith('.'))dirs.add(top)}   /* extra folders the games load from */
    for(const g of games)for(const f of[g.path,g.thumb]){const top=f.split('/')[0];if(top&&f.includes('/')&&!NEVER.has(top)&&!top.startsWith('.'))dirs.add(top)}}
  catch(e){err=e.code==='ENOENT'?'':e.message}
  libCache={at:Date.now(),games,dirs,err};return libCache}
function iconList(){try{return fs.readdirSync(path.join(LIB,'icons')).filter(f=>/\.(ico|png|svg|gif|jpe?g|webp)$/i.test(f)).sort().slice(0,200)}catch(e){return[]}}
/* streams a file with caching (ETag, 304), byte ranges for audio and video, and the right content type */
function sendFile(req,res,file,st){
  const ext=path.extname(file).slice(1).toLowerCase(),type=MIME[ext]||'application/octet-stream',etag='W/"'+st.size.toString(36)+'-'+Math.floor(st.mtimeMs).toString(36)+'"';
  const h={'Content-Type':type,'ETag':etag,'Last-Modified':st.mtime.toUTCString(),'Accept-Ranges':'bytes','Cache-Control':/^html?$/.test(ext)?'no-cache':'public, max-age=86400'};
  if(req.headers['if-none-match']===etag){res.writeHead(304,h);return res.end()}
  let start=0,end=st.size-1,code=200;const rg=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
  if(rg&&st.size){if(rg[1]===''){start=Math.max(0,st.size-(+rg[2]||0))}else{start=+rg[1];if(rg[2]!=='')end=Math.min(end,+rg[2])}
    if(start>end||start>=st.size){res.writeHead(416,{'Content-Range':'bytes */'+st.size});return res.end()}code=206;h['Content-Range']='bytes '+start+'-'+end+'/'+st.size}
  h['Content-Length']=st.size?end-start+1:0;res.writeHead(code,h);
  if(req.method==='HEAD'||!st.size)return res.end();
  const rs=fs.createReadStream(file,{start,end});rs.on('error',()=>res.destroy());rs.pipe(res)}
function serveLib(req,res,p){
  let rel;try{rel=decodeURIComponent(p).replace(/^\/+/,'')}catch(e){return false}
  if(!rel||rel.includes('\0')||rel.includes('\\'))return false;
  const parts=rel.split('/');if(parts.some(x=>x==='..'||x==='.'||x.startsWith('.')))return false;
  if(!library().dirs.has(parts[0]))return false;
  const file=path.resolve(LIB,rel);if(!file.startsWith(LIB+path.sep))return false;
  fs.stat(file,(e,st)=>{
    if(e){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('not found')}
    if(st.isDirectory()){if(!p.endsWith('/')){res.writeHead(301,{Location:p+'/'});return res.end()}
      const idx=path.join(file,'index.html');return fs.stat(idx,(e2,st2)=>{if(e2){res.writeHead(404);return res.end('not found')}sendFile(req,res,idx,st2)})}
    sendFile(req,res,file,st)});
  return true}
const secure=res=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer')};
const server=http.createServer((req,res)=>{
  secure(res);const u=new URL(req.url,'http://x'),p=u.pathname;
  if(p==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('ok')}
  if(p.startsWith('/clip/'))return clipServe(res,p.slice(6).replace(/[^0-9a-f]/g,''));
  if(p==='/games.json'){const L=library();res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache'});return res.end(JSON.stringify({games:L.games,err:L.err||undefined}))}
  if(p==='/icons.json'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache'});return res.end(JSON.stringify({icons:iconList()}))}
  if(p==='/favicon.ico'){const f=path.join(LIB,'favicon.ico');return fs.stat(f,(e,st)=>{if(e){res.writeHead(404);return res.end()}sendFile(req,res,f,st)})}
  if((req.method==='GET'||req.method==='HEAD')&&serveLib(req,res,p))return;
  if(p.startsWith('/admin/')&&ADMIN){
    const tok=u.searchParams.get('token')||'',a=Buffer.from(tok),b=Buffer.from(ADMIN);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){res.writeHead(403);return res.end('no')}
    if(p==='/admin/status'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({connections:conns.size,accounts:Object.keys(db.accounts).length,online:[...online.keys()],rooms:[...rooms.values()].map(r=>({id:r.id,name:r.name,kind:r.kind,priv:r.priv,master:r.master&&r.master.id,players:[...r.members].map(c=>({id:c.id,name:c.p&&c.p.name,acct:!!c.acct,ip:c.ip}))}))},null,1))}
    if(p==='/admin/reports'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(db.reports.filter(r=>u.searchParams.get('all')==='1'||r.open).slice(-100).reverse()))}
    if(p==='/admin/report'&&req.method==='POST'){
      const r=db.reports.find(x=>x.id===u.searchParams.get('id'));if(!r){res.writeHead(404);return res.end('none')}
      const act=u.searchParams.get('action'),a0=db.accounts[r.tk],a=a0&&a0.key!==OWNER_KEY?a0:null;
      if(act==='mute'&&a)a.muted=Date.now()+60*60000;if(act==='ban'&&a){applyBan(a,Date.now()+24*3600e3)}
      r.open=false;r.action=act;touch();res.writeHead(200);return res.end('ok')}
    if(p==='/admin/ban'&&req.method==='POST'){const a=db.accounts[key(u.searchParams.get('name'))];if(!a||a.key===OWNER_KEY){res.writeHead(a?403:404);return res.end('no')}
      const h=+u.searchParams.get('hours')||0;applyBan(a,h>0?Date.now()+h*3600e3:0);touch();res.writeHead(200);return res.end(h>0?'banned':'unbanned')}
    if(p==='/admin/outbox'&&mailMode==='log'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(outbox))}
    if(p==='/admin/kick'&&req.method==='POST'){const c=conns.get(u.searchParams.get('id')||'');if(!c){res.writeHead(404);return res.end('none')}bans.set(c.ip,Date.now()+LIM.banMs);c.kill(1008,'removed');res.writeHead(200);return res.end('kicked')}
    if(p==='/admin/mute'&&req.method==='POST'){const a=db.accounts[key(u.searchParams.get('name'))];if(!a){res.writeHead(404);return res.end('none')}a.muted=Date.now()+Math.max(0,+u.searchParams.get('minutes')||10)*60000;touch();res.writeHead(200);return res.end('muted')}
  }
  if(p==='/admin'&&ADMIN){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(ADMIN_PAGE)}
  if(p==='/'||p==='/index.html'){
    /* look in public/ first, then next to server.js, so a flat upload to GitHub still works */
    const tries=[path.join(PUB,'index.html'),path.join(__dirname,'index.html'),path.join(__dirname,'ExcaliburV2.html')];
    const next=i=>{if(i>=tries.length){res.writeHead(500,{'Content-Type':'text/plain'});return res.end('The game file was not found. Put index.html inside a folder named public next to server.js (or next to server.js itself).')}
      fs.readFile(tries[i],(e,d)=>{if(e)return next(i+1);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(d)})};
    next(0);return;
  }
  res.writeHead(404,{'Content-Type':'text/plain'});res.end('not found');
});
server.on('upgrade',(req,socket)=>{
  const u=new URL(req.url,'http://x');
  const refuse=(c,t)=>{try{socket.write('HTTP/1.1 '+c+' '+t+'\r\nConnection: close\r\n\r\n')}catch(e){}socket.destroy()};
  if(u.pathname!=='/ws')return refuse(404,'Not Found');
  const origin=req.headers.origin;if(ALLOWED.length&&origin&&!ALLOWED.includes(origin))return refuse(403,'Forbidden');
  const ip=clientIp(req),until=bans.get(ip);if(until&&until>Date.now())return refuse(403,'Forbidden');
  if(conns.size>=LIM.global||(perIp.get(ip)||0)>=LIM.perIp)return refuse(429,'Too Many Requests');
  const k=req.headers['sec-websocket-key'];if(!k||String(req.headers.upgrade).toLowerCase()!=='websocket')return refuse(400,'Bad Request');
  const accept=crypto.createHash('sha1').update(k+GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket.setNoDelay(true);
  const c=new Conn(socket,ip);conns.set(c.id,c);perIp.set(ip,(perIp.get(ip)||0)+1);
  if((METERED_KEY||CF_TOKEN)&&Date.now()-iceCache.at>12*3600e3)refreshIce();
  c.send({t:'welcome',id:c.id,ice:iceCache.list,channels:GCH,limits:{giftMax:LIM.giftMax,giftDay:LIM.giftDay}});
  eventInvite(c);
  if(poll){const left=Math.max(1,Math.ceil((poll.end-Date.now())/1000));c.send({t:'user.poll',poll:{id:poll.id,q:poll.q,a:poll.a,b:poll.b,by:poll.by,secs:left,left}})}
});
setInterval(()=>{for(const c of conns.values()){if(!c.pong){c.kill(1001,'timeout');continue}c.pong=false;try{c.s.write(frame(9,Buffer.alloc(0)))}catch(e){}}},25000).unref();
setInterval(()=>{const now=Date.now();for(const[ip,t]of bans)if(t<now)bans.delete(ip)},60000).unref();
process.on('unhandledRejection',e=>console.error('unhandled:',e&&e.message));
loadDb().then(ensureOwner).then(()=>server.listen(PORT,()=>{console.log('Excalibur server listening on '+PORT+' (storage: '+(useSB?'Supabase':DATA)+', email: '+mailMode+')');refreshIce();setInterval(refreshIce,6*3600e3).unref()}));
const stop=()=>{for(const c of conns.values())c.kill(1001,'restarting');dirty=true;Promise.race([flush(),new Promise(r=>setTimeout(r,2500))]).then(()=>process.exit(0))};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
