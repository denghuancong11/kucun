import fs from 'node:fs/promises';import {execFileSync} from 'node:child_process';
export const relocationAddressFixture='Supplier (RMA#: R616738)\n12000 Magnolia Ave, Suite#101\nRiverside, CA 92503 US\nTEL:555000000';
// Independently edit the actual downloaded template; keep only explicitly selected work numbers.
export async function relocationUpdateFixture(base,file,rows) {
 const response=await fetch(base+'/api/upgrades/relocation-update/template',{headers:{'x-role':'logistics'}});if(!response.ok)throw new Error(await response.text());await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
 execFileSync(process.env.ASTER_TEST_PYTHON||'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',['-X','utf8','-c',`import openpyxl,sys,json\nw=openpyxl.load_workbook(sys.argv[1]);s=w['移仓升级'];data=json.loads(sys.argv[2])\nfor n in range(s.max_row,2,-1):\n key=str(s.cell(n,1).value)\n if key not in data: s.delete_rows(n);continue\n s.cell(n,12,data[key]['rma']);s.cell(n,13,data[key]['address'])\nw.save(sys.argv[1])`,file,JSON.stringify(Object.fromEntries(rows.map(r=>[r.workNo,{rma:r.rma,address:r.address||relocationAddressFixture}])) )],{windowsHide:true});return file;
}
