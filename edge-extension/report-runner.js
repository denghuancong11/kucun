// 启动调用立即返回；采集在专用报表隔离世界运行，不占用 MV3 长事件。
globalThis.asterStartReport = job=>{
  if(globalThis.asterReportState?.key===job.requestId)return;
  if(globalThis.asterReportState?.settled===false)throw new Error('上一笔领星采集尚未结束');
  const state=globalThis.asterReportState={key:job.requestId,deadline:Date.now()+30000,payload:null,settled:false};
  const controller=new AbortController(),signal=controller.signal;
  const send=message=>chrome.runtime.sendMessage({...message,key:job.requestId}).catch(()=>{});
  const progress=text=>{
    state.lastProgress=text;
    state.pageAt=new Date().toISOString();
    state.pageVisibility=document.visibilityState??'unknown';
    void send({type:'report-progress',text,pageAt:state.pageAt,pageVisibility:state.pageVisibility});
  };
  async function ready() {
    const isReady=()=>{
      const visible=element=>element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0;
      const matches=selector=>[...document.querySelectorAll(selector)].filter(visible);
      if(matches('input[type="password"],input[autocomplete="one-time-code"],input[placeholder*="验证码"]').length)throw new Error('领星登录已过期或需要验证码，请在部署电脑的 Edge 主动登录后重新同步。');
      const logistics=matches('.vxe-table--main-wrapper').some(table=>{
        const headers=[...table.querySelectorAll('.vxe-table--header-wrapper.body--wrapper tr:first-child > th')].map(cell=>cell.innerText.replace(/[\uE000-\uF8FF]/g,'').replace(/\s+/g,' ').trim());
        return ['MSKU','FNSKU','申报量'].every(label=>headers.includes(label));
      });
      const field=matches('.search-block .field-select input[readonly]').length===1 && matches('.search-block .field-select .fake-select-label').length===1;
      return field && (job.target.action==='metrics' ? matches('#tab-msku').length===1&&matches('.search-input > input').length===1&&!logistics : logistics&&matches('.search-block .search-input > input').length===1&&!matches('#tab-msku').length);
    };
    if(isReady())return;
    await new Promise((resolve,reject)=>{
      let timer,observer,finished=false;
      const finish=error=>{
        if(finished)return;
        finished=true;clearTimeout(timer);observer?.disconnect();signal.removeEventListener('abort',abort);
        error?reject(error):resolve();
      };
      const inspect=()=>{try{if(isReady())finish();}catch(error){finish(error);}};
      const abort=()=>finish(signal.reason??new Error('领星页面就绪等待已取消'));
      observer=new MutationObserver(inspect);
      observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden']});
      timer=setTimeout(()=>{
        inspect();
        if(!finished)finish(new Error('30 秒内未能读取领星报表，请在部署电脑检查页面后重新同步。'));
      },Math.max(0,state.deadline-Date.now()));
      signal.addEventListener('abort',abort,{once:true});
      inspect();
    });
  }
  async function bounded(collect,milliseconds) {
    state.deadline=Date.now()+milliseconds;
    const timer=setTimeout(()=>controller.abort(new Error('领星查询超时，请在部署电脑检查报表后重新同步。')),milliseconds);
    try {const capture=await collect();signal.throwIfAborted();return capture;}
    finally {clearTimeout(timer);}
  }
  const done=(async()=>{
    try {
      await ready();
      signal.throwIfAborted();
      if(!document.title.startsWith('Aster后台查询 · '))document.title='Aster后台查询 · '+document.title;
      const request=job.target;
      let capture;
      if(request.action==='metrics') {
        for(const [index,asin]of request.asins.entries()) {
          progress(`正在查询 ${asin}（${index+1}/${request.asins.length}）…`);
          let next;
          try {next=await bounded(()=>globalThis.asterLingxing.collectAsins([asin],{signal,onProgress:step=>progress(`${asin}：${step}`)}),180000);}
          catch(error) {throw new Error(`${asin}：${error.message}`);}
          if(!capture)capture=next;
          else {capture.items.push(...next.items);capture.source.captures.push(...next.source.captures);capture.capturedAt=next.capturedAt;}
        }
      } else {
        progress(`正在查询移除单 ${request.orderNo}（FNSKU：${request.fnsku}）…`);
        capture=await bounded(()=>queryLingxingRemoval({orderNo:request.orderNo,fnsku:request.fnsku},{signal}),600000);
      }
      state.payload={capture};
    } catch(error) {state.payload={error:error.message};}
    finally {state.settled=true;}
  })();
  globalThis.asterStopReport=async message=>{
    if(!state.settled)controller.abort(new Error(message));
    await done;
  };
  void done.then(async()=>{
    // 消息中断时，下一次闹钟仍可读取同一结果，不重新查询报表。
    await send({type:'report-result'});
  });
};
