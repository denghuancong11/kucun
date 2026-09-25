import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = new URL('../', import.meta.url);
for (const name of ['lingxing-page-collector.js','lingxing-removal-page-collector.js']) {
  await fs.copyFile(new URL(`scripts/${name}`,root),new URL(`edge-extension/${name}`,root));
}
await fs.mkdir(new URL('web/public/',root),{recursive:true});
execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command','Compress-Archive -LiteralPath $env:ASTER_EXTENSION_SOURCE -DestinationPath $env:ASTER_EXTENSION_ARCHIVE -Force'],{windowsHide:true,stdio:'inherit',env:{...process.env,ASTER_EXTENSION_SOURCE:fileURLToPath(new URL('edge-extension/',root)),ASTER_EXTENSION_ARCHIVE:fileURLToPath(new URL('web/public/aster-lingxing-extension.zip',root))}});
console.log('Edge 扩展已复用当前两个页面采集脚本。');

