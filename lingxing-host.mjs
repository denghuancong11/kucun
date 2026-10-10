import crypto from 'node:crypto';
import os from 'node:os';
import { BusinessError } from './inventory-db.mjs';

const disconnected = '部署电脑领星插件未连接。已启用的插件会自动恢复，请保持 Edge 运行；首次使用请在插件中连接库存服务。';
const active = state => state === 'queued' || state === 'running';
const now = () => new Date().toISOString();

// 一个库存服务、一个扩展执行器；不由发起请求的浏览器维持任务。
export class LingxingHost {
  constructor(inventory, { authorize, leaseMs = 90000 } ) {
    this.inventory = inventory;
    this.db = inventory.db;
    this.authorize = authorize;
    this.leaseMs = leaseMs;
    this.worker = null;
    this.db.prepare(`UPDATE lingxing_sync_jobs SET state='failed',message=?,finished_at=? WHERE state IN ('queued','running')`)
      .run('库存服务重启使本次同步中断；插件自动恢复连接后，可重新发起同步。', now());
    this.timer = setInterval(() => this.expire(), 5000);
    this.timer.unref();
  }
  expire() {
    if (this.worker && Date.now() - this.worker.seen > this.leaseMs) {
      this.db.prepare(`UPDATE lingxing_sync_jobs SET state='failed',message=?,finished_at=? WHERE state IN ('queued','running')`).run(disconnected, now());
      this.worker = null;
    }
  }
  status() {
    this.expire();
    return { connected: !!this.worker, version: this.worker?.version ?? null, host: os.hostname(), message: this.worker ? '由部署电脑的 Edge 在后台执行，可关闭插件设置页和库存页面。' : disconnected };
  }
  local(request) {
    const address = request.socket.remoteAddress;
    const origin = String(request.headers.origin || '');
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address) || !['127.0.0.1','localhost','[::1]'].includes(hostname)
      || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      throw new BusinessError(403, 'deployment_worker_only', '请在部署电脑的 Edge 中打开最新版“Aster 领星同步”扩展，再连接本机库存服务。');
    }
    return origin;
  }
  connect(request, workerId, version) {
    const origin = this.local(request);
    this.expire();
    if (this.worker && (this.worker.id !== workerId || this.worker.origin !== origin)) throw new BusinessError(409, 'worker_connected', '部署电脑已有另一个领星执行器连接，等待原连接释放后将自动重试。');
    this.worker = { id: this.worker?.id ?? crypto.randomUUID(), origin, seen: Date.now(), version:version ?? null };
    return { ok: true, workerId: this.worker.id, databaseId: this.inventory.syncState().databaseId, host: os.hostname() };
  }
  authenticate(request, workerId) {
    const origin = this.local(request);
    this.expire();
    if (!this.worker || this.worker.id !== workerId || this.worker.origin !== origin) throw new BusinessError(409, 'worker_disconnected', disconnected);
    this.worker.seen = Date.now();
  }
  disconnect() {
    if (this.db.prepare("SELECT id FROM lingxing_sync_jobs WHERE state IN ('queued','running')").get()) {
      throw new BusinessError(409,'sync_jobs_active','仍有同步任务正在等待或执行，请等任务保存完成后再断开。');
    }
    this.worker = null;
    return {ok:true};
  }
  heartbeat(version) {
    if(version) this.worker.version=version;
    return {ok:true};
  }
  raw(id) { return this.db.prepare('SELECT * FROM lingxing_sync_jobs WHERE id=?').get(id); }
  resume(workerId, id, jobWorkerId) {
    const row = id ? this.raw(id) : this.db.prepare("SELECT * FROM lingxing_sync_jobs WHERE state='running' AND worker_id=?").get(workerId);
    if (id && (!row || row.worker_id !== jobWorkerId)) throw new BusinessError(409,'wrong_worker','无法核对原同步任务的执行身份，未重新执行或保存');
    return {ok:true,job:row ? this.publicJob(row) : null};
  }
  publicJob(row) {
    return { id: row.id, requestId:row.request_id, role: row.role, requestedFrom:row.requested_from, target: JSON.parse(row.target_json), state: row.state, message: row.message,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
      result: row.result_json ? JSON.parse(row.result_json) : null };
  }
  async submit(role, requestId, request, requestedFrom) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new BusinessError(400,'missing_request_id','同步请求信息不完整，请刷新库存页面后重新同步');
    // 先检查重复请求；不能因单据随后归档，把已经成功的请求重新执行。
    const json = JSON.stringify(request);
    const existing = this.db.prepare('SELECT * FROM lingxing_sync_jobs WHERE request_id=?').get(requestId);
    if (existing) {
      if (existing.role !== role || existing.request_json !== json) throw new BusinessError(409,'idempotency_conflict','本次重试的岗位或单据已改变，请切回原岗位和单据后确认结果');
      await this.authorize(role, JSON.parse(existing.target_json), false);
      return { ok: true, job: this.publicJob(existing), deduped: true };
    }
    const target = await this.authorize(role, request, true);
    if (this.db.prepare('SELECT id FROM lingxing_sync_jobs WHERE request_id=?').get(requestId)) return this.submit(role,requestId,request,requestedFrom);
    return this.enqueue(role,requestId,request,target,requestedFrom);
  }
  enqueue(role,requestId,request,target,requestedFrom) {
    const available = this.status().connected;
    const id = this.db.prepare(`INSERT INTO lingxing_sync_jobs(request_id,role,request_json,requested_from,target_json,state,message,created_at,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(requestId,role,JSON.stringify(request),requestedFrom,JSON.stringify(target),available?'queued':'failed',available?'等待部署电脑按顺序执行':disconnected,now(),available?null:now()).lastInsertRowid;
    return { ok: true, job: this.publicJob(this.raw(id)) };
  }
  async list(role, action, workId, requestId, latest = false) {
    this.expire();
    const rows = requestId
      ? this.db.prepare('SELECT * FROM lingxing_sync_jobs WHERE role=? AND request_id=?').all(role,requestId)
      : this.db.prepare("SELECT * FROM lingxing_sync_jobs WHERE role=? AND json_extract(target_json,'$.action')=? ORDER BY id DESC").all(role,action);
    const jobs = [];
    for (const row of rows) {
      const target = JSON.parse(row.target_json);
      if (target.action !== action || (action === 'logistics' && target.workId !== workId)) continue;
      try { await this.authorize(role, target, false); }
      catch (error) { if (error instanceof BusinessError && [403,404].includes(error.status)) continue; throw error; }
      jobs.push(this.publicJob(row));
      // 发起顺序以入库编号为准；先检查查看权限，再截取所需数量。
      if (jobs.length >= (latest ? 1 : 30)) break;
    }
    return { ok: true, jobs, worker: this.status() };
  }
  async claim(workerId) {
    if (this.db.prepare("SELECT id FROM lingxing_sync_jobs WHERE state='running'").get()) return { ok: true, job: null };
    const row = this.db.prepare("SELECT * FROM lingxing_sync_jobs WHERE state='queued' ORDER BY id LIMIT 1").get();
    if (!row) return { ok: true, job: null };
    try { await this.authorize(row.role, JSON.parse(row.target_json), false); }
    catch (error) { this.fail(row.id,error.message); return { ok: true, job: null }; }
    if (!this.worker || this.worker.id !== workerId) return {ok:true,job:null};
    // 权限读取期间可能有另一条领取请求；条件更新与唯一运行索引一起避免双领。
    const changed = this.db.prepare(`UPDATE lingxing_sync_jobs SET state='running',worker_id=?,started_at=?,message='部署电脑正在取数'
      WHERE id=? AND state='queued' AND NOT EXISTS(SELECT 1 FROM lingxing_sync_jobs WHERE state='running')`).run(workerId,now(),row.id).changes;
    return { ok: true, job: changed ? this.publicJob(this.raw(row.id)) : null };
  }
  fail(id, message, capture = null) {
    this.db.prepare("UPDATE lingxing_sync_jobs SET state='failed',message=?,capture_json=?,finished_at=? WHERE id=? AND state IN ('queued','running')")
      .run(message,capture ? JSON.stringify(capture):null,now(),id);
  }
  progress(id, workerId, message) {
    this.db.prepare("UPDATE lingxing_sync_jobs SET message=? WHERE id=? AND state='running' AND worker_id=?").run(String(message).slice(0,500),id,workerId);
    return { ok: true };
  }
  async finish(id, workerId, payload) {
    const row = this.raw(id);
    if (!row || row.worker_id !== workerId) throw new BusinessError(409,'wrong_worker','这个同步任务由另一个执行窗口处理，请查看原窗口的进度');
    if (!active(row.state)) return { ok: true, job: this.publicJob(row), deduped: true };
    if (payload.error) this.fail(id, String(payload.error).slice(0,1000));
    else {
      const capture = payload.capture;
      try {
        const target = JSON.parse(row.target_json);
        const current = await this.authorize(row.role,target,false);
        if (JSON.stringify(current) !== JSON.stringify(target)) throw new BusinessError(409,'sync_target_changed','同步期间单据查询信息已变更，请按最新信息重新同步');
        if (target.action === 'metrics' && JSON.stringify(capture?.items?.map(item=>item.asin).sort()) !== JSON.stringify(target.asins)) {
          throw new BusinessError(409,'capture_scope_mismatch','领星返回的 ASIN 与本次请求范围不一致，未保存');
        }
        if (!this.worker || this.worker.id !== workerId || this.raw(id).state !== 'running') throw new BusinessError(409,'worker_disconnected',disconnected);
        const onSaved = result => {
          this.db.prepare("UPDATE lingxing_sync_jobs SET state='succeeded',message=?,capture_json=?,result_json=?,finished_at=? WHERE id=?")
            .run(`同步成功，已保存 ${result.updated} ${target.action==='metrics'?'个 ASIN':'条包裹商品记录'}`,JSON.stringify(capture),JSON.stringify({updated:result.updated,capturedAt:result.capturedAt}),now(),id);
        };
        const args = {role:row.role,capturedAt:capture?.capturedAt,requestId:`lingxing-host-${id}`,onSaved};
        if (target.action === 'metrics') this.inventory.syncLingxing({...args,items:capture?.items});
        else this.inventory.syncRelocationLogistics({...args,id:target.workId,shipments:capture?.shipments});
      } catch(error) {
        if (!(error instanceof BusinessError)) console.error('[lingxing-save]',error);
        this.fail(id, error instanceof BusinessError ? error.message : '领星数据保存出错，请联系部署电脑的管理员检查库存服务。', capture);
      }
    }
    return { ok:true, job:this.publicJob(this.raw(id)) };
  }
}
