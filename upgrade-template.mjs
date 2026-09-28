// 两类升级共用回填列；身份和版本由系统导出，数量单位为件。
export const UPGRADE_COLUMNS = [
  ['flowId','流程ID'],['flowRevision','流程数据版本'],['completionId','完成明细ID'],['completionRevision','完成明细数据版本'],
  ['kind','升级类型'],['model','型号'],['plan','发货计划号'],['date','发货时间'],['sourceVersion','原版本号'],['fnsku','FNSKU'],
  ['store','店铺'],['packPerBox','套/箱'],['rma','RMA'],['rawAddress','原始移仓地址'],['processedAddress','处理后移仓地址'],
  ['contact','原文联系人片段'],['street','原文街道片段'],['orderNo','订单号'],['status','状况'],['sourceQuantity','启动来源数量'],
  ['countedQuantity','实际清点数量'],['progressQuantity','升级中数量'],['completedQuantity','升级完数量'],['completedVersion','升级完，版本号'],['warehouse','物理目标仓'],
];
export const TRANSFER_COLUMNS = [
  ['importId','首次导入ID'],['transitId','在途记录ID'],['model','型号'],['quantity','转出数量'],['plan','发货计划号'],['date','发货时间'],
  ['version','原版本号'],['fnsku','FNSKU'],['team','团队'],['store','店铺'],['packPerBox','套/箱'],
];
