// share.js：把课表传到另一台设备（电脑 ↔ 手机），或者发给朋友
//
// 做法：把课表压缩以后放进链接 # 后面的部分：
//   https://walkmyweek.com/#s=z…
// 浏览器不会把 # 后面的内容发给任何服务器（GitHub 也看不到），所以"课表不离开你的设备"仍然成立
// 另一台设备打开这个链接 → 读出课表 → 和导入文件一样，问"加进当前这份 / 另存一份"
//
// 电脑上：显示二维码，手机相机扫一下就行
// 手机上：电脑扫不了手机屏幕，所以用手机自带的分享菜单（AirDrop、微信、邮件……），或者复制链接

const SHARE_PREFIX = '#s=';
const QR_LIBRARY_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';

// ===== 课表 ↔ 一小段文字 =====

// 每门课只留必要的信息，越短二维码越好扫：
// [课名, 课号, 类型, 开始分钟, 结束分钟, 星期 'Mon,Wed', 地点 id, 教室, 状态 c=确认 k=跳过]
function packClass(c) {
  const status = c.status === 'confirmed' ? 'c' : (c.status === 'skipped' ? 'k' : '');
  return [c.title, c.course, c.section || '', c.start, c.end, c.days.join(','),
    c.place ? c.place.id : '', c.room || '', status];
}

// 反过来：变成和 localStorage 里存的一样的格式，交给 savedToClass（my-classes.js）还原
function unpackClass(a) {
  const start = typeof a[3] === 'number' ? a[3] : null;
  const end = typeof a[4] === 'number' ? a[4] : null;
  return {
    title: String(a[0] || ''), course: String(a[1] || ''), section: String(a[2] || ''),
    start: start, end: end,
    time: start != null ? formatTimeRange({ start: start, end: end }) : '',
    days: String(a[5] || '').split(',').filter(Boolean),
    placeId: a[6] || null, room: String(a[7] || ''),
    status: a[8] === 'c' ? 'confirmed' : (a[8] === 'k' ? 'skipped' : undefined),
    source: a[8] === 'c' ? 'schedule' : null
  };
}

// 字节 ↔ 能放进网址的文字（base64url：没有 + / =）
function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach(function (b) { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, function (ch) { return ch.charCodeAt(0); });
}

// 用浏览器自带的压缩（CompressionStream）；很旧的浏览器没有，就不压缩
// 开头一个字母说明是哪种：z = 压缩过，j = 没压缩
async function encodeShare(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + bytesToBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return 'j' + bytesToBase64Url(bytes);
}

async function decodeShare(token) {
  let bytes = base64UrlToBytes(token.slice(1));
  if (token[0] === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// 当前这份课表 → 链接
async function buildShareLink() {
  const data = { v: 1, n: activeSchedule().name, c: myClasses.items.map(packClass) };
  return location.origin + location.pathname + SHARE_PREFIX + await encodeShare(data);
}

// ===== 发送：My classes 下面的 "Send to your phone or laptop" =====

// 手机（触屏 + 有系统分享菜单）用分享菜单；电脑用二维码
function useNativeShare() {
  return typeof navigator.share === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

async function openSharePanel() {
  const panel = document.getElementById('share-panel');
  const count = myClasses.items.length;
  if (count === 0) {
    return;
  }
  logEvent('share-open');
  const link = await buildShareLink();
  panel.dataset.link = link;

  const what = `${count} ${count === 1 ? 'class' : 'classes'} from "${keepOriginal(escapeHtml(activeSchedule().name))}"`;
  let html = `<div class="share-box"><strong>Send ${what}</strong>`;
  if (useNativeShare()) {
    html += '<p class="hint"><span translate="no">AirDrop</span> it to your laptop, or send it to yourself on <span translate="no">WeChat</span>, <span translate="no">Messages</span> or email.</p>' +
      '<div class="share-actions"><button type="button" class="primary-button" data-share="native">Share link…</button>' +
      '<button type="button" class="small-button" data-share="copy">Copy link</button></div>';
  } else {
    html += '<div class="share-qr" id="share-qr"><span class="hint">Making the QR code…</span></div>' +
      '<p class="hint">Scan it with your phone’s camera. Or copy the link and send it.</p>' +
      '<div class="share-actions"><button type="button" class="small-button" data-share="copy">Copy link</button></div>';
  }
  html += '<p class="hint share-copied" id="share-copied" hidden>Link copied ✓</p>' +
    '<p class="hint share-warning">🔒 The classes are inside the link itself, nothing is uploaded. Anyone you send it to can see them.</p>' +
    '<button type="button" class="link-button" data-share="close">Close</button></div>';
  panel.innerHTML = html;
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest' });

  if (!useNativeShare()) {
    drawShareQr(link);
  }
}

// 二维码库只在用到时才加载（schedule-import.js 的 loadScriptOnce）
async function drawShareQr(link) {
  const box = document.getElementById('share-qr');
  try {
    await loadScriptOnce(QR_LIBRARY_URL);
    const qr = qrcode(0, 'L'); // 0 = 自动选大小；L = 纠错最低，同样的内容二维码最稀，最好扫
    qr.addData(link);
    qr.make();
    if (box && document.getElementById('share-panel').dataset.link === link) {
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    }
  } catch (error) {
    if (box) {
      box.innerHTML = '<span class="hint">Couldn’t make the QR code. Use "Copy link" instead.</span>';
    }
  }
}

async function handleShareClick(event) {
  const button = event.target.closest('button[data-share]');
  if (!button) {
    return;
  }
  const panel = document.getElementById('share-panel');
  const link = panel.dataset.link;
  const action = button.dataset.share;
  if (action === 'close') {
    panel.hidden = true;
    panel.innerHTML = '';
  } else if (action === 'native') {
    logEvent('share-native');
    try {
      await navigator.share({ title: 'My WalkMyWeek schedule', url: link });
    } catch (error) {
      // 用户自己关掉了分享菜单：什么都不用做
    }
  } else if (action === 'copy') {
    logEvent('share-copy');
    try {
      await navigator.clipboard.writeText(link);
      document.getElementById('share-copied').hidden = false;
    } catch (error) {
      // 不能自动复制（比如浏览器不允许）：把链接显示出来，让用户自己复制
      document.getElementById('share-copied').textContent = link;
      document.getElementById('share-copied').hidden = false;
    }
  }
}

// ===== 接收：打开带 #s= 的链接 =====

async function importSharedLink(placeIndex) {
  if (location.hash.indexOf(SHARE_PREFIX) !== 0) {
    return;
  }
  const token = location.hash.slice(SHARE_PREFIX.length);
  // 马上把 # 后面去掉：刷新页面时不会再导入一次，地址栏也不会一直挂着一长串
  history.replaceState(null, '', location.pathname + location.search);
  const status = document.getElementById('schedule-status');
  let data;
  try {
    data = await decodeShare(token);
  } catch (error) {
    status.textContent = 'This link couldn’t be opened. It may be cut off — ask for a new one.';
    return;
  }
  const classes = (Array.isArray(data.c) ? data.c : []).map(function (a) {
    return savedToClass(unpackClass(a), placeIndex);
  });
  if (classes.length === 0) {
    status.textContent = 'This link has no classes in it.';
    return;
  }
  logEvent('import-link');
  showTab('week');
  removeSampleClasses();
  // 和导入文件走同一条路：已经有自己的课时，问"加进当前这份 / 另存一份"
  const result = {
    located: classes.filter(function (c) { return c.status === 'confirmed' && c.place; }),
    unlocated: classes.filter(function (c) { return !(c.status === 'confirmed' && c.place) && c.status !== 'skipped'; })
  };
  offerImport([result], 'the link', { review: false }); // 链接里的课是整理好的，不用再核对
  // 要选"另存一份"时，名字默认用对方课表的名字（比如朋友叫它 "Alex"）；和这里已有的名字重复就不用
  const sentName = String(data.n || '').slice(0, 40);
  const taken = myClasses.schedules.some(function (s) { return s.name.toLowerCase() === sentName.toLowerCase(); });
  if (myClasses.pendingImport && sentName && !taken) {
    myClasses.pendingImport.suggestedName = sentName;
    renderImportChoice();
  }
  // 直接加进去了（这台设备上还没有自己的课）：说一声，用户才知道链接起作用了
  if (!myClasses.pendingImport && !status.textContent) {
    status.textContent = `Added ${classes.length} ${classes.length === 1 ? 'class' : 'classes'} from the link.`;
  }
}

function initShare(placeIndex) {
  document.getElementById('share-panel').addEventListener('click', handleShareClick);
  importSharedLink(placeIndex);
}

console.log('share.js loaded');
