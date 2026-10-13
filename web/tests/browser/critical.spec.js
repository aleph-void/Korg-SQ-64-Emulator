import {test, expect} from './fixtures.js';
import {syntheticVsb} from '../fixtures.js';
function firmware(unsafe = true) {
  const bytes = syntheticVsb(), view = new DataView(bytes.buffer);
  view.setUint32(260,0x200009,true);
  bytes.set(unsafe ? [1,0x48,2,0x49,1,0x60,0xfe,0xe7] : [0xfe,0xe7],264);
  if (unsafe) { view.setUint32(272,0x40023c14,true); view.setUint32(276,1,true); }
  view.setUint16(256+65534,0,true);let sum=0;for(let i=256;i<256+65536;i+=2)sum+=view.getUint16(i,true);view.setUint16(256+65534,-sum&65535,true);
  return {name:'synthetic-critical.vsb',mimeType:'application/octet-stream',buffer:Buffer.from(bytes)};
}
for (const action of ['run','step','debug-step','reset']) test(`critical pass terminates worker during ${action} and requires a new session`, async ({page}) => {
  await page.goto('/');await page.locator('#browser-workbench').waitFor();
  const panel=page.frameLocator('#emulator-frame');await panel.locator('#image').setInputFiles(firmware());
  await panel.locator('#workbench-tab-inspect').click(); await panel.locator('#validate-image').click();await expect(panel.locator('#validation-summary')).toContainText('PASS');
  expect(await page.evaluate(()=>window.sq64Emulator.terminated || false)).toBe(false);
  const loadedHash=(await page.evaluate(()=>window.sq64Emulator.request('state'))).report.imageSha256;
  if(action==='debug-step') { await panel.locator('#workbench-tab-inspect').click(); await panel.getByText('Developer debugging',{exact:true}).click();await panel.locator('#debug-enabled').check();await panel.locator('#debug-step').click();await panel.locator('#debug-step').click(); }
  await panel.locator('#'+action).click();
  await expect(panel.locator('#safety-stop')).toContainText('Your custom firmware probably will brick your device. Do not flash it.');
  await expect(panel.locator('#run')).toBeDisabled();await expect(panel.locator('#reset')).toBeDisabled();
  const state=await page.evaluate(()=>window.sq64Emulator.request('state'));
  expect(state.running).toBe(false);expect(state.report.status).toBe('terminated');expect(state.report.critical.terminateOnCritical).toBe(true);
  expect(await page.evaluate(()=>window.sq64Emulator.worker === null)).toBe(true);
  expect(state.report.critical.results.find(r=>r.status==='pass')).toMatchObject({id:'CRITICAL-002',severity:'critical',unsafeWhen:'pass',imageSha256:loadedHash,address:0x40023c14});
  for(const command of ['run','step','reset','midi','replay','event','load']) expect(await page.evaluate(async name=>{try{await window.sq64Emulator.request(name);return 'resumed';}catch(e){return e.message;}},command)).toContain('Do not flash');
  const pending=page.waitForEvent('download');await panel.locator('#report').click();const stream=await(await pending).createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  expect(JSON.parse(Buffer.concat(chunks).toString()).critical).toEqual(state.report.critical);
  await expect(panel.locator('#image')).toBeDisabled();
  await page.reload();await page.locator('#browser-workbench').waitFor();
  await panel.locator('#image').setInputFiles(firmware(false));await expect(panel.locator('#safety-stop')).toHaveCount(0);await expect(panel.locator('#run')).toBeEnabled();
  await panel.locator('#workbench-tab-inspect').click(); await panel.locator('#step').click();expect((await page.evaluate(()=>window.sq64Emulator.request('state'))).report.critical.terminated).toBe(false);
});

test('installation context requires Update mode and is discarded by reset', async ({page}) => {
  await page.goto('/'); await page.locator('#browser-workbench').waitFor();
  const panel = page.frameLocator('#emulator-frame');
  await panel.locator('#image').setInputFiles(firmware(false));
  await expect(panel.locator('#run')).toBeEnabled();
  const candidate = {bytes: Array.from(syntheticVsb()), caps: {protocol: 1, packetSize: 1024, flags: 2}};
  const rejected = await page.evaluate(async data => {
    try { await window.sq64Emulator.request('prepare-update', data); return ''; }
    catch (error) { return error.message; }
  }, candidate);
  expect(rejected).toContain('Start Update mode');
  await panel.locator('#update').click();
  let state = await page.evaluate(data => window.sq64Emulator.request('prepare-update', data), candidate);
  expect(state.report.critical.installation.phase).toBe('prepared');
  expect(state.report.critical.installation.packetsSubmitted).toBe(0);
  await panel.locator('#reset').click();
  state = await page.evaluate(() => window.sq64Emulator.request('state'));
  expect(state.report.critical.installation).toBeUndefined();
  expect(state.report.critical.terminated).toBe(false);
});
