import test from 'node:test';
import assert from 'node:assert/strict';
import {UsbDevice} from '../emulator/usb.js';
import {packetBytes} from '../emulator/midi.js';
const device=()=>new UsbDevice({cycles:0,pend(){},emitMidi(){}});
test('host waits for soft-connect and reset recovery even when ENUMDNE remains masked',()=>{
 const u=device();u.write(0x18,1<<12);u.service();assert.equal(u.phase,'disconnected');
 u.write(0x804,0);u.service();assert.equal(u.phase,'reset');u.write(0x14,1<<12);u.service();assert.equal(u.phase,'enumeration');
 u.board.cycles=2159999;u.service();assert.equal(u.phase,'enumeration');u.board.cycles++;u.service();assert.equal(u.phase,'address');
 assert.ok(u.global & 1<<13);assert.deepEqual(u.setupActive,[0,5,1,0,0,0,0,0]);
});
test('SOF and idle IN polling remain visible to polling firmware without interrupt masks',()=>{
 const u=device();u.write(0x804,0);u.phase='configured';u.write(0x920,0x88040);u.board.cycles=216000;u.service();
 assert.ok(u.read(0x14)&8);assert.ok(u.read(0x928)&16);assert.equal(u.read(0x808)>>>8,1);
 u.write(0x928,16);assert.equal(u.read(0x928)&16,0);u.write(0x14,8);assert.equal(u.read(0x14)&8,0);
});
test('active OUT pipe delivers data followed by completion, but stalled pipes hold traffic',()=>{
 const u=device();u.write(0x804,0);u.phase='configured';u.write(0xb20,0x88040|(1<<21));u.inject([240,1,247]);u.service();assert.equal(u.rx.length,0);
 u.write(0xb20,0x88040);u.service();assert.equal(u.read(0x20),1|(4<<4)|(2<<17));assert.equal(u.read(0x1000),0xf701f027);assert.equal(u.read(0x20),1|(3<<17));assert.equal(u.pending.length,0);
});
test('zero USB-MIDI padding is ignored while malformed nonzero packets are rejected',()=>{
 assert.deepEqual(packetBytes(Uint8Array.of(0x15,247,0,0,0,0,0,0)).map(([c,b])=>[c,[...b]]),[[1,[247]]]);
 assert.throws(()=>packetBytes(Uint8Array.of(0,1,0,0)),/CIN/);
});
