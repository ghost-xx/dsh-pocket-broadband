// 宽带出口查询只在 Host 发起；浏览器绝不直接请求第三方，以免显示手机自己的 IP。
import { isIP } from 'node:net';
import { qrDataUrl } from './service.mjs';

export const BROADBAND_CHECK_URL = 'https://ddns.oray.com/checkip';
export const BROADBAND_CACHE_MS = 60_000;
const MAX_RESPONSE_BYTES = 4096;

/** 严格四段十进制公网单播 IPv4；排除私网、CGNAT、回环、链路本地和保留/文档网段。 */
export function isPublicIPv4(ip) {
  if (typeof ip !== 'string' || isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function parsePublicIPv4(text) {
  // Oray 当前响应为 “Current IP Address: x.x.x.x”；也兼容只返回 IP 的形式。
  // 不在任意 HTML / 错误页中捞第一个数字串，防止把垃圾响应误当成有效地址。
  const match = /^(?:Current IP Address:\s*)?(\d{1,3}(?:\.\d{1,3}){3})\s*$/i.exec(String(text).trim());
  if (!match || !isPublicIPv4(match[1])) throw new Error('invalid-ip');
  return match[1];
}

async function boundedText(response) {
  if (!response.body) throw new Error('empty-response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('oversized-response');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    // 超限或超时时停止消费，不能留下无限增长的上游流。
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 每个插件实例一个缓存；失败也缓存以防自动轮询轰炸，用户 refresh 可随时重试。 */
export function createBroadbandStatus({ service, fetchImpl = globalThis.fetch, encodeQr = qrDataUrl, now = Date.now, timeoutMs = 8000, cacheMs = BROADBAND_CACHE_MS }) {
  let cached = null;
  let inFlight = null;
  async function query() {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
    });
    try {
      const value = await Promise.race([timedOut, (async () => {
        const response = await fetchImpl(BROADBAND_CHECK_URL, {
          signal: controller.signal,
          redirect: 'error',
          headers: { accept: 'text/plain' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('http-error');
        const ip = parsePublicIPv4(await boundedText(response));
        const status = await service.status();
        const port = status?.proxyPort;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || status.proxyRunning === false) throw new Error('proxy-unavailable');
        // 无 token / 密码，也不改变 LAN 覆盖或端口映射；只展示公网入口。
        const url = `http://${ip}:${port}`;
        const qr = await encodeQr(url);
        if (typeof qr !== 'string' || !qr.startsWith('data:image/')) throw new Error('qr-error');
        return { ip, url, qr, checkedAt: now(), error: null };
      })()]);
      cached = value;
    } catch (err) {
      const error = err?.message === 'proxy-unavailable'
        ? '代理未就绪，无法生成宽带入口 | Proxy is not ready'
        : controller.signal.aborted
          ? '查询超时，请重试 | Public IP lookup timed out'
          : '无法获取有效公网 IPv4，请重试 | Public IPv4 lookup failed';
      // 不回退上次成功结果：DDNS 可能已变更，旧二维码会把用户引向错误机器。
      cached = { ip: null, url: null, qr: null, checkedAt: now(), error };
    } finally {
      clearTimeout(timer);
    }
    return { ...cached };
  }
  return {
    async status({ refresh = false } = {}) {
      if (inFlight) return { ...await inFlight };
      if (!refresh && cached && now() - cached.checkedAt < cacheMs) return { ...cached };
      const request = query();
      inFlight = request;
      try { return { ...await request }; }
      finally { if (inFlight === request) inFlight = null; }
    },
  };
}
