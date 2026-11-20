import test from 'node:test';
import assert from 'node:assert/strict';
import {inferKind, mergeCatalog, adapterFor, statusFor, visibleInProxyView, safeMediaURL, videoState, imagePayload, gatherICE, speechFormat, sampleRequest} from './models.mjs';
import {encodePCM16,decodePCM16,pcmWav} from './realtime.mjs';

test('HeyGen speech uses its required PCM format and playback sample rate',()=>{
  assert.deepEqual(speechFormat({id:'openrouter/heygen/heygen-voice-1-turbo:free'}),{format:'pcm',rate:44100});
  assert.deepEqual(speechFormat({id:'openrouter/fish-audio/s2.1-pro-free:free'}),{format:'mp3'});
  const wav=pcmWav([new Uint8Array([0,0,1,0])],44100);
  assert.equal(new DataView(wav.buffer).getUint32(24,true),44100);
});

test('input vision does not imply image generation', () => {
  assert.equal(inferKind({id:'gpt-6.1-sol', supportedInputModalities:['text','image'], supportedOutputModalities:['text']}), null);
  assert.equal(inferKind({id:'custom-picture', supportedOutputModalities:['IMAGE']}), 'image');
  assert.equal(inferKind({id:'org/flux-schnell'}), 'image');
});
test('discovery preserves hidden voice and provider-prefixed models', () => {
  const models = mergeCatalog([{id:'gpt-live-1-codex',kind:'voice',adapter:'live'}, {id:'gpt-image-2',kind:'image',adapter:'image'}], [{id:'codex/gpt-image-2',owned_by:'codex'}, {id:'gpt-image-2'}]);
  assert.equal(models.length, 3);
  assert.equal(models.find(m => m.id === 'codex/gpt-image-2').listed, true);
  assert.equal(statusFor(models.find(m => m.id === 'gpt-live-1-codex'), true), 'Voice route not detected');
});
test('proxy view includes detected voice without claiming entitlement or showing reference aliases', () => {
  const catalog = [
    {id:'gpt-live-1-codex',kind:'voice',adapter:'live'},
    {id:'gpt-realtime',kind:'voice',adapter:'realtime-ws'},
    {id:'gpt-realtime-2.1',kind:'voice',adapter:'realtime-ws'},
    {id:'grok-imagine-video',kind:'video',adapter:'video'},
    {id:'gpt-image-2',kind:'image',adapter:'image'},
  ];
  const discovered = [{id:'gpt-image-2'}];
  const withoutRoute = mergeCatalog(catalog,discovered);
  assert.deepEqual(withoutRoute.filter(visibleInProxyView).map(m=>m.id),['gpt-image-2']);
  const withRoute = mergeCatalog(catalog,discovered,{voiceRouteDetected:true});
  assert.deepEqual(withRoute.filter(visibleInProxyView).map(m=>m.id),['gpt-image-2','gpt-live-1-codex','gpt-realtime']);
  assert.equal(statusFor(withRoute.find(m=>m.id==='gpt-live-1-codex'),true),'Voice route · access unverified');
  assert.equal(withRoute.find(m=>m.id==='gpt-live-1-codex').listed,false);
});
test('PCM encoding preserves sign and little-endian samples; WAV contains real sample bytes',()=>{
  const bytes=encodePCM16(new Float32Array([-1,0,1]));
  assert.deepEqual([...bytes],[0,128,0,0,255,127]);
  const samples=decodePCM16(bytes);assert.equal(samples[0],-1);assert.equal(samples[1],0);assert.ok(samples[2]>0.99);
  assert.equal(encodePCM16(new Float32Array(480),48000,24000).length,480);
  const wav=pcmWav([bytes]);assert.equal(wav.length,50);assert.equal(new DataView(wav.buffer).getUint32(40,true),6);
  assert.deepEqual([...wav.slice(44)],[...bytes]);
});
test('WebRTC sends the gathered local description instead of the initial candidate-free offer',async()=>{
  class Peer extends EventTarget {iceGatheringState='gathering';localDescription={sdp:'initial'};}
  const peer=new Peer(),pending=gatherICE(peer);
  peer.localDescription.sdp='complete offer with candidates';peer.iceGatheringState='complete';peer.dispatchEvent(new Event('icegatheringstatechange'));
  assert.equal(await pending,'complete offer with candidates');
  const waiting=new Peer(),abort=new AbortController(),cancelled=gatherICE(waiting,abort.signal);abort.abort();
  await assert.rejects(cancelled,{name:'AbortError'});
});
test('unsupported routes and aliases are not misrepresented', () => {
  assert.equal(adapterFor('gpt-live-1','voice'), 'unsupported');
  assert.equal(adapterFor('tts-1','voice'), 'unsupported');
  assert.equal(adapterFor('sora-2','video'), 'unsupported');
  assert.equal(adapterFor('imagen-4.0-generate-001','image'), 'unsupported');
  assert.equal(adapterFor('gemini-3.1-flash-image','image'), 'gemini');
  assert.equal(adapterFor('grok-imagine-video-1.5-lite','video'), 'unsupported');
});
test('media URL filtering rejects executable URLs and credentials', () => {
  const origin='http://127.0.0.1:8317';
  assert.equal(safeMediaURL('javascript:alert(1)', origin),null);
  assert.equal(safeMediaURL('https://key@evil.test/a',origin),null);
  assert.equal(safeMediaURL('http://elsewhere.test/a',origin),null);
  assert.equal(safeMediaURL('/v1/videos/id/content',origin),origin+'/v1/videos/id/content');
});
test('terminal failed video jobs do not poll forever', () => {
  assert.equal(videoState({status:'done'}),'completed');
  assert.equal(videoState({status:'cancelled'}),'failed');
  assert.equal(videoState({status:'queued',error:{message:'bad'}}),'failed');
  assert.equal(videoState({status:'processing'}),'pending');
});
test('automatic image options are omitted for provider compatibility', () => {
  assert.deepEqual(imagePayload('gpt-image-2','hello','auto','auto'),{model:'gpt-image-2',prompt:'hello',n:1,response_format:'b64_json'});
});

test('all OpenRouter output families use discovered endpoints instead of name guesses',()=>{
  const live=[
    {id:'openrouter/vendor/embed:free',architecture:{output_modalities:['embeddings']},endpoints:['/api/v1/embeddings'],media_gateway:true},
    {id:'openrouter/vendor/voice:free',architecture:{output_modalities:['speech']},endpoints:['/api/v1/audio/speech'],media_gateway:true,supported_voices:['nadine']},
    {id:'openrouter/vendor/picture:free',architecture:{output_modalities:['image']},endpoints:['/api/v1/images'],media_gateway:true},
    {id:'openrouter/vendor/music',architecture:{output_modalities:['text','audio']},endpoints:['/api/v1/chat/completions'],media_gateway:true},
    {id:'openrouter/vendor/movie:free',architecture:{output_modalities:['video']},endpoints:['/api/v1/videos'],media_gateway:true},
  ];
  const models=mergeCatalog([],live);
  assert.equal(models.find(m=>m.id===live[0].id).adapter,'json');
  assert.equal(models.find(m=>m.id===live[1].id).adapter,'speech');
  assert.deepEqual(models.find(m=>m.id===live[1].id).voices,['nadine']);
  assert.equal(models.find(m=>m.id===live[2].id).adapter,'openrouter-image');
  assert.equal(models.find(m=>m.id===live[3].id).adapter,'chat-media');
  assert.equal(models.find(m=>m.id===live[4].id).adapter,'video');
});
test('all provider namespaces expose declared media APIs and transcription uploads',()=>{
 const live=[{id:'groq/whisper-large-v3',media_gateway:true,endpoints:['/api/v1/audio/transcriptions'],architecture:{output_modalities:['transcription']}},
 {id:'freehub/provider/picture',media_gateway:true,endpoints:['/api/v1/images/generations'],architecture:{output_modalities:['image']}},
 {id:'nvidia/embed',media_gateway:true,endpoints:['/api/v1/embeddings'],architecture:{output_modalities:['embeddings']}},
 {id:'freehub/provider/live',media_gateway:true,endpoints:['/api/v1/realtime'],architecture:{output_modalities:['audio']}}];
 const models=mergeCatalog([],live);for(const [i,adapter]of ['transcription','image','json','realtime-ws'].entries())assert.equal(models.find(m=>m.id===live[i].id).adapter,adapter);
});


test('chat media preserves output modalities without an architecture object', () => {
  const [model] = mergeCatalog([], [{id: 'provider/music', media_gateway: true,
    supported_output_modalities: ['text', 'audio'], endpoints: ['/v1/chat/completions']}]);
  assert.equal(model.adapter, 'chat-media');
  assert.deepEqual(model.architecture.output_modalities, ['text', 'audio']);
  assert.deepEqual(model.endpoints, ['/api/v1/chat/completions']);
});

test('specialized JSON discovery uses normalized endpoints and matching sample requests', () => {
  const [model] = mergeCatalog([], [{id: 'provider/embeddings', media_gateway: true,
    output_modalities: ['embeddings'], endpoints: ['/v1/embeddings']}]);
  assert.equal(model.kind, 'other');
  assert.equal(model.adapter, 'json');
  assert.deepEqual(sampleRequest(model), {input: 'A quiet mountain lake at sunrise.'});
  assert.deepEqual(sampleRequest({endpoints: ['/api/v1/moderations']}), {input: 'A friendly greeting.'});
});
