// Category permission regression: filenames do not override an existing model's category.
// Temporary SQLite and owned localhost server only; no formal service/data calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInventoryDatabase,InventoryDatabase} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..'),output=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/transit-import-permissions');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-transit-import-permissions-'));
await fs.mkdir(output,{recursive:true});createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),roles=['admin','assistant-1','assistant-2','operation-1','operation-2','purchasing','business'];
const permissionPath=path.join(state,'data/permissions.json');
async function permission(actions){await fs.writeFile(permissionPath,JSON.stringify({墨盒:Object.fromEntries(roles.map(r=>[r,{summary:true,detail:true,expand:true,actions:r==='assistant-1'?actions:true}]))}));}
await permission(false);const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('transit-import-permissions');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],failures=[],evidence=[];
const snapshot=()=>Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.db.prepare('SELECT * FROM "'+name+'"').all()]));
function check(name,condition){if(condition){checks.push(name);console.log('PASS '+name);}else{failures.push(name);console.log('FAIL '+name);}}
function csv(plan,model='SYNTH-INK-001'){return `ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n${model},7,4,XPERMISSION,SyntheticWarehouseB,${plan},2026-10-08,一团,V1`;}
async function preview(fileName,content){const response=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'assistant-1','x-file-name':encodeURIComponent(fileName)},body:content});const result=await response.json();evidence.push({action:'preview',fileName,status:response.status,result});return {status:response.status,result};}
async function submit(previewed){const p=previewed.result;const response=await fetch(base+'/api/transit/import',{method:'POST',headers:{'x-role':'assistant-1','content-type':'application/json'},body:JSON.stringify({previewToken:p.previewToken,fileName:p.fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()})});const result=await response.json();evidence.push({action:'import',fileName:p.fileName,status:response.status,result});return {status:response.status,result};}
try{
 await waitForOwnedServer({base,child,instanceId});assert.equal(db.getModel('SYNTH-INK-001').category,'墨盒');
 let before=snapshot();const denied=await preview('改名硒鼓.csv',csv('DENIED-PREVIEW'));
 check('墨盒actions=false时，改名硒鼓不能预览墨盒型号',denied.status===403&&denied.result.code==='action_forbidden');
 check('被拒绝的改名预览不签发令牌或改变业务/流水',JSON.stringify(snapshot())===JSON.stringify(before));
 await permission(true);const allowed=await preview('权限收紧硒鼓.csv',csv('TIGHTENED'));assert.equal(allowed.status,200);assert.ok(allowed.result.previewToken);
 await permission(false);before=snapshot();const tightened=await submit(allowed);
 check('预览之后墨盒权限收紧，改名文件确认导入再次按实际类目拒绝',tightened.status===403&&tightened.result.code==='action_forbidden');
 check('权限收紧后的拒绝不消耗预览令牌、不记业务或流水',JSON.stringify(snapshot())===JSON.stringify(before));
 await permission(true);const resumed=await submit(allowed);assert.equal(resumed.status,200);assert.equal(resumed.result.rowCount,1);assert.equal(db.getTransit(resumed.result.rows[0].id).remaining_quantity,7);check('恢复权限后原预览可继续确认，拒绝未损坏操作流程',true);
 await permission(true);const normal=await preview('正常墨盒.csv',csv('ALLOWED'));assert.equal(normal.status,200);const imported=await submit(normal);assert.equal(imported.status,200);assert.equal(imported.result.rowCount,1);assert.equal(db.getModel('SYNTH-INK-001').category,'墨盒');assert.equal(db.getTransit(imported.result.rows[0].id).remaining_quantity,7);
 check('允许权限后正常墨盒预览确认仍可用且既有类目保持',true);
 await permission(false);before=snapshot();const newModel=await preview('新型号墨盒.csv',csv('NEW-MODEL','ISOLATED-NEW-INK'));check('新型号仍按文件类目检查墨盒权限',newModel.status===403);check('新型号权限拒绝不生成型号或数据',JSON.stringify(snapshot())===JSON.stringify(before));
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);check('隔离库存与外键完整',true);
 assert.deepEqual(failures,[],`Permission failures: ${failures.join('; ')}`);
}finally{await fs.writeFile(path.join(output,'result.json'),JSON.stringify({kind:'isolated-http-category-permissions',state,base,checks,failures,evidence,realLingxing:false},null,2));if(child.exitCode===null){const closed=once(child,'exit');child.kill();await closed;}db.close();}
console.log(`TRANSIT_IMPORT_PERMISSIONS_PASS ${checks.length}`);
