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
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
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
const KINDS={hub:{label:'Main Hub',max:16},casino:{label:'Casino',max:12},bedwars:{label:'Bedwars',max:16},parkour:{label:'Parkour',max:8}};
const GCH=['general','lfg','casino'];
const LIM={maxPayload:8192,rpcMax:7000,perIp:+process.env.PER_IP||8,global:400,msgPerSec:80,chatPerSec:1,chatBurst:3,strikes:60,banMs:10*60*1000,
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
  db.reports=db.reports||[];db.tokens=db.tokens||{};db.accounts=db.accounts||{};db.audit=db.audit||[];
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
const profile=(c,p)=>({id:c.id,name:c.acct?c.acct.name:sName(p&&p.name),acct:!!c.acct,staff:staffOf(c.acct),skin:/^#[0-9a-f]{6}$/i.test(p&&p.skin)?p.skin:'#4f8cff',rain:!!(p&&p.rain),hat:/^h_[a-z]{2,12}$/.test(p&&p.hat)?p.hat:'h_none'});
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
const userView=a=>({name:a.name,coins:a.coins,xp:a.xp,owned:a.owned,eq:a.eq,created:a.created,owner:a.key===OWNER_KEY&&OWNER_PW.length>=12,admin:!!a.admin,staff:staffOf(a),email:maskEmail(a.email),emailVerified:!!a.emailVerified,mail:mailMode!=='off'});
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
  drop(){if(!this.alive)return;this.alive=false;leaveRoom(this);unbind(this);conns.delete(this.id);perIp.set(this.ip,Math.max(0,(perIp.get(this.ip)||1)-1))}
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
  if(r.master===c){r.master=r.members.values().next().value||null;if(r.master)broadcast(r,{t:'master',room:r.id,id:r.master.id})}   /* the longest-standing member takes over */
  if(!r.members.size)rooms.delete(r.id);
  if(c.acct)presence(c.acct.key);
}
function enter(c,room,p,req){
  if(c.room)leaveRoom(c);
  if(room.locked){c.send({t:'deny',room:room.id,req,err:'That match has already started.'});return false}
  if(room.members.size>=room.max){c.send({t:'deny',room:room.id,req,err:'That room is full.'});return false}
  c.p=profile(c,p);
  const others=[...room.members].map(x=>x.p);
  room.members.add(c);c.room=room.id;if(!room.master)room.master=c;
  const meta=room.priv?{id:room.id,kind:room.kind,name:room.name,max:room.max,priv:true,code:room.code}:{id:room.id,kind:room.kind,name:room.name,max:room.max,priv:false};
  c.send({t:'roster',room:room.id,req,meta,players:others,master:room.master.id});
  broadcast(room,{t:'join',room:room.id,p:c.p},c);
  if(c.acct)presence(c.acct.key);
  return true;
}

/* ---------- accounts, wallet, gifts ---------- */
function unbind(c){const a=c.acct;if(!a)return;c.acct=null;if(online.get(a.key)===c){online.delete(a.key);presence(a.key)}}
function bind(c,a,req,token){
  unbind(c);const old=online.get(a.key);
  if(old&&old!==c){old.send({t:'kicked',reason:'You signed in from another place.'});old.acct=null;online.delete(a.key);old.kill(1000,'signed in elsewhere')}
  c.acct=a;online.set(a.key,c);
  const o={t:'auth.ok',req,user:userView(a),friends:friendList(a),ledger:a.ledger.slice(-20)};if(token)o.token=token;
  c.send(o);presence(a.key);
}
function newToken(a){const t=crypto.randomBytes(32).toString('hex');db.tokens[sha(t)]={k:a.key,exp:Date.now()+LIM.tokenDays*864e5};
  const now=Date.now();for(const h in db.tokens)if(db.tokens[h].exp<now)delete db.tokens[h];touch();return t}
async function authMsg(c,m){
  const fail=e=>c.send({t:'auth.err',req:m.req,err:e});
  if(m.t==='auth.logout'){const a=c.acct;if(a){for(const h in db.tokens)if(db.tokens[h].k===a.key&&m.token&&h===sha(String(m.token)))delete db.tokens[h];touch()}unbind(c);return c.send({t:'auth.out'})}
  if(m.t==='auth.token'){
    if(!authOk(c.ip))return fail('Too many attempts. Wait a minute.');
    const r=db.tokens[sha(String(m.token||''))];if(!r||r.exp<Date.now())return fail('Please sign in again.');
    const a=db.accounts[r.k];if(!a)return fail('Please sign in again.');if(a.ban>Date.now())return fail('This account is suspended.');return bind(c,a,m.req,null);
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
    const w=m.w&&typeof m.w==='object'?m.w:{};
    const a={name:u,key:key(u),salt:salt.toString('hex'),hash:hash.toString('hex'),created:Date.now(),coins:int(w.coins,0,LIM.startCoinsMax,100),xp:int(w.xp,0,1e6,0),owned:cosList(w.owned),eq:eqObj(w.eq),
      friends:{},ledger:[],gift:{d:'',n:0},lastSync:Date.now(),fails:0,lock:0,muted:0,email:'',emailVerified:false,ban:0};
    db.accounts[a.key]=a;touch();return bind(c,a,m.req,newToken(a));
  }
  if(m.t==='auth.login'){
    const a=u.includes('@')?db.accounts[emailIndex.get(key(u))]:db.accounts[key(u)];if(!a)return fail('Wrong username or password.');
    if(a.ban>Date.now())return fail('This account is suspended.');
    if(a.lock>Date.now())return fail('Too many wrong passwords. Try again in a few minutes.');
    const h=await pwHash(p,Buffer.from(a.salt,'hex')),good=crypto.timingSafeEqual(h,Buffer.from(a.hash,'hex'));
    if(!good){if(++a.fails>=5){a.lock=Date.now()+5*60000;a.fails=0}touch();return fail('Wrong username or password.')}
    a.fails=0;return bind(c,a,m.req,newToken(a));
  }
}
function walletSync(c,m){
  const a=c.acct;if(!a)return;const now=Date.now(),secs=Math.max(1,(now-a.lastSync)/1000);
  const coins=int(m.coins,0,1e9,a.coins);
  /* spending is always accepted; big jumps upward are not (the games run in the browser, so this is a sanity cap, not anti-cheat) */
  if(coins>a.coins+20000+300*secs){c.send({t:'wallet.set',coins:a.coins,xp:a.xp});return}
  a.coins=coins;a.xp=int(m.xp,0,1e6,a.xp);a.owned=cosList(m.owned);a.eq=eqObj(m.eq);a.lastSync=now;touch();
}
function gift(c,m){
  const reply=(ok,err,extra)=>c.send({t:'gift.res',req:m.req,ok,err,...extra});
  const a=c.acct;if(!a)return reply(false,'Sign in to send gifts.');
  const to=db.accounts[key(m.to)];if(!to)return reply(false,'No player with that username.');
  if(to===a)return reply(false,'You cannot gift yourself.');
  const amt=int(m.amount,0,LIM.giftMax,0);if(amt<1)return reply(false,'Pick an amount from 1 to '+LIM.giftMax+'.');
  if(a.coins<amt)return reply(false,'You do not have that many coins.');
  if(a.gift.d!==today())a.gift={d:today(),n:0};
  if(a.gift.n+amt>LIM.giftDay)return reply(false,'Daily gift limit reached ('+LIM.giftDay+' coins a day). You can still send '+Math.max(0,LIM.giftDay-a.gift.n)+'.');
  const nowT=Date.now();if(a.lastGift&&nowT-a.lastGift<2000)return reply(false,'Slow down a moment.');
  a.lastGift=nowT;a.coins-=amt;a.gift.n+=amt;to.coins+=amt;
  ledger(a,'Gifted '+amt+' coins to '+to.name);ledger(to,'Received '+amt+' coins from '+a.name);touch();
  reply(true,null,{balance:a.coins,left:LIM.giftDay-a.gift.n});
  const oc=online.get(to.key);if(oc)oc.send({t:'gift.in',from:a.name,amount:amt,balance:to.coins});
}

/* ---------- friends ---------- */
function roomInfo(c){const r=c&&c.room&&rooms.get(c.room);return r?{id:r.id,kind:r.kind,name:r.name,count:r.members.size,max:r.max,priv:r.priv}:null}
function friendList(a){
  const out=[];for(const k in a.friends){const o=db.accounts[k];if(!o)continue;const c=online.get(k);out.push({name:o.name,status:a.friends[k],online:!!c,room:a.friends[k]==='friend'?roomInfo(c):null})}
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
    const msg={from:a.name,text,ts:now,staff:staffOf(a)};ghist[ch].push(msg);if(ghist[ch].length>50)ghist[ch].shift();
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
function adminMsg(c,m){
  const lvl=staffLevel(c);if(!lvl)return;   /* anyone who is not staff is ignored without an answer */
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
      return ok({u:{name:a.name,coins:a.coins,xp:a.xp,created:a.created,online:!!online.get(a.key),email:lvl>=2&&a.email?maskEmail(a.email):'',admin:!!a.admin,verified:!!a.emailVerified,ban:a.ban>now?a.ban:0,muted:a.muted>now?a.muted:0,friends:Object.keys(a.friends||{}).length,owned:(a.owned||[]).length,ledger:(a.ledger||[]).slice(-5),owner:!notOwner(a)}})}
    case'admin.coins':{if(ownerOnly())return;const a=acct();if(!a)return no('No account with that name.');const amt=Math.floor(+m.amount);
      if(!Number.isFinite(amt)||Math.abs(amt)>1e9)return no('Use a whole number up to 1,000,000,000.');
      const n=m.mode==='set'?amt:a.coins+amt;a.coins=Math.max(0,Math.min(1e9,n));a.lastSync=Date.now();
      ledger(a,m.mode==='set'?'The owner set your balance to '+a.coins:'The owner '+(amt>=0?'added ':'removed ')+Math.abs(amt)+' coins');audit('coins',a.name,(m.mode==='set'?'set to ':'add ')+amt);touch();
      pushTo(a,{t:'acct.push',coins:a.coins});return ok({coins:a.coins})}
    case'admin.unlockall':{if(ownerOnly())return;const a=acct();if(!a)return no('No account with that name.');a.owned=cosList([...(a.owned||[]),...(Array.isArray(m.ids)?m.ids:[])]);audit('unlock cosmetics',a.name,a.owned.length+' items');touch();pushTo(a,{t:'acct.push',owned:a.owned});return ok({owned:a.owned.length})}
    case'admin.ban':{const a=acct();if(!a)return no('No account with that name.');if(guard(a))return;
      const h=+m.hours;if(!(h>=0)||h>87600)return no('Hours must be between 0 (lifts a ban) and 87600.');
      a.ban=h>0?Date.now()+h*3600e3:0;if(h>0){revokeTokens(a);kickAccount(a,'Your account has been suspended.')}audit(h>0?'ban':'unban',a.name,h>0?h+'h '+clean(m.reason,80):'');touch();return ok({})}
    case'admin.mute':{const a=acct();if(!a)return no('No account with that name.');if(guard(a))return;
      const mi=+m.minutes;if(!(mi>=0)||mi>525600)return no('Minutes must be between 0 (unmute) and 525600.');
      a.muted=mi>0?Date.now()+mi*60000:0;const oc=online.get(a.key);if(oc)oc.muteUntil=a.muted;audit(mi>0?'mute':'unmute',a.name,mi>0?mi+' min':'');touch();return ok({})}
    case'admin.kick':{const t=conns.get(String(m.id||''));if(!t)return no('That player already left.');if(t.acct&&(t.acct.key===OWNER_KEY||(lvl<2&&t.acct.admin)))return no(t.acct.key===OWNER_KEY?'The owner cannot be kicked.':'Admins cannot kick other admins.');
      if(m.ban)bans.set(t.ip,Date.now()+LIM.banMs);audit('kick',t.p?t.p.name:t.id,m.ban?'address blocked 10 min':'');t.kill(1008,'removed');return ok({})}
    case'admin.delmsg':{const ch=String(m.ch||'');if(!GCH.includes(ch))return no('Unknown channel.');const i=ghist[ch].findIndex(x=>x.ts===m.ts&&x.from===m.from);if(i<0)return no('That message is already gone.');
      ghist[ch].splice(i,1);for(const x of conns.values())if(x.gch.has(ch))x.send({t:'g.del',ch,ts:m.ts,from:m.from});audit('delete message',m.from,'#'+ch);return ok({})}
    case'admin.clear':{const ch=String(m.ch||'');if(!GCH.includes(ch))return no('Unknown channel.');ghist[ch].length=0;for(const x of conns.values())if(x.gch.has(ch))x.send({t:'g.clear',ch});audit('clear channel','#'+ch,'');return ok({})}
    case'admin.announce':{if(ownerOnly())return;const text=clean(m.text,200);if(!text)return no('Type a message first.');for(const x of conns.values())x.send({t:'notice',text:'Announcement: '+text});audit('announce','',text);return ok({})}
    case'admin.reports':return ok({reports:db.reports.filter(r=>m.all||r.open).slice(-100).reverse()});
    case'admin.resolve':{const r=db.reports.find(x=>x.id===m.id);if(!r)return no('That report is gone.');const a0=db.accounts[r.tk],a=a0&&notOwner(a0)&&!(lvl<2&&a0.admin)?a0:null;
      if(m.action==='mute'&&a){a.muted=Date.now()+60*60000;const oc=online.get(a.key);if(oc)oc.muteUntil=a.muted}
      if(m.action==='ban'&&a){a.ban=Date.now()+24*3600e3;revokeTokens(a);kickAccount(a,'Your account has been suspended.')}
      r.open=false;r.action=String(m.action||'dismiss');audit('report '+r.action,r.target,r.reason);touch();return ok({})}
    case'admin.setadmin':{if(ownerOnly())return;const a=acct();if(!a)return no('No account with that name.');if(!notOwner(a))return no('The owner is already the owner.');
      a.admin=!!m.on;audit(a.admin?'make admin':'remove admin',a.name,'');touch();pushTo(a,{t:'user.update',user:userView(a)});return ok({admin:a.admin})}
    case'admin.audit':return ok({log:db.audit.slice(-100).reverse()});
  }
}

/* ---------- message router ---------- */
async function handle(c,m){
  const t=m.t;
  if(t.startsWith('auth.'))return authMsg(c,m);
  if(t==='wallet.sync')return walletSync(c,m);
  if(t==='gift')return gift(c,m);
  if(t.startsWith('admin.'))return adminMsg(c,m);
  if(t.startsWith('email.'))return emailMsg(c,m);
  if(t.startsWith('reset.'))return resetMsg(c,m);
  if(t==='report')return reportMsg(c,m);
  if(t.startsWith('friend.'))return friendMsg(c,m);
  if(t.startsWith('g.'))return globalMsg(c,m);
  if(t==='who'){c.send({t:'rooms',rooms:[...rooms.values()].filter(r=>!r.priv&&!r.locked).map(pub)});return}
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
    let room=[...rooms.values()].filter(r=>r.kind===m.kind&&open(r)).sort((a,b)=>b.members.size-a.members.size)[0];
    if(!room){
      if(rooms.size>=200)return c.send({t:'deny',req:m.req,err:'The server is busy. Try again soon.'});
      const used=new Set([...rooms.values()].map(r=>r.name));let n=1;while(used.has(K.label+' '+n))n++;
      room={id:'r'+crypto.randomBytes(5).toString('hex'),kind:m.kind,name:K.label+' '+n,max:K.max,priv:false,code:code(),members:new Set(),master:null,chat:[]};rooms.set(room.id,room);
    }
    enter(c,room,m.p,m.req);return;
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
    const s=m.s;broadcast(room,{t:'state',room:room.id,from:c.id,s:{x:Math.round(num(s.x,-200,2600)),y:Math.round(num(s.y,-200,2600)),dir:Math.round(num(s.dir,0,3)),mv:!!s.mv,wk:+num(s.wk,0,100).toFixed(2)}},c);return;
  }
  if(t==='chat'){
    const now=Date.now();c.ctok=Math.min(LIM.chatBurst,c.ctok+(now-c.clast)/1000*LIM.chatPerSec);c.clast=now;
    if(c.ctok<1){c.send({t:'notice',text:'You are chatting too fast.'});return}
    if(c.muteUntil>now||(c.acct&&c.acct.muted>now)){c.send({t:'notice',text:'You are muted.'});return}
    const text=sChat(m.text);if(!text)return;c.ctok--;
    room.chat.push({from:c.p?c.p.name:'?',text,ts:now});if(room.chat.length>30)room.chat.shift();
    broadcast(room,{t:'chat',room:room.id,from:c.id,text},c);return;
  }
  if(t==='rpc'){   /* remote procedure calls inside a room: target is 'all', 'others', 'master' or a player id */
    const name=String(m.name||'');if(!/^[a-z][\w.]{0,30}$/.test(name))return;
    let args=m.args;if(args!==undefined&&JSON.stringify(args).length>LIM.rpcMax)return;
    const out={t:'rpc',room:room.id,from:c.id,name,args},tg=String(m.target||'others');
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
const secure=res=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer')};
const server=http.createServer((req,res)=>{
  secure(res);const u=new URL(req.url,'http://x'),p=u.pathname;
  if(p==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('ok')}
  if(p.startsWith('/admin/')&&ADMIN){
    const tok=u.searchParams.get('token')||'',a=Buffer.from(tok),b=Buffer.from(ADMIN);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){res.writeHead(403);return res.end('no')}
    if(p==='/admin/status'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({connections:conns.size,accounts:Object.keys(db.accounts).length,online:[...online.keys()],rooms:[...rooms.values()].map(r=>({id:r.id,name:r.name,kind:r.kind,priv:r.priv,master:r.master&&r.master.id,players:[...r.members].map(c=>({id:c.id,name:c.p&&c.p.name,acct:!!c.acct,ip:c.ip}))}))},null,1))}
    if(p==='/admin/reports'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(db.reports.filter(r=>u.searchParams.get('all')==='1'||r.open).slice(-100).reverse()))}
    if(p==='/admin/report'&&req.method==='POST'){
      const r=db.reports.find(x=>x.id===u.searchParams.get('id'));if(!r){res.writeHead(404);return res.end('none')}
      const act=u.searchParams.get('action'),a0=db.accounts[r.tk],a=a0&&a0.key!==OWNER_KEY?a0:null;
      if(act==='mute'&&a)a.muted=Date.now()+60*60000;if(act==='ban'&&a){a.ban=Date.now()+24*3600e3;revokeTokens(a);kickAccount(a,'Your account has been suspended.')}
      r.open=false;r.action=act;touch();res.writeHead(200);return res.end('ok')}
    if(p==='/admin/ban'&&req.method==='POST'){const a=db.accounts[key(u.searchParams.get('name'))];if(!a||a.key===OWNER_KEY){res.writeHead(a?403:404);return res.end('no')}
      const h=+u.searchParams.get('hours')||0;a.ban=h>0?Date.now()+h*3600e3:0;if(h>0){revokeTokens(a);kickAccount(a,'Your account has been suspended.')}touch();res.writeHead(200);return res.end(h>0?'banned':'unbanned')}
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
});
setInterval(()=>{for(const c of conns.values()){if(!c.pong){c.kill(1001,'timeout');continue}c.pong=false;try{c.s.write(frame(9,Buffer.alloc(0)))}catch(e){}}},25000).unref();
setInterval(()=>{const now=Date.now();for(const[ip,t]of bans)if(t<now)bans.delete(ip)},60000).unref();
process.on('unhandledRejection',e=>console.error('unhandled:',e&&e.message));
loadDb().then(ensureOwner).then(()=>server.listen(PORT,()=>{console.log('Excalibur server listening on '+PORT+' (storage: '+(useSB?'Supabase':DATA)+', email: '+mailMode+')');refreshIce();setInterval(refreshIce,6*3600e3).unref()}));
const stop=()=>{for(const c of conns.values())c.kill(1001,'restarting');dirty=true;Promise.race([flush(),new Promise(r=>setTimeout(r,2500))]).then(()=>process.exit(0))};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
