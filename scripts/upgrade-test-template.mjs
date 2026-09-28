// 隔离 HTTP 验收共用的真实导出→回填→预览步骤；不直接写业务表。
import assert from 'node:assert/strict';
import { UPGRADE_COLUMNS } from '../upgrade-template.mjs';
export async function prepareFlowUpdate(base, api, id, patches, progressQuantity) {
  const exported=await api('/api/upgrades/template','logistics',{ids:[id]});
  const rows=exported.rows.map((r,n)=>({...r,...(progressQuantity===undefined?{}:{progressQuantity}),...patches[n]}));
  const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  const csv=[UPGRADE_COLUMNS.map(c=>c[1]),...rows.map(r=>UPGRADE_COLUMNS.map(c=>r[c[0]]))].map(row=>row.map(quote).join(',')).join('\r\n');
  const response=await fetch(base+'/api/upgrades/update/preview',{method:'POST',headers:{'x-role':'logistics','x-file-name':'acceptance.csv'},body:csv});
  const preview=await response.json();assert.equal(response.status,200,JSON.stringify(preview));
  return {previewToken:preview.previewToken,rows:preview.rows,requestId:crypto.randomUUID()};
}
export const SAMPLE_ADDRESS='Mirella RW\n12000 Magnolia Ave, Suite#101\nRiverside CA 92503';
