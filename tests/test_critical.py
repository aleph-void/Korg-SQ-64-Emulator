import struct
import unittest
from helpers import image
from sq64_emulator.core import Machine
from sq64_emulator.critical import CriticalMonitor, CriticalHazard
from sq64_emulator.flash import SpiFlash

class CriticalTests(unittest.TestCase):
    def test_arm_stops_and_cannot_continue(self):
        for address, value in ((0x200020,1),(0x8000020,1),(0x40023c10,0x10002),(0x40023c08,1),(0x40023c14,1),(0x1ff0f000,1)):
            with self.subTest(address=hex(address)):
                m=Machine(image(bytes.fromhex('014802490160fee7')+struct.pack('<II',address,value)))
                report=m.run(20); self.assertEqual(report['status'],'terminated',report['error'])
                hit=next(r for r in report['critical']['results'] if r['status']=='pass')
                self.assertEqual(hit['severity'],'critical'); self.assertEqual(hit['unsafeWhen'],'pass')
                self.assertEqual(hit['imageSha256'],m.image.sha256); self.assertEqual(hit['address'],address)
                self.assertIn('Do not flash',report['error'])
                ticks=m.board.ticks; m.run(20); self.assertEqual(m.board.ticks,ticks)
                self.assertEqual(bytes(m.uc.mem_read(0x200020,4)),bytes(4))
                self.assertEqual(bytes(m.uc.mem_read(0x8000020,4)),bytes(4))
    def test_spi_guards_precede_mutation(self):
        for command in ([2,0,0,0,42],[32,0,0,0],[216,2,255,255],[199],[96],[1],[0x42],[255]):
            monitor=CriticalMonitor('a'*64); flash=SpiFlash(critical=monitor)
            flash.data[0]=3; flash.enabled=True; flash.select(True)
            with self.assertRaises(CriticalHazard):
                for b in command: flash.exchange(b)
            self.assertEqual(flash.writes,0); self.assertEqual(flash.data[0],3)
    def test_dma_secondary_buffer_and_boundary(self):
        for control,target in ((1,0x8000000),(1025,0x1fffffff),(0x40001,0x20000100)):
            values={0x40026010:control,0x40026014:8,0x4002601c:target,0x40026020:0x40023c14}
            monitor=CriticalMonitor('a'*64)
            with self.assertRaises(CriticalHazard): monitor.dma(lambda a:values.get(a,0))
            self.assertEqual(monitor.hit['source'],'dma')
    def test_staging_and_no_hazard_are_not_safety_certificates(self):
        monitor=CriticalMonitor('a'*64); flash=SpiFlash(critical=monitor); flash.enabled=True; flash.select(True)
        for b in [2,4,0,0,42]: flash.exchange(b)
        self.assertEqual(flash.data[0x40000],42); self.assertFalse(monitor.report()['terminated'])
        self.assertTrue(all(r['status']=='not-run' for r in monitor.report()['results']))
        self.assertIn('not proof',monitor.report()['claim'])

    def test_native_api_latches_warning_and_requires_new_session(self):
        import http.client, json, threading
        from sq64_emulator.server import Workbench, make_server
        code=image(bytes.fromhex('014802490160fee7')+struct.pack('<II',0x40023c14,1))
        work=Workbench(code); server=None
        try:
            loaded_hash=work.machine.image.sha256
            work.reset('normal'); self.assertEqual(work.machine.critical.image_sha256,loaded_hash)
            server=make_server(work); threading.Thread(target=server.serve_forever,daemon=True).start()
            connection=http.client.HTTPConnection('127.0.0.1',server.server_port)
            connection.request('GET','/api/session'); token=json.loads(connection.getresponse().read())['token']
            def post(name,data=None):
                connection.request('POST','/api/'+name,data if isinstance(data,bytes) else json.dumps(data or {}),{'X-Session-Token':token})
                response=connection.getresponse();return response.status,json.loads(response.read())
            code,state=post('step',{'instructions':20}); self.assertEqual(code,200);self.assertEqual(state['report']['status'],'terminated')
            critical=state['report']['critical'];self.assertEqual(critical['imageSha256'],loaded_hash)
            for name in ('run','step','reset','event','replay','storage','load'):
                status,data=post(name);self.assertEqual(status,400);self.assertIn('Do not flash',data['error'])
            self.assertEqual(post('load',b'bad')[0],400);self.assertEqual(post('state')[1]['report']['critical'],critical)
            self.assertEqual(post('load',image())[0],400)
            self.assertIsNone(work.machine); self.assertFalse(work.running); self.assertTrue(work.stop.is_set())
            replacement=Workbench(image())
            try: self.assertFalse(replacement.state()['report']['critical']['terminated'])
            finally: replacement.close()
            connection.close()
        finally:
            if server:server.shutdown();server.server_close()
            work.close()

    def test_arm_spi_and_dma_hazards(self):
        def stores(writes):
            code=bytearray(65536); struct.pack_into('<II',code,0,0x20040000,0x200009)
            pool=(8+len(writes)*6+2+3)&~3
            for i,(address,value,size) in enumerate(writes):
                pc=8+i*6;literal=pool+i*8
                struct.pack_into('<HHH',code,pc,0x4800|((literal-((pc+4)&~3))//4),0x4900|((literal+4-((pc+6)&~3))//4),0x7001 if size==1 else 0x6001)
                struct.pack_into('<II',code,literal,address,value)
            struct.pack_into('<H',code,8+len(writes)*6,0xe7fe);return bytes(code)
        scenarios=[([(0x40020418,0x02000000,4),(0x4000380c,199,1)],'CRITICAL-003'),
                   ([(0x40020418,0x02000000,4)]+[(0x4000380c,v,1) for v in (2,0,0,0,42)],'CRITICAL-004'),
                   ([(0x40026014,8,4),(0x40026018,0x4000380c,4),(0x4002601c,0x8000020,4),(0x40026010,1,4)],'CRITICAL-001')]
        for writes,identifier in scenarios:
            m=Machine(stores(writes));report=m.run(100)
            self.assertEqual(report['status'],'terminated',report['error']);self.assertEqual(m.critical.hit['id'],identifier);self.assertEqual(m.board.flash.writes,0)
