const output=document.querySelector('#status');
const portInput=document.querySelector('#port');
const connectButton=document.querySelector('#connect');
const disconnectButton=document.querySelector('#disconnect');
document.querySelector('#version').textContent=`扩展版本 ${chrome.runtime.getManifest().version}`;
async function render() {
  const state=await chrome.storage.local.get(['port','enabled','activeJob','connectionStatus']);
  if(state.port)portInput.value=String(state.port);
  portInput.disabled=!!state.enabled;
  connectButton.disabled=!!state.enabled;
  disconnectButton.disabled=!state.enabled || !!state.activeJob;
  output.textContent=state.connectionStatus || '尚未连接';
}
connectButton.addEventListener('click',async()=>{
  const result=await chrome.runtime.sendMessage({type:'connect',port:Number(portInput.value)});
  await render();if(result.error)output.textContent=result.error;
});
disconnectButton.addEventListener('click',async()=>{
  const result=await chrome.runtime.sendMessage({type:'disconnect'});
  await render();if(result.error)output.textContent=result.error;
});
chrome.storage.onChanged.addListener(()=>{void render();});
void render();
