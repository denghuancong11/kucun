import fs from 'node:fs';
import path from 'node:path';

export function relocationAccounts() {
  const file = process.env.ASTER_WAREHOUSE_ACCOUNTS || path.join(import.meta.dirname, '.local-private/warehouse-accounts.local.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).accounts : [];
}
export function accountStore(account) {
  const value = String(account ?? '').trim();
  return value.endsWith('US') ? value : value.replace(/号$/, '') + 'US';
}
export function lingxingStore(storeName) {
  const match = String(storeName ?? '').trim().match(/^([A-Z0-9]+)-US\s+美国$/);
  return match ? match[1] + 'US' : null;
}
export function processRelocationAddress(store, original) {
  const account = relocationAccounts().find(item => accountStore(item.account) === store);
  if (!account?.shortName || !account?.room) throw new Error('账号 ' + store + ' 缺少地址表 B 列的简称或房间号，请核对账号映射');
  const raw = String(original ?? '').trim();
  if (!raw || /填写项|^XXX$/i.test(raw)) throw new Error('请填写供应商提供的实际原始移仓地址');
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .filter(line => !/^(第三方仓退货|FBA仓退货|海外仓调货退货)$/.test(line));
  const compact = line => line.replace(/[\s#:：()]/g, '');
  const content = lines.filter(line => !(/^RMA\s*[#:：]/i.test(line) && lines.some(other => other !== line && /\(RMA/i.test(other) && compact(other).includes(compact(line)))));
  const streetIndex = content.findIndex(line => /12000\s+Magnolia\s+Ave\b|323\s+Industrial\s+Court\b/i.test(line));
  if (streetIndex < 1) throw new Error('移仓地址未能识别 Aster CA／SC 仓街道及供应商联系人，请核对原地址');
  const contactIndex = streetIndex - 1;
  const { shortName, room } = account;
  if (!content[contactIndex].includes('-' + shortName)) {
    content[contactIndex] = content[contactIndex].replace(/\s*(\(RMA.*)?$/i, (_, rma) => '-' + shortName + (rma ? ' ' + rma : ''));
  }
  content[streetIndex] = content[streetIndex].replace(/(12000\s+Magnolia\s+Ave|323\s+Industrial\s+Court)(\s+of\s+[^,]+)?/i,
    (_, street, existing) => existing ? street + existing : street + ' of ' + room);
  return { original: raw, address: content.join('\n'), account: account.account, store, shortName, room, sourceCell: account.sourceCell };
}
