/* Couchcast app. Everything runs in the browser; rooms are peer-to-peer via PeerJS. */
{
const $=id=>document.getElementById(id);
const vid=$('vid'),stage=$('stage'),PREFIX='couchcast-v1-';
const PLAY='M8 5v14l11-7z',PAUSE='M6 5h4v14H6zm8 0h4v14h-4z';
const VOL_ON='M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z',VOL_OFF='M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z';
const MIC_SVG='<svg viewBox="0 0 24 24" aria-label="in voice chat"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>';

let peer=null,isHost=false,code='',myName='',mode='stream',stream=null,leaving=false;
let allowCtl=false,title='',cues=[],curSub='',ccOn=true,showStats=false;
const conns=new Map();               // host: peerId -> {conn,name,call,mic,joined}
let hostConn=null,inCall=null,statTimer=null,retries=0;
let remote={p:true,c:0,d:0,at:0};    // viewer: host playback state
let people=[];                       // [{id,name,host,mic}]
let dragging=false,roomPw='',locked=false;
const banned=new Set(),trusted=new Set();   // trusted: people already in the room before a host hand-over
let queue=[],curKey='',pendingAt=null,nextTimer=null;
const library=new Map();             // viewer (sync mode): lowercased title -> File
let link=null,yt=null,ytReady=false,sharing=null;   // link={kind:'yt'|'url',id,url}; sharing = host's screen-share stream
let fileInfo=null,hostFi=null,myFp=null;           // matching-file check
let remoteMode=null,myRemoteToken='';
let fileTitle='',readyRound=null,suggestions=[],night=null,inStream=null,playWantAt=0;
const votes=new Map();               // host: voter peer id -> item key
const relayKids=new Map();           // viewer: friends this device passes the stream on to
const lvid=document.getElementById('lvid');

/* ---------- helpers ---------- */
const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}},del(k){try{localStorage.removeItem(k)}catch(e){}}};
const sess={get(k){try{const v=sessionStorage.getItem(k);sessionStorage.removeItem(k);return v?JSON.parse(v):null}catch(e){return null}},set(k,v){try{sessionStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
const toast=t=>{const e=$('toast');e.textContent=t;e.style.display='block';clearTimeout(e._t);e._t=setTimeout(()=>e.style.display='none',3200)};
const statusLine=t=>$('statusLine').textContent=t;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmt=s=>{s=Math.max(0,Math.floor(s||0));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=String(s%60).padStart(2,'0');return h?h+':'+String(m).padStart(2,'0')+':'+x:m+':'+x};
const clock=()=>new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const baseName=n=>String(n).replace(/\.[^.]+$/,'');
const isVideo=f=>/^video\//.test(f.type)||/\.(mkv|mp4|mov|m4v|webm|avi)$/i.test(f.name);
function newCode(){const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length:6},()=>a[Math.floor(Math.random()*a.length)]).join('')}
function getName(n){myName=(n||$('name').value).trim().slice(0,24)||'Guest'+Math.floor(Math.random()*90+10);store.set('cc-name',myName)}
function inviteLink(){const r=currentRelay();return location.href.split('#')[0].split('?')[0]+'#'+code+(r&&r.src!=='site'?'~'+packRelay(r.t):'')}
function inRoom(){return $('room').style.display==='grid'||$('room').style.display==='block'}
function showModal(html){$('modalBody').innerHTML=html;$('modal').style.display='grid';$('modalClose').focus()}
function overlay(html){const o=$('ov');if(html){o.innerHTML='<div>'+html+'</div>';o.style.display='grid'}else{o.style.display='none';o.innerHTML=''}}

/* ---------- connection config ---------- */
/* The relay login never lives in the public code: the host saves it on their device, and it rides
   along in the invite links they copy (after a ~ in the #hash, which browsers never send to any server). */
function normUrls(u){
  let a=String(u||'').split(',').map(x=>x.trim()).filter(Boolean).map(x=>/^turns?:|^stun:/.test(x)?x:'turn:'+x);
  if(a.length===1&&a[0].startsWith('turn:')&&!a[0].includes('transport='))a.push(a[0]+'?transport=tcp');
  return a.join(',');
}
const packRelay=t=>btoa(unescape(encodeURIComponent(JSON.stringify([t.urls,t.username,t.credential])))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function unpackRelay(b){
  try{const j=JSON.parse(decodeURIComponent(escape(atob(b.replace(/-/g,'+').replace(/_/g,'/')))));
    if(Array.isArray(j)&&j[0])return{urls:normUrls(String(j[0])),username:String(j[1]||''),credential:String(j[2]||'')}}catch(e){}
  return null;
}
let relaySetupMsg='';
const b64e=o=>btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const b64d=b=>{try{return JSON.parse(decodeURIComponent(escape(atob(String(b).replace(/-/g,'+').replace(/_/g,'/')))))}catch(e){return null}};
(function linkRelay(){
  const raw=location.hash.slice(1);if(!raw.includes('~'))return;
  const parts=raw.split('~');
  if(parts[0].toUpperCase()==='REMOTE'){
    const r=b64d(parts[1]);
    if(r&&/^[A-Z0-9]{6}$/.test(String(r.c))&&r.k)remoteMode={c:String(r.c),k:String(r.k).slice(0,20),n:String(r.n||'').slice(0,24)};
    const t=parts[2]&&unpackRelay(parts[2]);if(t)store.set('cc-turnlink',JSON.stringify(t));
    return;
  }
  if(parts[0].toUpperCase()==='NIGHT'){
    const n=b64d(parts[1]);
    if(n&&/^[A-Z0-9]{6}$/.test(String(n.c))&&+n.t)night={c:String(n.c),t:+n.t,m:String(n.m||'Movie night').slice(0,60),h:String(n.h||'').slice(0,24)};
    const t=parts[2]&&unpackRelay(parts[2]);if(t)store.set('cc-turnlink',JSON.stringify(t));
    history.replaceState(null,'',location.pathname+location.search+'#NIGHT~'+parts[1]);
    return;
  }
  const [pre,blob]=parts,t=unpackRelay(blob);
  if(t){
    if(pre.toUpperCase()==='RELAY'){store.set('cc-turn',JSON.stringify(t));relaySetupMsg='Relay saved on this device. Every invite link you copy will now include it, so friends on blocked networks can connect.'}
    else store.set('cc-turnlink',JSON.stringify(t));
  }
  history.replaceState(null,'',location.pathname+location.search+(pre.toUpperCase()==='RELAY'?'':'#'+pre));
})();
function currentRelay(){
  for(const k of ['cc-turn','cc-turnlink']){try{const t=JSON.parse(store.get(k)||'null');if(t&&t.urls)return{t,src:k}}catch(e){}}
  const c=window.COUCHCAST_TURN||{};return c.urls?{t:c,src:'site'}:null;
}
function iceServers(){
  const list=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}];
  const r=currentRelay();
  if(r)list.push({urls:normUrls(r.t.urls).split(','),username:r.t.username,credential:r.t.credential});
  return list;
}
/* Metered / Open Relay: fetch short-lived TURN credentials once per page load */
let iceList=null,relayOn=false;
function turnApi(){return store.get('cc-turnapi')||window.COUCHCAST_TURN_API||''}
async function loadIce(){
  const list=iceServers();relayOn=list.some(s=>String(s.urls).includes('turn'));
  const api=turnApi();
  if(api){
    try{
      const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),6000);
      const r=await fetch(api,{signal:ctl.signal});clearTimeout(t);
      const extra=await r.json();
      if(Array.isArray(extra)&&extra.length){list.push(...extra.filter(x=>x&&x.urls));relayOn=true}
    }catch(e){console.warn('TURN credentials',e)}
  }
  iceList=list;
  const r=currentRelay();
  $('relayState').textContent=!relayOn?'No relay set up on this device yet.':r&&r.src==='cc-turnlink'?'Relay is set up (it came with your invite link).':'Relay is set up on this device. Invite links you copy include it.';
  return list;
}
let iceReady=loadIce();
function makePeer(id){const o={config:{iceServers:iceList||iceServers()},debug:0};return id?new Peer(id,o):new Peer(o)}
function myId(){return peer&&peer.id}

/* =========================================================================
   AUDIO ENGINE
   One AudioContext per page. Everything ends in: duck (voice-chat dip) -> vol -> speakers.
   Host:   video element -> 5.1-aware stereo mix -> clear-dialogue -> limiter -> friends' stream
                                                                          \-> hostLocal -> duck -> vol
   Friend: incoming movie sound (or own file in sync mode) -> clear-dialogue -> delay -> duck -> vol
   ========================================================================= */
let ac=null,duck=null,volG=null,mix=null,vchain=null,streamSrc=null,elemSrc=null;
const me={vol:1,muted:false,hostOn:true};
function getAC(){
  if(ac)return ac;
  const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return null;
  try{ac=new AC({latencyHint:'playback',sampleRate:48000})}catch(e){try{ac=new AC()}catch(e2){return null}}
  duck=ac.createGain();volG=ac.createGain();duck.connect(volG);volG.connect(ac.destination);
  applyVol();
  return ac;
}
function wakeAudio(){if(ac&&ac.state!=='running')ac.resume().catch(()=>{})}
function audioBlocked(){return ac&&ac.state!=='running'}
function applyLinkVol(){
  const v=Math.min(1,me.muted?0:me.vol*(duckDown?.25:1));
  lvid.volume=v;if(ytReady)try{yt.setVolume(Math.round(v*100));if(v>0&&yt.isMuted())yt.unMute()}catch(e){}
}
function applyVol(){
  applyLinkVol();
  if(ac){volG.gain.value=me.muted?0:me.vol;if(mix)mix.local.gain.value=me.hostOn?1:0;return}
  vid.volume=Math.min(1,me.vol);vid.muted=me.muted||(isHost&&!me.hostOn);
}
function ensureMix(){
  if(mix)return mix;
  if(!getAC())return null;
  try{
    const src=ac.createMediaElementSource(vid);
    // normalise any layout to 5.1 first: mono lands on centre, stereo on front L/R, 5.1 unchanged
    const pre=ac.createGain();pre.channelCount=6;pre.channelCountMode='explicit';pre.channelInterpretation='speakers';
    const sp=ac.createChannelSplitter(6);src.connect(pre);pre.connect(sp);
    const L=ac.createGain(),R=ac.createGain(),mg=ac.createChannelMerger(2);
    const add=(ch,to,g)=>{const n=ac.createGain();n.gain.value=g;sp.connect(n,ch);n.connect(to);return n};
    // channel order (checked in Chrome): 0 FL, 1 FR, 2 Centre (dialogue), 3 LFE, 4 SL, 5 SR
    add(0,L,1);add(1,R,1);
    const cL=add(2,L,.707),cR=add(2,R,.707);
    add(3,L,.3);add(3,R,.3);add(4,L,.6);add(5,R,.6);
    L.connect(mg,0,0);R.connect(mg,0,1);
    const dry=ac.createGain(),wet=ac.createGain(),comp=ac.createDynamicsCompressor(),makeup=ac.createGain();
    comp.threshold.value=-26;comp.knee.value=12;comp.ratio.value=3.5;comp.attack.value=.006;comp.release.value=.25;makeup.gain.value=1.7;
    mg.connect(dry);mg.connect(comp);comp.connect(makeup);makeup.connect(wet);
    const lim=ac.createDynamicsCompressor();lim.threshold.value=-2;lim.knee.value=0;lim.ratio.value=20;lim.attack.value=.002;lim.release.value=.1;
    dry.connect(lim);wet.connect(lim);
    const dest=ac.createMediaStreamDestination();dest.channelCount=2;lim.connect(dest);
    const local=ac.createGain();lim.connect(local);local.connect(duck);
    mix={dest,local,cL,cR,dry,wet};
    setClear($('clearDlg').checked);
    vid.muted=false;vid.volume=1;applyVol();
    return mix;
  }catch(e){console.warn('mixer',e);return null}
}
function setClear(on){
  if(!mix)return;
  const c=on?1.15:.707;mix.cL.gain.value=c;mix.cR.gain.value=c;
  mix.dry.gain.value=on?0:1;mix.wet.gain.value=on?1:0;
}
function ensureViewerChain(){
  if(vchain)return vchain;
  if(!getAC())return null;
  const input=ac.createGain(),dry=ac.createGain(),wet=ac.createGain();
  // voice clarity: lift the speech band, gently compress, add back level
  const pk=ac.createBiquadFilter();pk.type='peaking';pk.frequency.value=2500;pk.Q.value=.9;pk.gain.value=6;
  const ls=ac.createBiquadFilter();ls.type='lowshelf';ls.frequency.value=160;ls.gain.value=-4;
  const comp=ac.createDynamicsCompressor();comp.threshold.value=-24;comp.knee.value=10;comp.ratio.value=3;comp.attack.value=.006;comp.release.value=.25;
  const makeup=ac.createGain();makeup.gain.value=1.4;
  input.connect(dry);input.connect(pk);pk.connect(ls);ls.connect(comp);comp.connect(makeup);makeup.connect(wet);
  const delay=ac.createDelay(2);dry.connect(delay);wet.connect(delay);delay.connect(duck);
  vchain={input,dry,wet,delay};
  setViewerClear($('vClear').checked);setViewerDelay(+$('vDelay').value);
  return vchain;
}
function setViewerClear(on){if(!vchain)return;vchain.dry.gain.value=on?0:1;vchain.wet.gain.value=on?1:0}
function setViewerDelay(ms){$('vDelayOut').textContent=ms;if(vchain)vchain.delay.delayTime.setTargetAtTime(ms/1000,ac.currentTime,.05)}
function viewerUseStream(s){
  // Chrome only lets page audio processing hear a live incoming stream through createMediaStreamSource
  if(!ensureViewerChain()){vid.muted=false;applyVol();return}
  if(streamSrc){try{streamSrc.disconnect()}catch(e){}streamSrc=null}
  if(s.getAudioTracks().length){streamSrc=ac.createMediaStreamSource(s);streamSrc.connect(vchain.input)}
  vid.muted=true;   // the element only shows the picture; sound goes through the chain
}
function viewerUseElement(){
  if(!ensureViewerChain()){vid.muted=false;applyVol();return}
  if(streamSrc){try{streamSrc.disconnect()}catch(e){}streamSrc=null}
  if(!elemSrc){try{elemSrc=ac.createMediaElementSource(vid);elemSrc.connect(vchain.input)}catch(e){console.warn(e)}}
  vid.muted=false;vid.volume=1;
}
let duckDown=false;
function setDuck(down){
  down=down&&$('duckOn').checked;
  if(!ac||down===duckDown)return;duckDown=down;
  duck.gain.setTargetAtTime(down?.25:1,ac.currentTime,down?.05:.35);
  applyLinkVol();
}

/* ---------- chat & people ---------- */
function addChat(n,m,sys,av,col,sp){
  av=cleanAv(av);col=cleanCol(col);
  const d=document.createElement('div'),tm='<time>'+clock()+'</time>',who=(av?'<span class="av">'+av+'</span>':'')+'<b'+(col?' style="color:'+col+'"':'')+'>'+esc(n)+':</b> ';
  if(sys){d.className='sys';d.innerHTML=tm+esc(m)}else d.innerHTML=tm+who+fmtMsg(m,sp);
  const box=$('chat');box.appendChild(d);while(box.children.length>300)box.firstChild.remove();box.scrollTop=1e9;
  if(!sys&&n!==myName&&typeof chatSeen==='function'&&!chatSeen()){unread++;drawBadge()}
  if(document.body.classList.contains('tv')||document.fullscreenElement===stage){
    const t=document.createElement('div');t.innerHTML=sys?esc(m):who+(hasSpoiler(m,sp)?'🙈 <i>spoiler</i>':esc(m));
    const tc=$('tvchat');tc.appendChild(t);while(tc.children.length>3)tc.firstChild.remove();setTimeout(()=>t.remove(),9000);
  }
}
let sureAct=null;
function renderPeople(){
  const mine=myId();
  const html=people.map(p=>{
    const extra=[p.via?'via '+p.via:'',p.q||'',p.match==='same'?'same file':p.match==='close'?'same length':p.match==='diff'?'different file':''].filter(Boolean).join(' · ');
    const sure=a=>sureAct&&sureAct.id===p.id&&sureAct.act===a&&Date.now()<sureAct.until;
    const acts=isHost&&!p.host?'<button class="ghost small" data-act="host" data-id="'+esc(p.id)+'">'+(sure('host')?'Confirm':'Make host')+'</button><button class="ghost small" data-act="kick" data-id="'+esc(p.id)+'">'+(sure('kick')?'Sure?':'Remove')+'</button>':'';
    return '<div class="person'+(p.id===mine?' me':'')+'" data-id="'+esc(p.id)+'">'+(p.mic?MIC_SVG:'')+(p.av?'<span class="av">'+esc(p.av)+'</span>':'')+'<span class="nm"'+(p.col?' style="color:'+p.col+'"':'')+'>'+esc(p.name)+'</span>'+(p.host?'<span class="tag">host</span>':'')+(extra?'<span class="tag">'+esc(extra)+'</span>':'')+acts+'</div>';
  }).join('');
  // only rebuild when something changed, so a tap in progress (or keyboard focus) isn't lost
  if(html!==$('people').dataset.h){$('people').innerHTML=html;$('people').dataset.h=html}
  document.querySelectorAll('#people .person').forEach(el=>el.classList.toggle('speaking',speaking.has(el.dataset.id)));
  document.querySelectorAll('#cams figure:not(.self)').forEach(f=>{const c=f.querySelector('figcaption');if(c)c.textContent=nameOf(f.dataset.id)});
  renderCouch();
  $('peopleCnt').textContent=people.length?String(people.length):'';
}
function setNow(t){title=t||'';$('now').textContent=title?'Now playing: '+title:''}
function setSub(t){curSub=t||'';$('subs').innerHTML=ccOn&&curSub?'<span>'+esc(curSub)+'</span>':''}
function popReaction(e){
  const s=document.createElement('span');s.textContent=e;s.style.left=(8+Math.random()*80)+'%';
  $('fx').appendChild(s);setTimeout(()=>s.remove(),2700);
}
function renderUpNext(list){
  $('upNextBox').style.display=list.length&&!isHost?'block':'none';
  $('upNext').innerHTML=list.map(n=>'<li><span>'+esc(n)+'</span></li>').join('');
}

/* ---------- room UI ---------- */
function enterRoom(){
  setTimeout(keepAwake,500);
  $('lobby').style.display='none';$('room').style.display='grid';$('leaveBtn').style.display='block';
  $('codeOut').textContent=code;history.replaceState(null,'','#'+code);$('lobbyMsg').textContent='';
  $('mySoundBox').style.display=isHost?'none':'block';
  $('roomBox').style.display=isHost?'block':'none';
  renderVotes(lastVotes);
  updateControls();
  if(/Web0S|webOS|SmartTV|SMART-TV|Tizen|BRAVIA|AFT[A-Z]|CrKey|GoogleTV/i.test(navigator.userAgent))setTV(true);
}
function emptyMsg(html){const e=$('empty');if(html){e.innerHTML=html;e.style.display='grid'}else e.style.display='none'}
function canControl(){return isHost||allowCtl}
function updateControls(){
  const ok=canControl()&&(isHost?M.ok():true)&&!M.live();
  $('pp').disabled=!ok;$('seek').disabled=!ok;
  $('nextBtn').style.display=isHost&&queue.length?'block':'none';
}

/* ---------- subtitles ---------- */
function parseSubs(text){
  const out=[],toS=t=>{const m=t.trim().replace(',','.').match(/(?:(\d+):)?(\d+):(\d+)\.(\d+)/);return m?(+(m[1]||0))*3600+(+m[2])*60+(+m[3])+(+('0.'+m[4])):0};
  text.replace(/\r/g,'').split(/\n{2,}/).forEach(block=>{
    const lines=block.split('\n'),i=lines.findIndex(l=>l.includes('-->'));if(i<0)return;
    const [a,b]=lines[i].split('-->');
    const txt=lines.slice(i+1).join('\n').replace(/<[^>]+>/g,'').replace(/\{[^}]+\}/g,'').trim();
    if(txt)out.push({s:toS(a),e:toS(b.trim().split(' ')[0]),t:txt});
  });
  return out.sort((x,y)=>x.s-y.s);
}
function subAt(t){for(const c of cues){if(c.s>t)break;if(t<=c.e)return c.t}return ''}

/* ---------- SDP tuning for the movie call ---------- */
/* Movie-quality sound: stereo Opus at 510 kbps, no silence-skipping (DTX), loss recovery on */
function tuneOpus(sdp){
  const L=sdp.split('\r\n'),rm=L.find(l=>/^a=rtpmap:\d+ opus\/48000/i.test(l));if(!rm)return sdp;
  const pt=rm.split(':')[1].split(' ')[0],want={stereo:'1','sprop-stereo':'1',maxaveragebitrate:'510000',maxplaybackrate:'48000',useinbandfec:'1',usedtx:'0',cbr:'0'};
  const fi=L.findIndex(l=>l.startsWith('a=fmtp:'+pt+' '));
  const cur={};if(fi>=0)L[fi].slice(('a=fmtp:'+pt+' ').length).split(';').forEach(kv=>{const [k,v]=kv.split('=');if(k)cur[k.trim()]=(v||'').trim()});
  const line='a=fmtp:'+pt+' '+Object.entries({...cur,...want}).map(([k,v])=>k+'='+v).join(';');
  if(fi>=0)L[fi]=line;else L.splice(L.indexOf(rm)+1,0,line);
  return L.join('\r\n');
}
function preferCodec(sdp){
  sdp=tuneOpus(sdp);
  const codec=$('codec').value;
  const L=sdp.split('\r\n'),mi=L.findIndex(l=>l.startsWith('m=video'));if(mi<0)return sdp;
  const pts=L.filter(l=>new RegExp('^a=rtpmap:\\d+ '+codec+'/','i').test(l)).map(l=>l.split(':')[1].split(' ')[0]);
  if(!pts.length)return sdp;
  const rtx=L.filter(l=>/^a=fmtp:\d+ apt=\d+/.test(l)&&pts.includes(l.split('apt=')[1])).map(l=>l.split(':')[1].split(' ')[0]);
  const pref=[...pts,...rtx],p=L[mi].split(' ');
  L[mi]=[...p.slice(0,3),...pref,...p.slice(3).filter(x=>!pref.includes(x))].join(' ');
  return L.join('\r\n');
}

/* ================= HOST ================= */
async function startHost(opts){
  getAC();$('lobbyMsg').textContent='Getting ready…';
  await iceReady;startHostNow(opts);
}
function startHostNow(opts){
  opts=opts||{};
  getName(opts.name);isHost=true;code=opts.code||newCode();
  if(isPhone){$('mbps').value=8;$('mbpsOut').textContent='8';$('fps').value='30';$('maxDirect').value='2'}
  getAC();
  $('lobbyMsg').textContent=opts.perm?'Opening your room…':opts.night?'Opening your movie night room…':opts.code?'Taking over room '+code+'…':'Creating room…';
  let tries=0;
  const open=()=>{
    peer=makePeer(PREFIX+code);
    peer.on('open',()=>{
      if(inRoom())return;
      enterRoom();$('hostBox').style.display='block';setMode(opts.st&&opts.st.mode||'stream');pushPeople();
      if(opts.st)restoreHost(opts.st);
      else{
        loadWatchlist();pushVotes();
        pickPrompt('Choose a movie to start');
        addChat('','Room created. Send friends the invite link.',true);statusLine('You are the host.');
      }
      if(opts.voice)joinVoice();
    });
    peer.on('disconnected',()=>{if(!leaving)setTimeout(()=>{try{peer&&!peer.destroyed&&peer.reconnect()}catch(e){}},1000)});
    peer.on('error',e=>{
      if(e.type==='unavailable-id'){
        try{peer.destroy()}catch(x){}
        if(opts.code&&tries++<15){setTimeout(open,1200);return}   // waiting for the old host to let go of the room
        if(opts.code){$('lobbyMsg').textContent=opts.perm?'Your room seems to be open in another tab or device. Close it there, or untick "Use my permanent room link".':'Could not take over the room. Try creating a new one.';return}
        code=newCode();open();return;
      }
      if(e.type==='peer-unavailable')return;
      toast('Connection problem: '+e.type);$('lobbyMsg').textContent='Could not connect ('+e.type+'). Check your internet and try again.';
    });
    peer.on('connection',conn=>{
      const prev=conns.get(conn.peer);
      if(prev){try{prev.call&&prev.call.close()}catch(e){}}
      conns.set(conn.peer,{conn,name:'…',call:null,mic:false,joined:prev?prev.joined:Date.now(),back:!!prev&&prev.name!=='…',helper:prev?prev.helper:false});
      setTimeout(()=>{
        const c=conns.get(conn.peer);
        if(c&&c.conn===conn&&!conn.open){addChat('','Someone tried to join but their connection couldn\'t get through. A relay fixes this: see Connection settings on the start page.',true);dropViewer(conn.peer)}
      },15000);
      conn.on('data',d=>onHostData(conn,d));
      const gone=()=>{const c=conns.get(conn.peer);if(c&&c.conn===conn)dropViewer(conn.peer)};
      conn.on('close',gone);conn.on('error',gone);
    });
    peer.on('call',onIncomingCall);
  };
  open();
}
function pickPrompt(text){
  emptyMsg('<div><p style="margin:0 0 12px;font-size:18px;color:var(--ink)">'+esc(text)+'</p><button id="pickBtn">Choose movie file</button><p class="hint">or drag video files here</p></div>');
  $('pickBtn').onclick=()=>$('file').click();
}
function restoreHost(st){
  allowCtl=!!st.ctl;$('allowCtl').checked=allowCtl;
  roomPw=String(st.pw||'');$('roomPw').value=roomPw;locked=!!st.locked;$('lockRoom').checked=locked;
  (st.banned||[]).forEach(b=>banned.add(b));
  (st.members||[]).forEach(n=>trusted.add(String(n).toLowerCase()));
  if(Array.isArray(st.cues))cues=st.cues;
  if(typeof st.clear==='boolean'){$('clearDlg').checked=st.clear}
  setNow(st.title||'');pendingAt=+st.c||0;
  loadWatchlist();
  if(Array.isArray(st.sug))for(const n of st.sug.map(String))if(!suggestions.some(x=>x.toLowerCase()===n.toLowerCase()))suggestions.push(n);
  saveWatchlist();
  addChat('','You are now the host.',true);statusLine('You are the host now.');
  const l=cleanLink(st.link);
  if(l&&st.mode==='link'){link=l;$('linkUrl').value=l.url||'';setMode('link');const at=pendingAt;pendingAt=null;setTimeout(()=>{if(M.ok())M.seek(at)},2500)}
  else pickPrompt(st.title?'Open "'+st.title+'" to carry on from '+fmt(pendingAt):'Choose a movie to start');
  pushVotes();
  if(st.queue&&st.queue.length)addChat('','The old host\'s queue was: '+st.queue.join(', ')+'. Add those files again to keep going.',true);
}
function dropViewer(id){
  const c=conns.get(id);if(!c)return;
  conns.delete(id);if(c.call)c.call.close();
  if(c.parent){const p=conns.get(c.parent);if(p)try{p.conn.send({t:'relayStop',id})}catch(e){}}
  for(const kid of kidsOf(id)){const k=conns.get(kid);k.parent=null;assignViewer(kid)}
  if(votes.delete(id))pushVotes();
  if(readyRound){readyRound.ids.delete(id);drawReady()}
  if(c.name!=='…'&&!c.remote){addChat('',c.name+' left',true);if(!c.bye&&!c.kicked)away.set(c.name,performance.now())}pushPeople();
}
function broadcast(o,except){for(const [id,{conn,name,remote:rm}] of conns)if(conn.open&&id!==except&&name!=='…'&&(!rm||['sync','title'].includes(o.t)))conn.send(o)}
function pushPeople(){
  people=[{id:myId(),name:myName,host:true,mic:voice.on,av:myLook.av,col:myLook.col,seat:mySeat},...[...conns.entries()].filter(([,c])=>c.name!=='…'&&!c.remote).map(([id,c])=>({id,name:c.name,mic:c.mic,av:c.av||'',col:c.col||'',seat:c.seat>=0?c.seat:-1,via:c.parent&&conns.get(c.parent)?conns.get(c.parent).name:'',q:mode==='stream'&&(c.call||c.parent)?(c.q||''):'',match:mode==='sync'?(c.match||''):''}))];
  renderPeople();broadcast({t:'people',list:people});voiceSyncCalls();camSync();
}
function state(){return{t:'sync',p:M.paused(),c:M.time(),d:M.dur(),live:M.live()}}
function deny(conn,why){try{conn.send({t:'denied',why})}catch(e){}setTimeout(()=>{try{conn.close()}catch(e){}},400)}
function onHostData(conn,d){
  const c=conns.get(conn.peer);if(!c||!d||typeof d!=='object')return;
  if(d.t==='join'&&d.remote){
    const k=String(d.k||'');
    if(!remoteTokens.has(k))return deny(conn,'remote');
    c.name=String(d.n||'Remote').slice(0,32);c.remote=true;c.for=remoteTokens.get(k);
    conn.send({t:'hello',remote:true,title});if(M.ok())conn.send(state());
    addChat('','A phone remote connected.',true);return;
  }
  if(d.t==='join'){
    const nm=String(d.n||'Guest').slice(0,24);
    if(c.name==='…'){
      if(banned.has(nm.toLowerCase()))return deny(conn,'kicked');
      if(!trusted.has(nm.toLowerCase())){
        if(locked)return deny(conn,'locked');
        if(roomPw&&String(d.pw||'')!==roomPw)return deny(conn,'password');
      }
    }
    c.name=nm;c.helper=!!d.helper;c.av=cleanAv(d.av);c.col=cleanCol(d.col);if(!(c.seat>=0))c.seat=freeSeat(conn.peer);c.health='ok';c.stallSince=0;c.ignore=false;away.delete(nm);
    if(!c.back)addChat('',c.name+' joined',true);
    conn.send({t:'hello',mode,ctl:allowCtl,title,sub:curSub,link:mode==='link'?link:null,fi:fileInfo,votes:voteItems(),marks,moments:momentsList});
    if(M.ok())conn.send(state());
    pushPeople();
    if(mode==='stream'&&stream)assignViewer(conn.peer);
    return;
  }
  if(c.name==='…')return;   // not admitted yet
  if(c.remote){if(d.t==='rc')hostRemote(c,d);return}
  if(d.t==='pairtoken'){const k=String(d.k||'').slice(0,20);if(k)remoteTokens.set(k,conn.peer)}
  if(d.t==='chat'){const m=String(d.m||'').slice(0,300);if(!m)return;const sp=!!d.sp;addChat(c.name,m,false,c.av,c.col,sp);broadcast({t:'chat',n:c.name,m,av:c.av,col:c.col,sp})}
  if(d.t==='seat'){if(!hostSeat(conn.peer,d.i))conn.send({t:'seatno'})}
  if(d.t==='spin'){hostSpin(avName({av:c.av,name:c.name}))}
  if(d.t==='look'){c.av=cleanAv(d.av);c.col=cleanCol(d.col);pushPeople()}
  if(d.t==='health'){const st=d.s==='stall'?'stall':'ok';if(st!==c.health){c.health=st;c.stallSince=st==='stall'?performance.now():0;if(st==='ok')c.ignore=false}}
  if(d.t==='bye'){c.bye=true}
  if(d.t==='laser'&&isFinite(d.x)&&isFinite(d.y)){const x=+d.x,y=+d.y,n=avName({av:c.av,name:c.name});showLaser(x,y,n,c.col);broadcast({t:'laser',x,y,n,col:c.col},conn.peer)}
  if(d.t==='react'){const e=String(d.e||'').slice(0,4);noteMoment(e);popReaction(e);seatPop(conn.peer,e);broadcast({t:'react',e,id:conn.peer},conn.peer)}
  if(d.t==='sfx'&&SFX[d.k]){const now=performance.now();if(now-(c.sfxAt||0)<1200)return;c.sfxAt=now;const n=avName({av:c.av,name:c.name});playSfx(d.k);showSfx(d.k,n);seatPop(conn.peer,SFX[d.k].i);broadcast({t:'sfx',k:d.k,n,id:conn.peer},conn.peer)}
  if(d.t==='mic'){c.mic=!!d.on;pushPeople()}
  if(d.t==='helper'){c.helper=!!d.on}
  if(d.t==='match'){c.match=['same','close','diff'].includes(d.v)?d.v:'';pushPeopleSoon()}
  if(d.t==='ready'&&readyRound&&readyRound.ids.has(conn.peer)){readyRound.ok.add(conn.peer);drawReady()}
  if(d.t==='vote')castVote(conn.peer,String(d.k||''));
  if(d.t==='suggest')addSuggestion(d.name,c.name);
  if(d.t==='ctl'&&allowCtl&&M.ok()&&!M.live()){
    if(d.a==='toggle'){const was=M.paused();was?M.play():M.pause();addChat('',c.name+(was?' pressed play':' paused'),true)}
    if(d.a==='seek'&&isFinite(d.v)){M.seek(Math.max(0,Math.min(M.dur()||0,+d.v)));addChat('',c.name+' skipped to '+fmt(d.v),true)}
  }
}
function callViewer(id){
  const c=conns.get(id);if(!c||!stream||c.name==='…'||c.remote)return;
  if(c.call)c.call.close();
  const call=peer.call(id,stream,{sdpTransform:preferCodec,metadata:{kind:'movie'}});
  if(!call)return;
  c.call=call;boost(call);
  adaptCall(call,{max:()=>+$('mbps').value,onq:st=>{const cc=conns.get(id);if(cc&&cc.call===call&&(cc.q!==st.q||cc.lvl!==st.lvl)){cc.q=st.q;cc.lvl=st.lvl;pushPeopleSoon()}}});
}
async function boost(call){
  const mbps=+$('mbps').value,fps=+$('fps').value;
  for(let i=0;i<60;i++){
    const pc=call.peerConnection,s=pc&&pc.getSenders().find(x=>x.track&&x.track.kind==='video');
    if(pc&&pc.connectionState==='closed')return;
    if(s&&pc.connectionState==='connected'){
      const p=s.getParameters();if(!p.encodings||!p.encodings.length)p.encodings=[{}];
      p.encodings[0].maxBitrate=mbps*1e6;p.encodings[0].maxFramerate=fps;p.encodings[0].scaleResolutionDownBy=1;
      p.degradationPreference='maintain-resolution';
      try{await s.setParameters(p)}catch(e){console.warn('setParameters',e)}
      const a=pc.getSenders().find(x=>x.track&&x.track.kind==='audio');
      if(a){
        const ap=a.getParameters();if(!ap.encodings||!ap.encodings.length)ap.encodings=[{}];
        ap.encodings[0].maxBitrate=510000;ap.encodings[0].priority='high';ap.encodings[0].networkPriority='high';
        try{await a.setParameters(ap)}catch(e){console.warn('audio setParameters',e)}
      }
      return;
    }
    await sleep(500);
  }
}
function setMode(m){
  const prev=mode;
  mode=m==='sync'||m==='link'?m:'stream';
  $('mStream').classList.toggle('on',mode==='stream');$('mSync').classList.toggle('on',mode==='sync');$('mLink').classList.toggle('on',mode==='link');
  $('quality').style.display=mode==='stream'?'block':'none';
  $('linkArea').style.display=mode==='link'?'block':'none';
  $('fileArea').style.display=mode==='link'?'none':'block';
  $('shareRow').style.display=mode==='stream'&&canShare?'flex':'none';
  $('modeHint').textContent=mode==='stream'
    ?'Your computer sends the picture to every friend. Easiest, but quality depends on your upload speed.'
    :mode==='sync'?'Everyone opens their own copy of the same file; only play, pause and skip are shared. Full 4K, almost no internet used.'
    :'Paste a YouTube or video link. Everyone plays it on their own device and it stays in step. Uses almost none of your internet.';
  for(const c of conns.values()){if(c.call){c.call.close();c.call=null}c.parent=null}
  broadcast({t:'relayStopAll'});
  if(mode!=='stream'&&sharing){stopShare(true);setNow(vid.src?fileTitle:'');broadcast({t:'title',title:title});if(!vid.src&&mode!=='link')pickPrompt('Choose a movie to start')}
  if(prev==='link'&&mode!=='link'){clearLinkPlayers();vid.style.visibility='';if(!vid.src)pickPrompt('Choose a movie to start');const n=vid.src?fileTitle:'';setNow(n);broadcast({t:'title',title:n})}
  if(mode==='link'){if(vid.src&&!vid.paused)vid.pause();vid.style.visibility='hidden';if(link)showLink();else emptyMsg('<div>Paste a YouTube or video link in the Movie panel.</div>')}
  broadcast({t:'mode',mode,link:mode==='link'?link:null});
  if(mode==='stream'&&(vid.src||sharing))makeStream();
  if(M.ok())broadcast(state());
  pushPeopleSoon();updateControls();
}
function makeStream(){
  const cap=vid.captureStream||vid.mozCaptureStream;
  if(!cap){
    addChat('','This browser can\'t send video to friends (iPhones and iPads can\'t), so Couchcast switched to "Everyone has the file". Friends open their own copy, or pick "A link" for YouTube.',true);
    toast('Switched to "Everyone has the file"');setTimeout(()=>setMode('sync'),0);return;
  }
  if(sharing){
    stream=new MediaStream([...sharing.getVideoTracks(),...sharing.getAudioTracks()]);
    stream.getVideoTracks().forEach(t=>{try{t.contentHint='motion'}catch(e){}});
  }else{
    const captured=cap.call(vid),m=ensureMix();
    const audio=m?m.dest.stream.getAudioTracks():captured.getAudioTracks();
    stream=new MediaStream([...captured.getVideoTracks(),...audio]);
    stream.getVideoTracks().forEach(t=>{try{t.contentHint='detail'}catch(e){}});
  }
  stream.getAudioTracks().forEach(t=>{try{t.contentHint='music'}catch(e){}});
  wakeAudio();
  assignAll();
}
/* Many 4K files carry AC3/E-AC3/DTS 5.1 sound, which browsers cannot decode: silent for everyone. */
let audioChecked=false;
vid.addEventListener('playing',()=>{
  if(!isHost||audioChecked||!vid.src)return;audioChecked=true;
  setTimeout(()=>{
    const silent=('webkitAudioDecodedByteCount' in vid&&vid.webkitAudioDecodedByteCount===0)||(vid.audioTracks&&vid.audioTracks.length===0);
    if(silent&&!vid.paused){
      toast('No sound found in this file');
      addChat('','This movie\'s sound format (often AC3/DTS 5.1 in 4K files) can\'t be played by browsers, so nobody will hear it. Convert the audio to AAC (see the README) or use another copy.',true);
    }
  },3000);
});
document.addEventListener('visibilitychange',()=>{
  if(isHost&&mode==='stream'&&stream&&conns.size&&!document.hidden)statusLine('Tip: keep this tab in front while streaming, or friends may get choppy picture and sound.');
});
const fileKey=f=>f.name+'|'+f.size;
function hostLoad(f,opts){
  opts=opts||{};
  if(!f)return;
  if(!isVideo(f)){toast('That does not look like a video file.');return}
  if(sharing)stopShare(true);
  if(mode==='link')setMode('stream');
  clearTimeout(nextTimer);overlay('');
  if(vid.src)URL.revokeObjectURL(vid.src);
  vid.srcObject=null;vid.src=URL.createObjectURL(f);vid.muted=false;emptyMsg('');
  fileInfo=null;fingerprint(f).then(fp=>{fileInfo={fp};broadcast({t:'fileinfo',fi:fileInfo})});
  for(const c of conns.values())c.match='';
  ensureMix();
  audioChecked=false;curKey=fileKey(f);
  vid.onloadedmetadata=()=>{
    let at=null;
    if(pendingAt!=null){at=pendingAt;pendingAt=null}
    else{
      const saved=+store.get('cc-pos-'+curKey)||0;
      if(saved>30&&saved<vid.duration-60){
        const go=opts.autoplay;opts.autoplay=false;   // ask first, then start
        overlay('<p>Resume "'+esc(baseName(f.name))+'" from '+fmt(saved)+'?</p><div class="row" style="justify-content:center"><button id="resumeYes">Resume</button><button class="ghost" id="resumeNo">Start over</button></div>');
        const done=()=>{overlay('');broadcast(state());if(go){wakeAudio();vid.play().catch(()=>{})}};
        $('resumeYes').onclick=()=>{vid.currentTime=saved;done()};
        $('resumeNo').onclick=()=>{store.del('cc-pos-'+curKey);done()};
        $('resumeYes').focus();
      }
    }
    if(at)vid.currentTime=at;
    if(mode==='stream')makeStream();
    broadcast(state());updateControls();
    if(!vid.videoWidth)toast('Your browser plays this file without picture. Try converting it to MP4 (H.264).');
    else statusLine('Movie loaded: '+vid.videoWidth+'×'+vid.videoHeight+'.'+(opts.autoplay?'':' Press play when everyone is here.'));
    if(opts.autoplay){wakeAudio();vid.play().catch(()=>{})}
  };
  vid.onerror=()=>{toast('Your browser cannot play this file. MP4 works best.');emptyMsg('<div>This file could not be played. Try an MP4 file.</div>')};
  const name=baseName(f.name);fileTitle=name;setNow(name);broadcast({t:'title',title:name});
  resetMoments();loadMarks();watched(name);
  addChat('','Now playing: '+name,true);broadcast({t:'chat',n:'Couchcast',m:'Now playing: '+name});
}
function hostSubTick(){
  if(!isHost)return;
  const t=cues.length&&M.ok()&&!M.live()?subAt(M.time()):'';
  if(t!==curSub){setSub(t);broadcast({t:'sub',x:t})}
}
/* ---------- queue ---------- */
function addFiles(files){
  files=[...files].filter(isVideo).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  if(!files.length)return;
  if(!vid.src||vid.ended||pendingAt!=null){hostLoad(files.shift())}
  files.forEach(f=>queue.push({file:f,name:baseName(f.name)}));
  if(files.length)toast(files.length+' added to the queue');
  renderQueue();
}
function renderQueue(){
  $('queueWrap').style.display=queue.length?'block':'none';
  $('queue').innerHTML=queue.map((q,i)=>'<li><span>'+esc(q.name)+'</span><button class="ghost small" data-q="play" data-i="'+i+'">Play</button><button class="ghost small" data-q="up" data-i="'+i+'" '+(i?'':'disabled')+' aria-label="Move up">Up</button><button class="ghost small" data-q="del" data-i="'+i+'" aria-label="Remove">Remove</button></li>').join('');
  updateControls();pushVotes();
}
function playNext(i){
  i=i||0;const q=queue.splice(i,1)[0];if(!q)return;
  for(const [v,k] of [...votes])if(k==='q:'+q.name)votes.delete(v);
  renderQueue();hostLoad(q.file,{autoplay:true});
}
vid.addEventListener('ended',()=>{
  if(!isHost)return;
  if(curKey)store.del('cc-pos-'+curKey);
  if(!queue.length){addChat('','That was the last movie in the queue.',true);return}
  let n=8;
  const draw=()=>{const nx=queue[bestNext()];if(!nx){clearTimeout(nextTimer);overlay('');return}overlay('<p>Up next'+(votes.size?' (most votes)':'')+': '+esc(nx.name)+'<br>starting in '+n+'s</p><div class="row" style="justify-content:center"><button id="nextNow">Play now</button><button class="ghost" id="nextCancel">Cancel</button></div>')};
  draw();$('nextNow').focus();
  const tickN=()=>{if(!queue.length){overlay('');return}if(--n<=0){playNext(bestNext());return}draw();bindNext();nextTimer=setTimeout(tickN,1000)};
  const bindNext=()=>{if(!$('nextNow'))return;$('nextNow').onclick=()=>{clearTimeout(nextTimer);playNext(bestNext())};$('nextCancel').onclick=()=>{clearTimeout(nextTimer);overlay('')}};
  bindNext();nextTimer=setTimeout(tickN,1000);
});
/* remember where we were, for "resume where we left off" */
setInterval(()=>{
  if(!isHost||!curKey||!vid.duration||vid.paused)return;
  if(vid.currentTime>30&&vid.duration-vid.currentTime>90)store.set('cc-pos-'+curKey,Math.floor(vid.currentTime));
  else if(vid.duration-vid.currentTime<=90)store.del('cc-pos-'+curKey);
},5000);

/* ---------- kick & hand over ---------- */
function kick(id){
  const c=conns.get(id);if(!c)return;
  banned.add(c.name.toLowerCase());c.kicked=true;
  try{c.conn.send({t:'kicked'})}catch(e){}
  addChat('',c.name+' was removed from the room.',true);
  setTimeout(()=>{try{c.conn.close()}catch(e){}dropViewer(id)},400);
}
function handState(){return{mode,ctl:allowCtl,pw:roomPw,locked,banned:[...banned],members:[myName,...[...conns.values()].filter(c=>c.name!=='…'&&!c.remote).map(c=>c.name)],cues,title,c:M.time(),clear:$('clearDlg').checked,queue:queue.map(q=>q.name),link:mode==='link'?link:null,sug:suggestions}}
function handOver(id,thenLeave){
  const c=conns.get(id);if(!c)return false;
  if(M.ok()&&!M.paused()&&!M.live())M.pause();
  if(sharing)stopShare(true);
  const st=handState();
  c.conn.send({t:'becomeHost',st});
  broadcast({t:'hostChange',name:c.name},id);broadcast({t:'sync',p:true,c:M.time(),d:M.dur()});
  addChat('','Handing the room to '+c.name+'…',true);
  leaving=true;
  setTimeout(()=>{
    try{peer.destroy()}catch(e){}
    if(thenLeave){history.replaceState(null,'',location.pathname);location.reload();return}
    sess.set('cc-boot',{act:'join',code,name:myName,delay:3500,voice:voice.on});location.reload();
  },700);
  return true;
}

/* ================= VIEWER ================= */
async function startJoin(opts){
  getAC();$('lobbyMsg').textContent='Getting ready…';$('joinBtn').disabled=true;
  await iceReady;startJoinNow(opts);
}
function startJoinNow(opts){
  opts=opts||{};
  getName(opts.name);code=(opts.code||$('joinCode').value).trim().toUpperCase();
  if(!/^[A-Z0-9]{6}$/.test(code)){$('lobbyMsg').textContent='Enter the 6-character code from your host.';return}
  getAC();
  $('lobbyMsg').textContent='Connecting…';$('joinBtn').disabled=true;
  if(peer&&!inRoom()){try{peer.destroy()}catch(e){}peer=null;hostConn=null}
  peer=makePeer();
  peer.on('open',()=>{if(!hostConn||!hostConn.open)connectHost()});
  peer.on('disconnected',()=>{if(!leaving)setTimeout(()=>{try{peer&&!peer.destroyed&&peer.reconnect()}catch(e){}},1000)});
  peer.on('error',e=>{
    $('joinBtn').disabled=false;
    if(e.type==='peer-unavailable'){
      if(String(e.message||'').includes(PREFIX+code)||!e.message){
        if(inRoom())retryHost();
        else if(opts.code&&retries++<6)setTimeout(connectHost,2500);
        else{hostConn=null;$('lobbyMsg').textContent='No room with that code. Check it with your host, or the host may have closed the page.'}
      }
    }else $('lobbyMsg').textContent='Could not connect ('+e.type+'). Check your internet and try again.';
  });
  peer.on('call',onIncomingCall);
  joinOpts=opts;
}
let joinOpts={};
function connectHost(){
  if(!peer||peer.destroyed)return;
  hostConn=peer.connect(PREFIX+code,{reliable:true});
  const mine=hostConn;
  setTimeout(()=>{
    if(mine!==hostConn||inRoom()||leaving)return;
    // never got in: say why instead of "Connecting…" forever
    $('lobbyMsg').innerHTML=mine.open
      ?'The host\'s page found you but didn\'t answer. Ask the host to refresh their page (Ctrl+Shift+R) and create the room again.'
      :'Can\'t reach the host\'s device. The room exists, but one of your networks is blocking a direct connection (common on Jio, Airtel, mobile hotspots and office Wi-Fi).'+
       (relayOn?' A relay is set up but it didn\'t get through either; check the relay details under Connection settings.':' <b>Fix:</b> set up a free relay under <b>Connection settings</b> below, or try both devices on the same Wi-Fi or a different network.');
    $('joinBtn').disabled=false;
    try{mine.close()}catch(e){}hostConn=null;try{peer.destroy()}catch(e){}peer=null;retries=0;
  },15000);
  hostConn.on('open',()=>{
    retries=0;
    hostConn.send({t:'join',n:myName,pw:$('joinPw').value,helper:$('helpShare').checked,av:myLook.av,col:myLook.col});
  });
  hostConn.on('data',onViewerData);
  hostConn.on('close',()=>{if(!leaving)retryHost()});
}
function admitted(){
  if(!inRoom()){enterRoom();addChat('','You joined the room.',true)}
  else addChat('','Reconnected.',true);
  statusLine('Connected to host.');
  try{bc&&bc.postMessage({code})}catch(e){}
  if(voice.on)hostConn.send({t:'mic',on:true});
  else if(joinOpts.voice){joinOpts.voice=false;joinVoice()}
}
function retryHost(){
  if(leaving)return;
  if(retries++>=25){statusLine('Lost the host. They may have left.');addChat('','Could not reach the host. They may have closed the room.',true);return}
  statusLine('Connection lost, reconnecting… ('+retries+')');
  setTimeout(()=>{if(!leaving&&(!hostConn||!hostConn.open))connectHost()},3000);
}
function bounce(msg,focusPw){
  leaving=true;sess.set('cc-flash',{msg,code,pw:!!focusPw});
  try{peer.destroy()}catch(e){}
  location.reload();
}
function onViewerData(d){
  if(!d||typeof d!=='object')return;
  switch(d.t){
    case 'denied':
      bounce(d.why==='password'?($('joinPw').value?'Wrong room password. Ask the host for it.':'This room has a password. Ask the host for it and type it in.'):d.why==='locked'?'The host has locked this room.':'The host removed you from this room.',d.why==='password');break;
    case 'kicked':bounce('The host removed you from this room.');break;
    case 'hello':admitted();marks=cleanMarks(d.marks);momentsList=cleanMoments(d.moments);renderMoments();setNow(d.title);setSub(d.sub);hostFi=d.fi&&typeof d.fi==='object'?{fp:String(d.fi.fp)}:null;applyMode(d.mode,cleanLink(d.link));allowCtl=!!d.ctl;updateControls();renderVotes(cleanVotes(d.votes));break;
    case 'chat':addChat(d.n,d.m,false,d.av,d.col,!!d.sp);break;
    case 'spin':if(Array.isArray(d.names)&&d.names.length>=2&&d.names.length<=24&&Number.isInteger(d.i)&&d.i>=0&&d.i<d.names.length)showWheel(d.names.map(x=>String(x).slice(0,60)),d.i,Math.max(0,Math.min(1,+d.j||0)),String(d.by||'').slice(0,30));break;
    case 'seatno':toast('That seat is taken.');break;
    case 'sfx':if(SFX[d.k]){playSfx(d.k);showSfx(d.k,String(d.n||'').slice(0,30));seatPop(d.id,SFX[d.k].i)}break;
    case 'laser':if(isFinite(d.x)&&isFinite(d.y))showLaser(+d.x,+d.y,String(d.n||'').slice(0,30),cleanCol(d.col));break;
    case 'wait':showWait(Array.isArray(d.names)?d.names.map(n=>String(n).slice(0,24)).slice(0,10):[]);break;
    case 'people':people=Array.isArray(d.list)?d.list.filter(p=>p&&typeof p==='object').map(p=>({id:String(p.id),name:String(p.name).slice(0,24),host:!!p.host,mic:!!p.mic,av:cleanAv(p.av),col:cleanCol(p.col),via:String(p.via||'').slice(0,24),q:String(p.q||'').slice(0,8),match:String(p.match||'').slice(0,6),seat:Number.isInteger(p.seat)&&p.seat>=0&&p.seat<16?p.seat:-1})):[];renderPeople();voiceSyncCalls();camSync();break;
    case 'mode':applyMode(d.mode,cleanLink(d.link));break;
    case 'link':link=cleanLink(d.link);if(mode==='link')showLink();break;
    case 'votes':renderVotes(cleanVotes(d.items));break;
    case 'fileinfo':hostFi=d.fi&&typeof d.fi==='object'?{fp:String(d.fi.fp)}:null;compareFiles();break;
    case 'readyq':overlay('<p>The host asks: ready to start?</p><div class="row" style="justify-content:center"><button id="rcMe">I\'m ready</button></div>');$('rcMe').onclick=()=>{if(hostConn&&hostConn.open)hostConn.send({t:'ready'});overlay('<p>Waiting for the others…</p>')};$('rcMe').focus();break;
    case 'readyx':overlay('');break;
    case 'count':countdown();break;
    case 'relayTo':{const id=String(d.id||'');if(id){relayKids.set(id,{call:null});forward(id)}break}
    case 'relayStop':{const id=String(d.id||''),o=relayKids.get(id);if(o&&o.call)try{o.call.close()}catch(e){}relayKids.delete(id);break}
    case 'relayStopAll':stopForwarding();break;
    case 'rcx':localRemoteAction(String(d.a||''));break;
    case 'moments':momentsList=cleanMoments(d.list);renderMoments();break;
    case 'marks':marks=cleanMarks(d.m);break;
    case 'perm':allowCtl=!!d.on;updateControls();renderMoments();addChat('',allowCtl?'The host let everyone control playback.':'Only the host controls playback now.',true);break;
    case 'title':setNow(d.title);if(mode==='sync')autoPick();break;
    case 'queue':renderUpNext(Array.isArray(d.list)?d.list.map(String):[]);break;
    case 'sub':setSub(d.x);break;
    case 'react':popReaction(String(d.e).slice(0,4));seatPop(d.id,String(d.e).slice(0,4));break;
    case 'hostChange':addChat('',String(d.name).slice(0,24)+' is taking over as host. Hang on a few seconds…',true);statusLine('Switching host…');retries=0;break;
    case 'becomeHost':
      leaving=true;
      sess.set('cc-boot',{act:'host',code,name:myName,st:d.st||{},voice:voice.on,delay:1200});
      try{peer.destroy()}catch(e){}
      location.reload();break;
    case 'sync':
      remote={p:!!d.p,c:+d.c||0,d:+d.d||0,at:performance.now(),live:!!d.live};
      if((mode==='sync'&&vid.src&&vid.readyState>0)||(mode==='link'&&M.ok()))applyRemote();
      break;
  }
}
function cleanMarks(m){if(!m||typeof m!=='object')return null;const o={};for(const k of ['is','ie','cs'])if(isFinite(m[k])&&m[k]!==null)o[k]=+m[k];return Object.keys(o).length?o:null}
function cleanMoments(l){return Array.isArray(l)?l.slice(0,5).filter(m=>m&&isFinite(m.t)).map(m=>({t:+m.t,n:+m.n||0,e:String(m.e||'').slice(0,4)})):[]}
function cleanVotes(items){return Array.isArray(items)?items.filter(i=>i&&typeof i==='object').slice(0,60).map(i=>({key:String(i.key),name:String(i.name).slice(0,60),sug:!!i.sug,n:+i.n||0,by:Array.isArray(i.by)?i.by.map(String):[]})):[]}
function applyMode(m,l){
  mode=m==='sync'||m==='link'?m:'stream';
  $('tap').style.display='none';playWantAt=0;
  if(l!==undefined)link=l;
  $('viewerBox').style.display=mode==='sync'?'block':'none';
  if(mode!=='stream')stopForwarding();
  if(mode!=='link'){clearLinkPlayers();vid.style.visibility=''}
  if(mode==='link'){
    vid.srcObject=null;$('stats').style.display='none';clearInterval(statTimer);
    if(vid.src){vid.pause()}
    vid.style.visibility='hidden';
    if(link)showLink();else emptyMsg('<div>Waiting for the host to pick a video…</div>');
    return;
  }
  if(mode==='sync'){
    vid.srcObject=null;$('stats').style.display='none';clearInterval(statTimer);
    if(!autoPick()&&!vid.src)emptyMsg('<div><p style="margin:0 0 12px;font-size:18px;color:var(--ink)">Open your copy'+(title?' of "'+esc(title)+'"':' of the movie')+'</p><button id="vpickBtn">Choose movie file</button></div>');
    const b=$('vpickBtn');if(b)b.onclick=()=>$('vfile').click();
  }else{
    if(vid.src){URL.revokeObjectURL(vid.src);vid.removeAttribute('src');vid.load()}
    if(!vid.srcObject)emptyMsg('<div>Waiting for the host to start the movie…</div>');
  }
}
let loadedTitle='';
function autoPick(){
  if(!title)return false;
  const f=library.get(title.toLowerCase());
  if(f&&loadedTitle!==title.toLowerCase()){viewerLoad(f);return true}
  if(!f&&library.size&&loadedTitle!==title.toLowerCase()){
    vid.removeAttribute('src');vid.load();
    emptyMsg('<div><p style="margin:0 0 12px;font-size:18px;color:var(--ink)">Open your copy of "'+esc(title)+'"</p><button id="vpickBtn">Choose movie file</button></div>');
    $('vpickBtn').onclick=()=>$('vfile').click();
  }
  return !!f;
}
function viewerLoad(f){
  if(!f)return;
  if(vid.src)URL.revokeObjectURL(vid.src);
  vid.srcObject=null;vid.src=URL.createObjectURL(f);emptyMsg('');loadedTitle=baseName(f.name).toLowerCase();
  viewerUseElement();
  myFp=null;$('matchMsg').textContent='Checking it matches the host\'s file…';$('matchMsg').className='hint';
  fingerprint(f).then(fp=>{myFp=fp;if(vid.readyState>0)compareFiles()});
  vid.onloadedmetadata=()=>{
    compareFiles();
    if(remote.d&&Math.abs(vid.duration-remote.d)>5)toast('Heads-up: your file is a different length from the host\'s. It may drift.');
    vid.currentTime=remote.c+(remote.p?0:(performance.now()-remote.at)/1000);
    if(!remote.p){wakeAudio();vid.play().catch(()=>{$('tap').style.display='grid'})}
  };
  vid.onerror=()=>toast('Your browser cannot play this file. MP4 works best.');
}
function onMovieCall(call){
  if(inCall)inCall.close();inCall=call;
  const via=call.metadata&&call.metadata.via?String(call.metadata.via).slice(0,24):'';
  call.answer(undefined,{sdpTransform:preferCodec});
  call.on('stream',s=>{
    if(mode!=='stream')return;
    inStream=s;if(relayKids.size)forwardAll();
    if(vid.src){URL.revokeObjectURL(vid.src);vid.removeAttribute('src')}
    vid.srcObject=s;emptyMsg('');
    viewerUseStream(s);applyVol();
    // A bigger playout buffer trades ~half a second of delay for smooth, unbroken sound.
    try{call.peerConnection.getReceivers().forEach(r=>{if('jitterBufferTarget' in r)r.jitterBufferTarget=500;else if('playoutDelayHint' in r)r.playoutDelayHint=0.5})}catch(e){}
    if(!s.getAudioTracks().length)addChat('','No sound is coming from the host. Ask them to check the movie file has sound.',true);
    vid.play().then(()=>{if(audioBlocked())$('tap').style.display='grid'}).catch(()=>{$('tap').style.display='grid'});
    $('stats').style.display=showStats?'block':'none';
    watchStats(call);statusLine(via?'Receiving the stream through '+via+'.':'Receiving the host\'s stream.');
  });
  call.on('close',()=>{
    if(inCall!==call)return;
    inCall=null;
    setTimeout(()=>{if(!inCall&&mode==='stream'&&!isHost){vid.srcObject=null;inStream=null;clearInterval(statTimer);$('stats').style.display='none';emptyMsg('<div>Waiting for the host to start the movie…</div>')}},1500);
  });
}
function watchStats(call){
  clearInterval(statTimer);let last=0,lastA=0,lastT=performance.now();
  statTimer=setInterval(async()=>{
    const pc=call.peerConnection;if(!pc)return;
    try{
      const r=await pc.getStats();let route='';
      r.forEach(s=>{
        if(s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated){const lc=r.get(s.localCandidateId);if(lc)route=lc.candidateType==='relay'?' · via relay':' · direct'}
      });
      let vtxt='',atxt=' · no sound';
      const now=performance.now(),dt=(now-lastT)/1000;
      r.forEach(s=>{
        if(s.type==='inbound-rtp'&&s.kind==='video'){
          const mb=last?((s.bytesReceived-last)*8/dt/1e6):0;last=s.bytesReceived;
          vtxt=(s.frameWidth||'?')+'×'+(s.frameHeight||'?')+' · '+Math.round(s.framesPerSecond||0)+' fps · '+mb.toFixed(1)+' Mbps';
        }
        if(s.type==='inbound-rtp'&&s.kind==='audio'){
          const kb=lastA?((s.bytesReceived-lastA)*8/dt/1e3):0;lastA=s.bytesReceived;
          const gaps=s.totalSamplesReceived?Math.round(100*(s.concealedSamples||0)/s.totalSamplesReceived):0;
          atxt=' · sound '+Math.round(kb)+' kbps'+(gaps>2?' ('+gaps+'% gaps)':'');
        }
      });
      lastT=now;
      $('stats').textContent=vtxt+atxt+route;
    }catch(e){}
  },2000);
}

/* ================= VOICE CHAT =================
   Everyone in voice sends their mic to everyone else directly (one-way calls, so each pair has two).
   Voices play through <audio> elements so the browser's echo cancellation knows about them.
   Push-to-talk by default, so speakers playing the movie don't leak into the mic. */
const voice={on:false,mic:null,ptt:true,talking:false,out:new Map(),in:new Map(),myAn:null,myBuf:null};
const speaking=new Set();
async function joinVoice(){
  if(voice.on)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast('Voice chat is not supported in this browser.');return}
  try{
    voice.mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  }catch(e){toast('Microphone blocked. Allow it in the address bar to use voice chat.');return}
  voice.on=true;voice.ptt=!$('openMic').checked;
  voice.mic.getAudioTracks().forEach(t=>t.enabled=!voice.ptt);
  if(getAC()){try{const s=ac.createMediaStreamSource(voice.mic);voice.myAn=ac.createAnalyser();voice.myAn.fftSize=512;s.connect(voice.myAn);voice.myBuf=new Float32Array(512)}catch(e){}}
  $('voiceBtn').textContent='Leave voice chat';$('voiceBtn').classList.add('ghost');$('voiceCtl').style.display='block';
  $('barMic').style.display=voice.ptt?'block':'none';$('pttBtn').style.display=voice.ptt?'block':'none';
  announceMic();voiceSyncCalls();
  addChat('','You joined voice chat. '+(voice.ptt?'Hold the talk button or the T key to speak.':'Your mic is open.'),true);
}
function leaveVoice(){
  if(!voice.on)return;
  voice.on=false;talk(false);
  for(const {call} of voice.out.values())try{call.close()}catch(e){}
  voice.out.clear();
  if(voice.mic)voice.mic.getTracks().forEach(t=>t.stop());voice.mic=null;voice.myAn=null;
  $('voiceBtn').textContent='Join voice chat';$('voiceBtn').classList.remove('ghost');$('voiceCtl').style.display='none';$('barMic').style.display='none';
  announceMic();
}
function announceMic(){
  if(isHost)pushPeople();
  else if(hostConn&&hostConn.open)hostConn.send({t:'mic',on:voice.on});
}
function voiceSyncCalls(){
  if(!voice.on||!peer)return;
  const ids=new Set(people.map(p=>p.id).filter(id=>id&&id!==myId()));
  for(const [id,o] of voice.out){
    const st=o.call.peerConnection&&o.call.peerConnection.connectionState;
    if(!ids.has(id)||st==='failed'||st==='closed'){try{o.call.close()}catch(e){}voice.out.delete(id)}
  }
  for(const id of ids)if(!voice.out.has(id)){
    const call=peer.call(id,voice.mic,{metadata:{kind:'voice'}});
    if(call){voice.out.set(id,{call});call.on('close',()=>{if(voice.out.get(id)&&voice.out.get(id).call===call)voice.out.delete(id)})}
  }
}
function onIncomingCall(call){
  const kind=call.metadata&&call.metadata.kind;
  if(kind==='voice')return onVoiceCall(call);
  if(kind==='cam')return onCamCall(call);
  if(!isHost)return onMovieCall(call);
  try{call.close()}catch(e){}
}
function onVoiceCall(call){
  const id=call.peer,old=voice.in.get(id);
  if(old)dropVoiceIn(id);
  call.answer();
  call.on('stream',s=>{
    const el=new Audio();el.autoplay=true;el.srcObject=s;el.volume=Math.min(1,+$('voiceVol').value);
    el.play().catch(()=>{$('tap').style.display='grid'});
    let an=null;
    if(getAC()){try{const src=ac.createMediaStreamSource(s);an=ac.createAnalyser();an.fftSize=512;src.connect(an)}catch(e){}}
    voice.in.set(id,{call,el,an,buf:new Float32Array(512),last:0});
  });
  call.on('close',()=>dropVoiceIn(id));
  call.on('error',()=>dropVoiceIn(id));
}
function dropVoiceIn(id){
  const v=voice.in.get(id);if(!v)return;
  voice.in.delete(id);try{v.el.pause();v.el.srcObject=null}catch(e){}try{v.call.close()}catch(e){}
  speaking.delete(id);
}
function rms(an,buf){an.getFloatTimeDomainData(buf);let s=0;for(let i=0;i<buf.length;i++)s+=buf[i]*buf[i];return Math.sqrt(s/buf.length)}
function talk(on){
  voice.talking=!!on&&voice.on;
  if(voice.mic&&voice.ptt)voice.mic.getAudioTracks().forEach(t=>t.enabled=voice.talking);
  $('pttBtn').classList.toggle('live',voice.talking);$('barMic').classList.toggle('live',voice.talking);
  $('pttBtn').textContent=voice.talking?'Talking… release to stop':'Hold to talk (or hold T)';
}
let lastVoiceAt=0,talkerKey='';
setInterval(()=>{
  const now=performance.now(),before=[...speaking].join();
  speaking.clear();
  for(const [id,v] of voice.in){
    if(v.call.peerConnection&&['failed','closed'].includes(v.call.peerConnection.connectionState)){dropVoiceIn(id);continue}
    if(v.an&&rms(v.an,v.buf)>.02)v.last=now;
    if(now-v.last<450)speaking.add(id);
  }
  let mine=false;
  if(voice.on&&voice.myAn){mine=(voice.ptt?voice.talking:true)&&rms(voice.myAn,voice.myBuf)>.02}
  else if(voice.talking)mine=true;
  if(mine&&myId())speaking.add(myId());
  if(speaking.size)lastVoiceAt=now;
  setDuck(now-lastVoiceAt<700);
  const after=[...speaking].join();
  if(after!==before){
    document.querySelectorAll('.person,#cams figure,#couch .seat.full').forEach(el=>el.classList.toggle('speaking',speaking.has(el.dataset.id)));
    const names=people.filter(p=>speaking.has(p.id)&&p.id!==myId()).map(avName);
    const key=names.join();if(key!==talkerKey){talkerKey=key;$('talkers').innerHTML=names.map(n=>'<span>'+esc(n)+' is talking</span>').join('')}
  }
},100);
setInterval(()=>{if(voice.on)voiceSyncCalls();camSync()},4000);

/* ================= ONE PLAYER, MANY SOURCES =================
   M is whatever is playing: a file in <video id=vid>, a shared screen, a direct video link in
   <video id=lvid>, or a YouTube player. Host controls and friends' syncing all go through it. */
function linkOn(){return mode==='link'&&!!link}
const M={
  ok(){if(linkOn())return link.kind==='yt'?ytReady:!!lvid.currentSrc;return !!(vid.src||sharing)},
  time(){if(linkOn())return link.kind==='yt'?(ytReady&&yt.getCurrentTime()||0):(lvid.currentTime||0);return vid.currentTime||0},
  dur(){if(M.live())return 0;if(linkOn())return link.kind==='yt'?(ytReady&&yt.getDuration()||0):(isFinite(lvid.duration)?lvid.duration:0);return isFinite(vid.duration)?vid.duration:0},
  paused(){if(linkOn())return link.kind==='yt'?!(ytReady&&[1,3].includes(yt.getPlayerState())):lvid.paused;return vid.paused},
  play(){wakeAudio();if(linkOn()){if(link.kind==='yt'){if(ytReady)yt.playVideo()}else lvid.play().catch(()=>{$('tap').style.display='grid'})}else vid.play().catch(()=>{})},
  pause(){if(linkOn()){if(link.kind==='yt'){if(ytReady)yt.pauseVideo()}else lvid.pause()}else vid.pause()},
  seek(t){if(linkOn()){if(link.kind==='yt'){if(ytReady)yt.seekTo(t,true)}else lvid.currentTime=t}else vid.currentTime=t},
  live(){return isHost?(!!sharing&&!linkOn()):!!remote.live}
};
function applyRemote(){
  if(!M.ok())return;
  const target=remote.c+(remote.p?0:(performance.now()-remote.at)/1000);
  if(Math.abs(M.time()-target)>(mode==='link'?1.5:.6))M.seek(target);
  if(remote.p&&!M.paused())M.pause();
  if(!remote.p&&M.paused()){playWantAt=performance.now();M.play()}
}

/* ---------- YouTube & video links ---------- */
function parseLink(u){
  u=String(u||'').trim();if(!u)return null;
  const m=u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  if(m)return{kind:'yt',id:m[1],url:u};
  if(/^https?:\/\/\S+$/i.test(u))return{kind:'url',url:u};
  return null;
}
function cleanLink(l){if(!l||typeof l!=='object')return null;if(l.kind==='yt'&&/^[\w-]{11}$/.test(String(l.id)))return{kind:'yt',id:String(l.id),url:String(l.url||'')};if(l.kind==='url'&&/^https?:\/\//i.test(String(l.url)))return{kind:'url',url:String(l.url)};return null}
let ytApi=null;
function loadYTApi(){
  if(ytApi)return ytApi;
  ytApi=new Promise(res=>{
    if(window.YT&&window.YT.Player)return res();
    const prev=window.onYouTubeIframeAPIReady;window.onYouTubeIframeAPIReady=()=>{prev&&prev();res()};
    const sc=document.createElement('script');sc.src='https://www.youtube.com/iframe_api';sc.onerror=()=>res();document.head.appendChild(sc);
    setTimeout(res,10000);
  });
  return ytApi;
}
function clearLinkPlayers(){
  if(yt){try{yt.destroy()}catch(e){}}yt=null;ytReady=false;
  $('ytbox').innerHTML='';$('ytbox').style.display='none';
  lvid.pause();lvid.removeAttribute('src');lvid.load();lvid.style.display='none';
}
let linkGen=0;
async function showLink(){
  const gen=++linkGen;
  clearLinkPlayers();
  if(!link)return;
  emptyMsg('');vid.style.visibility='hidden';
  if(link.kind==='url'){
    lvid.style.display='block';lvid.src=link.url;applyLinkVol();
    lvid.onerror=()=>{toast('That video link could not be played here.');emptyMsg('<div>This link could not be played. Direct video links (ending in .mp4 or .webm) and YouTube links work.</div>')};
    lvid.onloadedmetadata=()=>{if(isHost){broadcast(state());updateControls()}else applyRemote()};
    return;
  }
  await loadYTApi();
  if(gen!==linkGen)return;
  if(!window.YT||!window.YT.Player){toast('YouTube could not load.');emptyMsg('<div>YouTube could not load on this device.</div>');return}
  if(!linkOn())return;
  $('ytbox').style.display='block';$('ytbox').innerHTML='<div id="ytp"></div>';
  const mine=link;
  yt=new YT.Player('ytp',{width:'100%',height:'100%',videoId:link.id,playerVars:{controls:0,disablekb:1,rel:0,modestbranding:1,playsinline:1,iv_load_policy:3,fs:0,origin:location.origin},events:{
    onReady:()=>{
      if(link!==mine||gen!==linkGen)return;ytReady=true;applyLinkVol();
      if(isHost){const t=yt.getVideoData&&yt.getVideoData().title;if(t){setNow(t);broadcast({t:'title',title:t});loadMarks();watched(t)}broadcast(state());updateControls()}
      else applyRemote();
    },
    onStateChange:e=>{
      if(isHost)broadcast(state());
      $('spin').style.display=e.data===3?'grid':'none';
      if(e.data===1)playWantAt=0;
    },
    onError:()=>{toast('This YouTube video can\'t be played inside other sites.');emptyMsg('<div>This YouTube video can\'t be played on other sites. Try another video.</div>')}
  }});
}
function hostLoadLink(){
  const l=parseLink($('linkUrl').value);
  if(!l){toast('Paste a YouTube link, or a direct video link starting with https://');return}
  link=l;
  const name=l.kind==='yt'?'YouTube video':decodeURIComponent(baseName(l.url.split('?')[0].split('/').pop()||'Video link'));
  setNow(name);broadcast({t:'link',link});broadcast({t:'title',title:name});resetMoments();loadMarks();
  addChat('','Now playing: '+name,true);broadcast({t:'chat',n:'Couchcast',m:'Now playing: '+name});
  if(mode!=='link')setMode('link');else showLink();
}

/* ---------- screen & tab sharing ---------- */
async function startShare(){
  if(sharing)return stopShare();
  if(!navigator.mediaDevices||!navigator.mediaDevices.getDisplayMedia)return toast('Screen sharing needs Chrome or Edge on a computer.');
  let s;
  try{s=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30,max:60},width:{max:3840},height:{max:2160}},audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},systemAudio:'include',selfBrowserSurface:'exclude',surfaceSwitching:'include'})}
  catch(e){return}
  if(mode!=='stream')setMode('stream');
  if(vid.src&&!vid.paused)vid.pause();
  sharing=s;
  s.getVideoTracks()[0].addEventListener('ended',()=>stopShare());
  vid.srcObject=s;vid.muted=true;vid.play().catch(()=>{});emptyMsg('');overlay('');
  setNow('Screen share');broadcast({t:'title',title:'Screen share'});resetMoments();marks=null;broadcast({t:'marks',m:null});
  if(!s.getAudioTracks().length)addChat('','Sharing without sound. To include sound, share a Chrome tab and keep "Also share tab audio" ticked.',true);
  $('shareBtn').textContent='Stop sharing';
  addChat('','You are sharing your screen.',true);
  makeStream();broadcast(state());updateControls();
}
function stopShare(silent){
  if(!sharing)return;
  sharing.getTracks().forEach(t=>t.stop());sharing=null;
  vid.srcObject=null;vid.muted=false;stream=null;
  for(const c of conns.values()){if(c.call){c.call.close();c.call=null}c.parent=null}
  broadcast({t:'relayStopAll'});
  $('shareBtn').textContent='Share a tab or screen instead';
  if(!silent){addChat('','Screen sharing stopped.',true);setNow('');broadcast({t:'title',title:''});broadcast(state());pickPrompt('Choose a movie to start')}
  applyVol();updateControls();
}

/* ---------- camera bubbles ---------- */
const cam={on:false,stream:null,out:new Map(),in:new Map()};
function nameOf(id){const p=people.find(p=>p.id===id);return p?avName(p):'Friend'}
function addBubble(id,name,s,self){
  removeBubble(id);
  const f=document.createElement('figure');f.dataset.id=id;if(self)f.className='self';
  const v=document.createElement('video');v.muted=true;v.autoplay=true;v.playsInline=true;v.srcObject=s;
  const c=document.createElement('figcaption');c.textContent=name;
  f.append(v,c);$('cams').appendChild(f);v.play().catch(()=>{});
}
function removeBubble(id){const f=[...$('cams').children].find(x=>x.dataset.id===id);if(f){const v=f.querySelector('video');if(v)v.srcObject=null;f.remove()}}
async function camOn(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return toast('Camera is not supported in this browser.');
  try{cam.stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:320},height:{ideal:240},frameRate:{ideal:15,max:20},facingMode:'user'},audio:false})}
  catch(e){return toast('Camera blocked. Allow it in the address bar.')}
  cam.on=true;$('camBtn').textContent='Turn off camera';
  addBubble(myId(),'You',cam.stream,true);camSync();
}
function camOff(){
  cam.on=false;
  for(const o of cam.out.values())try{o.call.close()}catch(e){}
  cam.out.clear();if(cam.stream)cam.stream.getTracks().forEach(t=>t.stop());cam.stream=null;
  removeBubble(myId());$('camBtn').textContent='Turn on camera';
}
function camSync(){
  for(const [id,o] of cam.in){const st=o.call.peerConnection&&o.call.peerConnection.connectionState;if(st==='failed'||st==='closed'||!people.some(p=>p.id===id))dropCamIn(id)}
  if(!cam.on||!peer)return;
  const ids=new Set(people.map(p=>p.id).filter(id=>id&&id!==myId()));
  for(const [id,o] of cam.out){const st=o.call.peerConnection&&o.call.peerConnection.connectionState;if(!ids.has(id)||st==='failed'||st==='closed'){try{o.call.close()}catch(e){}cam.out.delete(id)}}
  for(const id of ids)if(!cam.out.has(id)){
    const call=peer.call(id,cam.stream,{metadata:{kind:'cam'}});
    if(call){cam.out.set(id,{call});call.on('close',()=>{const o=cam.out.get(id);if(o&&o.call===call)cam.out.delete(id)});capBitrate(call,300000)}
  }
}
async function capBitrate(call,bps){
  for(let i=0;i<40;i++){
    const pc=call.peerConnection,s=pc&&pc.getSenders().find(x=>x.track&&x.track.kind==='video');
    if(pc&&pc.connectionState==='closed')return;
    if(s&&pc.connectionState==='connected'){const p=s.getParameters();if(!p.encodings||!p.encodings.length)p.encodings=[{}];p.encodings[0].maxBitrate=bps;try{await s.setParameters(p)}catch(e){}return}
    await sleep(500);
  }
}
function onCamCall(call){
  const id=call.peer;dropCamIn(id);
  call.answer();
  call.on('stream',s=>{cam.in.set(id,{call});addBubble(id,nameOf(id),s,false)});
  call.on('close',()=>dropCamIn(id));call.on('error',()=>dropCamIn(id));
}
function dropCamIn(id){const o=cam.in.get(id);if(!o)return;cam.in.delete(id);try{o.call.close()}catch(e){}removeBubble(id)}

/* ---------- ready check & 3-2-1 ---------- */
function startReady(){
  if(!isHost)return;
  if(!M.ok())return toast('Load something to watch first.');
  const ids=[...conns.entries()].filter(([,c])=>c.name!=='…'&&!c.remote).map(([id])=>id);
  if(M.ok()&&!M.paused())M.pause();
  if(!ids.length){goCountdown();return}
  readyRound={ids:new Set(ids),ok:new Set()};
  broadcast({t:'readyq'});drawReady();
}
function drawReady(){
  if(!readyRound)return;
  for(const id of [...readyRound.ids])if(!conns.has(id))readyRound.ids.delete(id);
  const waiting=[...readyRound.ids].filter(id=>!readyRound.ok.has(id)).map(id=>conns.get(id).name);
  if(!waiting.length){readyRound=null;goCountdown();return}
  overlay('<p>Ready check: '+readyRound.ok.size+' of '+readyRound.ids.size+' ready<br><span class="hint">Waiting for '+esc(waiting.join(', '))+'</span></p><div class="row" style="justify-content:center"><button id="rcGo">Start now</button><button class="ghost" id="rcCancel">Cancel</button></div>');
  $('rcGo').onclick=()=>{readyRound=null;goCountdown()};
  $('rcCancel').onclick=()=>{readyRound=null;overlay('');broadcast({t:'readyx'})};
}
function goCountdown(){broadcast({t:'count'});countdown(()=>{if(M.ok())M.play()})}
let cdTimer=null;
function countdown(done){
  clearInterval(cdTimer);let n=3;
  const draw=()=>overlay('<div class="count">'+n+'</div>');
  draw();cdTimer=setInterval(()=>{if(--n<=0){clearInterval(cdTimer);overlay('');done&&done()}else draw()},1000);
}

/* ---------- suggestions & votes for what's next ---------- */
function voteItems(){
  const items=[...queue.map(q=>({key:'q:'+q.name,name:q.name,sug:false})),...suggestions.map(n=>({key:'s:'+n,name:n,sug:true}))];
  const by={};for(const [v,k] of votes)(by[k]=by[k]||[]).push(v);
  return items.map(i=>({...i,n:(by[i.key]||[]).length,by:by[i.key]||[]}));
}
function pushVotes(){if(!isHost)return;const items=voteItems();renderVotes(items);broadcast({t:'votes',items})}
let lastVotes=[];
function renderVotes(items){
  lastVotes=items;
  $('upNextBox').style.display=inRoom()?'block':'none';
  const mine=myId();
  $('upNext').innerHTML=items.length?items.map(i=>{
    const on=i.by.includes(mine);
    return '<li><span>'+esc(i.name)+(i.sug?' <span class="sug">watchlist</span>':'')+'</span><span class="n">'+i.n+'</span><button class="ghost small'+(on?' on':'')+'" data-v="'+esc(i.key)+'">'+(on?'Voted':'Vote')+'</button>'+(isHost&&i.sug?'<button class="ghost small" data-vdel="'+esc(i.key)+'">Remove</button>':'')+'</li>';
  }).join(''):'<li><span class="hint" style="margin:0">Nothing lined up yet. Suggest something below.</span></li>';
}
function castVote(voter,key){
  if(!voteItems().some(i=>i.key===key))return;
  if(votes.get(voter)===key)votes.delete(voter);else votes.set(voter,key);
  pushVotes();
}
function addSuggestion(name,by){
  name=String(name||'').trim().slice(0,60);if(!name)return;
  const low=name.toLowerCase();
  if(suggestions.some(n=>n.toLowerCase()===low)||queue.some(q=>q.name.toLowerCase()===low))return toast('Already on the list');
  if(suggestions.length>=30)suggestions.shift();
  suggestions.push(name);saveWatchlist();addChat('',by+' added '+name+' to the watchlist',true);broadcast({t:'chat',n:'Couchcast',m:by+' added '+name+' to the watchlist'});pushVotes();
}
function bestNext(){
  let bi=0,bn=-1;
  queue.forEach((q,i)=>{let n=0;for(const k of votes.values())if(k==='q:'+q.name)n++;if(n>bn){bn=n;bi=i}});
  return bi;
}

/* ---------- friends pass the stream on, and quality that adapts per friend ---------- */
let peopleT=null;function pushPeopleSoon(){clearTimeout(peopleT);peopleT=setTimeout(pushPeople,400)}
function kidsOf(pid){return [...conns.entries()].filter(([,c])=>c.parent===pid).map(([id])=>id)}
function directCount(except){let n=0;for(const [id,c] of conns)if(id!==except&&c.name!=='…'&&!c.parent&&c.call)n++;return n}
function assignViewer(id){
  const c=conns.get(id);if(!c||!stream||c.name==='…'||c.remote)return;
  const max=+$('maxDirect').value||3;
  if(directCount(id)<max){c.parent=null;callViewer(id);pushPeopleSoon();return}
  const cands=[...conns.entries()].filter(([pid,p])=>pid!==id&&p.name!=='…'&&!p.parent&&p.call&&p.helper&&kidsOf(pid).length<2&&(p.lvl||0)<2)
    .sort((a,b)=>kidsOf(a[0]).length-kidsOf(b[0]).length);
  if(!cands.length){c.parent=null;callViewer(id);pushPeopleSoon();return}
  const [pid,p]=cands[0];
  if(c.call){c.call.close();c.call=null}
  c.parent=pid;p.conn.send({t:'relayTo',id});pushPeopleSoon();
}
function assignAll(){
  broadcast({t:'relayStopAll'});
  for(const c of conns.values()){if(c.call){c.call.close();c.call=null}c.parent=null}
  for(const id of conns.keys())assignViewer(id);
}
function forward(id){
  const old=relayKids.get(id);if(old&&old.call)try{old.call.close()}catch(e){}
  if(!peer||!inStream||!inStream.getVideoTracks().some(t=>t.readyState==='live')){relayKids.set(id,{call:null});return}
  const call=peer.call(id,inStream,{sdpTransform:preferCodec,metadata:{kind:'movie',via:myName}});
  relayKids.set(id,{call});
  if(call)adaptCall(call,{max:10});
}
function forwardAll(){for(const id of relayKids.keys())forward(id)}
function stopForwarding(){for(const o of relayKids.values())try{o.call&&o.call.close()}catch(e){}relayKids.clear()}
const LV=[{s:1},{s:1.5,b:8},{s:2,b:4},{s:3,b:2}];
function adaptCall(call,o){
  const st={lvl:0,goodSince:0,last:performance.now(),q:''};call._q=st;
  const iv=setInterval(async()=>{
    const pc=call.peerConnection;
    if(!pc||pc.connectionState==='closed'||call.closed){clearInterval(iv);return}
    if(pc.connectionState!=='connected')return;
    let loss=0,avail=0,lim='',h=0;
    try{const r=await pc.getStats();r.forEach(x=>{
      if(x.type==='remote-inbound-rtp'&&x.kind==='video')loss=x.fractionLost||0;
      if(x.type==='candidate-pair'&&x.nominated&&x.state==='succeeded'&&x.availableOutgoingBitrate)avail=x.availableOutgoingBitrate;
      if(x.type==='outbound-rtp'&&x.kind==='video'){lim=x.qualityLimitationReason||'';h=x.frameHeight||h}
    })}catch(e){return}
    const max=(typeof o.max==='function'?o.max():o.max)*1e6,cap=l=>Math.min(max,(LV[l].b||1e9)*1e6);
    const now=performance.now();
    const bad=loss>.05||(lim==='bandwidth'&&avail&&avail<cap(st.lvl)*.7);
    const good=loss<.01&&(!avail||st.lvl===0||avail>cap(st.lvl-1)*1.3);
    let lvl=st.lvl;
    if(bad){st.goodSince=0;if(now-st.last>6000&&lvl<LV.length-1)lvl++}
    else if(good){if(!st.goodSince)st.goodSince=now;else if(lvl>0&&now-st.goodSince>20000){lvl--;st.goodSince=now}}
    else st.goodSince=0;
    st.q=h?(h>=2000?'4K':h>=1400?'1440p':h>=1000?'1080p':h>=700?'720p':h>=460?'480p':h+'p'):'';
    if(lvl!==st.lvl){st.lvl=lvl;st.last=now;await applyLevel(call,cap(lvl),lvl)}
    if(o.onq)o.onq(st);
  },3000);
}
async function applyLevel(call,bps,lvl){
  const pc=call.peerConnection,s=pc&&pc.getSenders().find(x=>x.track&&x.track.kind==='video');if(!s)return;
  const p=s.getParameters();if(!p.encodings||!p.encodings.length)p.encodings=[{}];
  p.encodings[0].maxBitrate=bps;p.encodings[0].scaleResolutionDownBy=LV[lvl].s;
  p.degradationPreference=lvl?'balanced':'maintain-resolution';
  try{await s.setParameters(p)}catch(e){}
}

/* ---------- is everyone's file the same? ---------- */
async function fingerprint(f){
  try{
    const MB=1<<20,buf=await new Blob([f.slice(0,MB),f.slice(Math.max(0,f.size-MB))]).arrayBuffer();
    const h=new Uint8Array(await crypto.subtle.digest('SHA-256',buf));
    return f.size+'-'+[...h.slice(0,8)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }catch(e){return String(f.size)}
}
function compareFiles(){
  if(isHost||mode!=='sync'||!hostFi||!myFp)return;
  const close=remote.d&&vid.duration&&Math.abs(vid.duration-remote.d)<2;
  const v=myFp===hostFi.fp?'same':close?'close':'diff';
  const m=$('matchMsg');
  m.className='hint '+(v==='diff'?'match-bad':'match-ok');
  m.textContent=v==='same'?'Same file as the host.':v==='close'?'A different copy, but the same length. It should stay in step.':'This is a different version from the host\'s (different length). It will drift. Try another copy.';
  if(hostConn&&hostConn.open)hostConn.send({t:'match',v});
}

/* ---------- subtitles: zips and a finder ---------- */
const LANGS=[['en','eng','English'],['hi','hin','Hindi'],['pa','pan','Punjabi'],['ur','urd','Urdu'],['ta','tam','Tamil'],['te','tel','Telugu'],['bn','ben','Bengali'],['ml','mal','Malayalam'],['mr','mar','Marathi'],['es','spa','Spanish'],['fr','fre','French'],['de','ger','German'],['ar','ara','Arabic'],['ja','jpn','Japanese'],['ko','kor','Korean']];
function cleanTitle(t){return String(t||'').replace(/[._]+/g,' ').replace(/\((19|20)\d{2}\)|\b(19|20)\d{2}\b.*$/,'').replace(/\b(2160p|1080p|720p|480p|4k|x264|x265|h264|h265|hevc|bluray|brrip|web-?dl|webrip|hdr|10bit|aac|ddp?5 ?1)\b.*$/i,'').replace(/\s+/g,' ').trim()}
function loadSubText(name,text){
  cues=parseSubs(text);
  if(cues.length){toast(cues.length+' subtitle lines loaded');addChat('','Subtitles added: '+name,true)}else toast('No subtitles found in that file.');
}
let jszipP=null;
function loadJSZip(){if(!jszipP)jszipP=new Promise(r=>{if(window.JSZip)return r();const sc=document.createElement('script');sc.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';sc.onload=r;sc.onerror=r;document.head.appendChild(sc)});return jszipP}
async function readSubFile(f){
  if(!f)return;
  if(/\.zip$/i.test(f.name)){
    await loadJSZip();if(!window.JSZip)return toast('Could not open the zip.');
    try{const z=await JSZip.loadAsync(f);const e=Object.values(z.files).find(x=>/\.(srt|vtt)$/i.test(x.name));if(!e)return toast('No .srt or .vtt inside that zip.');loadSubText(e.name,await e.async('string'))}
    catch(e){toast('Could not open the zip.')}
    return;
  }
  loadSubText(f.name,await f.text());
}
function subFinder(){
  const key=store.get('cc-oskey')||'',lang=store.get('cc-sublang')||'en';
  showModal('<h2>Find subtitles</h2>'+
    '<label for="sfQ">Movie name</label><input id="sfQ" type="text" value="'+esc(cleanTitle(title))+'">'+
    '<label for="sfL">Language</label><select id="sfL">'+LANGS.map(l=>'<option value="'+l[0]+'"'+(l[0]===lang?' selected':'')+'>'+l[2]+'</option>').join('')+'</select>'+
    '<div class="row" style="margin-top:12px"><button id="sfGo">Search</button></div>'+
    '<ul class="subres" id="sfRes"></ul><p class="hint" id="sfMsg"></p>'+
    '<details'+(key?'':' open')+'><summary>One-click search (free OpenSubtitles key)</summary><p class="hint">Make a free account at opensubtitles.com, open <a href="https://www.opensubtitles.com/en/consumers" target="_blank" rel="noopener">API consumers</a>, create a key and paste it here. It stays on this device only.</p>'+
    '<div class="row" style="flex-wrap:nowrap"><input id="sfKey" type="password" value="'+esc(key)+'" placeholder="API key" style="flex:1" autocomplete="off"><button class="ghost" id="sfSave">Save</button></div></details>');
  $('sfSave').onclick=()=>{const k=$('sfKey').value.trim();if(k)store.set('cc-oskey',k);else store.del('cc-oskey');toast(k?'Key saved on this device':'Key removed')};
  $('sfGo').onclick=()=>subSearch();
  $('sfQ').onkeydown=e=>{if(e.key==='Enter')subSearch()};
}
async function subSearch(){
  const q=$('sfQ').value.trim(),lang=$('sfL').value,l3=(LANGS.find(l=>l[0]===lang)||LANGS[0])[1];store.set('cc-sublang',lang);
  if(!q)return;
  const key=store.get('cc-oskey')||'';
  const links='<a href="https://www.opensubtitles.org/en/search2/sublanguageid-'+l3+'/moviename-'+encodeURIComponent(q)+'" target="_blank" rel="noopener">OpenSubtitles</a> or <a href="https://subdl.com/search/'+encodeURIComponent(q)+'" target="_blank" rel="noopener">SubDL</a>';
  if(!key){$('sfRes').innerHTML='';$('sfMsg').innerHTML='Search on '+links+', download the subtitle, then drop the .srt or .zip onto the player. For one-click search, add a free key below.';return}
  $('sfMsg').textContent='Searching…';$('sfRes').innerHTML='';
  try{
    const r=await fetch('https://api.opensubtitles.com/api/v1/subtitles?query='+encodeURIComponent(q)+'&languages='+lang+'&order_by=download_count',{headers:{'Api-Key':key}});
    const j=await r.json();
    if(!r.ok)throw new Error(j&&j.message||('error '+r.status));
    const items=(j.data||[]).filter(d=>d.attributes&&d.attributes.files&&d.attributes.files.length).slice(0,15);
    if(!items.length){$('sfMsg').innerHTML='Nothing found. Try a shorter name, or search on '+links+'.';return}
    $('sfMsg').textContent='Pick one. The most downloaded are first.';
    $('sfRes').innerHTML=items.map((d,i)=>{const a=d.attributes;return '<li><span>'+esc(a.release||(a.feature_details&&a.feature_details.title)||'Subtitle')+' <span class="hint">('+(a.download_count||0)+' downloads)</span></span><button class="ghost small" data-sf="'+i+'">Use</button></li>'}).join('');
    $('sfRes').onclick=async e=>{
      const b=e.target.closest('button[data-sf]');if(!b)return;
      const a=items[+b.dataset.sf].attributes;b.textContent='Loading…';b.disabled=true;
      try{
        const d=await fetch('https://api.opensubtitles.com/api/v1/download',{method:'POST',headers:{'Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify({file_id:a.files[0].file_id,sub_format:'srt'})});
        const dj=await d.json();if(!d.ok||!dj.link)throw new Error(dj&&dj.message||'download refused');
        try{const t=await (await fetch(dj.link)).text();loadSubText(a.release||q,t);$('modal').style.display='none'}
        catch(x){$('sfMsg').innerHTML='Got it, but the browser can\'t open it directly. <a href="'+esc(dj.link)+'" target="_blank" rel="noopener">Download it</a>, then drop it onto the player.'}
      }catch(x){$('sfMsg').textContent='Could not download: '+x.message;b.textContent='Use';b.disabled=false}
    };
  }catch(e){$('sfMsg').innerHTML='Search failed ('+esc(e.message)+'). Check the key, or search on '+links+'.'}
}

/* ---------- movie nights ---------- */
const packNight=n=>b64e({c:n.c,t:n.t,m:n.m,h:n.h});
function nightLink(n){const r=currentRelay();return location.href.split('#')[0].split('?')[0]+'#NIGHT~'+packNight(n)+(r&&r.src!=='site'?'~'+packRelay(r.t):'')}
function myNights(){try{return (JSON.parse(store.get('cc-nights')||'[]')||[]).filter(n=>n&&n.t>Date.now()-12*3600e3)}catch(e){return []}}
function renderNights(){
  const ns=myNights().sort((a,b)=>a.t-b.t);
  $('nights').innerHTML=ns.map(n=>'<li><span>'+esc(n.m)+' · '+esc(new Date(n.t).toLocaleString([],{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}))+'</span><button class="ghost small" data-n="copy" data-c="'+n.c+'">Copy link</button><button class="small" data-n="start" data-c="'+n.c+'">Start room</button><button class="ghost small" data-n="del" data-c="'+n.c+'" aria-label="Remove">Remove</button></li>').join('');
}
function planNight(){
  const t=new Date($('planWhen').value).getTime(),m=$('planTitle').value.trim()||'Movie night';
  if(!t||t<Date.now()-60000){$('planMsg').textContent='Pick a time in the future.';return}
  getName();
  const n={c:newCode(),t,m,h:myName};
  const ns=myNights();ns.push(n);store.set('cc-nights',JSON.stringify(ns));renderNights();
  copy(nightLink(n),'Invite copied. Send it to your friends.');
  $('planMsg').textContent='Done. On the night, press Start room here (or open your own invite link).';
}
function calDates(n){const f=d=>new Date(d).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');return f(n.t)+'/'+f(n.t+3*3600e3)}
function showNight(){
  if(!night)return;
  $('lobby').classList.add('nightmode');
  $('nightTitle').textContent=night.m;
  $('nightWhen').textContent=new Date(night.t).toLocaleString([],{weekday:'long',day:'numeric',month:'long',hour:'numeric',minute:'2-digit'})+(night.h?' · hosted by '+night.h:'');
  $('joinCode').value=night.c;
  const mine=myNights().some(n=>n.c===night.c);
  if(mine){$('nightJoin').textContent='Start the room (you\'re the host)'}
  let lastTry=0;
  const draw=()=>{
    const left=night.t-Date.now();
    if(left>0){
      const d=Math.floor(left/864e5),h=Math.floor(left%864e5/36e5),m=Math.floor(left%36e5/6e4),sx=Math.floor(left%6e4/1e3);
      $('nightCd').innerHTML=(d?'<div><b>'+d+'</b><span>days</span></div>':'')+'<div><b>'+h+'</b><span>hours</span></div><div><b>'+String(m).padStart(2,'0')+'</b><span>minutes</span></div><div><b>'+String(sx).padStart(2,'0')+'</b><span>seconds</span></div>';
    }else $('nightCd').innerHTML='<div><b>Now</b><span>it\'s time</span></div>';
    if(!mine&&$('nightAuto').checked&&!inRoom()&&left<60000&&Date.now()-lastTry>20000&&$('name').value.trim()){
      lastTry=Date.now();$('nightMsg').textContent='Looking for the room…';startJoin({code:night.c});
    }
  };
  draw();setInterval(()=>{if(!inRoom())draw()},1000);
  $('nightJoin').onclick=()=>{
    if(!$('name').value.trim()){$('name').focus();$('nightMsg').textContent='Type your name first.';return}
    if(mine)startHost({code:night.c,night:true});else{lastTry=Date.now();startJoin({code:night.c})}
  };
  $('nightCal').onclick=()=>{window.open('https://calendar.google.com/calendar/render?action=TEMPLATE&text='+encodeURIComponent(night.m+' (Couchcast)')+'&dates='+calDates(night)+'&details='+encodeURIComponent('Join here: '+location.href),'_blank','noopener')};
  $('nightIcs').onclick=()=>{
    const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Couchcast//EN','BEGIN:VEVENT','UID:'+night.c+'@couchcast','DTSTAMP:'+calDates({t:Date.now()}).split('/')[0],'DTSTART:'+calDates(night).split('/')[0],'DTEND:'+calDates(night).split('/')[1],'SUMMARY:'+night.m.replace(/[,;\n]/g,' ')+' (Couchcast)','DESCRIPTION:Join here: '+location.href,'END:VEVENT','END:VCALENDAR'].join('\r\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([ics],{type:'text/calendar'}));a.download='movie-night.ics';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
  };
}

/* ---------- "Test my connection" ---------- */
function gatherCands(servers,policy,ms){
  return new Promise(res=>{
    let pc;try{pc=new RTCPeerConnection({iceServers:servers,iceTransportPolicy:policy||'all'})}catch(e){return res([])}
    const out=[];let done=false;const fin=()=>{if(done)return;done=true;try{pc.close()}catch(e){}res(out)};
    pc.onicecandidate=e=>{if(!e.candidate)return fin();out.push({type:e.candidate.type,port:e.candidate.port,rport:e.candidate.relatedPort,addr:e.candidate.address,proto:e.candidate.protocol})};
    pc.createDataChannel('t');pc.createOffer().then(o=>pc.setLocalDescription(o)).catch(fin);
    setTimeout(fin,ms||6000);
  });
}
async function connTest(){
  showModal('<h2>Connection check</h2><ul class="subres ct" id="ctList"></ul><p class="hint" id="ctSum">Checking… this takes about 15 seconds.</p>');
  const add=(k,v,cls)=>{const li=document.createElement('li');li.innerHTML='<span><b>'+esc(k)+'</b> <span class="'+cls+'">'+esc(v)+'</span></span>';$('ctList').appendChild(li)};
  let direct='unknown',relay='none',speed=0;
  const c1=await gatherCands([{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}],'all',6000);
  const sr=c1.filter(c=>c.type==='srflx'&&c.proto==='udp');
  if(!sr.length){add('Direct connections:','Blocked on this network. You will need the relay.','bad');direct='blocked'}
  else{
    const byBase={};sr.forEach(c=>{(byBase[c.rport]=byBase[c.rport]||new Set()).add(c.port)});
    const sym=Object.values(byBase).some(p=>p.size>1);
    if(sym){add('Direct connections:','Strict network. Direct connections often fail; the relay will be used.','warn');direct='strict'}
    else{add('Direct connections:','Should work.','ok');direct='ok'}
  }
  const r=currentRelay();
  if(!r&&!turnApi())add('Relay:','Not set up on this device. Open an invite link from your host, or add one under Connection settings.','warn');
  else{
    const servers=(iceList||await iceReady).filter(s=>String(s.urls).includes('turn'));
    const c2=await gatherCands(servers,'relay',8000);
    if(c2.some(c=>c.type==='relay')){add('Relay:','Working.','ok');relay='ok'}else{add('Relay:','Set up, but it could not be reached from here.','bad');relay='bad'}
  }
  try{
    const t0=performance.now(),res=await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js?cc='+Date.now(),{cache:'no-store'});
    const b=await res.arrayBuffer(),sec=(performance.now()-t0)/1000;speed=b.byteLength*8/sec/1e6;
  }catch(e){speed=navigator.connection&&navigator.connection.downlink||0}
  if(speed)add('Download speed:','About '+speed.toFixed(1)+' Mbps ('+(speed>=25?'enough for 4K':speed>=8?'good for 1080p':speed>=4?'fine for 720p':'low; expect lower quality')+').',speed>=8?'ok':speed>=4?'warn':'bad');
  else add('Download speed:','Could not measure.','warn');
  const good=direct==='ok'||relay==='ok';
  $('ctSum').innerHTML=(good?'<b class="ok">You should be able to join.</b> ':'<b class="bad">You may not be able to join from this network.</b> Ask your host for an invite link (it brings the relay), or try another Wi-Fi. ')+'Hosting also needs good <em>upload</em> speed (about 8 Mbps per friend for 1080p), which this check can\'t measure.';
}

/* ---------- permanent room link ---------- */
function permCode(){let c=store.get('cc-myroom');if(!/^[A-Z0-9]{6}$/.test(c||'')){c=newCode();store.set('cc-myroom',c)}return c}
function permLinkFor(c){const r=currentRelay();return location.href.split('#')[0].split('?')[0]+'#'+c+(r&&r.src!=='site'?'~'+packRelay(r.t):'')}
function showPerm(){
  const on=$('permRoom').checked;$('permInfo').style.display=on?'block':'none';
  if(on){const c=permCode();$('permLink').textContent='Your room: '+c+' (same link every time)'}
}

/* ---------- phone remote ---------- */
const remoteTokens=new Map();   // host: token -> device id it controls
function remoteLink(){
  if(!myRemoteToken)myRemoteToken=Math.random().toString(36).slice(2,12);
  if(isHost)remoteTokens.set(myRemoteToken,myId());else if(hostConn&&hostConn.open)hostConn.send({t:'pairtoken',k:myRemoteToken});
  const r=currentRelay();
  return location.href.split('#')[0].split('?')[0]+'#REMOTE~'+b64e({c:code,k:myRemoteToken,n:myName})+(r&&r.src!=='site'?'~'+packRelay(r.t):'');
}
let qrP=null;
function loadQR(){if(!qrP)qrP=new Promise(r=>{if(window.qrcode)return r();const sc=document.createElement('script');sc.src='https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';sc.onload=r;sc.onerror=r;document.head.appendChild(sc)});return qrP}
async function showRemote(){
  const l=remoteLink();
  showModal('<h2>Use your phone as a remote</h2><p class="hint">Scan this with your phone camera. It controls <b>this screen</b>: play, pause, skip, volume, subtitles and reactions.</p><div id="qrBox">Loading…</div><p class="hint" style="overflow-wrap:anywhere">Or open this on your phone: <a href="'+esc(l)+'" target="_blank" rel="noopener">remote link</a> <button class="ghost small" id="rmCopy">Copy</button></p>');
  $('rmCopy').onclick=()=>copy(l,'Remote link copied');
  await loadQR();
  if(!window.qrcode){$('qrBox').textContent='QR code could not load. Use the link instead.';return}
  try{const q=window.qrcode(0,'M');q.addData(l);q.make();$('qrBox').innerHTML=q.createSvgTag({cellSize:4,margin:2,scalable:true})}catch(e){$('qrBox').textContent='Use the link instead.'}
}
function startRemoteMode(){
  document.body.classList.add('remote');
  myName=(store.get('cc-name')||'Phone').slice(0,24);
  const go=async()=>{
    await iceReady;
    peer=makePeer();
    peer.on('open',()=>{
      hostConn=peer.connect(PREFIX+remoteMode.c,{reliable:true});
      hostConn.on('open',()=>{hostConn.send({t:'join',n:(remoteMode.n||myName)+' remote',remote:true,k:remoteMode.k});$('rStatus').textContent='Connected. Controlling '+(remoteMode.n||'the screen')+'.'});
      hostConn.on('data',d=>{
        if(!d||typeof d!=='object')return;
        if(d.t==='hello'||d.t==='title'){$('rTitle').textContent=d.title||'Nothing playing yet'}
        if(d.t==='sync'){remote={p:!!d.p,c:+d.c||0,d:+d.d||0,at:performance.now(),live:!!d.live};$('rPlay').textContent=remote.p?'Play':'Pause'}
        if(d.t==='denied'){$('rStatus').textContent='This remote link has expired. Make a new one on the screen.';leaving=true}
      });
      hostConn.on('close',()=>{if(!leaving){$('rStatus').textContent='Disconnected. Reconnecting…';setTimeout(()=>{try{peer.destroy()}catch(e){}go()},3000)}});
    });
    peer.on('error',e=>{if(e.type==='peer-unavailable'){$('rStatus').textContent='The room is not open right now. Retrying…';setTimeout(()=>{try{peer.destroy()}catch(x){}go()},5000)}});
  };
  go();
  setInterval(()=>{if(remote.live){$('rTime').textContent='LIVE';return}const c=remote.c+(remote.p?0:(performance.now()-remote.at)/1000);$('rTime').textContent=fmt(c)+(remote.d?' / '+fmt(remote.d):'')},500);
  document.querySelectorAll('[data-rc]').forEach(b=>b.onclick=()=>{if(hostConn&&hostConn.open)hostConn.send({t:'rc',a:b.dataset.rc})});
  document.querySelectorAll('[data-re]').forEach(b=>b.onclick=()=>{if(hostConn&&hostConn.open)hostConn.send({t:'rc',a:'react',e:b.dataset.re})});
}
function localRemoteAction(a){
  if(a==='vol+'||a==='vol-'){me.vol=Math.max(0,Math.min(1,me.vol+(a==='vol+'?.1:-.1)));me.muted=false;$('vol').value=me.vol;applyVol();toast('Volume '+Math.round(me.vol*100)+'%')}
  if(a==='mute')$('muteBtn').click();
  if(a==='cc')$('ccBtn').click();
}
function hostRemote(c,d){
  const a=String(d.a||''),target=c.for;
  if(a==='react'){const e=String(d.e||'').slice(0,4);noteMoment(e);popReaction(e);seatPop(target,e);broadcast({t:'react',e,id:target});return}
  if(['toggle','back','fwd'].includes(a)){
    if(!(target===myId()||allowCtl)||!M.ok()||M.live())return;
    if(a==='toggle'){M.paused()?M.play():M.pause()}
    else M.seek(Math.max(0,Math.min(M.dur()||0,M.time()+(a==='fwd'?10:-10))));
    return;
  }
  if(target===myId())localRemoteAction(a);
  else{const t=conns.get(target);if(t)try{t.conn.send({t:'rcx',a})}catch(e){}}
}

/* ---------- chat while in fullscreen ---------- */
function sendChat(m,sp){
  m=String(m||'').trim();if(!m)return;sp=!!sp;
  if(isHost){addChat(myName,m,false,myLook.av,myLook.col,sp);broadcast({t:'chat',n:myName,m,av:myLook.av,col:myLook.col,sp})}
  else if(hostConn&&hostConn.open)hostConn.send({t:'chat',m,sp});
  else toast('Not connected right now.');
}
function openFsChat(){$('fsChat').style.display='flex';$('fsMsg').focus();wake()}
function closeFsChat(){$('fsChat').style.display='none';$('fsMsg').blur()}

/* ---------- picture-in-picture ---------- */
async function togglePip(){
  try{
    if(document.pictureInPictureElement){await document.exitPictureInPicture();return}
    if(mode==='link'&&link&&link.kind==='yt')return toast('YouTube videos can\'t pop out here.');
    const el=mode==='link'?lvid:vid;
    if(!el.srcObject&&!el.currentSrc)return toast('Nothing playing yet.');
    await el.requestPictureInPicture();
  }catch(e){toast('Picture-in-picture is not available here.')}
}

/* ---------- best moments (where the reactions happened) ---------- */
let moments=[],momentsList=[],momT=null;
function noteMoment(e){
  if(!isHost||!M.ok()||M.live())return;
  moments.push({t:M.time(),e});
  clearTimeout(momT);momT=setTimeout(pushMoments,800);
}
function topMoments(){
  const b={};for(const m of moments){const k=Math.floor(m.t/20);const x=(b[k]=b[k]||{sum:0,n:0,e:{}});x.n++;x.sum+=m.t;x.e[m.e]=(x.e[m.e]||0)+1}
  // jump to a few seconds before the reactions, so the scene plays into the laugh
  return Object.values(b).filter(x=>x.n>=2).sort((x,y)=>y.n-x.n).slice(0,3).map(x=>({t:Math.max(0,Math.floor(x.sum/x.n)-6),n:x.n,e:Object.entries(x.e).sort((p,q)=>q[1]-p[1])[0][0]})).sort((x,y)=>x.t-y.t);
}
function pushMoments(){if(!isHost)return;momentsList=topMoments();renderMoments();broadcast({t:'moments',list:momentsList})}
function renderMoments(){
  $('momentsBox').style.display=momentsList.length?'block':'none';
  $('moments').innerHTML=momentsList.map(m=>'<li><span class="e">'+esc(m.e)+'</span><span>'+fmt(m.t)+' · '+m.n+'×</span><button class="ghost small" data-mt="'+m.t+'"'+(canControl()?'':' disabled')+'>Jump</button></li>').join('');
}
function resetMoments(){moments=[];momentsList=[];renderMoments();if(isHost)broadcast({t:'moments',list:[]})}

/* ---------- skip intro / credits, per series ---------- */
let marks=null;
function seriesKey(t){return String(t||'').replace(/[._]+/g,' ').replace(/\b(s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{2,3}|episode\s*\d+|ep\s*\d+)\b.*$/i,'').replace(/\s+/g,' ').trim().toLowerCase()}
function loadMarks(){
  if(!isHost)return;
  const k=seriesKey(title);marks=null;
  if(k)try{marks=JSON.parse(store.get('cc-marks-'+k)||'null')}catch(e){}
  $('marksInfo').textContent=marks?'Saved for "'+k+'": '+[marks.is!=null?'intro '+fmt(marks.is)+'–'+(marks.ie!=null?fmt(marks.ie):'?'):'',marks.cs!=null?'credits from '+fmt(marks.cs):''].filter(Boolean).join(', '):'';
  broadcast({t:'marks',m:marks});
}
function setMark(which){
  if(!isHost||!M.ok()||M.live()||!title)return toast('Play the episode first.');
  const k=seriesKey(title);marks=marks||{};
  if(which==='clear'){marks=null;store.del('cc-marks-'+k);loadMarks();return}
  marks[which]=Math.floor(M.time());
  store.set('cc-marks-'+k,JSON.stringify(marks));loadMarks();toast('Saved for every episode of "'+k+'"');
}
function skipTick(){
  const b=$('skipBtn');
  if(!marks||!inRoom()||M.live()||!canControl()){b.style.display='none';return}
  const t=curTime();let label='';
  if(marks.ie!=null&&t>=(marks.is||0)&&t<marks.ie-1)label='Skip intro';
  else if(marks.cs!=null&&t>=marks.cs&&isHost&&queue.length)label='Next episode';
  if(label){b.textContent=label;b.style.display='block'}else b.style.display='none';
}

/* ---------- watchlist (suggestions kept on the host's device) ---------- */
function saveWatchlist(){if(isHost)store.set('cc-watchlist',JSON.stringify(suggestions.slice(-30)))}
function loadWatchlist(){try{const w=JSON.parse(store.get('cc-watchlist')||'[]');if(Array.isArray(w))suggestions=w.map(String).slice(-30)}catch(e){}}
function watched(name){
  const low=String(name||'').toLowerCase();const n=suggestions.length;
  suggestions=suggestions.filter(x=>x.toLowerCase()!==low);
  if(suggestions.length!==n){for(const [v,k] of [...votes])if(k==='s:'+name)votes.delete(v);saveWatchlist();pushVotes()}
}

/* ---------- Hindi & Punjabi ---------- */
const I18N={
'Install app':['ऐप इंस्टॉल करें','ਐਪ ਇੰਸਟਾਲ ਕਰੋ'],
'Leave room':['कमरा छोड़ें','ਕਮਰਾ ਛੱਡੋ'],
'Movie night, no matter where everyone is.':['मूवी नाइट, चाहे सब कहीं भी हों।','ਮੂਵੀ ਨਾਈਟ, ਭਾਵੇਂ ਸਾਰੇ ਕਿਤੇ ਵੀ ਹੋਣ।'],
'One friend hosts and plays a movie from their computer. Everyone else joins with a code or link and watches in sync, with voice chat, reactions and subtitles. Video goes straight between your devices: no account, no upload, free.':['एक दोस्त होस्ट बनकर अपने कंप्यूटर से फ़िल्म चलाता है। बाकी सब कोड या लिंक से जुड़ते हैं और साथ-साथ देखते हैं, वॉइस चैट, रिएक्शन और सबटाइटल के साथ। वीडियो सीधे आपके डिवाइसों के बीच जाता है: न अकाउंट, न अपलोड, बिल्कुल मुफ़्त।','ਇੱਕ ਦੋਸਤ ਹੋਸਟ ਬਣ ਕੇ ਆਪਣੇ ਕੰਪਿਊਟਰ ਤੋਂ ਫ਼ਿਲਮ ਚਲਾਉਂਦਾ ਹੈ। ਬਾਕੀ ਸਾਰੇ ਕੋਡ ਜਾਂ ਲਿੰਕ ਨਾਲ ਜੁੜਦੇ ਹਨ ਅਤੇ ਇਕੱਠੇ ਦੇਖਦੇ ਹਨ, ਵੌਇਸ ਚੈਟ, ਰਿਐਕਸ਼ਨ ਅਤੇ ਸਬਟਾਈਟਲ ਨਾਲ। ਵੀਡੀਓ ਸਿੱਧਾ ਤੁਹਾਡੇ ਡਿਵਾਈਸਾਂ ਵਿਚਕਾਰ ਜਾਂਦਾ ਹੈ: ਨਾ ਖਾਤਾ, ਨਾ ਅੱਪਲੋਡ, ਬਿਲਕੁਲ ਮੁਫ਼ਤ।'],
'Your name':['आपका नाम','ਤੁਹਾਡਾ ਨਾਮ'],
'Host a room':['कमरा होस्ट करें','ਕਮਰਾ ਹੋਸਟ ਕਰੋ'],
'You pick the movie and control playback. Best on Chrome or Edge on a computer.':['फ़िल्म आप चुनते हैं और चलाना-रोकना आपके हाथ में। कंप्यूटर पर Chrome या Edge में सबसे अच्छा चलता है।','ਫ਼ਿਲਮ ਤੁਸੀਂ ਚੁਣਦੇ ਹੋ ਅਤੇ ਚਲਾਉਣਾ-ਰੋਕਣਾ ਤੁਹਾਡੇ ਹੱਥ। ਕੰਪਿਊਟਰ ਤੇ Chrome ਜਾਂ Edge ਵਿੱਚ ਸਭ ਤੋਂ ਵਧੀਆ ਚੱਲਦਾ ਹੈ।'],
'Create room':['कमरा बनाएँ','ਕਮਰਾ ਬਣਾਓ'],
'Use my permanent room link':['मेरा स्थायी कमरा लिंक इस्तेमाल करें','ਮੇਰਾ ਪੱਕਾ ਕਮਰਾ ਲਿੰਕ ਵਰਤੋ'],
'Copy':['कॉपी','ਕਾਪੀ'],
'Join a room':['कमरे में जुड़ें','ਕਮਰੇ ਵਿੱਚ ਜੁੜੋ'],
'Type the code your host sent, or just open their invite link.':['होस्ट का भेजा कोड लिखें, या बस उनका इनवाइट लिंक खोलें।','ਹੋਸਟ ਦਾ ਭੇਜਿਆ ਕੋਡ ਲਿਖੋ, ਜਾਂ ਬੱਸ ਉਹਨਾਂ ਦਾ ਸੱਦਾ ਲਿੰਕ ਖੋਲ੍ਹੋ।'],
'Join':['जुड़ें','ਜੁੜੋ'],
'Room password (only if the host set one)':['कमरे का पासवर्ड (सिर्फ़ अगर होस्ट ने रखा हो)','ਕਮਰੇ ਦਾ ਪਾਸਵਰਡ (ਸਿਰਫ਼ ਜੇ ਹੋਸਟ ਨੇ ਰੱਖਿਆ ਹੋਵੇ)'],
'Leave empty if none':['न हो तो खाली छोड़ें','ਨਾ ਹੋਵੇ ਤਾਂ ਖਾਲੀ ਛੱਡੋ'],
'Plan a movie night':['मूवी नाइट प्लान करें','ਮੂਵੀ ਨਾਈਟ ਪਲਾਨ ਕਰੋ'],
'Pick a time and share a link with a countdown. Friends can add it to their calendar.':['समय चुनें और काउंटडाउन वाला लिंक भेजें। दोस्त इसे अपने कैलेंडर में जोड़ सकते हैं।','ਸਮਾਂ ਚੁਣੋ ਅਤੇ ਕਾਊਂਟਡਾਊਨ ਵਾਲਾ ਲਿੰਕ ਭੇਜੋ। ਦੋਸਤ ਇਸਨੂੰ ਆਪਣੇ ਕੈਲੰਡਰ ਵਿੱਚ ਜੋੜ ਸਕਦੇ ਹਨ।'],
'What are you watching?':['क्या देख रहे हैं?','ਕੀ ਦੇਖ ਰਹੇ ਹੋ?'],
'When':['कब','ਕਦੋਂ'],
'Create invite':['इनवाइट बनाएँ','ਸੱਦਾ ਬਣਾਓ'],
'Test my connection':['मेरा कनेक्शन जाँचें','ਮੇਰਾ ਕਨੈਕਸ਼ਨ ਜਾਂਚੋ'],
'Check before movie night whether you can connect and how fast your internet is.':['मूवी नाइट से पहले देख लें कि आप जुड़ पाएँगे या नहीं और इंटरनेट कितना तेज़ है।','ਮੂਵੀ ਨਾਈਟ ਤੋਂ ਪਹਿਲਾਂ ਦੇਖ ਲਓ ਕਿ ਤੁਸੀਂ ਜੁੜ ਸਕੋਗੇ ਜਾਂ ਨਹੀਂ ਅਤੇ ਇੰਟਰਨੈੱਟ ਕਿੰਨਾ ਤੇਜ਼ ਹੈ।'],
"Connection settings (if a friend can't connect)":['कनेक्शन सेटिंग (अगर कोई दोस्त जुड़ न पाए)','ਕਨੈਕਸ਼ਨ ਸੈਟਿੰਗ (ਜੇ ਕੋਈ ਦੋਸਤ ਜੁੜ ਨਾ ਸਕੇ)'],
'Save':['सेव करें','ਸੇਵ ਕਰੋ'],
"You're invited to a movie night":['आपको मूवी नाइट पर बुलाया गया है','ਤੁਹਾਨੂੰ ਮੂਵੀ ਨਾਈਟ ਤੇ ਸੱਦਿਆ ਗਿਆ ਹੈ'],
'Join the room':['कमरे में जुड़ें','ਕਮਰੇ ਵਿੱਚ ਜੁੜੋ'],
'Add to Google Calendar':['Google कैलेंडर में जोड़ें','Google ਕੈਲੰਡਰ ਵਿੱਚ ਜੋੜੋ'],
'Download calendar file':['कैलेंडर फ़ाइल डाउनलोड करें','ਕੈਲੰਡਰ ਫ਼ਾਈਲ ਡਾਊਨਲੋਡ ਕਰੋ'],
'Join on my own when it starts (keep this page open)':['शुरू होते ही अपने-आप जुड़ जाऊँ (यह पेज खुला रखें)','ਸ਼ੁਰੂ ਹੁੰਦੇ ਹੀ ਆਪਣੇ-ਆਪ ਜੁੜ ਜਾਵਾਂ (ਇਹ ਪੰਨਾ ਖੁੱਲ੍ਹਾ ਰੱਖੋ)'],
'Invite friends':['दोस्तों को बुलाएँ','ਦੋਸਤਾਂ ਨੂੰ ਸੱਦੋ'],
'Copy invite link':['इनवाइट लिंक कॉपी करें','ਸੱਦਾ ਲਿੰਕ ਕਾਪੀ ਕਰੋ'],
'Copy code':['कोड कॉपी करें','ਕੋਡ ਕਾਪੀ ਕਰੋ'],
'Phone remote':['फ़ोन रिमोट','ਫ਼ੋਨ ਰਿਮੋਟ'],
'Voice chat':['वॉइस चैट','ਵੌਇਸ ਚੈਟ'],
'Join voice chat':['वॉइस चैट में जुड़ें','ਵੌਇਸ ਚੈਟ ਵਿੱਚ ਜੁੜੋ'],
'Leave voice chat':['वॉइस चैट छोड़ें','ਵੌਇਸ ਚੈਟ ਛੱਡੋ'],
'Hold to talk (or hold T)':['बोलने के लिए दबाए रखें (या T दबाए रखें)','ਬੋਲਣ ਲਈ ਦਬਾ ਕੇ ਰੱਖੋ (ਜਾਂ T ਦਬਾ ਕੇ ਰੱਖੋ)'],
'Talking… release to stop':['बोल रहे हैं… रोकने के लिए छोड़ें','ਬੋਲ ਰਹੇ ਹੋ… ਰੋਕਣ ਲਈ ਛੱਡੋ'],
'Open mic (wear headphones)':['माइक हमेशा चालू (हेडफ़ोन पहनें)','ਮਾਈਕ ਹਮੇਸ਼ਾ ਚਾਲੂ (ਹੈੱਡਫ਼ੋਨ ਪਹਿਨੋ)'],
"Friends' voices":['दोस्तों की आवाज़','ਦੋਸਤਾਂ ਦੀ ਆਵਾਜ਼'],
'Make the movie quieter while someone talks':['कोई बोले तो फ़िल्म की आवाज़ धीमी करें','ਕੋਈ ਬੋਲੇ ਤਾਂ ਫ਼ਿਲਮ ਦੀ ਆਵਾਜ਼ ਹੌਲੀ ਕਰੋ'],
'Turn on camera':['कैमरा चालू करें','ਕੈਮਰਾ ਚਾਲੂ ਕਰੋ'],
'Turn off camera':['कैमरा बंद करें','ਕੈਮਰਾ ਬੰਦ ਕਰੋ'],
'Show camera bubbles':['कैमरा बबल दिखाएँ','ਕੈਮਰਾ ਬੱਬਲ ਦਿਖਾਓ'],
'Movie':['फ़िल्म','ਫ਼ਿਲਮ'],
'Stream':['स्ट्रीम','ਸਟ੍ਰੀਮ'],
'Everyone has the file':['सबके पास फ़ाइल है','ਸਭ ਕੋਲ ਫ਼ਾਈਲ ਹੈ'],
'A link':['एक लिंक','ਇੱਕ ਲਿੰਕ'],
'YouTube or video link':['YouTube या वीडियो लिंक','YouTube ਜਾਂ ਵੀਡੀਓ ਲਿੰਕ'],
'Load':['लोड करें','ਲੋਡ ਕਰੋ'],
'Movie files (pick several to make a queue)':['फ़िल्म फ़ाइलें (कतार बनाने के लिए कई चुनें)','ਫ਼ਿਲਮ ਫ਼ਾਈਲਾਂ (ਕਤਾਰ ਬਣਾਉਣ ਲਈ ਕਈ ਚੁਣੋ)'],
'Up next':['अगली','ਅਗਲੀ'],
'Share a tab or screen instead':['इसके बजाय टैब या स्क्रीन शेयर करें','ਇਸਦੀ ਬਜਾਏ ਟੈਬ ਜਾਂ ਸਕ੍ਰੀਨ ਸ਼ੇਅਰ ਕਰੋ'],
'Stop sharing':['शेयर करना बंद करें','ਸ਼ੇਅਰ ਕਰਨਾ ਬੰਦ ਕਰੋ'],
'Subtitles (.srt, .vtt or .zip, optional)':['सबटाइटल (.srt, .vtt या .zip, ज़रूरी नहीं)','ਸਬਟਾਈਟਲ (.srt, .vtt ਜਾਂ .zip, ਜ਼ਰੂਰੀ ਨਹੀਂ)'],
'Find subtitles':['सबटाइटल ढूँढें','ਸਬਟਾਈਟਲ ਲੱਭੋ'],
'Ready check & start':['सब तैयार? फिर शुरू','ਸਾਰੇ ਤਿਆਰ? ਫਿਰ ਸ਼ੁਰੂ'],
'Series: mark the intro and credits once, then everyone gets Skip buttons on every episode':['सीरीज़: इंट्रो और क्रेडिट एक बार मार्क करें, फिर हर एपिसोड में सबको स्किप बटन मिलेगा','ਸੀਰੀਜ਼: ਇੰਟਰੋ ਅਤੇ ਕ੍ਰੈਡਿਟ ਇੱਕ ਵਾਰ ਮਾਰਕ ਕਰੋ, ਫਿਰ ਹਰ ਐਪੀਸੋਡ ਵਿੱਚ ਸਭ ਨੂੰ ਸਕਿੱਪ ਬਟਨ ਮਿਲੇਗਾ'],
'Intro starts':['इंट्रो शुरू','ਇੰਟਰੋ ਸ਼ੁਰੂ'],
'Intro ends':['इंट्रो ख़त्म','ਇੰਟਰੋ ਖ਼ਤਮ'],
'Credits start':['क्रेडिट शुरू','ਕ੍ਰੈਡਿਟ ਸ਼ੁਰੂ'],
'Clear':['हटाएँ','ਹਟਾਓ'],
'Let friends play, pause and skip':['दोस्तों को चलाने, रोकने और आगे-पीछे करने दें','ਦੋਸਤਾਂ ਨੂੰ ਚਲਾਉਣ, ਰੋਕਣ ਅਤੇ ਅੱਗੇ-ਪਿੱਛੇ ਕਰਨ ਦਿਓ'],
'Clearer dialogue (lift voices, tame loud music)':['साफ़ डायलॉग (आवाज़ ऊपर, तेज़ संगीत नीचे)','ਸਾਫ਼ ਡਾਇਲਾਗ (ਆਵਾਜ਼ ਉੱਪਰ, ਤੇਜ਼ ਸੰਗੀਤ ਹੇਠਾਂ)'],
'Clearer dialogue':['साफ़ डायलॉग','ਸਾਫ਼ ਡਾਇਲਾਗ'],
'Play sound on this computer':['इस कंप्यूटर पर आवाज़ चलाएँ','ਇਸ ਕੰਪਿਊਟਰ ਤੇ ਆਵਾਜ਼ ਚਲਾਓ'],
'Room':['कमरा','ਕਮਰਾ'],
'Password for new people (optional)':['नए लोगों के लिए पासवर्ड (ज़रूरी नहीं)','ਨਵੇਂ ਲੋਕਾਂ ਲਈ ਪਾਸਵਰਡ (ਜ਼ਰੂਰੀ ਨਹੀਂ)'],
'No password':['कोई पासवर्ड नहीं','ਕੋਈ ਪਾਸਵਰਡ ਨਹੀਂ'],
'Lock room (no one new can join)':['कमरा लॉक करें (कोई नया नहीं जुड़ पाएगा)','ਕਮਰਾ ਲਾਕ ਕਰੋ (ਕੋਈ ਨਵਾਂ ਨਹੀਂ ਜੁੜ ਸਕੇਗਾ)'],
'Your copy of the movie':['आपकी फ़िल्म की कॉपी','ਤੁਹਾਡੀ ਫ਼ਿਲਮ ਦੀ ਕਾਪੀ'],
'Your sound':['आपकी आवाज़ सेटिंग','ਤੁਹਾਡੀ ਆਵਾਜ਼ ਸੈਟਿੰਗ'],
'If voices come before lips move, slide right until they match.':['अगर आवाज़ होंठ हिलने से पहले आए, तो मिलने तक दाईं ओर खिसकाएँ।','ਜੇ ਆਵਾਜ਼ ਬੁੱਲ੍ਹ ਹਿੱਲਣ ਤੋਂ ਪਹਿਲਾਂ ਆਵੇ, ਤਾਂ ਮਿਲਣ ਤੱਕ ਸੱਜੇ ਪਾਸੇ ਖਿਸਕਾਓ।'],
'Help pass the stream on to other friends':['दूसरे दोस्तों तक स्ट्रीम पहुँचाने में मदद करें','ਦੂਜੇ ਦੋਸਤਾਂ ਤੱਕ ਸਟ੍ਰੀਮ ਪਹੁੰਚਾਉਣ ਵਿੱਚ ਮਦਦ ਕਰੋ'],
'Best moments':['सबसे मज़ेदार पल','ਸਭ ਤੋਂ ਮਜ਼ੇਦਾਰ ਪਲ'],
'Up next & watchlist':['आगे क्या और वॉचलिस्ट','ਅੱਗੇ ਕੀ ਅਤੇ ਵਾਚਲਿਸਟ'],
'Add to the watchlist':['वॉचलिस्ट में जोड़ें','ਵਾਚਲਿਸਟ ਵਿੱਚ ਜੋੜੋ'],
'Add':['जोड़ें','ਜੋੜੋ'],
"The watchlist is kept on the host's device, so it's still there next movie night.":['वॉचलिस्ट होस्ट के डिवाइस पर रहती है, इसलिए अगली मूवी नाइट में भी मिलेगी।','ਵਾਚਲਿਸਟ ਹੋਸਟ ਦੇ ਡਿਵਾਈਸ ਤੇ ਰਹਿੰਦੀ ਹੈ, ਇਸ ਲਈ ਅਗਲੀ ਮੂਵੀ ਨਾਈਟ ਵਿੱਚ ਵੀ ਮਿਲੇਗੀ।'],
'Vote':['वोट करें','ਵੋਟ ਪਾਓ'],
'Voted':['वोट दिया','ਵੋਟ ਪਾਈ'],
'Watching':['देख रहे हैं','ਦੇਖ ਰਹੇ ਹਨ'],
'Chat':['चैट','ਚੈਟ'],'People':['लोग','ਲੋਕ'],'Settings':['सेटिंग्स','ਸੈਟਿੰਗਾਂ'],'Stream quality':['स्ट्रीम क्वालिटी','ਸਟ੍ਰੀਮ ਕੁਆਲਿਟੀ'],
'Send':['भेजें','ਭੇਜੋ'],
'Say something':['कुछ कहें','ਕੁਝ ਕਹੋ'],
'Show connection stats':['कनेक्शन की जानकारी दिखाएँ','ਕਨੈਕਸ਼ਨ ਦੀ ਜਾਣਕਾਰੀ ਦਿਖਾਓ'],
'Hide connection stats':['कनेक्शन की जानकारी छिपाएँ','ਕਨੈਕਸ਼ਨ ਦੀ ਜਾਣਕਾਰੀ ਲੁਕਾਓ'],
'Close':['बंद करें','ਬੰਦ ਕਰੋ'],
'Skip intro':['इंट्रो छोड़ें','ਇੰਟਰੋ ਛੱਡੋ'],
'Next episode':['अगला एपिसोड','ਅਗਲਾ ਐਪੀਸੋਡ'],
'Click to start watching':['देखना शुरू करने के लिए क्लिक करें','ਦੇਖਣਾ ਸ਼ੁਰੂ ਕਰਨ ਲਈ ਕਲਿੱਕ ਕਰੋ'],
'Choose movie file':['फ़िल्म फ़ाइल चुनें','ਫ਼ਿਲਮ ਫ਼ਾਈਲ ਚੁਣੋ'],
'Choose a movie to start':['शुरू करने के लिए फ़िल्म चुनें','ਸ਼ੁਰੂ ਕਰਨ ਲਈ ਫ਼ਿਲਮ ਚੁਣੋ'],
'or drag video files here':['या वीडियो फ़ाइलें यहाँ खींचें','ਜਾਂ ਵੀਡੀਓ ਫ਼ਾਈਲਾਂ ਇੱਥੇ ਖਿੱਚੋ'],
'Waiting for the host to start the movie…':['होस्ट के फ़िल्म शुरू करने का इंतज़ार…','ਹੋਸਟ ਦੇ ਫ਼ਿਲਮ ਸ਼ੁਰੂ ਕਰਨ ਦੀ ਉਡੀਕ…'],
'Max FPS':['अधिकतम FPS','ਵੱਧ ਤੋਂ ਵੱਧ FPS'],
'Codec':['कोडेक','ਕੋਡੈਕ'],
'Send straight to up to':['सीधे इतने दोस्तों को भेजें','ਸਿੱਧੇ ਇੰਨੇ ਦੋਸਤਾਂ ਨੂੰ ਭੇਜੋ'],
'Everyone':['सबको','ਸਭ ਨੂੰ'],
'Code copied':['कोड कॉपी हो गया','ਕੋਡ ਕਾਪੀ ਹੋ ਗਿਆ'],
'Invite link copied. Send it to your friends.':['इनवाइट लिंक कॉपी हो गया। दोस्तों को भेजें।','ਸੱਦਾ ਲਿੰਕ ਕਾਪੀ ਹੋ ਗਿਆ। ਦੋਸਤਾਂ ਨੂੰ ਭੇਜੋ।'],
'Only the host can pause or play.':['सिर्फ़ होस्ट ही रोक या चला सकता है।','ਸਿਰਫ਼ ਹੋਸਟ ਹੀ ਰੋਕ ਜਾਂ ਚਲਾ ਸਕਦਾ ਹੈ।'],
'You are the host.':['आप होस्ट हैं।','ਤੁਸੀਂ ਹੋਸਟ ਹੋ।'],
'Connected to host.':['होस्ट से जुड़ गए।','ਹੋਸਟ ਨਾਲ ਜੁੜ ਗਏ।'],
"Receiving the host's stream.":['होस्ट की स्ट्रीम आ रही है।','ਹੋਸਟ ਦੀ ਸਟ੍ਰੀਮ ਆ ਰਹੀ ਹੈ।'],
'Connecting…':['जुड़ रहे हैं…','ਜੁੜ ਰਹੇ ਹਾਂ…'],
'Getting ready…':['तैयारी हो रही है…','ਤਿਆਰੀ ਹੋ ਰਹੀ ਹੈ…'],
'Creating room…':['कमरा बन रहा है…','ਕਮਰਾ ਬਣ ਰਿਹਾ ਹੈ…'],
'Your computer sends the picture to every friend. Easiest, but quality depends on your upload speed.':['आपका कंप्यूटर हर दोस्त को तस्वीर भेजता है। सबसे आसान, पर क्वालिटी आपकी अपलोड स्पीड पर निर्भर है।','ਤੁਹਾਡਾ ਕੰਪਿਊਟਰ ਹਰ ਦੋਸਤ ਨੂੰ ਤਸਵੀਰ ਭੇਜਦਾ ਹੈ। ਸਭ ਤੋਂ ਸੌਖਾ, ਪਰ ਕੁਆਲਿਟੀ ਤੁਹਾਡੀ ਅੱਪਲੋਡ ਸਪੀਡ ਤੇ ਨਿਰਭਰ ਹੈ।'],
'Everyone opens their own copy of the same file; only play, pause and skip are shared. Full 4K, almost no internet used.':['हर कोई उसी फ़ाइल की अपनी कॉपी खोलता है; सिर्फ़ चलाना, रोकना और आगे-पीछे करना साझा होता है। पूरा 4K, इंटरनेट लगभग नहीं लगता।','ਹਰ ਕੋਈ ਉਸੇ ਫ਼ਾਈਲ ਦੀ ਆਪਣੀ ਕਾਪੀ ਖੋਲ੍ਹਦਾ ਹੈ; ਸਿਰਫ਼ ਚਲਾਉਣਾ, ਰੋਕਣਾ ਅਤੇ ਅੱਗੇ-ਪਿੱਛੇ ਕਰਨਾ ਸਾਂਝਾ ਹੁੰਦਾ ਹੈ। ਪੂਰਾ 4K, ਇੰਟਰਨੈੱਟ ਲਗਭਗ ਨਹੀਂ ਲੱਗਦਾ।'],
'Paste a YouTube or video link. Everyone plays it on their own device and it stays in step. Uses almost none of your internet.':['YouTube या वीडियो लिंक पेस्ट करें। हर कोई इसे अपने डिवाइस पर चलाता है और सब साथ-साथ चलता है। आपका इंटरनेट लगभग नहीं लगता।','YouTube ਜਾਂ ਵੀਡੀਓ ਲਿੰਕ ਪੇਸਟ ਕਰੋ। ਹਰ ਕੋਈ ਇਸਨੂੰ ਆਪਣੇ ਡਿਵਾਈਸ ਤੇ ਚਲਾਉਂਦਾ ਹੈ ਅਤੇ ਸਭ ਇਕੱਠੇ ਚੱਲਦਾ ਹੈ। ਤੁਹਾਡਾ ਇੰਟਰਨੈੱਟ ਲਗਭਗ ਨਹੀਂ ਲੱਗਦਾ।'],
'Make host':['होस्ट बनाएँ','ਹੋਸਟ ਬਣਾਓ'],
'Remove':['हटाएँ','ਹਟਾਓ'],
'Play':['चलाएँ','ਚਲਾਓ'],
'Jump':['वहाँ जाएँ','ਉੱਥੇ ਜਾਓ'],
'Start room':['कमरा शुरू करें','ਕਮਰਾ ਸ਼ੁਰੂ ਕਰੋ'],
'Copy link':['लिंक कॉपी करें','ਲਿੰਕ ਕਾਪੀ ਕਰੋ'],
'Your avatar and name colour':['आपका अवतार और नाम का रंग','ਤੁਹਾਡਾ ਅਵਤਾਰ ਅਤੇ ਨਾਮ ਦਾ ਰੰਗ'],
"Wait for everyone (pause if a friend's video stalls or they drop out)":['सबका इंतज़ार करें (किसी दोस्त का वीडियो अटके या वो निकल जाए तो रोकें)','ਸਭ ਦੀ ਉਡੀਕ ਕਰੋ (ਕਿਸੇ ਦੋਸਤ ਦੀ ਵੀਡੀਓ ਅਟਕੇ ਜਾਂ ਉਹ ਨਿਕਲ ਜਾਵੇ ਤਾਂ ਰੋਕੋ)'],
'Keep going':['चलते रहें','ਚੱਲਦੇ ਰਹੋ'],
'Soundboard':['साउंडबोर्ड','ਸਾਊਂਡਬੋਰਡ'],
'Sit here':['यहाँ बैठें','ਇੱਥੇ ਬੈਠੋ'],'🎡 Spin the wheel':['🎡 पहिया घुमाएँ','🎡 ਪਹੀਆ ਘੁਮਾਓ'],'Spin the watchlist to pick tonight\'s movie.':['आज की मूवी चुनने के लिए वॉचलिस्ट घुमाएँ।','ਅੱਜ ਦੀ ਮੂਵੀ ਚੁਣਨ ਲਈ ਵਾਚਲਿਸਟ ਘੁਮਾਓ।'],
'Hear soundboard sounds':['साउंडबोर्ड की आवाज़ें सुनें','ਸਾਊਂਡਬੋਰਡ ਦੀਆਂ ਆਵਾਜ਼ਾਂ ਸੁਣੋ'],
'Drumroll':['ड्रमरोल','ਡਰੱਮਰੋਲ'],'Applause':['तालियाँ','ਤਾੜੀਆਂ'],'Air horn':['हॉर्न','ਹਾਰਨ'],'Sad trombone':['उदास ट्रॉम्बोन','ਉਦਾਸ ਟ੍ਰੌਂਬੋਨ']
};
let lang=['hi','pa'].includes(store.get('cc-lang'))?store.get('cc-lang'):'en';
function tr(t){if(lang==='en'||t==null)return t;const v=I18N[String(t).trim()];return v?(lang==='hi'?v[0]:v[1]):t}
const origText=new WeakMap();
const NO_TR='script,style,#chat,#tvchat,#people,#now,#codeOut,#upNext span,#nights span,#langSel,#rTitle,#subs,#talkers,#cams,#fx,.subres';
function trNode(n){
  const p=n.parentElement;if(!p||p.closest(NO_TR))return;
  if(!origText.has(n))origText.set(n,n.nodeValue);
  const o=origText.get(n),k=o.trim();if(!k||!I18N[k])return;
  const want=lang==='en'?o:o.replace(k,tr(k));if(n.nodeValue!==want)n.nodeValue=want;
}
function translateAll(root){
  const w=document.createTreeWalker(root||document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode()))trNode(n);
  (root||document).querySelectorAll('[placeholder]').forEach(el=>{if(!el.dataset.ph)el.dataset.ph=el.placeholder;el.placeholder=tr(el.dataset.ph)});
  document.documentElement.lang=lang;
}
let trPending=[];
new MutationObserver(ms=>{
  if(lang==='en')return;
  const first=!trPending.length;trPending.push(...ms);if(!first)return;
  requestAnimationFrame(()=>{const list=trPending;trPending=[];for(const m of list){if(m.type==='characterData')trNode(m.target);else m.addedNodes.forEach(a=>{if(a.nodeType===3)trNode(a);else if(a.nodeType===1&&a.isConnected)translateAll(a)})}});
}).observe(document.body,{childList:true,subtree:true,characterData:true});

/* ---------- avatars & name colours ---------- */
const AVATARS=['🦁','🐯','🐼','🦊','🐸','🐵','🦄','🐙','🐧','🐻','🐨','🐰'];
const COLORS=['#ffc857','#ff6b6b','#5ad17a','#4dabf7','#c77dff','#ff9f1c','#2ec4b6','#f15bb5'];
const cleanAv=a=>AVATARS.includes(a)?a:'';
const cleanCol=c=>COLORS.includes(c)?c:'';
const myLook={av:cleanAv(store.get('cc-av'))||AVATARS[Math.floor(Math.random()*AVATARS.length)],col:cleanCol(store.get('cc-col'))||COLORS[Math.floor(Math.random()*COLORS.length)]};
store.set('cc-av',myLook.av);store.set('cc-col',myLook.col);
function renderLook(){
  $('avPick').innerHTML=AVATARS.map(a=>'<button type="button" class="'+(a===myLook.av?'on':'')+'" data-av="'+a+'" aria-label="Avatar '+a+'" aria-pressed="'+(a===myLook.av)+'">'+a+'</button>').join('');
  $('colPick').innerHTML=COLORS.map(c=>'<button type="button" class="'+(c===myLook.col?'on':'')+'" data-col="'+c+'" aria-label="Colour '+c+'" aria-pressed="'+(c===myLook.col)+'"><span class="sw" style="background:'+c+'"></span></button>').join('');
}
function lookChanged(){
  store.set('cc-av',myLook.av);store.set('cc-col',myLook.col);renderLook();
  if(!inRoom())return;
  if(isHost)pushPeople();else if(hostConn&&hostConn.open)hostConn.send({t:'look',av:myLook.av,col:myLook.col});
}
function avName(p){return (p.av?p.av+' ':'')+p.name}

/* ---------- laser pointer ---------- */
let laserOn=false,lastLaser=0;
function contentBox(){
  const r=stage.getBoundingClientRect();let vw=16,vh=9;
  const el=mode==='link'&&link&&link.kind==='url'?lvid:vid;
  if(!(mode==='link'&&link&&link.kind==='yt')&&el.videoWidth){vw=el.videoWidth;vh=el.videoHeight}
  const k=Math.min(r.width/vw,r.height/vh),w=vw*k,h=vh*k;
  return{x:(r.width-w)/2,y:(r.height-h)/2,w,h,r};
}
function showLaser(x,y,name,col){
  const b=contentBox(),d=document.createElement('div');
  d.className='laser';d.style.color=col||'#ff3b3b';
  d.style.left=(b.x+Math.max(0,Math.min(1,x))*b.w)+'px';d.style.top=(b.y+Math.max(0,Math.min(1,y))*b.h)+'px';
  const sp=document.createElement('span');sp.textContent=name;d.appendChild(sp);
  $('lasers').appendChild(d);setTimeout(()=>d.remove(),3100);
}
function setLaser(on){laserOn=on;$('laserBtn').classList.toggle('on',on);stage.classList.toggle('lasering',on);if(on)toast('Laser on: click or tap the picture to point. Press L or the button again to stop.')}
function laserAt(ev){
  const now=performance.now();if(now-lastLaser<250)return;lastLaser=now;
  const b=contentBox(),x=(ev.clientX-b.r.left-b.x)/b.w,y=(ev.clientY-b.r.top-b.y)/b.h;
  if(x<0||x>1||y<0||y>1)return;
  showLaser(x,y,myLook.av+' '+myName,myLook.col);
  if(isHost)broadcast({t:'laser',x,y,n:avName({av:myLook.av,name:myName}),col:myLook.col});
  else if(hostConn&&hostConn.open)hostConn.send({t:'laser',x,y});
}

/* ---------- wait for everyone ---------- */
// Friends report whether their picture/sound is flowing; the host pauses when someone stalls or drops out.
let myHealth='ok';
const hb={call:null,recv:0,lost:0,frames:0,noFrames:0,since:0};
async function reportHealth(){
  if(isHost||!hostConn||!hostConn.open||!inRoom())return;
  let st='ok';
  try{
    if(mode==='stream'&&inCall&&inCall.peerConnection){
      const pc=inCall.peerConnection,now=performance.now();
      if(hb.call!==inCall){Object.assign(hb,{call:inCall,recv:0,lost:0,frames:0,noFrames:0,since:now})}
      if(['disconnected','failed'].includes(pc.connectionState))st='stall';
      else if(now-hb.since>5000){   // a fresh stream gets a few seconds to settle
        let recv=-1,lost=0,frames=-1;
        (await pc.getStats()).forEach(x=>{
          if(x.type==='inbound-rtp'&&x.kind==='audio'){recv=x.packetsReceived||0;lost=x.packetsLost||0}
          if(x.type==='inbound-rtp'&&x.kind==='video')frames=x.framesReceived!=null?x.framesReceived:(x.framesDecoded||0);
        });
        if(recv>=0){const dr=recv-hb.recv,dl=Math.max(0,lost-hb.lost);if(hb.recv&&(dr<=0||dl/(dr+dl)>.15))st='stall';hb.recv=recv;hb.lost=lost}
        // count frames arriving over the network, not frames drawn: a friend in another tab is not "stuck"
        if(frames>=0){if(!remote.p&&!remote.live&&hb.frames&&frames<=hb.frames)hb.noFrames++;else hb.noFrames=0;hb.frames=frames;if(hb.noFrames>=4)st='stall'}
      }
    }else if(mode==='sync'&&vid.src&&!vid.ended&&vid.readyState<3)st='stall';
    else if(mode==='link'&&M.ok()){
      if(link.kind==='yt'){if(yt.getPlayerState()===3)st='stall'}
      else if(lvid.readyState<3&&!lvid.ended)st='stall';
    }
  }catch(e){}
  if(st!==myHealth){myHealth=st;hostConn.send({t:'health',s:st})}
}
setInterval(reportHealth,1000);
const away=new Map();   // host: name -> time they dropped out without saying goodbye
let autoWait=null,waitShown='';
function waitingNames(now){
  for(const [n,t] of away)if(now-t>45000)away.delete(n);
  return [...[...conns.values()].filter(c=>!c.remote&&c.name!=='…'&&c.health==='stall'&&!c.ignore&&now-c.stallSince>2000).map(c=>c.name),...away.keys()];
}
function showWait(names){
  const key=names.join(', ');if(key===waitShown)return;waitShown=key;
  const b=$('waitb');
  if(!names.length){b.style.display='none';b.innerHTML=''}
  else{b.innerHTML='<span>Paused: waiting for '+esc(key)+'…</span>'+(isHost?'<button id="waitGo">Keep going</button>':'');b.style.display='flex';
    if(isHost)$('waitGo').onclick=()=>{for(const c of conns.values())if(c.health==='stall')c.ignore=true;away.clear();endWait(true);addChat('','Carrying on. They can catch up.',true)}}
  if(isHost)broadcast({t:'wait',names});
}
function endWait(resume){if(!autoWait)return;autoWait=null;showWait([]);if(resume&&M.ok()&&M.paused())M.play()}
setInterval(()=>{
  if(!isHost||!inRoom())return;
  if(!$('waitOn').checked||!M.ok()||M.live()){if(autoWait)endWait(false);return}
  const now=performance.now(),names=waitingNames(now);
  if(!autoWait){if(names.length&&!M.paused()){autoWait={since:now,clearAt:0};M.pause();showWait(names);addChat('','Paused to wait for '+names.join(', ')+'.',true)}}
  else if(!names.length){if(!autoWait.clearAt)autoWait.clearAt=now;else if(now-autoWait.clearAt>1500){endWait(true);addChat('','Everyone\'s back. Carrying on.',true)}}
  else{autoWait.clearAt=0;showWait(names);
    if(now-autoWait.since>60000){for(const c of conns.values())if(c.health==='stall')c.ignore=true;away.clear();endWait(true);addChat('','Waited a minute. Carrying on; they can catch up.',true)}}
},500);

/* ---------- hosting from a phone ---------- */
const isPhone=matchMedia('(pointer:coarse)').matches&&Math.min(screen.width,screen.height)<820;
let wakeLock=null;
async function keepAwake(){
  if(!('wakeLock' in navigator)||!inRoom()||document.hidden||wakeLock)return;
  try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null})}catch(e){}
}
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){keepAwake();if(isHost&&isPhone&&mode==='stream'&&stream&&conns.size)addChat('','Phones pause the stream while Couchcast is in the background. Keep it open on screen while friends watch.',true)}
});

/* ================= SOUNDBOARD ================= */
// short sounds made on the fly with Web Audio, so there are no files to download.
// They play on each person's own speakers and never go into the movie stream.
const SFX={
  drum:{i:'🥁',n:'Drumroll'},rim:{i:'😆',n:'Ba-dum-tss'},clap:{i:'👏',n:'Applause'},
  horn:{i:'📯',n:'Air horn'},sad:{i:'🎺',n:'Sad trombone'},boing:{i:'🌀',n:'Boing'}
};
const sfx={on:store.get('cc-sfx')!=='off',vol:Math.max(0,Math.min(1,parseFloat(store.get('cc-sfxv')??'0.6')||0)),last:0,out:null};
if(store.get('cc-sfxv')==='0')sfx.vol=0;
function sfxOut(){
  const a=getAC();if(!a)return null;
  if(!sfx.out){sfx.out=a.createGain();const lim=a.createDynamicsCompressor();lim.threshold.value=-6;lim.knee.value=3;lim.ratio.value=12;lim.attack.value=.002;lim.release.value=.15;sfx.out.connect(lim);lim.connect(a.destination)}
  sfx.out.gain.value=sfx.vol;return a;
}
function noiseBuf(a,sec){
  const b=a.createBuffer(1,Math.ceil(a.sampleRate*sec),a.sampleRate),d=b.getChannelData(0);
  for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;return b;
}
function hit(a,t,{dur=.08,freq=1800,q=1,type='bandpass',vol=.6}={}){
  const n=a.createBufferSource();n.buffer=noiseBuf(a,dur+.05);
  const f=a.createBiquadFilter();f.type=type;f.frequency.value=freq;f.Q.value=q;
  const g=a.createGain();g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(.001,t+dur);
  n.connect(f);f.connect(g);g.connect(sfx.out);n.start(t);n.stop(t+dur+.05);
}
function tone(a,t,{f0=200,f1=null,dur=.3,type='sine',vol=.4,vib=0,attack=.01}={}){
  const o=a.createOscillator();o.type=type;o.frequency.setValueAtTime(f0,t);
  if(f1)o.frequency.exponentialRampToValueAtTime(f1,t+dur);
  if(vib){const l=a.createOscillator(),lg=a.createGain();l.frequency.value=6;lg.gain.value=vib;l.connect(lg);lg.connect(o.frequency);l.start(t);l.stop(t+dur)}
  const g=a.createGain();g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(vol,t+attack);
  g.gain.setValueAtTime(vol,t+Math.max(attack,dur-.08));g.gain.linearRampToValueAtTime(0,t+dur);
  o.connect(g);g.connect(sfx.out);o.start(t);o.stop(t+dur+.02);
}
function playSfx(k){
  if(!sfx.on||!sfx.vol||!SFX[k])return;
  const a=sfxOut();if(!a)return;wakeAudio();
  const t=a.currentTime+.03;
  if(k==='drum'){for(let i=0;i<34;i++)hit(a,t+i*.045,{dur:.06,freq:900,q:.8,vol:.25+.35*(i/34)});hit(a,t+1.6,{dur:1.1,freq:6000,q:.4,type:'highpass',vol:.5});tone(a,t+1.6,{f0:90,f1:45,dur:.35,vol:.4})}
  else if(k==='rim'){tone(a,t,{f0:160,f1:60,dur:.18,vol:.6});hit(a,t,{dur:.08,freq:1200,vol:.35});tone(a,t+.22,{f0:150,f1:55,dur:.2,vol:.6});hit(a,t+.22,{dur:.08,freq:1200,vol:.35});hit(a,t+.48,{dur:.9,freq:7000,q:.3,type:'highpass',vol:.45})}
  else if(k==='clap'){for(let i=0;i<120;i++){const x=Math.random()*2.4;hit(a,t+x,{dur:.04+Math.random()*.03,freq:1100+Math.random()*1500,q:1.2,vol:1*(x<1.9?1:(2.4-x)*2)})}}
  else if(k==='horn'){[0,.45,.9].forEach((d,i)=>{const L=i===2?.9:.35;[440,554,659].forEach(f=>tone(a,t+d,{f0:f,dur:L,type:'sawtooth',vol:.18,attack:.02}))})}
  else if(k==='sad'){[[293,.42],[277,.42],[262,.42],[247,1.2]].reduce((d,[f,L],i)=>{tone(a,t+d,{f0:f,dur:L,type:'sawtooth',vol:.3,vib:i===3?7:0,attack:.04});return d+L+.04},0)}
  else if(k==='boing'){tone(a,t,{f0:120,f1:520,dur:.5,vol:.22,vib:30})}
}
function showSfx(k,who){if(!SFX[k])return;popReaction(SFX[k].i);if(sfx.on&&who)toast(who+': '+SFX[k].i+' '+SFX[k].n)}
function sendSfx(k){
  if(!SFX[k])return;
  const now=performance.now();if(now-sfx.last<1500)return;sfx.last=now;
  playSfx(k);showSfx(k,'');seatPop(myId(),SFX[k].i);
  if(isHost)broadcast({t:'sfx',k,n:avName({av:myLook.av,name:myName}),id:myId()});
  else if(hostConn&&hostConn.open)hostConn.send({t:'sfx',k});
}
function renderSfx(){
  $('sfxGrid').innerHTML=Object.entries(SFX).map(([k,v])=>'<button data-sfx="'+k+'"><b>'+v.i+'</b>'+esc(v.n)+'</button>').join('');
  $('sfxOn').checked=sfx.on;$('sfxVol').value=sfx.vol;$('sfxVol').disabled=!sfx.on;
  $('sfxBtn').classList.toggle('off',!sfx.on);
}

/* ================= COUCH SEATS ================= */
let mySeat=0;
function seatCount(n,maxSeat){let c=Math.max(6,n+2);if(c%2)c++;return Math.min(16,Math.max(c,maxSeat+1))}
function takenSeats(except){const t=new Set();if(except!=='host')t.add(mySeat);for(const [id,c] of conns)if(id!==except&&c.name!=='…'&&!c.remote&&c.seat>=0)t.add(c.seat);return t}
function freeSeat(except){const t=takenSeats(except);for(let i=0;i<16;i++)if(!t.has(i))return i;return -1}
function hostSeat(who,i){   // who: 'host' or a peer id
  i=Math.floor(+i);const n=people.length,max=seatCount(n,Math.max(...people.map(p=>p.seat|0),0));
  if(!(i>=0&&i<max)||takenSeats(who).has(i))return false;
  if(who==='host')mySeat=i;else{const c=conns.get(who);if(!c)return false;c.seat=i}
  pushPeople();return true;
}
function renderCouch(){
  const box=$('couch');if(!box)return;
  const bySeat=new Map();people.forEach(p=>{if(p.seat>=0)bySeat.set(p.seat,p)});
  const n=seatCount(people.length,Math.max(-1,...people.map(p=>p.seat)));
  const mine=myId(),per=n<=8?n/2>3?Math.ceil(n/2):n:Math.ceil(n/Math.ceil(n/6));
  let html='';
  for(let st=0;st<n;st+=per){
    html+='<div class="sofa">';
    for(let i=st;i<Math.min(n,st+per);i++){
      const p=bySeat.get(i);
      html+=p?'<button class="seat full'+(p.id===mine?' me':'')+(speaking.has(p.id)?' speaking':'')+'" data-seat="'+i+'" data-id="'+esc(p.id)+'" aria-label="'+esc(p.name)+'"><span class="sav">'+esc(p.av||'🙂')+'</span><span class="snm"'+(p.col?' style="color:'+p.col+'"':'')+'>'+esc(p.name)+'</span></button>'
        :'<button class="seat" data-seat="'+i+'" aria-label="Sit here"><span class="sav">＋</span><span class="snm">Sit here</span></button>';
    }
    html+='</div>';
  }
  box.innerHTML=html;
}
function seatPop(id,e){
  if(!id)return;const el=document.querySelector('#couch .seat[data-id="'+CSS.escape(String(id))+'"]');if(!el)return;
  const s=document.createElement('span');s.className='spop';s.textContent=e;el.appendChild(s);setTimeout(()=>s.remove(),1800);
}
function pickSeat(i){
  const me=people.find(p=>p.id===myId());if(me&&me.seat===i)return;
  if(isHost){if(!hostSeat('host',i))toast('That seat is taken.')}
  else if(hostConn&&hostConn.open)hostConn.send({t:'seat',i});
}

/* ================= SPOILER SHIELD ================= */
let spoilNext=false;
function spoilWrap(h){return '<span class="spoil" tabindex="0" role="button" title="Spoiler: tap to show">'+h+'</span>'}
function isSpoilerText(m){return /^\s*spoiler\b/i.test(m)}
function fmtMsg(m,sp){const h=esc(m);if(sp||isSpoilerText(m))return spoilWrap(h);return h.replace(/\|\|(.+?)\|\|/g,(_,x)=>spoilWrap(x))}
function hasSpoiler(m,sp){return !!sp||isSpoilerText(m)||/\|\|.+?\|\|/.test(m)}
function setSpoil(on){spoilNext=on;$('spoilBtn').classList.toggle('on',on);$('spoilBtn').setAttribute('aria-pressed',on);$('msg').placeholder=on?'Spoiler (hidden until tapped)':'Say something'}

/* ================= MOVIE ROULETTE ================= */
let spinAt=0,spinT=null;
function spinRequest(){
  if((lastVotes||[]).length<2)return toast('Add at least 2 movies to the watchlist first, then spin.');
  if(isHost)hostSpin(avName({av:myLook.av,name:myName}));
  else if(hostConn&&hostConn.open)hostConn.send({t:'spin'});
}
function hostSpin(by){
  const now=performance.now();if(now-spinAt<9000)return;
  const names=voteItems().map(x=>x.name).slice(0,24);if(names.length<2)return;
  spinAt=now;
  const r=new Uint32Array(2);crypto.getRandomValues(r);
  const i=r[0]%names.length,j=(r[1]%1000)/1000;
  broadcast({t:'spin',names,i,j,by});showWheel(names,i,j,by);
}
function showWheel(names,i,j,by){
  const w=$('wheel'),n=names.length,a=360/n;clearTimeout(spinT);
  const cx=150,r=140,pal=['#e5383b','#ffc857','#5ad17a','#4cc9f0','#b388ff','#ff8fab','#f4a261','#2ec4b6'];
  let segs='';
  names.forEach((nm,k)=>{
    const a0=(k*a-90)*Math.PI/180,a1=((k+1)*a-90)*Math.PI/180,large=a>180?1:0;
    const p0=[cx+r*Math.cos(a0),cx+r*Math.sin(a0)],p1=[cx+r*Math.cos(a1),cx+r*Math.sin(a1)];
    const col=pal[k%pal.length]+(k%pal.length===0&&n%pal.length===1&&k===n-1?'':'');
    segs+='<path d="M'+cx+' '+cx+'L'+p0[0].toFixed(1)+' '+p0[1].toFixed(1)+'A'+r+' '+r+' 0 '+large+' 1 '+p1[0].toFixed(1)+' '+p1[1].toFixed(1)+'Z" fill="'+(n%pal.length===1&&k===n-1?'#9d8df1':col)+'"/>';
    const mid=k*a+a/2,label=nm.length>18?nm.slice(0,17)+'…':nm,fs=n>16?9:n>10?11:13;
    const flip=mid>180;   // keep labels on the left half the right way up
    segs+='<text transform="rotate('+(flip?mid+90:mid-90).toFixed(2)+' '+cx+' '+cx+')" x="'+(flip?cx-r+10:cx+r-10)+'" y="'+cx+'" font-size="'+fs+'" text-anchor="'+(flip?'start':'end')+'" dominant-baseline="middle">'+esc(label)+'</text>';
  });
  w.innerHTML='<div class="wbox"><svg viewBox="-6 -14 312 320" class="wsvg"><g class="wrot">'+segs+'</g><circle cx="150" cy="150" r="14" fill="#16141a" stroke="#fff" stroke-width="3"/><path d="M137 -10H163L150 22Z" fill="#fff" stroke="#0008" stroke-width="1.5"/></svg><div class="wres" id="wres">'+(by?esc(by)+' spun the wheel…':'Spinning…')+'</div></div>';
  w.hidden=false;
  const g=w.querySelector('.wrot'),R=360*6+(360-(i+.2+j*.6)*a);
  g.style.transform='rotate(0deg)';g.getBoundingClientRect();
  g.style.transition='transform 5s cubic-bezier(.33,1,.68,1)';g.style.transform='rotate('+R+'deg)';
  wheelTicks(R,a);
  spinT=setTimeout(()=>{
    const nm=names[i];
    $('wres').innerHTML='🎡 Tonight: <b>'+esc(nm)+'</b>'+(isHost?wheelActs(nm):'')+'<button class="ghost small" id="wClose">Close</button>';
    $('wClose').onclick=()=>{w.hidden=true};
    if($('wPlay'))$('wPlay').onclick=()=>{w.hidden=true;const qi=queue.findIndex(q=>q.name===nm);if(qi>=0)playNext(qi)};
    if($('wFirst'))$('wFirst').onclick=()=>{w.hidden=true;const qi=queue.findIndex(q=>q.name===nm);if(qi>0){queue.unshift(queue.splice(qi,1)[0]);renderQueue()}};
    addChat('','🎡 The wheel picked '+nm,true);playSfx('rim');
    spinT=setTimeout(()=>{w.hidden=true},15000);
  },5200);
}
function wheelActs(nm){const qi=queue.findIndex(q=>q.name===nm);return qi<0?'':'<button class="small" id="wPlay">Play it now</button>'+(qi>0?'<button class="ghost small" id="wFirst">Make it next</button>':'')}
function wheelTicks(R,a){
  if(!sfx.on||!sfx.vol)return;const ac2=sfxOut();if(!ac2)return;wakeAudio();
  const t0=ac2.currentTime+.02,ticks=Math.min(220,Math.floor(R/a));
  for(let k=1;k<=ticks;k++){
    const th=k*a/R;if(th>=1)break;
    // invert the ease-out curve 1-(1-t)^3 to find when the wheel passes each segment
    const t=1-Math.cbrt(1-th);
    hit(ac2,t0+t*5,{dur:.018,freq:3200,q:2,vol:.35});
  }
}

/* ================= SIDE PANEL TABS, SCREEN GLOW ================= */
let tabNow='chat',unread=0;
function showTab(t){
  tabNow=t;
  document.querySelectorAll('.tabs [data-tab]').forEach(b=>{const on=b.dataset.tab===t;b.classList.toggle('on',on);b.setAttribute('aria-selected',on)});
  document.querySelectorAll('.tabp').forEach(p=>p.classList.toggle('on',p.dataset.p===t));
  if(t==='chat'){unread=0;drawBadge();const c=$('chat');c.scrollTop=1e9}
}
function drawBadge(){const b=$('chatBadge');b.textContent=unread>9?'9+':unread||'';b.classList.toggle('on',unread>0)}
function chatSeen(){return tabNow==='chat'&&!document.body.classList.contains('tv')&&document.fullscreenElement!==stage}
// the room is lit by the screen: sample the picture a couple of times a second and tint the glow behind it
const glowCv=document.createElement('canvas');glowCv.width=16;glowCv.height=9;
const glowCx=glowCv.getContext('2d',{willReadFrequently:true});
let glowLast='';
function sampleGlow(){
  if(document.hidden||!inRoom()||document.body.classList.contains('tv'))return;
  let col='255,180,84';
  const src=lvid.style.display==='block'&&lvid.readyState>=2?lvid:vid.readyState>=2&&vid.videoWidth?vid:null;
  if(src){
    try{
      glowCx.drawImage(src,0,0,16,9);
      const d=glowCx.getImageData(0,0,16,9).data;let r=0,g=0,b=0,w=0;
      for(let i=0;i<d.length;i+=4){const l=Math.max(d[i],d[i+1],d[i+2]),k=1+l/64;r+=d[i]*k;g+=d[i+1]*k;b+=d[i+2]*k;w+=k}
      r/=w;g/=w;b/=w;
      const mx=Math.max(r,g,b,1),lift=Math.min(2.4,200/mx);   // keep dark scenes from going black
      const avg=(r+g+b)/3,sat=1.35;
      col=[r,g,b].map(v=>Math.round(Math.max(0,Math.min(255,(avg+(v-avg)*sat)*lift)))).join(',');
    }catch(e){/* picture from another site can't be read; keep the lamp colour */}
  }
  if(col!==glowLast){glowLast=col;document.documentElement.style.setProperty('--glow',col)}
}
setInterval(sampleGlow,700);

/* ================= PLAYER ================= */
function localPlayer(){return isHost||((mode==='sync'||mode==='link')&&M.ok())}
function curTime(){
  if(localPlayer())return M.time();
  return remote.c+(remote.p?0:(performance.now()-remote.at)/1000);
}
function duration(){return localPlayer()?M.dur():remote.d}
function isPaused(){return localPlayer()?M.paused():remote.p}
function tick(){
  const d=duration(),c=Math.min(curTime(),d||Infinity),live=M.live();
  $('tcur').textContent=live?'LIVE':fmt(c);$('tdur').textContent=live?'':fmt(d);
  if(!isHost&&mode==='link'&&!remote.p&&M.ok()&&M.paused()&&playWantAt&&performance.now()-playWantAt>2500)$('tap').style.display='grid';
  if(!dragging)$('seek').value=d?Math.round(c/d*1000):0;
  const p=isPaused();$('ppIcon').setAttribute('d',p?PLAY:PAUSE);$('pp').setAttribute('aria-label',p?'Play':'Pause');
  const silent=me.muted||me.vol===0||(isHost&&!me.hostOn);
  $('volIcon').setAttribute('d',silent?VOL_OFF:VOL_ON);
  hostSubTick();skipTick();
  if(inRoom()&&audioBlocked()&&(vid.srcObject||(vid.src&&!vid.paused)))$('tap').style.display='grid';
  else if($('tap').style.display==='grid'&&!audioBlocked()&&((vid.srcObject&&!vid.paused)||(M.ok()&&!M.paused())||(!isHost&&remote.p&&mode!=='stream')))$('tap').style.display='none';
}
setInterval(tick,250);
function togglePlay(){
  if(!canControl())return toast('Only the host can pause or play.');
  wakeAudio();
  if(isHost){if(!M.ok()||M.live())return;if(autoWait){autoWait=null;showWait([])}M.paused()?M.play():M.pause()}
  else if(hostConn&&hostConn.open)hostConn.send({t:'ctl',a:'toggle'});
}
function seekTo(t){
  if(!canControl())return;
  t=Math.max(0,Math.min(duration()||0,t));
  if(isHost){if(M.ok()&&!M.live())M.seek(t)}
  else if(hostConn&&hostConn.open)hostConn.send({t:'ctl',a:'seek',v:t});
}
function sendReaction(e){
  popReaction(e);seatPop(myId(),e);if(isHost)noteMoment(e);
  if(isHost)broadcast({t:'react',e,id:myId()});else if(hostConn&&hostConn.open)hostConn.send({t:'react',e});
}
function toggleFs(){
  if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
  else if(stage.requestFullscreen)stage.requestFullscreen().catch(()=>{});
  else if(vid.webkitEnterFullscreen)vid.webkitEnterFullscreen();
}
function setTV(on){
  document.body.classList.toggle('tv',on);
  if(on){toast('TV mode: OK plays or pauses, arrows skip and change volume, Back exits');
    if(!document.fullscreenElement&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().catch(()=>{});
    $('pp').focus();wake();}
  else if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
}
function castHelp(){
  const link=inviteLink();
  showModal('<h2>Watch on a TV</h2>'+
    '<p><b>Cast from this computer</b> (Chromecast, Google TV, Android TV and many LG and Samsung TVs):</p>'+
    '<ol><li>In Chrome, open the menu (three dots, top right) and choose <b>Cast, save and share</b>, then <b>Cast…</b></li><li>Pick your TV. Under <b>Sources</b>, choose <b>Cast tab</b>.</li><li>Press the TV button on the player so the movie fills the screen.</li></ol>'+
    '<p><b>Or open Couchcast on the TV itself</b>: in the TV\'s web browser go to<br><span style="color:var(--gold);overflow-wrap:anywhere">'+esc(link.split('#')[0])+'</span><br>and join with code <span class="code">'+esc(code)+'</span>. It switches to TV mode on its own. This needs a fairly recent TV browser; older ones may not connect.</p>'+
    '<p><b>Mac or iPhone</b>: use Screen Mirroring (AirPlay) to your TV, then press the TV button.</p>');
}
let idleT;function wake(){stage.classList.remove('idle');clearTimeout(idleT);idleT=setTimeout(()=>{if(!isPaused())stage.classList.add('idle')},3500)}

/* ================= INSTALL (PWA) ================= */
let installEvt=null;
const isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent)&&!window.MSStream;
const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvt=e;$('installBtn').style.display='block'});
window.addEventListener('appinstalled',()=>{$('installBtn').style.display='none';toast('Couchcast installed')});
if(isIOS&&!standalone)$('installBtn').style.display='block';
$('installBtn').onclick=async()=>{
  if(installEvt){installEvt.prompt();try{await installEvt.userChoice}catch(e){}installEvt=null;$('installBtn').style.display='none';return}
  showModal('<h2>Install Couchcast</h2><ol><li>Tap the <b>Share</b> button in Safari (square with an arrow).</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open Couchcast from its new icon.</li></ol>');
};
if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('sw.js').catch(()=>{});

/* ================= EVENTS ================= */
try{$('name').value=store.get('cc-name')||''}catch(e){}
try{const t=JSON.parse(store.get('cc-turn')||'null');if(t){$('turnUrl').value=t.urls||'';$('turnUser').value=t.username||'';$('turnPass').value=t.credential||''}}catch(e){}
const h=location.hash.slice(1).split('~')[0].toUpperCase();
if(relaySetupMsg){$('lobbyMsg').textContent=relaySetupMsg}
if(/^[A-Z0-9]{6}$/.test(h)){$('joinCode').value=h;$('lobbyMsg').textContent='You were invited to room '+h+'. Enter your name and press Join.';($('name').value?$('joinBtn'):$('name')).focus()}
$('vClear').checked=store.get('cc-vclear')==='1';$('vDelay').value=+store.get('cc-vdelay')||0;$('vDelayOut').textContent=$('vDelay').value;
if(store.get('cc-clear')==='0')$('clearDlg').checked=false;
$('duckOn').checked=store.get('cc-duck')!=='0';
$('duckOn').onchange=e=>{store.set('cc-duck',e.target.checked?'1':'0');if(!e.target.checked)setDuck(false)};

$('hostBtn').onclick=()=>$('permRoom').checked?startHost({code:permCode(),perm:true}):startHost();
$('joinBtn').onclick=()=>startJoin();
$('joinCode').addEventListener('keydown',e=>{if(e.key==='Enter')startJoin()});
$('joinPw').addEventListener('keydown',e=>{if(e.key==='Enter')startJoin()});
$('name').addEventListener('keydown',e=>{if(e.key==='Enter'&&$('joinCode').value)startJoin()});
$('turnSave').onclick=async()=>{
  const u=$('turnUrl').value.trim();
  if(u)store.set('cc-turn',JSON.stringify({urls:normUrls(u),username:$('turnUser').value.trim(),credential:$('turnPass').value}));else store.del('cc-turn');
  const api=$('turnApi').value.trim();if(api)store.set('cc-turnapi',api);else store.del('cc-turnapi');
  $('turnMsg').textContent='Checking…';iceReady=loadIce();await iceReady;
  $('turnMsg').textContent=relayOn?'Saved. The relay will be used for the next room you create or join.':'Saved, but no relay could be loaded. Check the link or details.';
};
$('turnApi').value=store.get('cc-turnapi')||'';
$('mStream').onclick=()=>setMode('stream');
$('mSync').onclick=()=>setMode('sync');
$('mLink').onclick=()=>setMode('link');
$('linkLoad').onclick=hostLoadLink;
$('linkUrl').addEventListener('keydown',e=>{if(e.key==='Enter')hostLoadLink()});
$('shareBtn').onclick=startShare;
$('readyBtn').onclick=startReady;
$('subFind').onclick=subFinder;
$('camBtn').onclick=()=>cam.on?camOff():camOn();
$('showCams').checked=store.get('cc-showcams')!=='0';document.body.classList.toggle('nocams',!$('showCams').checked);
$('showCams').onchange=e=>{store.set('cc-showcams',e.target.checked?'1':'0');document.body.classList.toggle('nocams',!e.target.checked)};
$('helpShare').checked=store.get('cc-help')?store.get('cc-help')==='1':!matchMedia('(pointer:coarse)').matches;
$('helpShare').onchange=e=>{store.set('cc-help',e.target.checked?'1':'0');if(hostConn&&hostConn.open)hostConn.send({t:'helper',on:e.target.checked});if(!e.target.checked)stopForwarding()};
$('maxDirect').onchange=()=>{if(isHost&&mode==='stream'&&stream)assignAll()};
$('upNext').onclick=e=>{
  const v=e.target.closest('button[data-v]'),d=e.target.closest('button[data-vdel]');
  if(v){if(isHost)castVote(myId(),v.dataset.v);else if(hostConn&&hostConn.open)hostConn.send({t:'vote',k:v.dataset.v})}
  if(d&&isHost){const k=d.dataset.vdel;suggestions=suggestions.filter(n=>'s:'+n!==k);for(const [x,y] of [...votes])if(y===k)votes.delete(x);saveWatchlist();pushVotes()}
};
$('suggestForm').onsubmit=e=>{
  e.preventDefault();const n=$('suggestIn').value.trim();if(!n)return;$('suggestIn').value='';
  if(isHost)addSuggestion(n,myName);else if(hostConn&&hostConn.open)hostConn.send({t:'suggest',name:n});
};
$('planBtn').onclick=planNight;
$('nights').onclick=e=>{
  const b=e.target.closest('button[data-n]');if(!b)return;const n=myNights().find(x=>x.c===b.dataset.c);if(!n)return;
  if(b.dataset.n==='copy')copy(nightLink(n),'Invite copied');
  if(b.dataset.n==='start'){$('joinCode').value='';startHost({code:n.c,night:true})}
  if(b.dataset.n==='del'){store.set('cc-nights',JSON.stringify(myNights().filter(x=>x.c!==n.c)));renderNights()}
};
(()=>{const d=new Date();d.setHours(21,0,0,0);if(d<new Date())d.setDate(d.getDate()+1);const p=x=>String(x).padStart(2,'0');$('planWhen').value=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T21:00'})();
['play','pause','seeked'].forEach(ev=>lvid.addEventListener(ev,()=>{if(isHost&&mode==='link')broadcast(state())}));
lvid.addEventListener('waiting',()=>$('spin').style.display='grid');
['playing','pause'].forEach(ev=>lvid.addEventListener(ev,()=>{$('spin').style.display='none';if(ev==='playing')playWantAt=0}));
$('file').onchange=e=>{addFiles(e.target.files);e.target.value=''};
$('vfile').onchange=e=>{
  const fs=[...e.target.files].filter(isVideo);if(!fs.length)return;
  fs.forEach(f=>library.set(baseName(f.name).toLowerCase(),f));
  if(!autoPick()){viewerLoad(fs[0]);if(title&&baseName(fs[0].name).toLowerCase()!==title.toLowerCase())toast('Name differs from the host\'s "'+title+'". Make sure it is the same movie.')}
  e.target.value='';
};
$('queue').onclick=e=>{
  const b=e.target.closest('button');if(!b)return;const i=+b.dataset.i;
  if(b.dataset.q==='play')playNext(i);
  if(b.dataset.q==='del'){queue.splice(i,1);renderQueue()}
  if(b.dataset.q==='up'&&i>0){[queue[i-1],queue[i]]=[queue[i],queue[i-1]];renderQueue()}
};
$('nextBtn').onclick=()=>{if(isHost&&queue.length)playNext(bestNext())};
$('subFile').onchange=e=>{readSubFile(e.target.files[0]);e.target.value=''};
$('hostSound').onchange=e=>{me.hostOn=e.target.checked;applyVol()};
$('clearDlg').onchange=e=>{setClear(e.target.checked);store.set('cc-clear',e.target.checked?'1':'0')};
$('vClear').onchange=e=>{setViewerClear(e.target.checked);store.set('cc-vclear',e.target.checked?'1':'0')};
$('vDelay').oninput=e=>{setViewerDelay(+e.target.value);store.set('cc-vdelay',e.target.value)};
$('roomPw').oninput=e=>{roomPw=e.target.value.trim()};
$('roomPw').onchange=()=>{if(roomPw)addChat('','New people now need the password to join.',true)};
$('lockRoom').onchange=e=>{locked=e.target.checked;addChat('',locked?'Room locked. No one new can join.':'Room unlocked.',true)};
$('people').onclick=e=>{
  const b=e.target.closest('button[data-act]');if(!b||!isHost)return;
  const c=conns.get(b.dataset.id);if(!c)return;
  // a second tap within 3 s confirms; kept outside the button so a redraw of the list doesn't lose it
  const id=b.dataset.id,act=b.dataset.act;
  if(sureAct&&sureAct.id===id&&sureAct.act===act&&Date.now()<sureAct.until){sureAct=null;if(act==='kick')kick(id);else handOver(id,false);renderPeople();return}
  sureAct={id,act,until:Date.now()+3000};renderPeople();setTimeout(renderPeople,3100);
};
vid.addEventListener('play',()=>{wakeAudio();keepAwake()});
/* Same-computer test: a friend tab in this browser tells the host tab, which mutes itself to stop the hollow double sound. */
let bc=null;try{bc=new BroadcastChannel('couchcast');bc.onmessage=e=>{
  if(isHost&&e.data&&e.data.code===code&&me.hostOn){
    me.hostOn=false;$('hostSound').checked=false;applyVol();
    addChat('','A friend tab is open on this computer, so sound here is muted to avoid an echo. Friends still hear it.',true);
  }
}}catch(e){}
$('allowCtl').onchange=e=>{allowCtl=e.target.checked;broadcast({t:'perm',on:allowCtl})};
$('mbps').oninput=()=>$('mbpsOut').textContent=$('mbps').value;
['mbps','fps'].forEach(id=>$(id).addEventListener('change',()=>{for(const c of conns.values())if(c.call){if(c.call._q){c.call._q.lvl=0;c.call._q.goodSince=0}boost(c.call)}}));
$('codec').onchange=()=>{if(mode==='stream'&&stream)assignAll()};
['play','pause','seeked'].forEach(ev=>vid.addEventListener(ev,()=>{if(isHost&&vid.src)broadcast(state())}));
vid.addEventListener('waiting',()=>$('spin').style.display='grid');
['playing','canplay','pause'].forEach(ev=>vid.addEventListener(ev,()=>$('spin').style.display='none'));
setInterval(()=>{if(isHost&&M.ok())broadcast(state())},1500);

$('pp').onclick=togglePlay;
$('seek').addEventListener('input',()=>{dragging=true;$('tcur').textContent=fmt($('seek').value/1000*duration())});
$('seek').addEventListener('change',()=>{dragging=false;seekTo($('seek').value/1000*duration())});
$('vol').oninput=()=>{me.vol=+$('vol').value;me.muted=me.vol===0;applyVol()};
$('muteBtn').onclick=()=>{me.muted=!me.muted;if(!me.muted&&me.vol===0){me.vol=1;$('vol').value=1}applyVol()};
$('ccBtn').onclick=()=>{ccOn=!ccOn;$('ccBtn').classList.toggle('on',ccOn);setSub(curSub)};
$('fsBtn').onclick=toggleFs;
$('tvBtn').onclick=()=>setTV(!document.body.classList.contains('tv'));
$('castBtn').onclick=castHelp;
$('modalClose').onclick=()=>{$('modal').style.display='none'};
$('modal').onclick=e=>{if(e.target===$('modal'))$('modal').style.display='none'};
vid.addEventListener('dblclick',toggleFs);
vid.addEventListener('click',()=>{if(laserOn)return;if(canControl())togglePlay();else wake()});
stage.addEventListener('pointerdown',e=>{if(!laserOn||e.target.closest('.bar,#ov,#fsChat,#tap,#skipBtn,#waitb,.empty button'))return;e.preventDefault();laserAt(e)});
$('laserBtn').onclick=()=>setLaser(!laserOn);
renderSfx();
$('sfxBtn').onclick=e=>{e.stopPropagation();const p=$('sfxPop');p.hidden=!p.hidden};
document.addEventListener('click',e=>{const p=$('sfxPop');if(!p.hidden&&!p.contains(e.target)&&e.target!==$('sfxBtn'))p.hidden=true});
$('sfxGrid').onclick=e=>{const b=e.target.closest('[data-sfx]');if(b)sendSfx(b.dataset.sfx)};
$('sfxOn').onchange=()=>{sfx.on=$('sfxOn').checked;store.set('cc-sfx',sfx.on?'on':'off');renderSfx()};
$('sfxVol').oninput=()=>{sfx.vol=+$('sfxVol').value;store.set('cc-sfxv',String(sfx.vol));if(sfx.out)sfx.out.gain.value=sfx.vol};
$('avPick').onclick=e=>{const b=e.target.closest('button[data-av]');if(b){myLook.av=cleanAv(b.dataset.av)||myLook.av;lookChanged()}};
$('colPick').onclick=e=>{const b=e.target.closest('button[data-col]');if(b){myLook.col=cleanCol(b.dataset.col)||myLook.col;lookChanged()}};
renderLook();
const canShare=!!(navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia)&&!isPhone;
if(!canShare)$('shareRow').style.display='none';
['mousemove','touchstart'].forEach(ev=>stage.addEventListener(ev,wake,{passive:true}));
$('tapBtn').onclick=()=>{$('tap').style.display='none';wakeAudio();if(mode==='link'){if(!isHost&&!remote.p)M.play()}else if(vid.srcObject||vid.src)vid.play().catch(()=>{});for(const v of voice.in.values())v.el.play().catch(()=>{})};
document.addEventListener('pointerdown',wakeAudio,{passive:true});
document.querySelectorAll('.react[data-e]').forEach(b=>b.onclick=()=>sendReaction(b.dataset.e));
$('statsBtn').onclick=()=>{showStats=!showStats;$('stats').style.display=showStats&&vid.srcObject?'block':'none';$('statsBtn').textContent=showStats?'Hide connection stats':'Show connection stats';if(isHost&&showStats)toast('Stats show on your friends\' screens. Ask them what they see.')};
const copy=(t,ok)=>{const done=()=>toast(ok),fail=()=>toast('Copy this: '+t);navigator.clipboard?navigator.clipboard.writeText(t).then(done,fail):fail()};
$('copyLink').onclick=()=>copy(inviteLink(),'Invite link copied. Send it to your friends.');
$('copyCode').onclick=()=>copy(code,'Code copied');
$('chatForm').onsubmit=e=>{e.preventDefault();if(!$('msg').value.trim())return;sendChat($('msg').value,spoilNext);$('msg').value='';setSpoil(false)};
$('spoilBtn').onclick=()=>{setSpoil(!spoilNext);$('msg').focus()};
const revealSpoil=e=>{const sp=e.target.closest('.spoil');if(sp)sp.classList.toggle('shown')};
$('chat').addEventListener('click',revealSpoil);
$('chat').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.classList.contains('spoil')){e.preventDefault();revealSpoil(e)}});
$('couch').addEventListener('click',e=>{const b=e.target.closest('.seat');if(b)pickSeat(+b.dataset.seat)});
$('spinBtn').onclick=spinRequest;
document.querySelectorAll('.tabs [data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$('chatBtn').addEventListener('click',()=>{unread=0;drawBadge()});
$('fsChat').onsubmit=e=>{e.preventDefault();sendChat($('fsMsg').value);$('fsMsg').value='';closeFsChat()};
$('fsMsg').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeFsChat()}});
$('chatBtn').onclick=()=>$('fsChat').style.display==='flex'?closeFsChat():openFsChat();
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&!document.body.classList.contains('tv'))closeFsChat()});
if(document.pictureInPictureEnabled)$('pipBtn').style.display='block';
$('pipBtn').onclick=togglePip;
$('remoteBtn').onclick=showRemote;
$('ctBtn').onclick=connTest;
$('permRoom').checked=store.get('cc-useperm')==='1';showPerm();
$('permRoom').onchange=e=>{store.set('cc-useperm',e.target.checked?'1':'0');showPerm()};
$('permCopy').onclick=()=>copy(permLinkFor(permCode()),'Your permanent room link is copied. Friends can bookmark it.');
$('moments').onclick=e=>{const b=e.target.closest('button[data-mt]');if(b)seekTo(+b.dataset.mt)};
$('skipBtn').onclick=()=>{if($('skipBtn').textContent==='Next episode'){if(isHost&&queue.length)playNext(bestNext())}else if(marks&&marks.ie!=null)seekTo(marks.ie)};
$('mkIs').onclick=()=>setMark('is');$('mkIe').onclick=()=>setMark('ie');$('mkCs').onclick=()=>setMark('cs');$('mkClear').onclick=()=>setMark('clear');
/* voice controls */
$('voiceBtn').onclick=()=>voice.on?leaveVoice():joinVoice();
$('openMic').onchange=e=>{
  voice.ptt=!e.target.checked;
  if(voice.mic)voice.mic.getAudioTracks().forEach(t=>t.enabled=!voice.ptt);
  $('pttBtn').style.display=voice.ptt?'block':'none';$('barMic').style.display=voice.on&&voice.ptt?'block':'none';
  if(!voice.ptt)toast('Open mic: wear headphones so the movie does not leak into your mic.');
};
$('voiceVol').oninput=e=>{for(const v of voice.in.values())v.el.volume=Math.min(1,+e.target.value)};
['pttBtn','barMic'].forEach(id=>{
  const b=$(id);
  b.addEventListener('pointerdown',e=>{e.preventDefault();try{b.setPointerCapture(e.pointerId)}catch(x){}talk(true)});
  ['pointerup','pointercancel','lostpointercapture'].forEach(ev=>b.addEventListener(ev,()=>talk(false)));
  b.addEventListener('contextmenu',e=>e.preventDefault());
});
$('leaveBtn').onclick=()=>{
  if(isHost){
    const next=[...conns.entries()].filter(([,c])=>c.name!=='…'&&!c.remote).sort((a,b)=>a[1].joined-b[1].joined)[0];
    if(next){
      if(!$('leaveBtn').dataset.sure){$('leaveBtn').dataset.sure=1;$('leaveBtn').textContent='Click again: '+next[1].name+' becomes host';setTimeout(()=>{delete $('leaveBtn').dataset.sure;$('leaveBtn').textContent='Leave room'},4000);return}
      handOver(next[0],true);return;
    }
  }
  leaving=true;
  if(!isHost&&hostConn&&hostConn.open)try{hostConn.send({t:'bye'})}catch(e){}
  setTimeout(()=>{try{peer&&peer.destroy()}catch(e){}history.replaceState(null,'',location.pathname);location.reload()},200);
};

/* drag & drop for host */
['dragenter','dragover'].forEach(ev=>stage.addEventListener(ev,e=>{if(!isHost)return;e.preventDefault();$('empty').classList.add('drag')}));
['dragleave','drop'].forEach(ev=>stage.addEventListener(ev,()=>$('empty').classList.remove('drag')));
stage.addEventListener('drop',e=>{
  if(!isHost)return;e.preventDefault();
  const files=[...e.dataTransfer.files],s=files.find(f=>/\.(srt|vtt|zip)$/i.test(f.name));
  addFiles(files.filter(isVideo));
  if(s)readSubFile(s);
});

/* keyboard and TV remote */
document.addEventListener('keydown',e=>{
  if(!inRoom()||$('modal').style.display==='grid')return;
  const typing=/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)&&!['range','checkbox'].includes(document.activeElement.type);
  if(typing)return;
  const tv=document.body.classList.contains('tv');
  if(tv)wake();
  if((e.key==='t'||e.key==='T')&&!e.repeat&&voice.on&&voice.ptt){talk(true);return}
  if(e.key===' '||e.key==='k'||e.key==='MediaPlayPause'){e.preventDefault();togglePlay()}
  else if(e.key==='Enter'&&tv&&(document.activeElement===document.body||document.activeElement===vid)){e.preventDefault();togglePlay()}
  else if(e.key==='Enter'&&document.fullscreenElement===stage){e.preventDefault();openFsChat()}
  else if(e.key==='f')toggleFs();
  else if(e.key==='l'||e.key==='L')setLaser(!laserOn);
  else if(e.key==='m')$('muteBtn').click();
  else if(e.key==='c')$('ccBtn').click();
  else if(e.key==='ArrowRight'&&document.activeElement.type!=='range'){e.preventDefault();seekTo(curTime()+10)}
  else if(e.key==='ArrowLeft'&&document.activeElement.type!=='range'){e.preventDefault();seekTo(curTime()-10)}
  else if(tv&&(e.key==='ArrowUp'||e.key==='ArrowDown')&&document.activeElement.type!=='range'){e.preventDefault();me.vol=Math.max(0,Math.min(1,me.vol+(e.key==='ArrowUp'?.1:-.1)));me.muted=false;$('vol').value=me.vol;applyVol();toast('Volume '+Math.round(me.vol*100)+'%')}
  else if(tv&&(e.key==='Escape'||e.key==='Backspace'||e.key==='GoBack'||e.keyCode===461)){e.preventDefault();setTV(false)}
});
document.addEventListener('keyup',e=>{if(e.key==='t'||e.key==='T')talk(false)});
window.addEventListener('blur',()=>talk(false));
window.addEventListener('beforeunload',e=>{
  if(isHost&&conns.size&&!leaving){e.preventDefault();e.returnValue=''}
});
window.addEventListener('pagehide',()=>{
  if(!isHost&&!leaving&&hostConn&&hostConn.open)try{hostConn.send({t:'bye'})}catch(e){}
  // host closing the tab: hand the room to the longest-present friend so the movie night carries on
  if(isHost&&!leaving){
    const next=[...conns.entries()].filter(([,c])=>c.name!=='…'&&!c.remote).sort((a,b)=>a[1].joined-b[1].joined)[0];
    if(next){try{next[1].conn.send({t:'becomeHost',st:handState()});broadcast({t:'hostChange',name:next[1].name},next[0])}catch(e){}}
  }
  try{peer&&peer.destroy()}catch(e){}
});

/* ---------- boot: messages and host hand-over after a reload ---------- */
const flash=sess.get('cc-flash');
if(flash){$('lobbyMsg').textContent=flash.msg;if(flash.code)$('joinCode').value=flash.code;if(flash.pw)$('joinPw').focus()}
renderNights();
if(night)showNight();
if(remoteMode)startRemoteMode();
$('langSel').value=lang;if(lang!=='en')translateAll();
$('langSel').onchange=e=>{lang=e.target.value;store.set('cc-lang',lang);translateAll()};
const boot=sess.get('cc-boot');
if(boot&&boot.code){
  $('name').value=boot.name||'';$('joinCode').value=boot.code;
  $('lobbyMsg').textContent=boot.act==='host'?'Becoming the host…':'Rejoining the room…';
  setTimeout(()=>{
    if(boot.act==='host')startHost({code:boot.code,name:boot.name,st:boot.st,voice:boot.voice});
    else startJoin({code:boot.code,name:boot.name,voice:boot.voice});
  },boot.delay||0);
}
}
