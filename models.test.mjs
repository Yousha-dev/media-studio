import test from 'node:test';
import assert from 'node:assert/strict';
import {inferKind, mergeCatalog, adapterFor, statusFor, visibleInProxyView, safeMediaURL, videoState, imagePayload, gatherICE} from './models.mjs';
import {encodePCM16,decodePCM16,pcmWav} from './realtime.mjs';

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
