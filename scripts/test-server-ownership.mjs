import crypto from "node:crypto";
import net from "node:net";

export function createTestInstanceId(prefix = "aster-test") {
  return `${prefix}-${process.pid}-${crypto.randomUUID()}`;
}

export const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.unref();
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : null;
    listener.close((error) => error ? reject(error) : resolve(port));
  });
});

export function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    const fail = (error) => {
      listener.close(() => reject(error));
    };
    listener.once("error", fail);
    listener.listen(port, "127.0.0.1", () => {
      listener.close((error) => error ? reject(error) : resolve());
    });
  });
}

export async function assertOwnedServer({ base, instanceId, readyPath = "/api/health" }) {
  if (!instanceId) throw new Error("缺少测试服务实例标识，拒绝继续执行 UI 检查");
  const response = await fetch(`${base}${readyPath}`);
  const responseInstanceId = response.headers.get("x-aster-test-instance-id");
  await response.arrayBuffer();
  if (!response.ok || responseInstanceId !== instanceId) {
    throw new Error(`测试目标 ${base} 不是当前子进程服务，拒绝继续执行`);
  }
}

export async function waitForOwnedServer({ base, child, instanceId, readyPath = "/api/health", attempts = 100 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`隔离服务子进程提前退出，退出码 ${child.exitCode}`);
    try {
      await assertOwnedServer({ base, instanceId, readyPath });
      return;
    } catch { /* 启动窗口 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`服务未能在 ${base} 启动，或端口响应不属于当前子进程`);
}
