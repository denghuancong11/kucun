import fs from 'node:fs';
import path from 'node:path';

const file = process.env.ASTER_WAREHOUSE_ACCOUNTS || path.join(import.meta.dirname,'.local-private','warehouse-accounts.local.json');
export function accountForStore(store) {
  if (!fs.existsSync(file)) return {issue:'缺少海外仓账号资料，请联系管理员补充。'};
  const accounts=JSON.parse(fs.readFileSync(file,'utf8')).accounts;
  const account=accounts.find(row=>row.stores.includes(String(store || '').trim()));
  if (!account) return {issue:String(store || '').trim() ? `店铺‘${store}’未配置公司账号，请联系管理员核对。` : '请补充来源店铺。'};
  if (!account.shortName || !account.room) return {issue:`账号 ${account.account} 缺少英文简称或房间号，请联系管理员补充。`};
  return account;
}

export function lingxingStoreCode(name) {
  // 仅把 AUS / A-US 美国这种相同账号的显示格式统一，不建立跨账号别名。
  const match=String(name || '').trim().match(/^([A-Z0-9]+?)-?US(?:\s+美国)?$/);
  return match ? `${match[1]}US` : null;
}

export function processWarehouseAddress({store,rma,raw,contact='',street=''}) {
  const account=accountForStore(store);
  if (account.issue) return {processed:'',issue:account.issue,contact,street};
  const text=String(raw || '').trim();
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const first=lines[0] || '';
  if (!contact) contact=first.replace(/^(?:联系人|收件人|Contact|Name)\s*[:：]\s*/i,'').split(/\s*[（(]\s*RMA/i)[0].trim();
  if (!street) {
    const line=lines.find((value,index)=>index>0 && /^(?:(?:地址|Address)(?:\s*1)?\s*[:：]\s*)?\d+\s+\S/i.test(value));
    if (line) street=line.replace(/^(?:地址|Address)(?:\s*1)?\s*[:：]\s*/i,'').split(/,\s*(?:Suite|Ste|Unit|Apt)\b/i)[0].trim();
  }
  if (!contact || !street || !text.includes(contact) || !text.includes(street) || /^\d/.test(contact)) {
    return {processed:'',issue:'无法识别原始地址中的联系人或街道，请补填原文中的联系人和街道片段',contact,street};
  }
  const originalRma=text.match(/RMA\s*#?\s*[:：]?\s*([A-Za-z0-9-]+)/i)?.[1];
  if (originalRma && originalRma!==rma) return {processed:'',issue:`原地址RMA ${originalRma} 与本次 ${rma} 不一致，请核对原文`,contact,street};
  let processed=text.replace(contact,`${contact}-${account.shortName}${originalRma?'':` (RMA#: ${rma})`}`);
  processed=processed.replace(street,`${street} of ${account.room}`);
  return {processed,issue:'',contact,street};
}
