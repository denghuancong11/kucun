// 比对指定schema29副本与schema30结果；只读，不执行迁移或业务写入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [beforePath,afterPath,output]=process.argv.slice(2);
if(!beforePath||!afterPath||!output) throw new Error('参数：迁移前数据库 迁移后数据库 结果JSON');
const before=new DatabaseSync(beforePath,{readOnly:true}),after=new DatabaseSync(afterPath,{readOnly:true}),checks=[];
const check=(name,fn)=>{fn();checks.push(name);};
const all=(db,sql)=>db.prepare(sql).all();
try {
  check('schema29→30，完整性和外键通过',()=>{assert.equal(before.prepare('PRAGMA user_version').get().user_version,29);assert.equal(after.prepare('PRAGMA user_version').get().user_version,30);assert.equal(after.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.deepEqual(all(after,'PRAGMA foreign_key_check'),[]);});
  for(const table of ['inventory_ledger','upgrade_inventory_ledger','upgrade_operations','stock_receipts','upgrade_relocation_external_items','lingxing_removal_shipments'])
    check(`${table}每条原记录保持不变`,()=>assert.deepEqual(all(after,`SELECT * FROM ${table} ORDER BY id`),all(before,`SELECT * FROM ${table} ORDER BY id`)));
  for(const sql of [
    'SELECT batch_key,on_hand,locked FROM stock_balances ORDER BY batch_key',
    'SELECT id,quantity,remaining_quantity FROM transit_batches ORDER BY id',
    'SELECT id,requested_quantity,approved_quantity,supplier_quantity,store_name FROM inquiry_documents ORDER BY id',
    'SELECT id,source_quantity_before,shipped_quantity,sold_quantity,completed_quantity FROM upgrade_relocations ORDER BY id',
  ]) check(sql,()=>assert.deepEqual(all(after,sql),all(before,sql)));
  check('所有旧完成操作按操作ID分别接续，不按版本名合并',()=>{
    const operations=all(before,"SELECT o.* FROM upgrade_operations o JOIN upgrade_relocation_work_items w ON w.relocation_id=o.relocation_id WHERE o.operation_type='relocation_complete'");
    for(const op of operations) assert.ok(after.prepare('SELECT id FROM upgrade_completion_details WHERE id=? AND operation_id=?').get('COMP-'+op.operation_no,op.id));
  });
  check('8条询库重新可见、零回复拒绝、待办采购接续',()=>{
    assert.equal(after.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE hidden_at IS NULL').get().n,8);
    assert.equal(after.prepare('SELECT status FROM inquiry_documents WHERE id=6').get().status,'rejected');
    for(const id of [5,9])assert.equal(after.prepare('SELECT status FROM inquiry_documents WHERE id=?').get(id).status,'pending_procurement');
  });
  check('v111原1件及套/箱4保留，不新增入账；MOVE-WORK-4由物流接续',()=>{
    const d=after.prepare("SELECT d.*,b.pack_per_box,b.shipping_method,s.on_hand FROM upgrade_completion_details d JOIN stock_batches b ON b.batch_key=d.batch_key JOIN stock_balances s ON s.batch_key=b.batch_key WHERE d.id='COMP-UOP-00000007'").get();
    assert.equal(d.quantity,1);assert.equal(d.on_hand,1);assert.equal(d.version,'v111');assert.equal(d.pack_per_box,'4');assert.equal(d.shipping_method,'Aster海外仓-升级后库存');
    assert.equal(after.prepare('SELECT status FROM upgrade_relocation_work_items WHERE id=4').get().status,'awaiting_procurement');
  });
  const facts={inquiries:all(after,'SELECT id,status,hidden_at FROM inquiry_documents ORDER BY id'),workItems:all(after,'SELECT id,status,source_quantity_before,shipped_quantity,sold_quantity FROM upgrade_relocation_work_items ORDER BY id'),completionDetails:all(after,'SELECT id,work_id,quantity,version,warehouse FROM upgrade_completion_details ORDER BY rowid'),balances:all(after,'SELECT batch_key,on_hand,locked FROM stock_balances ORDER BY batch_key')};
  fs.writeFileSync(output,JSON.stringify({beforePath,afterPath,passed:checks.length,checks,facts},null,2));
  console.log(JSON.stringify({passed:checks.length,output}));
} finally {before.close();after.close();}
