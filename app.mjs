import {mergeCatalog, statusFor, visibleInProxyView, safeMediaURL, videoState, summarize, imagePayload, gatherICE} from './models.mjs';
import {RealtimeVoice} from './realtime.mjs';

const $ = id => document.getElementById(id);
let catalog = [], models = [], selected = null, kind = 'all', key = '', connected = false;
let controller = null, busy = false, peer = null, mic = null, channel = null, callPath = '', operation = 0;
let realtimeVoice=null, voiceWatchdog=null;
const urls = new Set();
const transcriptLines = [];
const defaults = {image:'A quiet mountain lake at sunrise, soft mist over the water, cinematic light, natural colors.',
  voice:'You are a warm, concise voice assistant. Help me brainstorm ideas for a weekend trip.',
  video:'A slow cinematic tracking shot over a quiet mountain lake at sunrise. Soft mist drifts across the water.'};

function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function message(text, failure = false) {
  $('output').replaceChildren();
  const el = document.createElement('div'); el.className = 'message' + (failure ? ' failure' : ''); el.textContent = text;
  $('output').append(el);
}
function details(value) { $('details').textContent = summarize(value); }
function objectURL(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
function clearOutput() {
  $('output').replaceChildren(); $('remoteAudio').srcObject = null; $('remoteAudio').removeAttribute('src');
  $('remoteAudio').hidden = true; $('transcript').hidden = true; $('transcript').textContent = ''; transcriptLines.length = 0;
  for (const url of urls) URL.revokeObjectURL(url); urls.clear();
}
function setBusy(value) {
  busy = value;
  $('run').disabled = busy || !connected || !selected || selected.adapter === 'unsupported';
  $('stop').disabled = !busy;
  $('connect').disabled = busy;
  for (const id of ['imageMode','imageSize','quality','imageFile','voice','seconds','videoSize','prompt']) $(id).disabled = busy;
  for (const card of document.querySelectorAll('.modelcard')) card.disabled = busy;
}
function currentModels() {
  const term = $('search').value.trim().toLowerCase();
  return models.filter(m => (kind === 'all' || m.kind === kind) && (!$('listedOnly').checked || visibleInProxyView(m)) &&
    `${m.id} ${m.title} ${m.provider}`.toLowerCase().includes(term));
}
function renderModels() {
  const list = $('modelList'); list.replaceChildren();
  const visible = currentModels(); $('modelCount').textContent = visible.length;
  for (const m of visible) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'modelcard' + (m.id === selected?.id ? ' selected' : '') + (m.listed ? ' listed' : '') + (m.hidden ? ' hiddenmodel' : '');
    button.disabled = busy; button.setAttribute('aria-pressed', String(m.id === selected?.id));
    const title = document.createElement('strong'); title.textContent = m.title || m.id;
    const provider = document.createElement('small'); provider.textContent = `${m.kind.toUpperCase()} / ${m.provider || 'Proxy'}`;
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = statusFor(m, connected);
    button.append(title, provider, tag); button.onclick = () => choose(m); list.append(button);
  }
  if (!visible.length) { const el = document.createElement('p'); el.className = 'hint'; el.textContent = connected ? 'No matching listed models or detected voice routes. Try another category, or uncheck “Hide reference catalog” to browse other models.' : 'Connect to load your media models and detect dedicated voice routes.'; list.append(el); }
}
function choose(m) {
  if (busy) return;
  const previous = selected; selected = m;
  $('selectedKind').textContent = `${m.kind.toUpperCase()} WORKSPACE`;
  $('selectedTitle').textContent = m.title || m.id; $('selectedID').textContent = m.id;
  $('selectedStatus').textContent = statusFor(m, connected);
  $('modelNote').textContent = m.note || 'Test this model through your proxy.';
  $('unsupported').hidden = m.adapter !== 'unsupported';
  $('imageOptions').hidden = m.kind !== 'image'; $('voiceOptions').hidden = m.kind !== 'voice'; $('videoOptions').hidden = m.kind !== 'video';
  const live = ['live','realtime-ws'].includes(m.adapter);
  $('promptLabel').textContent = live ? 'Conversation instructions' : m.adapter === 'speech' ? 'Text to speak' : 'Your prompt';
  $('voiceHint').textContent = m.adapter === 'realtime-ws' ? 'Realtime voice over WebSocket: microphone in, speech playback out. It uses the selected Realtime model and avoids WebRTC / UDP. A brief greeting plays after connecting.' : live ? 'Codex GPT-Live uses WebRTC. If media cannot connect, select gpt-realtime for WebSocket voice instead. Your browser asks for microphone permission when you start.' : 'Generate speech and play or download the returned audio. No microphone is needed.';
  $('voiceState').textContent = live ? 'Microphone off' : 'Speech playback';
  $('run').textContent = live ? 'Start voice session ↗' : m.kind === 'image' ? 'Generate image ↗' : m.kind === 'video' ? 'Generate video ↗' : 'Generate speech ↗';
  const voices = live ? ['marin','cedar','alloy','ash','coral','sage','verse'] : ['eve','ara','rex','sal','leo','luna','orion','iris','aurora','celeste','lumen'];
  $('voice').replaceChildren(...voices.map(v => { const option=document.createElement('option'); option.value=v; option.textContent=v; return option; }));
  if (!previous || previous.kind !== m.kind || (previous.adapter === 'speech') !== (m.adapter === 'speech')) $('prompt').value = m.adapter === 'speech' ? 'Hello! This is a voice demo through my local model proxy.' : defaults[m.kind];
  $('imageMode').value = 'generate'; $('imageFileWrap').hidden = true;
  $('imageMode').disabled = m.adapter !== 'image';
  renderModels(); setBusy(false); $('imageMode').disabled = m.adapter !== 'image';
}
async function api(path, options = {}) {
  if (!key) throw new Error('Connect with a proxy client key first.');
  if (!/^\/v(?:1|1beta)\//.test(path) || path.includes('://')) throw new Error('Only this proxy’s media endpoints are allowed.');
  const headers = new Headers(options.headers); headers.set('Authorization', `Bearer ${key}`);
  const response = await fetch(path, {...options, headers, signal: options.signal || controller?.signal});
  if (!response.ok) {
    const text = await response.text(); let error = text;
    try { const data = JSON.parse(text); error = data.error?.message || data.error || data.message || text; } catch {}
    throw new Error(`HTTP ${response.status}: ${typeof error === 'string' ? error.slice(0,1800) : JSON.stringify(error)}`);
  }
  return response;
}
async function jsonAPI(path, body) {
  const response = await api(path, body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}
async function connect(event) {
  event.preventDefault(); if (busy) return;
  key = $('apiKey').value.trim() || key;
  if (!key) { notice('Paste a proxy client API key to connect. This is different from the management key.',true); return; }
  $('connect').disabled = true;
  try {
    const response = await api('/v1/models'); const data = await response.json();
    if (!Array.isArray(data.data)) throw new Error('The proxy did not return a model list.');
    // A plain GET only detects the route. It does not create a voice session,
    // consume audio quota, or establish the selected account's entitlement.
    let voiceRouteDetected = false;
    try {
      const probe = await fetch('/v1/realtime', {headers:{Authorization:`Bearer ${key}`}});
      if (probe.status === 426) {
        const diagnostic = await probe.json();
        voiceRouteDetected = diagnostic.error?.code === 'websocket_upgrade_required';
      }
    } catch {}
    connected = true; models = mergeCatalog(catalog, data.data, {voiceRouteDetected});
    $('apiKey').value = ''; $('apiKey').placeholder = 'Connected · key held in memory';
    $('connectionState').textContent = `Connected · ${models.filter(m => m.listed).length} listed${voiceRouteDetected ? ' + voice route' : ''}`;
    notice(voiceRouteDetected ? 'Showing listed media models and detected voice routes. gpt-realtime uses WebSocket; GPT-Live uses WebRTC. Each session reports its actual model and connection status.' : 'Showing models listed by your proxy. No dedicated voice route was detected. Unrelated reference models are hidden by default.');
    choose(models.find(m => m.id === selected?.id && visibleInProxyView(m)) || models.find(m => m.listed && m.adapter !== 'unsupported') || models[0]);
  } catch (error) {
    connected = false; key = ''; models = mergeCatalog(catalog, []); renderModels(); setBusy(false);
    $('connectionState').textContent = 'Connection failed'; notice(error.message,true);
  } finally { $('connect').disabled = false; }
}
function addMedia(type, src, filename) {
  const figure = document.createElement('figure'); const media = document.createElement(type); media.src = src;
  if (type === 'img') media.alt = $('prompt').value;
  else { media.controls = true; media.preload = 'metadata'; }
  const caption = document.createElement('figcaption'); const link = document.createElement('a');
  link.href = src; link.download = filename; link.textContent = 'Open / download'; link.target = '_blank'; link.rel = 'noopener noreferrer';
  caption.append(link); figure.append(media, caption); $('output').append(figure);
}
function base64URL(data, type = 'image/png') {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); return objectURL(new Blob([bytes],{type}));
}
async function imageDemo(model, prompt) {
  if (model.adapter === 'gemini') {
    const payload = {contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseModalities:['TEXT','IMAGE']}};
    details({method:'POST',endpoint:'/v1beta/models/{model}:generateContent',body:payload});
    const result = await jsonAPI(`/v1beta/models/${encodeURIComponent(model.id)}:generateContent`,payload);
    details(result); $('output').replaceChildren(); let images = 0;
    for (const candidate of result.candidates || []) for (const part of candidate.content?.parts || []) {
      const inline=part.inlineData || part.inline_data;
      if (inline?.data && /^image\/(png|jpeg|webp)$/.test(inline.mimeType || inline.mime_type || 'image/png')) {
        addMedia('img',base64URL(inline.data,inline.mimeType || inline.mime_type),'image.png'); images++;
      }
      if (part.text) {const p=document.createElement('p'); p.className='message'; p.textContent=part.text; $('output').append(p);}
    }
    if (!images) throw new Error('No image returned. Check response details for safety or provider restrictions.');
    return;
  }
  const body = imagePayload(model.id,prompt,$('imageSize').value,$('quality').value);
  let result;
  if ($('imageMode').value === 'edit') {
    const file = $('imageFile').files[0];
    if (!file) throw new Error('Choose a reference image to edit.');
    if (file.size > 10*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('Use a PNG, JPEG, or WebP image up to 10 MB.');
    const form = new FormData(); Object.entries(body).forEach(([k,v]) => form.append(k,String(v))); form.append('image',file);
    details({method:'POST',endpoint:'/v1/images/edits',body:{...body,image:`${file.name} (${file.size} bytes)`}});
    const response=await api('/v1/images/edits',{method:'POST',body:form}); result=await response.json();
  } else {
    details({method:'POST',endpoint:'/v1/images/generations',body}); result=await jsonAPI('/v1/images/generations',body);
  }
  if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
  details(result); $('output').replaceChildren(); let count=0;
  for (const image of result.data || []) {
    const src = image.b64_json ? base64URL(image.b64_json, image.output_format === 'jpeg' ? 'image/jpeg' : image.output_format === 'webp' ? 'image/webp' : 'image/png') : safeMediaURL(image.url, location.origin);
    if (src) { addMedia('img',src,'image.png'); count++; }
  }
  if (!count) throw new Error('No supported image returned. See the response details.');
}
async function speechDemo(model,prompt) {
  const body={model:model.id,input:prompt,voice:$('voice').value,response_format:'mp3'};
  details({method:'POST',endpoint:'/v1/audio/speech',body});
  const response=await api('/v1/audio/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const blob=await response.blob(); if (!blob.size) throw new Error('The speech endpoint returned empty audio.');
  $('output').replaceChildren(); addMedia('audio',objectURL(blob),'speech.mp3'); details({content_type:blob.type,bytes:blob.size});
}
async function pause(ms, signal) {
  if (signal.aborted) throw new DOMException('Stopped','AbortError');
  await new Promise((resolve,reject) => {
    const onAbort=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}
async function videoDemo(model,prompt) {
  const body={model:model.id,prompt,duration:Number($('seconds').value),aspect_ratio:$('videoSize').value==='1280x720'?'16:9':'9:16',resolution:'720p'};
  const endpoint='/v1/videos/generations';
  details({method:'POST',endpoint,body}); let result=await jsonAPI(endpoint,body);
  const id=result.request_id || result.id;
  if (!id && videoState(result)==='pending') throw new Error('The video endpoint did not return a job ID.');
  while (true) {
    details(result); const state=videoState(result);
    if (state==='failed') throw new Error(result.error?.message || result.message || `Video job ${result.status || 'failed'}.`);
    if (state==='completed') break;
    message(`Video job ${id}\n${result.status || 'queued'}${result.progress!==undefined?' · '+result.progress+'%':''}\nPolling every 5 seconds. Stop ends polling; the provider job may continue.`);
    $('runState').textContent='Waiting for video…';
    await pause(5000,controller.signal); result=await jsonAPI(`/v1/videos/${encodeURIComponent(id)}`);
  }
  const src=safeMediaURL(result.video_url || result.video?.url || result.url || result.data?.[0]?.url,location.origin);
  if (!src) throw new Error('Video completed but returned no supported video URL. See response details.');
  $('output').replaceChildren(); addMedia('video',src,'video.mp4');
}
function appendTranscript(event) {
  if (event.type === 'error') { notice(event.error?.message || event.message || 'Voice session reported an error.',true); return; }
  if (/transcript|transcription|input_text|output_text/.test(event.type || '')) {
    if(/\.done$/.test(event.type)){transcriptLines.push('\n');return;}
    const text=event.delta || event.transcript || event.text;
    if (typeof text==='string') { transcriptLines.push(text); if (transcriptLines.length>500) transcriptLines.shift(); $('transcript').textContent=transcriptLines.join(''); $('transcript').hidden=false; }
  }
}
async function realtimeDemo(model,prompt,token) {
  const voiceSession=new RealtimeVoice({
    onReady:actualModel=>{
      if(token!==operation)return;
      $('voiceState').textContent=`Connected · ${actualModel} · microphone on`;
      $('runState').textContent='Voice session active';$('mute').hidden=false;
      message('Voice connected over WebSocket. A greeting will play shortly. Speak to continue the conversation.');
      details({transport:'WebSocket',requested_model:model.id,actual_model:actualModel,status:'connected'});
    },
    onAudio:()=>{if(token===operation)$('runState').textContent='Playing speech…';},
    onRecording:wav=>{
      if(token!==operation)return;
      $('output').replaceChildren();addMedia('audio',objectURL(new Blob([wav],{type:'audio/wav'})),'voice-reply.wav');
      $('runState').textContent='Voice session active';
    },
    onEvent:event=>{if(token!==operation)return;appendTranscript(event);if(!/audio\.delta|audio_buffer/.test(event.type || ''))details(event);},
    onError:async error=>{
      if(token!==operation)return;await stop();message(error.message,true);notice(error.message,true);
      $('runState').textContent='Voice connection failed';details({error:error.message,model:model.id,transport:'WebSocket'});
    },
  });
  realtimeVoice=voiceSession;
  details({transport:'WebSocket',endpoint:'/v1/realtime',model:model.id,status:'connecting'});
  await voiceSession.start({key,model:model.id,instructions:prompt,voice:$('voice').value,signal:controller.signal});
}
async function voiceDemo(model,prompt,token) {
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Voice needs HTTPS or localhost and a browser with microphone support.');
  const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
  if (token!==operation) {stream.getTracks().forEach(t=>t.stop()); throw new DOMException('Stopped','AbortError');}
  mic=stream; peer=new RTCPeerConnection(); const currentPeer=peer;
  currentPeer.ontrack=event=>{ $('remoteAudio').srcObject=event.streams[0] || new MediaStream([event.track]); $('remoteAudio').hidden=false; $('remoteAudio').play().catch(()=>notice('Voice audio is ready. Press play on the audio player if playback was blocked.')); };
  for (const track of stream.getTracks()) currentPeer.addTrack(track,stream);
  channel=currentPeer.createDataChannel('oai-events');
  channel.onclose=()=>{if(token===operation && busy){notice('The voice data channel closed. Microphone released.');stop();}};
  channel.onmessage=event=>{try{const data=JSON.parse(event.data);if(data.type==='error'){const text=data.error?.message || 'Voice service error';stop().then(()=>{notice(text,true);message(text,true);});return;}clearTimeout(voiceWatchdog);$('voiceState').textContent='Connected · microphone on';$('runState').textContent='Voice session active';appendTranscript(data);details(data);}catch{}};
  channel.onopen=()=>{ $('voiceState').textContent='Transport connected · waiting for voice'; $('runState').textContent='Waiting for voice…'; message('WebRTC transport connected. Waiting for the voice service. If no voice events arrive, try gpt-realtime WebSocket voice.'); };
  currentPeer.onconnectionstatechange=()=>{
    if (currentPeer.connectionState==='failed' && token===operation) {const text='The WebRTC media connection failed. Select gpt-realtime for WebSocket voice, which avoids UDP.';stop().then(()=>{notice(text,true);message(text,true);});}
  };
  const offer=await currentPeer.createOffer(); await currentPeer.setLocalDescription(offer);
  $('voiceState').textContent='Gathering network candidates…';
  const completeSDP=await gatherICE(currentPeer,controller.signal);
  const session={model:model.id,instructions:prompt,audio:{output:{voice:$('voice').value}}};
  details({method:'POST',endpoint:'/v1/realtime/calls',session,sdp:'[WebRTC offer omitted]'});
  const form=new FormData(); form.append('sdp',completeSDP); form.append('session',JSON.stringify(session));
  const response=await api('/v1/realtime/calls',{method:'POST',headers:{'OpenAI-Alpha':'quicksilver=v2'},body:form});
  const answer=await response.text();
  const locationHeader=response.headers.get('Location');
  if (locationHeader) { const url=new URL(locationHeader,location.origin); if (url.origin===location.origin && /^\/v1\/realtime\/calls\/[A-Za-z0-9_-]+$/.test(url.pathname)) callPath=url.pathname; }
  if (token!==operation) throw new DOMException('Stopped','AbortError');
  $('mute').hidden=false; $('voiceState').textContent='Connecting media…'; $('runState').textContent='Connecting voice…';
  message('Voice session created. Connecting microphone and audio…');
  await currentPeer.setRemoteDescription({type:'answer',sdp:answer});
  voiceWatchdog=setTimeout(async()=>{
    if(token!==operation)return;
    const text='WebRTC session setup succeeded, but the voice service returned no events or audio within 20 seconds. Select gpt-realtime for WebSocket voice. Your microphone has been released.';
    await stop();notice(text,true);message(text,true);$('runState').textContent='Voice media unavailable';
  },20000);
  details({status:response.status,call:callPath || 'created',model:model.id,canonical_model:'gpt-live-1-codex',sdp:'[answer omitted]'});
}
async function stop() {
  clearTimeout(voiceWatchdog);voiceWatchdog=null;
  operation++; controller?.abort(); controller=null;
  const socketVoice=realtimeVoice;realtimeVoice=null;await socketVoice?.stop();
  if (channel?.readyState==='open') {try{channel.send(JSON.stringify({type:'session.close'}));}catch{}}
  if(channel) {channel.onclose=null;channel.onopen=null;channel.onmessage=null;channel.close();} channel=null;
  if (peer) {peer.onconnectionstatechange=null; peer.ontrack=null; peer.close(); peer=null;}
  mic?.getTracks().forEach(t=>t.stop()); mic=null;
  $('remoteAudio').srcObject=null; $('remoteAudio').hidden=true; $('mute').hidden=true; $('mute').textContent='Mute microphone';
  $('voiceState').textContent='Microphone off';
  const closingPath=callPath; callPath='';
  setBusy(false); $('runState').textContent='Stopped';
  if (closingPath && key) {
    try {await api(closingPath+'/hangup',{method:'POST'});} catch(error) {notice(`Media stopped locally. Upstream hangup could not be confirmed: ${error.message}`,true);}
  }
}
async function run(event) {
  event.preventDefault(); if (busy || !selected || selected.adapter==='unsupported' || !connected) return;
  const model=selected,prompt=$('prompt').value.trim(); if (!prompt) return;
  clearOutput(); controller=new AbortController(); const token=++operation; setBusy(true);
  $('runState').textContent='Running…'; message(model.adapter==='live'?'Requesting microphone access…':'Sending your request…');
  const start=performance.now();
  try {
    if (model.adapter==='live') {await voiceDemo(model,prompt,token); return;}
    if (model.adapter==='realtime-ws') {await realtimeDemo(model,prompt,token);return;}
    if (model.kind==='image') await imageDemo(model,prompt);
    else if (model.adapter==='speech') await speechDemo(model,prompt);
    else if (model.kind==='video') await videoDemo(model,prompt);
    if (token!==operation) return;
    $('runState').textContent=`Completed in ${((performance.now()-start)/1000).toFixed(1)}s`;
    notice(`Demo succeeded for ${model.id}. Results are kept in this page until cleared or reloaded.`);
  } catch(error) {
    if (token!==operation) return;
    if (error.name==='AbortError') {message('Request stopped. A provider generation job may continue.'); $('runState').textContent='Stopped';}
    else {message(error.message,true);notice(error.message,true);details({error:error.message,model:model.id});$('runState').textContent='Demo failed';}
    if (['live','realtime-ws'].includes(model.adapter)) await stop();
  } finally { if (token===operation && !['live','realtime-ws'].includes(model.adapter)) {controller=null;setBusy(false);} }
}

$('connectForm').addEventListener('submit',connect);
$('demoForm').addEventListener('submit',run);
$('stop').onclick=()=>{const keepOutput=!!document.querySelector('#output audio, #output video, #output img');stop();if(!keepOutput)message(selected?.kind==='voice'?'Voice stopped. The microphone has been released.':'Stopped. If a video job was already created, it may continue at the provider.');};
$('disconnect').onclick=async()=>{await stop();key='';connected=false;$('apiKey').value='';$('apiKey').placeholder='Paste a client API key from management';$('connectionState').textContent='Disconnected';models=mergeCatalog(catalog,[]);choose(models.find(m=>m.id===selected?.id)||models[0]);notice('Disconnected. The client key has been removed from this page’s memory.');};
$('mute').onclick=()=>{if(realtimeVoice){const muted=realtimeVoice.mute(!realtimeVoice.muted);$('mute').textContent=muted?'Unmute microphone':'Mute microphone';$('voiceState').textContent=muted?'Connected · microphone muted':'Connected · microphone on';return;}if(!mic)return;const enabled=!mic.getAudioTracks()[0].enabled;mic.getAudioTracks().forEach(t=>t.enabled=enabled);$('mute').textContent=enabled?'Mute microphone':'Unmute microphone';$('voiceState').textContent=enabled?'Connected · microphone on':'Connected · microphone muted';};
$('clear').onclick=()=>{if(!busy){clearOutput();message('Ready for your next idea.');details({});}};
$('imageMode').onchange=()=>{$('imageFileWrap').hidden=$('imageMode').value!=='edit';$('run').textContent=$('imageMode').value==='edit'?'Edit image ↗':'Generate image ↗';};
$('search').oninput=renderModels; $('listedOnly').onchange=renderModels;
for (const button of document.querySelectorAll('[data-kind]')) button.onclick=()=>{kind=button.dataset.kind;document.querySelectorAll('[data-kind]').forEach(b=>b.classList.toggle('active',b===button));renderModels();};
window.addEventListener('pagehide',()=>{operation++;clearTimeout(voiceWatchdog);controller?.abort();realtimeVoice?.stop();mic?.getTracks().forEach(t=>t.stop());channel?.close();peer?.close();key='';});
try {
  const response=await fetch('./catalog.json',{cache:'no-store'}); if(!response.ok)throw new Error('Could not load the media catalog.');
  catalog=await response.json();models=mergeCatalog(catalog,[]);choose(models.find(m=>m.id==='gpt-realtime')||models[0]);
} catch(error) {notice(error.message,true);}
