import assert from 'node:assert/strict';

async function sourceFields(row) {
  await row.waitFor({state:'attached'});
  return row.evaluate(element=>{
    const headers=[...element.closest('table').tHead.rows[0].cells].map(cell=>cell.textContent.trim());
    const modelIndex=headers.indexOf('型号'),versionIndex=headers.indexOf('原版本');
    const text=index=>{
      const cell=element.cells[index].cloneNode(true);
      cell.querySelectorAll('button').forEach(button=>button.remove());
      return cell.textContent.trim();
    };
    return {key:element.getAttribute('data-source-key'),model:text(modelIndex),version:text(versionIndex),modelIndex};
  });
}

export async function selectRelocationSource(page,row) {
  const {key,model,version}=await sourceFields(row);
  assert(key&&model&&version,'来源行须包含具体来源、型号和原版本');
  await page.getByLabel('移仓筛选型号',{exact:true}).selectOption(model);
  await page.getByLabel('移仓筛选原版本',{exact:true}).selectOption(version);
  await page.getByLabel('移仓筛选来源',{exact:true}).selectOption(key);
}

export async function openRelocationSource(page,row) {
  const {key,modelIndex}=await sourceFields(row);
  if(await row.getAttribute('aria-expanded')!=='true')await row.locator('td').nth(modelIndex).click();
  await page.locator('[data-relocation-source-detail="'+key+'"]').waitFor();
}
