import sys,json,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import requests
from bilifav import server
from bilifav.sorter import normalize_item

class Checks(unittest.TestCase):
 def test_ui_patch_merge_security_and_failure(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'prefs.json';path.write_text(json.dumps({'ui':{'old':'keep'},'misc':{'fold':True},'shortcuts':{'x':'Ctrl+J'}}),encoding='utf-8')
   with patch.object(server,'prefs_file',return_value=path),patch.object(server.CTX,'ensure_loaded',side_effect=AssertionError('must stay local')):
    httpd=server.Server(('127.0.0.1',0),server.Handler,'fake-test-token');worker=threading.Thread(target=httpd.serve_forever,daemon=True);worker.start();url='http://127.0.0.1:'+str(httpd.server_address[1]);endpoint=url+'/api/prefs/ui-patch';body={'ui':{'bilifav.boxW':'470'}}
    try:
     self.assertEqual(requests.get(endpoint,timeout=3).status_code,405)
     self.assertEqual(requests.post(endpoint,json=body,timeout=3).status_code,403)
     self.assertEqual(requests.post(endpoint,json=body,headers={'X-Token':'fake-test-token','Origin':'https://untrusted.invalid'},timeout=3).status_code,403)
     self.assertTrue(requests.post(endpoint,json=body,headers={'X-Token':'fake-test-token','Origin':url},timeout=3).json()['ok'])
    finally:httpd.shutdown();httpd.server_close();worker.join(5)
    threads=[threading.Thread(target=lambda i=i: server.api_prefs_ui_patch({'ui':{str(i):str(i)}},{})) for i in range(30)]
    for t in threads:t.start()
    for t in threads:t.join(5)
    data=json.loads(path.read_text(encoding='utf-8'));self.assertEqual(data['misc'],{'fold':True});self.assertEqual(data['shortcuts'],{'x':'Ctrl+J'});self.assertEqual(data['ui']['old'],'keep');self.assertEqual(data['ui']['bilifav.boxW'],'470');self.assertTrue(all(data['ui'][str(i)]==str(i) for i in range(30)))
    before=path.read_bytes()
    self.assertFalse(server.api_prefs_ui_patch({'ui':{'__proto__':'x'}},{})['ok'])
    with patch.object(server.os,'replace',side_effect=OSError('simulated failure')):self.assertFalse(server.api_prefs_ui_patch({'ui':{'new':'v'}},{})['ok'])
    self.assertEqual(path.read_bytes(),before)
 def test_owner_metadata(self):
  self.assertEqual(normalize_item({'id':42,'upper':{'mid':7,'name':'mock','face':'//fake.invalid/avatar.png'}})['upper_info'],{'mid':7,'name':'mock','face':'//fake.invalid/avatar.png'})
  self.assertEqual(normalize_item({'id':43})['upper_info']['face'],'')

if __name__=='__main__':unittest.main()
