// 離線可用（service worker）：只在正式版註冊（見 src/offline/register-offline.ts）
//   - 只處理這個網站自己的檔案（GET）；其他網址一律不碰
//   - 頁面（index.html）：網路優先，沒網路才用上次存下的版本 → 有網路時一定拿到最新版
//   - 其他檔案（程式、影片、模型、音樂）：存過就直接用，沒存過才下載並存起來
//     → 第一次有網路時練過、用到的檔案，之後沒網路也能開
//   - 影片會用「分段讀取」（Range）：有完整檔就從完整檔切出那一段；沒有就照常下載，並在背景存一份完整檔
//   - 只存網站本身的檔案；不碰鏡頭影像、骨架資料、練習紀錄（那些不經過網路）
const CACHE = 'health-move-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 換版本時刪掉舊的快取
      for (const key of await caches.keys()) if (key.startsWith('health-move-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/__dev/') || url.pathname.endsWith('/sw.js')) return;

  if (req.mode === 'navigate') event.respondWith(networkFirst(req));
  else if (req.headers.has('range')) event.respondWith(rangeFromCache(event, req));
  else event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) ?? (await cache.match(new URL('./', self.location.href).href));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) await cache.put(req, res.clone());
  return res;
}

/** 影片的分段讀取：從完整檔切出要的那一段（回 206）；沒有完整檔就照常下載，背景存完整檔 */
async function rangeFromCache(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url, { ignoreSearch: true });
  if (!hit) {
    event.waitUntil(
      fetch(req.url)
        .then((full) => (full.ok && full.status === 200 ? cache.put(req.url, full) : undefined))
        .catch(() => undefined),
    );
    return fetch(req);
  }
  const blob = await hit.blob();
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return new Response(blob, { status: 200, headers: hit.headers });
  let start;
  let end;
  if (m[1] === '') {
    // bytes=-500：最後 500 個位元組
    start = Math.max(0, blob.size - Number(m[2]));
    end = blob.size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? blob.size - 1 : Math.min(Number(m[2]), blob.size - 1);
  }
  if (start >= blob.size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') ?? 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
