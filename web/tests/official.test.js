import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync, inflateRawSync} from 'node:zlib';
import {extractVsb, crc32, verifyOfficial203, fetchOfficial203, OFFICIAL_203} from '../emulator/official.js';
import {syntheticVsb} from './fixtures.js';
function zip(data, method=8) {
  const name=Buffer.from('test.VSB'), packed=method===8?deflateRawSync(data):data;
  const local=Buffer.alloc(30+name.length), central=Buffer.alloc(46+name.length), end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method,8);local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);name.copy(local,30);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(crc32(data),16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);name.copy(central,46);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length+packed.length,16);
  return Buffer.concat([local,packed,central,end]);
}
const inflate=async bytes=>new Uint8Array(inflateRawSync(bytes));
test('original ZIP fixtures unpack stored and deflated images and validate CRC',async()=>{
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const data=syntheticVsb();for(const method of[0,8])assert.deepEqual(await extractVsb(zip(data,method),inflate),data);
  const broken=zip(data,0);broken[40]^=1;await assert.rejects(extractVsb(broken,inflate),/checksum|match/);
});
test('ZIP bounds, encryption, unsupported methods and directory disagreement are rejected',async()=>{
  const valid=zip(syntheticVsb());
  for(const mutate of[
    b=>b.subarray(0,b.length-1),
    b=>{b.writeUInt32LE(0xffffffff,b.length-6);return b;},
    b=>{b.writeUInt16LE(1,b.length-22+4);return b;},
    b=>{b[8]=99;return b;},
    b=>{b[6]=1;return b;},
  ])await assert.rejects(extractVsb(mutate(Buffer.from(valid)),inflate));
  await assert.rejects(extractVsb(new Uint8Array(4*1024*1024+1)),/oversized/);
});
test('official load rejects arbitrary valid firmware and leaves CORS enabled',async()=>{
  await assert.rejects(verifyOfficial203(syntheticVsb()),/verified official/);
  let request;
  await assert.rejects(fetchOfficial203({fetcher:async(url,options)=>{request={url,options};return new Response('bad',{status:503});}}),/unavailable/);
  assert.equal(request.url,OFFICIAL_203.url);assert.equal(request.options.mode,'cors');assert.equal(request.options.credentials,'omit');
});
