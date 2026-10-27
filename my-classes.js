// my-classes.js：只负责 "My classes" 区域的显示和交互
//
// 每门课都有一个状态：
//   confirmed：确定了地点（从课表读到的，或用户确认过的）→ 显示在地图上
//   guess：    课表没写地点，但根据课号能推测出候选楼 → 需要用户点开、看清楚后自己选
//   none：     课表没写地点，也推测不出来（比如线上课）→ 用户可以填地点，或跳过
//   skipped：  用户跳过的 → 收进 "Skipped"，随时可以恢复
//
// 原则：只有"读到的"可以直接上地图；"猜的"一定要用户确认。任何操作都能 Edit、Undo、Restore

const myClasses = {
  items: [],        // 当前这一份课表里的所有课（页面上的列表、地图、课间步行、Directions 都只看它）
  schedules: [{ id: 1, name: 'My schedule', items: [] }], // 所有课表；当前那一份的课以 items 为准（schedules.js）
  activeId: 1,      // 当前是哪一份课表
  placeIndex: null, // 地点搜索索引（app.js 建好后传进来）
  openId: null,     // 当前展开（正在确认 / 编辑）的是哪门课
  expandedId: null, // 列表里点开看详情的是哪门课（一次只开一门）
  mapPlaceId: null, // 在地图上点了哪栋楼：列表里在这栋楼上的课都标出来
  day: null,        // 按星期看：null 是 All week，'Wed' 是只看周三（my-week.js）
  undo: null,       // 上一步之前的样子，用来 Undo
  selecting: false, // 是不是在"批量选择"模式（每门课前面有一个圈）
  selected: new Set() // 批量选择模式下，勾选了哪些课（存课的 id）
};
let nextClassId = 1;
let toastTimer = null;

// ===== 工具函数 =====

// 把文字里的 < > & 等符号换成安全的写法，再放进 innerHTML
// 课名是从用户的图片里识别出来的，不能当成 HTML 执行
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 不让浏览器翻译的内容：课名、课号、教室、楼名、地址、专有名词（Google Maps、Safari……）
// 用户用 Chrome / Safari / Edge 的"翻译网页"时，按钮和说明会翻成他的语言，这些保持原样，
// 才对得上自己的课表、路牌和地图 App。输入：已经转义好的 HTML
function keepOriginal(html) {
  return `<span translate="no">${html}</span>`;
}

// 放进 HTML 属性（比如 value="..."）时，引号也要换掉，不然课名里的 " 会把属性提前结束
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// 记一次匿名统计（analytics.js）。只传事件名，绝不传课表内容
// analytics.js 没加载（比如被浏览器插件挡住）时什么都不做，不会让网站出错
function logEvent(name) {
  if (typeof trackEvent === 'function') {
    trackEvent(name);
  }
}

// 课程数量 → 区间（统计用）。只记区间，不记具体数字，更看不出是哪几门课
function classCountBucket(n) {
  if (n <= 3) {
    return '1-3';
  }
  return n <= 6 ? '4-6' : '7plus';
}

// ===== 在 Directions 里用"我的课"当起点 / 终点 =====

// 一门课在 From / To 候选列表里显示的名字，比如 "Calculus 1 (CASMA 123 DIS)"
function myClassLabel(c) {
  const base = `${c.title} (${c.course}${c.section ? ' ' + c.section : ''})`;
  // 同名的有好几个时段（比如 .ics 里没写 LEC / DIS 的同一门课）：加上开始时间，才分得清
  const sameName = myClasses.items.filter(function (other) {
    return other.status === 'confirmed' && other.title === c.title && other.course === c.course &&
      (other.section || '') === (c.section || '');
  });
  if (sameName.length > 1 && c.start != null) {
    return `${c.title} (${c.course}${c.section ? ' ' + c.section : ''} · ${formatClock(c.start)})`;
  }
  return base;
}

// From / To 候选列表里的"我的课"：只放已经确定地点的课
// 输出：[{ value: 'Calculus 1 (CASMA 123 DIS)', label: 'My class · CAS 216' }]
function getMyClassOptions() {
  return myClasses.items
    .filter(function (c) { return c.status === 'confirmed'; })
    .map(function (c) {
      return { value: myClassLabel(c), label: 'My class · ' + classWhere(c) };
    });
}

// 一门课在哪里上，比如 "CAS 216"；楼没有代码时用楼名
// 只用于已经确定地点（有 place）的课
function classWhere(c) {
  return (c.place.code || c.place.name) + (c.room ? ' ' + c.room : '');
}

// 根据输入的文字找自己的课
// allowPartial = false：必须和课名标签完全一样；true：课名里包含这段文字就算（比如 "calc"）
// 输出：这门课所在的楼（复制一份，名字改成"课名 · 楼 教室"，id 不变，所以查表、判断"两节课之间"都照常）；找不到时是 undefined
function findMyClass(text, allowPartial) {
  const q = text.trim().toLowerCase();
  if (q === '') {
    return undefined;
  }
  const confirmed = myClasses.items.filter(function (c) { return c.status === 'confirmed'; });
  const match = confirmed.find(function (c) { return myClassLabel(c).toLowerCase() === q; }) ||
    (allowPartial ? confirmed.find(function (c) { return myClassLabel(c).toLowerCase().includes(q); }) : undefined);
  if (!match) {
    return undefined;
  }
  const where = (match.place.code || match.place.name) + (match.room ? ' ' + match.room : '');
  return Object.assign({}, match.place, { name: `${match.title} · ${where}`, myClass: match });
}

// 把用户输入的地点文字变成地点："CAS 211"（楼宇代码 + 教室）或者地点名 "GSU"、"Mugar"
// 输出：{ place, room }；空的或找不到时是 null
function resolveLocationText(text, placeIndex) {
  if (text.trim() === '') {
    return null;
  }
  const classroom = parseClassroom(text);
  if (classroom) {
    const building = findPlace(placeIndex, classroom.code, false);
    return building ? { place: building, room: classroom.room } : null;
  }
  const place = findPlace(placeIndex, text, true);
  return place ? { place: place, room: '' } : null;
}

// 把地点显示成一行文字：楼名 · room 211
function locationLabel(place, room) {
  return keepOriginal(escapeHtml(place.name)) + (room ? ` · room ${keepOriginal(escapeHtml(room))}` : '');
}

// "我的课"统一用一种深蓝色：地图上的标签、列表卡片左边的色条都是它
// 以前每栋楼一种颜色，但颜色本身没有意思，反而让人以为绿色的楼是"没问题"
// 和 style.css 里的 --mine 是同一个颜色
const CLASS_COLOR = '#1a1f71';

// ===== 保存在这个浏览器里（localStorage） =====
//
// 下次打开网页，课还在，不用再传一遍
// 只存课的信息（课号、时间、楼、教室、有没有确认），截图和文件本身不存，也不会上传到任何服务器
// 地点只存 id（比如 'cas'）：读回来时再到地点数据里找，这样 data.json 里的楼改了地址，也会用新的

// 名字前面加上网站名，免得和同一个网址下的其他网页冲突
const SAVED_CLASSES_KEY = 'bu-dorm-dash:my-classes';

// 把一门课变成可以存的样子（只有文字和数字）
function classToSaved(c) {
  return {
    title: c.title, course: c.course, section: c.section,
    start: c.start, end: c.end, time: c.time, days: c.days,
    placeId: c.place ? c.place.id : null, code: c.code, room: c.room, noRoom: c.noRoom,
    status: c.status, source: c.source, statusBeforeSkip: c.statusBeforeSkip || null, sample: Boolean(c.sample),
    suggestion: c.scanSuggestion ? { placeId: c.scanSuggestion.place.id, room: c.scanSuggestion.room } : null
  };
}

// 存下来的样子 → 一门课；地点找不到了（比如那栋楼从数据里删掉了）就当作没有地点，让用户重新确认
function savedToClass(s, placeIndex) {
  const byId = function (id) {
    const entry = id ? placeIndex.find(function (e) { return e.place.id === id; }) : null;
    return entry ? entry.place : null;
  };
  const place = byId(s.placeId);
  const candidates = guessLocations(s.course, placeIndex); // 推测的候选楼不存，每次重新算
  const suggested = s.suggestion ? byId(s.suggestion.placeId) : null;
  const lostPlace = s.placeId && !place;
  const noPlaceStatus = candidates.length > 0 ? 'guess' : 'none';
  return {
    id: nextClassId++,
    title: s.title || s.course || 'Class', course: s.course || '', section: s.section || '',
    start: s.start == null ? null : s.start, end: s.end == null ? null : s.end, time: s.time || '',
    days: Array.isArray(s.days) ? s.days : [],
    place: place, code: place ? (s.code || '') : '', room: place ? (s.room || '') : '', noRoom: Boolean(s.noRoom),
    candidates: candidates,
    status: lostPlace && s.status === 'confirmed' ? noPlaceStatus : (s.status || noPlaceStatus),
    source: s.source || null,
    statusBeforeSkip: s.statusBeforeSkip || undefined,
    scanSuggestion: suggested ? { place: suggested, room: s.suggestion.room || '' } : null,
    scanMessage: '',
    sample: Boolean(s.sample)
  };
}

// 存的格式（version 2）：{ version: 2, activeId, schedules: [{ id, name, items: [存下来的课] }] }
function saveMyClasses() {
  syncActiveSchedule();
  try {
    const empty = myClasses.schedules.length === 1 && myClasses.items.length === 0;
    if (empty) {
      localStorage.removeItem(SAVED_CLASSES_KEY);
    } else {
      localStorage.setItem(SAVED_CLASSES_KEY, JSON.stringify({
        version: 2,
        activeId: myClasses.activeId,
        schedules: myClasses.schedules.map(function (schedule) {
          // breakPlans：课间规划（gap-planner.js），key 是那一对课
          // 正在手动添加、还没保存的课（draft）不存
          const items = schedule.items.filter(function (c) { return !c.draft; });
          return { id: schedule.id, name: schedule.name, kind: schedule.kind || null, items: items.map(classToSaved), breakPlans: schedule.breakPlans || undefined };
        })
      }));
    }
  } catch (error) {
    // 无痕模式、浏览器禁止存储时会出错：存不了也不影响使用，只是下次要重新导入
    console.log("Couldn't save classes:", error);
  }
}

// 读回上次存的所有课表
// 输出：{ schedules: [{ id, name, items }], activeId }；没有或读不懂时返回 null
// 以前（只有一份课表时）存的是 { version: 1, items }：自动变成一份叫 "My schedule" 的课表，用户什么都不用做
function loadSavedSchedules(placeIndex) {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_CLASSES_KEY));
    if (!saved) {
      return null;
    }
    const toClasses = function (items) {
      return (Array.isArray(items) ? items : []).map(function (s) { return savedToClass(s, placeIndex); });
    };
    if (Array.isArray(saved.schedules) && saved.schedules.length > 0) {
      const schedules = saved.schedules.map(function (schedule, i) {
        const restored = { id: Number(schedule.id) || i + 1, name: String(schedule.name || 'My schedule'), items: toClasses(schedule.items) };
        if (schedule.kind === 'friend') {
          restored.kind = 'friend'; // 朋友的课表（Shared classes 默认选它）
        }
        if (schedule.breakPlans && typeof schedule.breakPlans === 'object') {
          restored.breakPlans = schedule.breakPlans; // 课间规划（gap-planner.js）
        }
        return restored;
      });
      const active = schedules.find(function (schedule) { return schedule.id === saved.activeId; }) || schedules[0];
      return { schedules: schedules, activeId: active.id };
    }
    if (Array.isArray(saved.items)) {
      return { schedules: [{ id: 1, name: 'My schedule', items: toClasses(saved.items) }], activeId: 1 };
    }
    return null;
  } catch (error) {
    console.log("Couldn't read saved classes:", error);
    return null;
  }
}

// 当前那一份课表的课以 myClasses.items 为准；存储、切换之前，先把它写回 schedules 里
function syncActiveSchedule() {
  activeSchedule().items = myClasses.items;
}

function activeSchedule() {
  return myClasses.schedules.find(function (schedule) { return schedule.id === myClasses.activeId; });
}

// ===== 用户自己输入的地址（数据里还没有的楼） =====
//
// 我们的楼宇数据还不完整。用户输入一个不认识的地址（比如 "3 Cummington Mall"）时，
// 不能直接说"找不到"：先去地图服务（OpenStreetMap）查，查到了就变成一个新地点，
// 加进搜索索引（Directions 也能用），并存在这个浏览器里，下次直接认得

const CUSTOM_PLACES_KEY = 'bu-dorm-dash:custom-places';
const SAME_BUILDING_METERS = 40; // 查到的位置离已有的楼这么近，就当作是那栋楼

// 把一个地点加进搜索索引：名字、地址都能搜到
function addPlaceToIndex(place, placeIndex) {
  [place.name, place.address].forEach(function (label) {
    if (label) {
      placeIndex.push({ label: label, place: place });
    }
  });
}

function loadCustomPlaces(placeIndex) {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_PLACES_KEY));
    (Array.isArray(saved) ? saved : []).forEach(function (place) { addPlaceToIndex(place, placeIndex); });
  } catch (error) {
    console.log("Couldn't read saved places:", error);
  }
}

function saveCustomPlace(place) {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_PLACES_KEY)) || [];
    saved.push(place);
    localStorage.setItem(CUSTOM_PLACES_KEY, JSON.stringify(saved));
  } catch (error) {
    console.log("Couldn't save place:", error);
  }
}

// 查一个数据里没有的地址
// 输入：用户输入的文字
// 输出：{ place, room }（和 resolveLocationText 一样）；查不到时是 null
async function lookUpAddress(text, placeIndex) {
  const found = await geocodeAddress(text);
  if (!found) {
    return null;
  }

  // 1. 离已有的某栋楼很近：就是那栋楼（比如输入 "665 Comm Ave" → CDS），不新建
  let nearest = null;
  let nearestMeters = Infinity;
  placeIndex.forEach(function (entry) {
    const meters = getDistance(found.latitude, found.longitude, entry.place.latitude, entry.place.longitude);
    if (meters < nearestMeters) {
      nearest = entry.place;
      nearestMeters = meters;
    }
  });
  if (nearest && nearestMeters <= SAME_BUILDING_METERS) {
    return { place: nearest, room: '' };
  }

  // 2. 真的是新地方：建一个新地点，加进索引，存起来
  const address = text.trim();
  const place = {
    id: 'custom-' + Date.now(),
    name: found.name || address,
    address: address,
    code: '',
    latitude: found.latitude,
    longitude: found.longitude,
    kind: 'building',
    type: 'academic',
    custom: true // 用户自己加的，不在 data.json 里
  };
  addPlaceToIndex(place, placeIndex);
  saveCustomPlace(place);
  return { place: place, room: '' };
}

// 点 "Look up this address"（或在输入框里按回车）
async function handleAddressLookup(card) {
  const input = card.querySelector('.other-location');
  const preview = card.querySelector('.other-preview');
  const text = input.value;
  if (text.trim() === '') {
    return;
  }
  preview.textContent = '→ Looking up this address…';
  const found = await lookUpAddress(text, myClasses.placeIndex);
  if (input.value !== text) {
    return; // 查的时候用户又改了文字：以新的为准
  }
  if (found) {
    // 让输入框里的文字直接对应到这个地点，确认按钮就能用了
    input.value = found.place.address === text.trim() ? text.trim() : found.place.name;
    card.querySelector('input[type="radio"][value="other"]').checked = true;
    updateConfirmButton(card);
  } else {
    preview.innerHTML = '→ Couldn\'t find this address in <span translate="no">Boston</span>. Check the spelling, or try a building code like <span translate="no">SCI 107</span>.';
  }
}

// ===== 示例课表 =====
//
// 给手边没有课表的人试用（比如活动现场扫码打开的人）
// 每门课都是真实的 BU 课（课号、课名、时间、教室都没改），从几份不同的课表里各取一部分混在一起，
// 不会出现任何一个人的完整课表，也不放老师名字和班级号码。正好能展示三个功能：
//   好几栋楼 → 地图上看分布；Calculus 1 本来就没有教室 → 展示"需要确认"；
//   周三 Macro（PRB）9:55 下课 → Experience Management（SHA）10:10 上课，走路约 18 分钟 → 🔴 来不及；
//   周一三 Multivariate（LSE）2:15 下课 → Foundation Drawing（CFA）2:30 上课，约 14 分钟 → 🟡 很紧
// 用 .ics 的格式写，和用户导入 BU 日历文件走同一条路，所以示例能证明真实流程也是好的
const SAMPLE_EVENTS = [
  ['CASEC 102', 'Intro Macroeconomic Analysis', 'WE', '0905', '0955', '3 Cummington Mall PRB 148'],
  ['SHAHF 150', 'Experience Management', 'MO,WE', '1010', '1155', '928 Commonwealth Ave SHA 110'],
  ['CASMA 225', 'Multivariate Calculus', 'MO,WE,FR', '1325', '1415', '24 Cummington Mall LSE B01'],
  ['CFAAR 131', 'Foundation Drawing 1', 'MO,WE', '1430', '1715', '855 Commonwealth Ave CFA 304'],
  ['CASMA 123', 'Calculus 1', 'TH', '1830', '2030', 'No room assigned NO ROOM']
];

function sampleIcs() {
  const lines = ['BEGIN:VCALENDAR'];
  SAMPLE_EVENTS.forEach(function (e) {
    lines.push('BEGIN:VEVENT', 'SUMMARY:' + e[0], 'DESCRIPTION:' + e[1],
      'RRULE:FREQ=WEEKLY;BYDAY=' + e[2],
      'DTSTART;TZID=America/New_York:20260902T' + e[3] + '00',
      'DTEND;TZID=America/New_York:20260902T' + e[4] + '00',
      'LOCATION:' + e[5], 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// 读出示例课，每门都标上 sample，之后可以整批拿掉
function addSampleClasses() {
  const result = parseIcs(sampleIcs(), myClasses.placeIndex, []);
  result.located.concat(result.unlocated).forEach(function (c) { c.sample = true; });
  addParsedSchedule(result);
}

// 点 "Try a sample schedule"：导入示例课，然后在 Directions 里填好"课间来不及"的那两节课
function loadSampleSchedule() {
  addSampleClasses();
  fillSampleRoute();
}

// 在 Directions 里填好示例中"课间来不及"的两节课：周三 Macro（PRB）9:55 下课 → Experience Management（SHA）10:10 上课
function fillSampleRoute() {
  const macro = myClasses.items.find(function (c) { return c.sample && c.course === 'CASEC 102'; });
  const sha = myClasses.items.find(function (c) { return c.sample && c.course === 'SHAHF 150'; });
  if (macro && sha) {
    fillRouteCheck(macro, sha); // 9:55 下课 → 10:10 上课
  }
}

// 在 Directions 里填好"从哪门课 → 到哪门课"，然后算路线、在地图上画线
// 示例按钮和 "Your walks between classes" 的每一行（my-week.js）共用
// 来不来得及写在 walk 那一行上（课间分钟数来自课表）；Directions 只显示要走多久
// 输入：前一节课、后一节课
function fillRouteCheck(fromClass, toClass) {
  const from = document.getElementById('from-input');
  const to = document.getElementById('to-input');
  from.value = myClassLabel(fromClass);
  to.value = myClassLabel(toClass);
  setRouteBack(null); // 用户留在 My week 里，不需要"返回"
  // 和用户自己选完一样，让 app.js 去算路线
  from.dispatchEvent(new Event('change'));
  to.dispatchEvent(new Event('change'));
}

// 存下来的示例课是不是旧版本：有一门示例课（课号 + 开始时间）不在现在的 SAMPLE_EVENTS 里，就是旧的
// 只看"多出来的"，不看"少了的"：用户删掉一门示例课不算过期，不会被恢复
function hasOutdatedSample(items) {
  const current = SAMPLE_EVENTS.map(function (e) {
    return e[0] + '@' + (Number(e[3].slice(0, 2)) * 60 + Number(e[3].slice(2))); // '0905' → 545 分钟
  });
  return items.some(function (c) {
    return c.sample && !current.includes(c.course + '@' + c.start);
  });
}

// 用户导入自己的课表时，先把示例课拿掉，免得混在一起
function removeSampleClasses() {
  const hadSample = myClasses.items.some(function (c) { return c.sample; });
  myClasses.items = myClasses.items.filter(function (c) { return !c.sample; });
  // 示例课没了，示例填好的那条路线也一起清掉，不然地图上留着一条和用户的课无关的线
  if (hadSample) {
    clearRouteLine();
    document.getElementById('from-input').value = '';
    document.getElementById('to-input').value = '';
    showRouteMessage('Choose a starting point and a destination to see the walking time.');
  }
}

// ===== 状态变化 =====

// 读文件的结果这类"告诉你一声"的话：过一会儿自动消失，不然几步以后它说的已经不对了
// （比如"6 still need a room"，补完 4 门以后还挂在那里）
let statusTimer = null;
function flashStatus(text, ms) {
  const status = document.getElementById('schedule-status');
  status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(function () {
    if (status.textContent === text) {
      status.textContent = '';
    }
  }, ms || 10000);
}

// 记下现在的样子，以便 Undo；然后执行修改、重新显示、弹出提示
// 用户动手改了课表：之前那句读文件的结果多半已经过时，清掉（这一步自己有 Undo 提示）
function changeWithUndo(message, change) {
  document.getElementById('schedule-status').textContent = '';
  myClasses.undo = myClasses.items.map(function (item) {
    return Object.assign({}, item, { days: item.days.slice() });
  });
  change();
  myClasses.openId = null;
  clearClassPreview();
  renderMyClasses();
  showToast(message);
}

// 把 parseSchedule 的结果加进来（以后上传多张截图时，也用它合并）
function addParsedSchedule(result) {
  const incoming = [];

  result.located.forEach(function (c) {
    incoming.push(Object.assign({}, c, { status: 'confirmed', source: 'schedule' }));
  });

  result.unlocated.forEach(function (c) {
    const candidates = guessLocations(c.course, myClasses.placeIndex);
    incoming.push(Object.assign({}, c, {
      days: c.days || [],
      place: null,
      room: '',
      candidates: candidates,
      status: candidates.length > 0 ? 'guess' : 'none',
      source: null
    }));
  });

  let filledIn = 0; // 新截图帮多少门"原来没地点"的课找到了地点

  incoming.forEach(function (c) {
    // 先对课号，再对类型和时间（规则在 schedule.js 的 sameMeeting 里）
    const existing = myClasses.items.find(function (item) { return sameMeeting(item, c); });
    if (!existing) {
      c.id = nextClassId++;
      myClasses.items.push(c);
      return;
    }
    // 同一个上课时段：合并星期；补上原来没读到的时间、类型
    existing.days = sortDays(existing.days.concat(c.days));
    if (existing.start == null && c.start != null) {
      Object.assign(existing, { start: c.start, end: c.end, time: c.time });
    }
    if (!existing.section && c.section) {
      existing.section = c.section;
    }
    // 新截图里读到了地点，而原来还在等确认：这是从课表读到的事实，直接用（有 Undo）
    // 用户自己跳过的课不动，尊重用户的决定
    if (c.status === 'confirmed' && (existing.status === 'guess' || existing.status === 'none')) {
      Object.assign(existing, {
        place: c.place, room: c.room, code: c.code, status: 'confirmed', source: 'schedule',
        scanSuggestion: null, scanMessage: '' // 已经确定了，之前单独扫描得到的建议不再需要
      });
      filledIn++;
    }
  });

  renderMyClasses();
  return filledIn;
}

// 现在知道的所有课号（用来认简写，比如 Google 日历里的 "DS 110" → CDSDS 110）
function knownCourses() {
  return myClasses.items.map(function (c) { return c.course; }).filter(Boolean);
}

// ===== 显示 =====

function renderMyClasses() {
  // 所有修改最后都会走到这里重新显示，所以在这里保存，就不会漏存任何一次修改
  saveMyClasses();

  // 课表变了（确认、编辑、跳过、新截图）：From / To 的候选列表跟着更新
  renderPlaceOptions();

  // 课间步行分析（my-week.js）也跟着重新算
  renderClassWalks();

  // Find a dorm 里"按整周课表排名"（app.js）
  refreshRankOptions();

  // 有好几份课表时，最上面的切换栏（schedules.js）和对比表（compare.js）
  renderScheduleSwitcher();
  renderCompare();

  // 还没选好的导入卡片：课表名字可能变了（比如换了一份课表），跟着更新
  renderImportChoice();

  const items = myClasses.items;
  const list = document.getElementById('schedule-list');
  const status = document.getElementById('schedule-status');

  // 已经有课了，就不需要"试试示例"按钮
  document.getElementById('sample-row').hidden = items.length > 0;

  // "添加课表"：还没有课时展开，是这一页的主角；第一次有课以后自动收起，变成 "+ Add more classes"
  const addBox = document.getElementById('add-schedule');
  if (items.length === 0) {
    addBox.open = true;
  } else if (!myClasses.hadItems) {
    addBox.open = false;
  }
  myClasses.hadItems = items.length > 0;
  document.getElementById('add-schedule-title').textContent =
    items.length === 0 ? 'Add your class schedule' : '+ Add more classes';

  // 已经确定的课：按一周的顺序排（先星期，再上课时间），读起来就像一张课表
  const confirmed = items.filter(function (c) { return c.status === 'confirmed'; }).sort(compareByWeek);
  const review = items.filter(function (c) { return !c.draft && (c.status === 'guess' || c.status === 'none'); }).sort(compareMeetings);
  const skipped = items.filter(function (c) { return c.status === 'skipped'; });
  const drafts = items.filter(function (c) { return c.draft; }); // 正在手动添加的课

  if (items.length === 0) {
    status.textContent = '';
    list.innerHTML = '';
    clearClassMarkers();
    return;
  }

  // 地图：只放确定了地点的课，同一栋楼的课合成一个标记；每栋楼一种颜色，列表里的卡片也用这个颜色
  const groups = [];
  confirmed.forEach(function (c) {
    let group = groups.find(function (g) { return g.place.id === c.place.id; });
    if (!group) {
      group = { place: c.place, classes: [], color: CLASS_COLOR };
      groups.push(group);
    }
    group.classes.push(c);
  });
  // 选了某一天：只显示那天要去的楼，标签上写上课顺序 ①②③（my-week.js dayStops）
  const stops = dayStops();
  if (stops) {
    showClassMarkers(groups.filter(function (g) { return stops[g.place.id]; }).map(function (g) {
      return Object.assign({}, g, {
        stops: stops[g.place.id],
        classes: g.classes.filter(function (c) { return c.days.includes(myClasses.day); })
      });
    }));
  } else {
    showClassMarkers(groups);
  }
  // 课的数量已经写在 "My classes (n)" 标题上，这里不再重复；#schedule-status 只用来显示读文件的进度和结果

  // 标题 + "Select" 按钮放在同一行
  const count = review.length + confirmed.length;
  let html = `<div class="list-head"><h3>My classes <span class="count">(${count})</span></h3>` +
    renderSelectToolbar(count) + '</div>';

  // 说清楚地图上有几门、为什么少了：还没确认地点的课不上地图
  if (count > 0) {
    const onMap = review.length === 0
      ? `All ${count} on the map.`
      : `${confirmed.length} of ${count} on the map · ${review.length} ${review.length === 1 ? 'needs' : 'need'} your check below.`;
    html += `<p class="hint list-sub">${onMap}</p>`;
  }

  // 正在看示例：说清楚这是示例，以及怎么换成自己的
  if (items.some(function (c) { return c.sample; })) {
    html += `<div class="sample-banner">👀 This is a <strong>sample schedule</strong> (real <span translate="no">BU</span> classes, mixed from a few students).
      Add your own schedule below and it replaces the sample.</div>`;
  }

  // 0. 正在手动添加的课：放最上面
  if (drafts.length > 0) {
    html += '<ul class="class-list">' + drafts.map(renderCard).join('') + '</ul>';
  }

  // 1. 需要确认的放最上面，并有一个醒目的提示
  if (review.length > 0) {
    // 一句话 + 一个按钮：一次补完所有课的教室；还可以再传一张有教室的截图
    const needRooms = coursesNeedingRooms().length;
    html += `<div class="review-banner">
      <span>${needRooms} ${needRooms === 1 ? 'course needs' : 'courses need'} a room to show on your map.</span>
      <div class="review-banner-actions">
        <button type="button" class="small-button small-button-filled" data-action="rooms">Add rooms</button>
        <button type="button" class="link-button" data-action="scan-all">or add a file with rooms</button>
      </div>
    </div>`;
    html += '<ul class="class-list">' + review.map(renderCard).join('') + '</ul>';
  }

  // 2. 已经确定的
  if (confirmed.length > 0) {
    html += '<ul class="class-list">' + confirmed.map(renderCard).join('') + '</ul>';
  }

  // 3. 跳过的：折叠起来，可以恢复
  if (skipped.length > 0) {
    // 删掉的和跳过的（线上课）都在这里，不上地图，随时可以 Restore
    html += `<details class="skipped-list"><summary>Removed &amp; skipped (${skipped.length})</summary><ul class="class-list">`;
    skipped.forEach(function (c) {
      html += `
        <li class="class-card skipped" data-id="${c.id}">
          <strong translate="no">${escapeHtml(c.title)}</strong>
          <span class="rank-detail" translate="no">${escapeHtml(c.course)} ${escapeHtml(c.section)}</span>
          <button type="button" class="link-button" data-action="restore">Restore</button>
        </li>`;
    });
    html += '</ul></details>';
  }

  // 识别漏掉了某节课：自己加
  if (!myClasses.selecting && drafts.length === 0) {
    html += '<p class="manual-row"><button type="button" class="link-button" data-action="add-manual">+ Add a missing class by hand</button></p>';
  }

  // 4. 告诉用户课存在哪里，并且可以一键清空（比如用的是公用电脑）
  if (!myClasses.selecting) {
    // 只存在这个浏览器里 → 紧接着给出"传到另一台设备"（share.js），在用户最需要的地方
    html += `<p class="saved-note">💾 Saved in this browser only, so your classes are still here next time.
      <button type="button" class="link-button" data-action="clear-all">Clear all classes</button></p>
      <p class="share-row"><button type="button" class="link-button share-button" data-action="share">📤 Send to your phone or laptop</button></p>`;
  }

  list.innerHTML = html;

  // 有展开的卡片（比如刚扫描完、预先选中了新截图里的地点）：更新它的确认按钮
  if (myClasses.openId !== null) {
    const opened = list.querySelector(`[data-id="${myClasses.openId}"].editing`);
    if (opened) {
      updateConfirmButton(opened);
    }
  }
}

// 课名下面那一行：课号、时间、日期
function classMetaLine(c) {
  const parts = [keepOriginal(`${escapeHtml(c.course)} ${escapeHtml(c.section)}`)];
  if (c.time) {
    parts.push(escapeHtml(c.time));
  }
  if (c.days.length > 0) {
    parts.push(escapeHtml(c.days.join(', ')));
  }
  return `<span class="rank-detail">${parts.join(' · ')}</span>`;
}

// 一门课的卡片：展开时显示确认 / 编辑的界面，收起时显示简要信息
function renderCard(c) {
  if (myClasses.selecting) {
    return renderSelectableCard(c);
  }
  if (myClasses.openId === c.id) {
    return renderEditor(c);
  }

  if (c.status === 'confirmed') {
    return renderClassRow(c);
  }

  // 需要确认的：收起时只说"可能在哪"，必须点 Review 才能看到详细信息并确认
  const noRoomText = c.noRoom ? 'Your schedule says "No room assigned".' : 'No room listed.';
  const hint = c.status === 'guess'
    ? `${noRoomText} Possible: ${c.candidates.map(function (o) { return keepOriginal(escapeHtml(o.place.code || o.place.name)); }).join(' or ')}.`
    : `${noRoomText} We can't guess one (online class?).`;
  return `
    <li class="class-card review" data-id="${c.id}">
      <span class="badge badge-review">❓ Needs your check</span>
      <strong translate="no">${escapeHtml(c.title)}</strong>
      ${classMetaLine(c)}
      <p class="card-note">${hint}</p>
      <button type="button" class="primary-button" data-action="open">Review</button>
    </li>`;
}

// 在地图上点了"我的课"的一栋楼：切到 My week，列表里在这栋楼上的课都标出来，滚过去
// 这栋楼只有一门课时直接展开；有好几门时都标出来，用户自己点要看的那一门
function showClassesAt(place) {
  logEvent('map-building');
  showTab('week');
  const here = myClasses.items.filter(function (c) {
    return c.status === 'confirmed' && c.place && c.place.id === place.id;
  });
  myClasses.mapPlaceId = place.id;
  myClasses.expandedId = here.length === 1 ? here[0].id : null;
  renderMyClasses();
  selectClassPlace(place);
  // 滚到这门课：直接跳过去（平滑滚动会被紧接着的地图移动打断）；nearest：刚好露出来就行，手机上地图还能看到一部分
  // 等这一轮地图、列表更新完再滚（放在 setTimeout 里），不然会被打断
  setTimeout(function () {
    const first = document.querySelector('#schedule-list .class-row.map-picked');
    if (first) {
      first.scrollIntoView({ block: 'nearest' });
    }
  }, 0);
}

// 已经确定的课：收起时只有一行（课名、楼、什么时候），点一下展开看详情
// 只留下和地图、课间步行对得上的信息：楼的代码和地图上的标签一样，时间用来看懂课间步行
function renderClassRow(c) {
  const expanded = myClasses.expandedId === c.id;
  // 在地图上点了这门课的楼：标出来（showClassesAt）
  const picked = myClasses.mapPlaceId !== null && c.place.id === myClasses.mapPlaceId ? ' map-picked' : '';
  const head = `
    <button type="button" class="class-row-head" data-action="toggle" aria-expanded="${expanded}">
      <span class="color-dot"></span>
      <span class="class-row-title" translate="no">${escapeHtml(c.title)}</span>
      <span class="class-row-where" translate="no">${escapeHtml(c.place.code || c.place.name)}</span>
      <span class="class-row-when">${escapeHtml(shortWhen(c))}</span>
    </button>`;
  if (!expanded) {
    return `<li class="class-row${picked}" data-id="${c.id}">${head}</li>`;
  }
  // 展开：完整的课号、时间、楼名、教室；只有用户自己设的地点才特别标出来
  const badge = c.source === 'schedule' ? '' : '<span class="badge badge-user">Location set by you</span>';
  return `
    <li class="class-row expanded${picked}" data-id="${c.id}">
      ${head}
      <div class="class-row-detail">
        ${badge}
        ${classMetaLine(c)}<br>
        <span class="rank-detail">${locationLabel(c.place, c.room)}</span>
        <button type="button" class="link-button edit-button" data-action="open">Edit</button>
        <button type="button" class="directions-button" data-action="directions">Directions ›</button>
      </div>
    </li>`;
}

// 一行里的"什么时候"：MWF 9:05 AM、TuTh 11:00 AM
const DAY_SHORT = { Mon: 'M', Tue: 'Tu', Wed: 'W', Thu: 'Th', Fri: 'F', Sat: 'Sa', Sun: 'Su' };

function shortWhen(c) {
  const days = c.days.map(function (d) { return DAY_SHORT[d] || d; }).join('');
  const time = c.start != null ? formatClock(c.start) : '';
  return [days, time].filter(Boolean).join(' ');
}

// 按一周的顺序排：先比第一天是星期几，再比几点上课
function compareByWeek(a, b) {
  const dayA = a.days.length > 0 ? DAY_ORDER.indexOf(a.days[0]) : 99;
  const dayB = b.days.length > 0 ? DAY_ORDER.indexOf(b.days[0]) : 99;
  return dayA - dayB || (a.start == null ? 9999 : a.start) - (b.start == null ? 9999 : b.start);
}

// ===== 批量选择 =====

// 工具条上的"移到另一份课表"：别的课表 + 新建一份（只有一份课表时，也能把一部分课拆出去）
function renderMoveRow(none) {
  let options = '';
  myClasses.schedules.forEach(function (schedule) {
    if (schedule.id !== myClasses.activeId) {
      options += `<option value="${schedule.id}" translate="no">${escapeHtml(schedule.name)}</option>`;
    }
  });
  options += `<option value="new">A new schedule (${escapeHtml(nextScheduleName())})</option>`;
  return `<div class="select-row">
      <label for="bulk-move" class="move-label">Move to</label>
      <select id="bulk-move" ${none}>${options}</select>
      <button type="button" class="small-button" data-action="bulk-move" ${none}>Move</button>
    </div>`;
}

// 列表上方的工具条
// 平时：只有一个 "Select" 按钮；批量选择时：显示选了几门，以及"全选、删除、设地点、完成"
function renderSelectToolbar(count) {
  if (count === 0) {
    return '';
  }
  if (!myClasses.selecting) {
    return `<div class="select-toolbar">
      <button type="button" class="link-button" data-action="select-start">Select classes</button>
    </div>`;
  }

  const n = myClasses.selected.size;
  const none = n === 0 ? 'disabled' : '';
  return `<div class="select-toolbar selecting">
    <div class="select-row">
      <strong>${n} selected</strong>
      <button type="button" class="link-button" data-action="select-all">${n === count ? 'Clear all' : 'Select all'}</button>
      <button type="button" class="link-button" data-action="select-done">Done</button>
    </div>
    <div class="select-row">
      <input type="search" id="bulk-location" list="place-options" placeholder="New location, e.g. CAS 211" ${none}>
      <button type="button" class="small-button" data-action="bulk-location" disabled>Set location</button>
    </div>
    ${renderMoveRow(none)}
    <button type="button" class="delete-button" data-action="bulk-delete" ${none}>
      Remove ${n} ${n === 1 ? 'class' : 'classes'}
    </button>
  </div>`;
}

// 批量选择模式下的卡片：前面一个圈，整张卡片都可以点
function renderSelectableCard(c) {
  const checked = myClasses.selected.has(c.id);
  const where = c.place ? locationLabel(c.place, c.room) : 'No location yet';
  return `
    <li class="class-card selectable ${checked ? 'selected' : ''}" data-id="${c.id}">
      <span class="select-circle">${checked ? '✓' : ''}</span>
      <span class="select-body">
        <strong translate="no">${escapeHtml(c.title)}</strong>
        ${classMetaLine(c)}<br>
        <span class="rank-detail">${where}</span>
      </span>
    </li>`;
}

// 批量操作：把勾选的课拿掉（可以 Undo）
// 不真的删：收进列表最下面的 "Removed & skipped"，过了 Undo 的时间也能一门一门放回来
function bulkDelete() {
  const ids = myClasses.selected;
  const n = ids.size;
  changeWithUndo(`Removed ${n} ${n === 1 ? 'class' : 'classes'}`, function () {
    myClasses.items.forEach(function (c) {
      if (ids.has(c.id) && c.status !== 'skipped') {
        c.statusBeforeSkip = c.status;
        c.status = 'skipped';
      }
    });
  });
  endSelecting();
}

// 批量操作：把勾选的课都设成同一个地点（可以 Undo）
function bulkSetLocation(found) {
  const ids = myClasses.selected;
  changeWithUndo(`Moved ${ids.size} to ${found.place.name}`, function () {
    myClasses.items.forEach(function (c) {
      if (ids.has(c.id)) {
        Object.assign(c, {
          place: found.place, room: found.room, code: found.place.code || '',
          status: 'confirmed', source: 'user', scanSuggestion: null, scanMessage: ''
        });
      }
    });
  });
  endSelecting();
}

function endSelecting() {
  myClasses.selecting = false;
  myClasses.selected = new Set();
  renderMyClasses();
}

// 批量选择工具条里的"新地点"输入框：认出地点才能点 Set location，按钮上写出是哪里
function updateBulkLocationButton() {
  const input = document.getElementById('bulk-location');
  const button = document.querySelector('[data-action="bulk-location"]');
  const found = resolveLocationText(input.value, myClasses.placeIndex);
  button.disabled = !found;
  button.textContent = found
    ? `Set to ${found.place.code || found.place.name}${found.room ? ' ' + found.room : ''}`
    : 'Set location';
}

// ===== 课的详情：课名、课号、类型、星期、时间（编辑卡片和导入预览共用） =====

// 分钟数 ↔ <input type="time"> 的值（"09:05"）
function toTimeValue(minutes) {
  if (minutes == null) {
    return '';
  }
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

function fromTimeValue(value) {
  const m = /^(\d{2}):(\d{2})/.exec(value || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// 一组可以改的输入框。输入：一门课（或导入预览里的一行）
function renderDetailFields(c) {
  const days = DAY_ORDER.map(function (d) {
    return `<label class="day-chip"><input type="checkbox" class="f-day" value="${d}" ${c.days.includes(d) ? 'checked' : ''}><span>${DAY_SHORT[d]}</span></label>`;
  }).join('');
  return `
    <div class="detail-fields">
      <label class="field">Class name
        <input type="text" class="f-title" maxlength="80" value="${escapeAttr(c.title || '')}" placeholder="e.g. Calculus 1" translate="no">
      </label>
      <div class="field-row">
        <label class="field">Course number
          <input type="text" class="f-course" maxlength="20" value="${escapeAttr(c.course || '')}" placeholder="e.g. CASMA 123" translate="no">
        </label>
        <label class="field field-short">Type
          <input type="text" class="f-section" maxlength="10" value="${escapeAttr(c.section || '')}" placeholder="LEC" translate="no">
        </label>
      </div>
      <fieldset class="field day-field"><legend>Days</legend><div class="day-chips">${days}</div></fieldset>
      <div class="field-row">
        <label class="field">Starts<input type="time" class="f-start" value="${toTimeValue(c.start)}"></label>
        <label class="field">Ends<input type="time" class="f-end" value="${toTimeValue(c.end)}"></label>
      </div>
      <p class="detail-error" role="alert"></p>
    </div>`;
}

// 读出输入框里的值，并检查
// 输出：{ title, course, section, days, start, end, time }；有问题时是 { error: '给用户看的话' }
function readDetailFields(box) {
  const value = function (cls) { return box.querySelector(cls).value.replace(/\s+/g, ' ').trim(); };
  const course = value('.f-course').toUpperCase();
  const title = value('.f-title') || course;
  const start = fromTimeValue(box.querySelector('.f-start').value);
  const end = fromTimeValue(box.querySelector('.f-end').value);
  if (!title) {
    return { error: 'Add a class name or a course number.' };
  }
  if (start === null && end !== null) {
    return { error: 'Add a start time too.' };
  }
  if (start !== null && end !== null && end <= start) {
    return { error: 'The end time must be after the start time.' };
  }
  return {
    title: title,
    course: course,
    section: value('.f-section').toUpperCase(),
    days: sortDays(Array.from(box.querySelectorAll('.f-day:checked')).map(function (i) { return i.value; })),
    start: start,
    end: start === null ? null : end,
    time: start === null ? '' : formatTimeRange({ start: start, end: end })
  };
}

// 把改好的详情放回一门课；课号改了，推测的候选楼也重新算
function applyDetails(item, details) {
  if (details.course !== item.course) {
    item.candidates = guessLocations(details.course, myClasses.placeIndex);
  }
  Object.assign(item, {
    title: details.title, course: details.course, section: details.section,
    days: details.days, start: details.start, end: details.end, time: details.time
  });
}

// 展开后的确认 / 编辑界面
function renderEditor(c) {
  const isEdit = c.status === 'confirmed';

  // 选项：编辑时第一个是"当前地点"；推测的候选楼；最后是"别的地方"（自己输入）
  const options = [];
  // 用户针对这门课再传了一张截图，并且在里面读到了地点：放在第一个、预先选中，但还是要用户点确认
  if (c.scanSuggestion) {
    options.push({ value: 'scan', place: c.scanSuggestion.place, room: c.scanSuggestion.room, note: 'Found in your new screenshot' });
  }
  if (isEdit) {
    options.push({ value: 'current', place: c.place, room: c.room, note: 'Current location' });
  }
  (c.candidates || []).forEach(function (o, i) {
    if (!isEdit || o.place.id !== c.place.id) {
      options.push({ value: 'guess-' + i, place: o.place, room: '', note: 'Why: ' + o.reason });
    }
  });

  // 预先选中哪个：有新截图读到的就选它；编辑时选"当前地点"；推测的一律不预先选中
  const preselected = c.scanSuggestion ? 'scan' : (isEdit ? 'current' : null);

  let optionsHtml = '';
  options.forEach(function (o) {
    const checked = o.value === preselected ? 'checked' : '';
    optionsHtml += `
      <label class="location-option">
        <input type="radio" name="location-${c.id}" value="${o.value}" ${checked}>
        <span>
          <strong>${locationLabel(o.place, o.room)}</strong><br>
          <span class="rank-detail" translate="no">${escapeHtml(o.place.address || '')}</span><br>
          <span class="option-note">${escapeHtml(o.note)}</span>
        </span>
      </label>`;
  });
  optionsHtml += `
    <label class="location-option">
      <input type="radio" name="location-${c.id}" value="other">
      <span>
        <strong>Somewhere else</strong>
        <input type="search" class="other-location" list="place-options" placeholder="e.g. CAS 211, GSU, 3 Cummington Mall">
        <span class="other-preview option-note"></span>
      </span>
    </label>`;

  // 手动添加的新课：只有"填一个地点"，没有截图可以再传
  if (c.draft) {
    return `
      <li class="class-card editing" data-id="${c.id}" data-mode="new">
        <strong>Add a class by hand</strong>
        <p class="card-note">For a class time we missed. Fill in what your schedule says.</p>
        ${renderDetailFields(c)}
        <p class="field-heading">Where it meets</p>
        <div class="location-options">${optionsHtml}</div>
        <button type="button" class="primary-button" data-action="confirm" disabled>Choose a location above</button>
        <div class="secondary-actions">
          <button type="button" class="link-button" data-action="save-details">Save without a location</button>
          <button type="button" class="link-button" data-action="cancel">Cancel</button>
        </div>
      </li>`;
  }

  const intro = isEdit
    ? 'Fix anything we read wrong, or change where this class meets.'
    : (c.status === 'guess'
      ? "Your schedule doesn't list a room for this class. Here's where it might be — <strong>check your schedule</strong> and pick the right one."
      : "Your schedule doesn't list a room, and we can't guess one. If it meets in person, tell us where. If it's online, skip it.");

  return `
    <li class="class-card editing" data-id="${c.id}" data-mode="${isEdit ? 'edit' : 'review'}">
      <strong translate="no">${escapeHtml(c.title)}</strong>
      ${classMetaLine(c)}
      <p class="card-note">${intro}</p>
      <details class="detail-box"${isEdit ? ' open' : ''}>
        <summary>Name, days and time</summary>
        ${renderDetailFields(c)}
      </details>
      <p class="field-heading">Where it meets</p>
      <div class="location-options">${optionsHtml}</div>
      <button type="button" class="primary-button" data-action="confirm" disabled>Choose a location above</button>
      <button type="button" class="scan-one-button" data-action="scan-one">📷 Add a screenshot or file that shows this class</button>
      <p class="scan-message option-note">${c.scanMessage ? escapeHtml(c.scanMessage) : ''}</p>
      <div class="secondary-actions">
        <button type="button" class="link-button" data-action="skip">${isEdit ? 'Remove from my map' : "It's online · Skip"}</button>
        ${isEdit ? '' : '<button type="button" class="link-button" data-action="save-details">Save details only</button>'}
        <button type="button" class="link-button" data-action="cancel">Cancel</button>
      </div>
    </li>`;
}

// ===== 展开的卡片里：当前选了哪个地点 =====

// 读出展开卡片里用户选的地点
// 输出：{ place, room }；还没选、或者"别的地方"还没填对时是 null
function readSelection(card, item) {
  const radio = card.querySelector('input[type="radio"]:checked');
  if (!radio) {
    return null;
  }
  if (radio.value === 'current') {
    return { place: item.place, room: item.room };
  }
  if (radio.value === 'scan') {
    return { place: item.scanSuggestion.place, room: item.scanSuggestion.room };
  }
  if (radio.value.startsWith('guess-')) {
    return { place: item.candidates[Number(radio.value.slice(6))].place, room: '' };
  }
  return resolveLocationText(card.querySelector('.other-location').value, myClasses.placeIndex);
}

// 根据选择，更新确认按钮：没选好就是灰的点不了；选好了，按钮上直接写出"确认的是哪里"
function updateConfirmButton(card) {
  const item = findItem(card);
  const selection = readSelection(card, item);
  const button = card.querySelector('[data-action="confirm"]');
  const preview = card.querySelector('.other-preview');
  const otherText = card.querySelector('.other-location').value;

  // "别的地方"输入框下面，实时显示认出来的是哪里
  if (otherText.trim() === '') {
    preview.textContent = '';
  } else {
    const found = resolveLocationText(otherText, myClasses.placeIndex);
    if (found) {
      const where = found.place.custom && found.place.name !== found.place.address
        ? `${found.place.name} (${found.place.address})` : found.place.name;
      preview.textContent = '→ ' + where + (found.room ? ', room ' + found.room : '');
    } else {
      // 不在我们的数据里：不直接说找不到，让用户去地图上查（按回车也可以）
      preview.innerHTML = 'Not in our building list yet. ' +
        '<button type="button" class="small-button" data-action="lookup-address">🔍 Look up this address</button>';
    }
  }

  if (selection) {
    const verb = card.dataset.mode === 'edit' ? 'Save' : 'Confirm';
    button.disabled = false;
    button.textContent = `✓ ${verb}: ${selection.place.name}${selection.room ? ' ' + selection.room : ''}`;
    showClassPreview(selection.place); // 地图上用空心问号标出来，让用户看到选的是哪栋楼
  } else {
    button.disabled = true;
    button.textContent = 'Choose a location above';
    clearClassPreview();
  }
}

// 编辑卡片里的详情：检查不通过时，在卡片里说明原因，把详情那一块展开，返回 null
function readCardDetails(card) {
  const details = readDetailFields(card);
  const error = card.querySelector('.detail-error');
  error.textContent = details.error || '';
  if (details.error) {
    const box = card.querySelector('.detail-box');
    if (box) {
      box.open = true;
    }
    error.scrollIntoView({ block: 'nearest' });
    return null;
  }
  return details;
}

// ===== 一次补完教室 =====
//
// 文件里没有教室时，一门一门点 Review 太累，很多人补到第二门就放弃了，课间步行就一直是空的
// 所以放进一个弹窗：一门课一行（LEC、DIS 一般在同一栋楼，只问一次），推测的楼直接是按钮，点一下就好

// 还要补地点的课，按课号合在一起
// 输出：[{ key, course, title, items: [这门课的各个时段], candidates: 推测的楼 }]
function coursesNeedingRooms() {
  const groups = [];
  myClasses.items.forEach(function (c) {
    if (c.draft || c.sample || (c.status !== 'guess' && c.status !== 'none')) {
      return;
    }
    const key = (c.course || c.title).toUpperCase();
    let group = groups.find(function (g) { return g.key === key; });
    if (!group) {
      group = { key: key, course: c.course, title: c.title, items: [], candidates: c.candidates || [] };
      groups.push(group);
    }
    group.items.push(c);
  });
  return groups.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
}

// afterImport：刚从导入预览过来（加了几个时段），弹窗里说明这是第 2 步
function openRoomsDialog(afterImport) {
  if (coursesNeedingRooms().length === 0) {
    return;
  }
  logEvent('rooms-dialog');
  myClasses.roomsAfterImport = afterImport || 0;
  myClasses.roomDraft = {}; // 课号 → { place, room, other: 正在输入别的地方, otherText, skip: 线上课 }
  renderRoomsDialog();
  const dialog = document.getElementById('rooms-dialog');
  if (!dialog.open) {
    dialog.showModal();
  }
}

function closeRoomsDialog() {
  const dialog = document.getElementById('rooms-dialog');
  if (dialog.open) {
    dialog.close();
  }
  dialog.innerHTML = '';
  myClasses.roomDraft = null;
}

// 一门课的一行：课名、这门课的几个时段，推测的楼（按钮）、别的地方、线上课
function renderRoomRow(group) {
  const draft = myClasses.roomDraft[group.key] || {};
  const meetings = group.items.slice().sort(compareMeetings).map(function (c) {
    return [c.section, shortWhen(c)].filter(Boolean).join(' ');
  }).join(' · ');
  const chips = group.candidates.map(function (o) {
    const selected = draft.place && !draft.other && draft.place.id === o.place.id;
    return `<button type="button" class="room-chip${selected ? ' selected' : ''}" data-action="room-pick" data-place="${escapeAttr(o.place.id)}"
      title="${escapeAttr(o.place.name + ' · ' + o.reason)}" aria-pressed="${selected}" translate="no">${escapeHtml(o.place.code || o.place.name)}</button>`;
  }).join('');
  const otherPicked = draft.other || (draft.place && !group.candidates.some(function (o) { return o.place.id === draft.place.id; }));
  let detail = '';
  if (draft.other) {
    const found = resolveLocationText(draft.otherText || '', myClasses.placeIndex);
    detail = `<div class="room-detail">
        <input type="search" class="room-other-input" list="place-options" value="${escapeAttr(draft.otherText || '')}"
          placeholder="Building or room, e.g. CAS 211, GSU" aria-label="Where ${escapeAttr(group.course)} meets" translate="no">
        <span class="room-preview">${found ? '→ ' + escapeHtml(found.place.name) + (found.room ? ', room ' + escapeHtml(found.room) : '') : (draft.otherText ? 'Not in our building list' : '')}</span>
      </div>`;
  } else if (draft.place) {
    detail = `<div class="room-detail">
        <span class="room-picked" translate="no">${escapeHtml(draft.place.name)}</span>
        <input type="text" class="room-number" value="${escapeAttr(draft.room || '')}" placeholder="Room # (optional)" aria-label="Room number" maxlength="12" translate="no">
      </div>`;
  }
  return `
    <li class="room-row${draft.place || draft.skip ? ' done' : ''}" data-key="${escapeAttr(group.key)}">
      <div class="room-course">
        <strong translate="no">${escapeHtml(group.title || group.course)}</strong>
        <span class="room-meetings" translate="no">${escapeHtml(group.course)}${meetings ? ' · ' + escapeHtml(meetings) : ''}</span>
      </div>
      <div class="room-choices">
        ${chips}
        <button type="button" class="room-chip${otherPicked ? ' selected' : ''}" data-action="room-other">${group.candidates.length > 0 ? 'Other' : 'Pick a building'}</button>
        <button type="button" class="room-chip room-chip-quiet${draft.skip ? ' selected' : ''}" data-action="room-skip" aria-pressed="${Boolean(draft.skip)}">Online</button>
      </div>
      ${detail}
    </li>`;
}

function renderRoomsDialog() {
  const dialog = document.getElementById('rooms-dialog');
  const groups = coursesNeedingRooms();
  const draft = myClasses.roomDraft;
  const done = groups.filter(function (g) { return draft[g.key] && (draft[g.key].place || draft[g.key].skip); }).length;
  const scroll = dialog.querySelector('.dlg-body') ? dialog.querySelector('.dlg-body').scrollTop : 0;
  dialog.innerHTML = `
    <div class="dlg-head">
      <div class="dlg-title">
        ${myClasses.roomsAfterImport ? `<p class="dlg-step">Step 2 of 2 · ${myClasses.roomsAfterImport} class ${myClasses.roomsAfterImport === 1 ? 'time' : 'times'} added</p>` : ''}
        <h2 id="rooms-dialog-title">Where are your classes?</h2>
        <p class="dlg-lead">Tap the building for each course. We guessed from the course number, so check it against your schedule.</p>
      </div>
      <button type="button" class="dlg-close" data-action="rooms-cancel" aria-label="Close without saving">×</button>
    </div>
    <div class="dlg-body dlg-body-single">
      <ul class="room-list">${groups.map(renderRoomRow).join('')}</ul>
    </div>
    <div class="dlg-foot">
      <div class="dlg-foot-row">
        <p class="import-foot-note">${done} of ${groups.length} ${groups.length === 1 ? 'course' : 'courses'} set${done < groups.length ? '. You can do the rest later.' : '.'}</p>
        <button type="button" class="ghost-button" data-action="rooms-cancel">Cancel</button>
        <button type="button" class="primary-button" data-action="rooms-save" ${done === 0 ? 'disabled' : ''}>Save</button>
      </div>
    </div>`;
  dialog.querySelector('.dlg-body').scrollTop = scroll;
}

// 把弹窗里还没记下的输入框（教室号、别的地方）记下来，再重画或保存
function keepRoomInputs() {
  const dialog = document.getElementById('rooms-dialog');
  dialog.querySelectorAll('.room-row').forEach(function (li) {
    const draft = myClasses.roomDraft[li.dataset.key];
    if (!draft) {
      return;
    }
    const number = li.querySelector('.room-number');
    if (number) {
      draft.room = number.value.trim();
    }
    const other = li.querySelector('.room-other-input');
    if (other) {
      draft.otherText = other.value;
      const found = resolveLocationText(other.value, myClasses.placeIndex);
      draft.place = found ? found.place : null;
      draft.room = found ? found.room : '';
    }
  });
}

function handleRoomsClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  if (action === 'rooms-cancel') {
    closeRoomsDialog();
    return;
  }
  keepRoomInputs();
  if (action === 'rooms-save') {
    saveRooms();
    return;
  }
  const li = button.closest('.room-row');
  const group = coursesNeedingRooms().find(function (g) { return g.key === li.dataset.key; });
  const draft = myClasses.roomDraft;
  if (action === 'room-pick') {
    const pick = group.candidates.find(function (o) { return o.place.id === button.dataset.place; });
    draft[group.key] = { place: pick.place, room: '' };
  } else if (action === 'room-other') {
    draft[group.key] = { other: true, otherText: '' };
  } else if (action === 'room-skip') {
    draft[group.key] = draft[group.key] && draft[group.key].skip ? {} : { skip: true };
  }
  renderRoomsDialog();
  if (action === 'room-other') {
    const input = document.querySelector(`#rooms-dialog .room-row[data-key="${group.key}"] .room-other-input`);
    if (input) {
      input.focus();
    }
  }
}

// "别的地方"输入框：打字时只更新下面那行"→ 认出来是哪里"；离开输入框（change）再重画，按钮上的数字跟着变
function handleRoomsInput(event) {
  if (!event.target.classList.contains('room-other-input')) {
    return;
  }
  const found = resolveLocationText(event.target.value, myClasses.placeIndex);
  const preview = event.target.parentElement.querySelector('.room-preview');
  preview.textContent = found
    ? '→ ' + found.place.name + (found.room ? ', room ' + found.room : '')
    : (event.target.value.trim() ? 'Not in our building list' : '');
  if (event.type === 'change') {
    keepRoomInputs();
    renderRoomsDialog();
  }
}

// 保存：每门课的所有时段一起设好；选了 Online 的收进 "Removed & skipped"（可以恢复）
function saveRooms() {
  const groups = coursesNeedingRooms();
  const draft = myClasses.roomDraft;
  const chosen = groups.filter(function (g) { return draft[g.key] && (draft[g.key].place || draft[g.key].skip); });
  closeRoomsDialog();
  if (chosen.length === 0) {
    return;
  }
  logEvent('rooms-saved');
  changeWithUndo(`Set ${chosen.length} ${chosen.length === 1 ? 'course' : 'courses'}`, function () {
    chosen.forEach(function (g) {
      const d = draft[g.key];
      g.items.forEach(function (c) {
        if (d.skip) {
          c.statusBeforeSkip = c.status;
          c.status = 'skipped';
        } else {
          Object.assign(c, {
            place: d.place, room: d.room || '', code: d.place.code || '',
            status: 'confirmed', source: 'user', scanSuggestion: null, scanMessage: ''
          });
        }
      });
    });
  });
}

// 手动添加：一门空的课，标成 draft（不存、不上地图），展开编辑卡片
function startManualClass() {
  logEvent('manual-add');
  myClasses.items = myClasses.items.filter(function (c) { return !c.draft; });
  const item = {
    id: nextClassId++, title: '', course: '', section: '', start: null, end: null, time: '', days: [],
    place: null, code: '', room: '', noRoom: false, candidates: [], status: 'none', source: 'user',
    scanSuggestion: null, scanMessage: '', draft: true
  };
  myClasses.items.push(item);
  myClasses.openId = item.id;
  showTab('week');
  renderMyClasses();
  const card = document.querySelector(`#schedule-list [data-id="${item.id}"]`);
  if (card) {
    updateConfirmButton(card);
    card.scrollIntoView({ block: 'nearest' });
    card.querySelector('.f-title').focus();
  }
}

function findItem(card) {
  const id = Number(card.dataset.id);
  return myClasses.items.find(function (c) { return c.id === id; });
}

// ===== 事件 =====

function handleListClick(event) {
  const button = event.target.closest('button[data-action]');

  // 批量选择模式：点一张卡片（任何位置）就勾选 / 取消勾选
  if (!button && myClasses.selecting) {
    const card = event.target.closest('.class-card.selectable');
    if (card) {
      const id = Number(card.dataset.id);
      if (myClasses.selected.has(id)) {
        myClasses.selected.delete(id);
      } else {
        myClasses.selected.add(id);
      }
      renderMyClasses();
    }
    return;
  }
  if (!button) {
    return;
  }
  const action = button.dataset.action;

  // 批量选择的工具条
  if (action === 'select-start') {
    myClasses.selecting = true;
    myClasses.openId = null; // 收起正在编辑的卡片
    myClasses.items = myClasses.items.filter(function (c) { return !c.draft; });
    clearClassPreview();
    renderMyClasses();
    return;
  }
  if (action === 'select-done') {
    endSelecting();
    return;
  }
  if (action === 'select-all') {
    const selectable = myClasses.items.filter(function (c) { return c.status !== 'skipped'; });
    myClasses.selected = myClasses.selected.size === selectable.length
      ? new Set()
      : new Set(selectable.map(function (c) { return c.id; }));
    renderMyClasses();
    return;
  }
  if (action === 'bulk-move') {
    moveSelectedTo(document.getElementById('bulk-move').value);
    return;
  }
  if (action === 'bulk-delete') {
    if (myClasses.selected.size > 0) {
      bulkDelete();
    }
    return;
  }
  if (action === 'bulk-location') {
    const found = resolveLocationText(document.getElementById('bulk-location').value, myClasses.placeIndex);
    if (found && myClasses.selected.size > 0) {
      bulkSetLocation(found);
    }
    return;
  }

  // 把课表传到另一台设备（share.js）
  if (action === 'share') {
    openSharePanel();
    return;
  }

  // 清空所有的课（包括跳过的），这个浏览器里存的也一起删掉；8 秒内可以 Undo
  if (action === 'clear-all') {
    const n = myClasses.items.length;
    changeWithUndo(`Cleared ${n} ${n === 1 ? 'class' : 'classes'}`, function () {
      myClasses.items = [];
    });
    return;
  }

  if (action === 'lookup-address') {
    handleAddressLookup(button.closest('[data-id]'));
    return;
  }

  // 一次补完教室
  if (action === 'rooms') {
    openRoomsDialog();
    return;
  }

  // 手动添加一节课：先放一门空的"草稿"课，展开它的编辑卡片
  if (action === 'add-manual') {
    startManualClass();
    return;
  }

  // 提示条上的"再传一张截图"：不属于某一门课，打开普通的上传框
  if (action === 'scan-all') {
    document.getElementById('schedule-file').click();
    return;
  }

  const card = button.closest('[data-id]');
  const item = findItem(card);

  // "针对这门课再传一张截图"：记住是哪门课，然后打开专用的上传框
  if (action === 'scan-one') {
    myClasses.scanTargetId = item.id;
    document.getElementById('class-scan-file').click();
    return;
  }

  // 点一门课的那一行：展开 / 收起详情；地图移到这栋楼、框出来，这门课的标签挪到框的上方（map.js）
  if (action === 'toggle') {
    myClasses.expandedId = myClasses.expandedId === item.id ? null : item.id;
    myClasses.mapPlaceId = null; // 用户自己在列表里点了一门课，不再标出地图上点的那栋楼
    renderMyClasses();
    selectClassPlace(myClasses.expandedId !== null ? item.place : null);
    return;
  }

  // 怎么走到这门课：带到 Directions，To 已经填好（my-week.js）
  if (action === 'directions') {
    directionsToClass(item, null);
    return;
  }

  if (action === 'open') {
    myClasses.openId = item.id;
    renderMyClasses();
    const opened = document.querySelector(`#schedule-list [data-id="${item.id}"]`);
    if (opened) {
      updateConfirmButton(opened);
    }
  } else if (action === 'cancel') {
    myClasses.openId = null;
    myClasses.items = myClasses.items.filter(function (c) { return !c.draft; });
    clearClassPreview();
    renderMyClasses();
  } else if (action === 'save-details') {
    // 只改课名、星期、时间，地点先不定（还在等确认的课保持原来的状态）
    const details = readCardDetails(card);
    if (!details) {
      return;
    }
    changeWithUndo(item.draft ? `Added ${details.title}` : `Saved ${details.title}`, function () {
      applyDetails(item, details);
      if (item.draft) {
        delete item.draft;
        item.status = item.candidates.length > 0 ? 'guess' : 'none';
      }
    });
  } else if (action === 'confirm') {
    const selection = readSelection(card, item);
    const details = readCardDetails(card);
    if (!selection || !details) {
      return; // 按钮是灰的时候本来就点不了，这里再保险一次
    }
    changeWithUndo(`${details.title} → ${selection.place.name}`, function () {
      applyDetails(item, details);
      delete item.draft;
      Object.assign(item, {
        place: selection.place,
        room: selection.room,
        code: selection.place.code || '',
        scanSuggestion: null, // 已经确认了，下次编辑不再显示"新截图里找到的"
        scanMessage: '',
        status: 'confirmed',
        source: item.source === 'schedule' && card.dataset.mode === 'edit' &&
          selection.place === item.place && selection.room === item.room ? 'schedule' : 'user'
      });
    });
  } else if (action === 'skip') {
    changeWithUndo(`Skipped ${item.title}`, function () {
      item.statusBeforeSkip = item.status;
      item.status = 'skipped';
    });
  } else if (action === 'restore') {
    changeWithUndo(`Restored ${item.title}`, function () {
      item.status = item.statusBeforeSkip || (item.candidates && item.candidates.length > 0 ? 'guess' : 'none');
    });
  }
}

// 选项变化、在"别的地方"里打字：更新确认按钮
function handleListInput(event) {
  if (event.target.id === 'bulk-location') {
    updateBulkLocationButton();
    return;
  }
  const card = event.target.closest('.class-card.editing');
  if (!card) {
    return;
  }
  // 在"别的地方"输入框里打字，就自动选中"别的地方"这个选项
  if (event.target.classList.contains('other-location')) {
    card.querySelector('input[type="radio"][value="other"]').checked = true;
  }
  updateConfirmButton(card);
}

// ===== 撤销提示 =====

function showToast(message) {
  const toast = document.getElementById('class-toast');
  toast.innerHTML = `<span>${escapeHtml(message)}</span> <button type="button" class="link-button" id="undo-button">Undo</button>`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.hidden = true; }, 8000);
}

function undoLastChange() {
  if (!myClasses.undo) {
    return;
  }
  // undo 有两种：一份课的旧样子（大多数操作），或者一个"怎么恢复"的函数（比如删掉了一整份课表）
  if (typeof myClasses.undo === 'function') {
    myClasses.undo();
  } else {
    myClasses.items = myClasses.undo.filter(function (c) { return !c.draft; });
  }
  myClasses.undo = null;
  myClasses.openId = null;
  document.getElementById('class-toast').hidden = true;
  renderMyClasses();
}

// ===== 读取课表 =====

// 读一个课表文件（截图、.ics、PDF、Word、文字都行），返回 { located, unlocated }
// 读不了时返回 { error: '给用户看的原因' }
// 输入：文件、这是第几个 / 一共几个（用来显示进度）
// context：几张截图连着读时共用的记录（schedule.js 的 parseTable 用它把上一张的星期接到下一张）
async function readOneFile(file, number, total, context) {
  const status = document.getElementById('schedule-status');
  const prefix = total > 1 ? `(${number} of ${total}) ` : '';
  try {
    return await readScheduleFile(file, myClasses.placeIndex, knownCourses(), function (message) {
      status.textContent = prefix + message;
    }, context);
  } catch (error) {
    console.log('Reading failed:', error);
    return { error: error.message || `Couldn't read ${file.name}.` };
  }
}

// 上传了一个或多个文件：一个一个读，结果合并进列表
async function handleScheduleFiles(files) {
  const status = document.getElementById('schedule-status');
  removeSampleClasses();

  hideOcrTip(); // 新的一次导入：上一次的提示、结果、没做完的导入预览先收起来
  status.textContent = '';
  dropPendingImport();
  renderImportChoice();

  // 1. 先把所有文件都在浏览器里读一遍，再决定放进哪一份课表
  const results = [];
  const errors = [];
  let failedImages = [];   // 网站自己读不出课的截图（一门课都没认出来，或者根本读不了）
  const doubtful = [];     // 网站读出了课、但看起来不对的截图（有课缺时间或星期）
  const context = {}; // 按顺序读：表格截图被切成几张时，下一张开头的课接着上一张的星期
  for (let i = 0; i < files.length; i++) {
    const result = await readOneFile(files[i], i + 1, files.length, context);
    const isImage = /^image\//.test(files[i].type) || /\.(png|jpe?g|heic|webp|gif)$/i.test(files[i].name);
    if (isImage && (result.error || result.located.length + result.unlocated.length === 0)) {
      failedImages.push(files[i]); // 截图读不出来：先不报错，下面交给 AI
    } else if (isImage && looksDoubtful(result)) {
      doubtful.push({ file: files[i], result: result }); // 读出来了，但缺时间或星期：下面让 AI 再读一遍
    } else if (result.error) {
      errors.push(result.error);
    } else {
      results.push(result);
    }
  }

  // 2. 读不出来的截图自动交给 AI（上传按钮下面写明了这一点）；后端没有 AI 时跳过
  let aiTried = false;
  let aiNote = ''; // AI 也没读出来的原因，比如"今天的次数用完了"：放进下面的提示卡里告诉用户
  if (failedImages.length > 0 && aiAvailable()) {
    aiTried = true;
    const ai = await readImagesWithAi(failedImages);
    ai.results.forEach(function (r) { results.push(r); });
    failedImages = ai.failed;
    aiNote = ai.errors.length > 0 ? ai.errors[0] : 'Our AI reader couldn’t find classes in it either.';
  }

  // 3. 读得不完整的截图：也交给 AI；AI 读得更完整就用 AI 的，否则还是用网站自己读的（用户可以在预览里改）
  for (const item of doubtful) {
    let best = item.result;
    if (aiAvailable()) {
      const ai = await readImagesWithAi([item.file]);
      if (ai.results.length > 0 && completeMeetings(ai.results[0]) >= completeMeetings(item.result)) {
        best = ai.results[0];
      }
    }
    results.push(best);
  }

  // 读完了："Reading …" 这类进度提示换成出错的原因；读出了课的话，出错的原因写进导入预览里
  status.textContent = errors.join(' ');
  errors.forEach(function () { logEvent('import-error'); });
  if (results.length > 0) {
    const source = files.length === 1 ? `"${files[0].name}"` : `${files.length} files`;
    // 截图把星期标题裁掉了：星期是按下一个标题往前推的，预览里提醒用户看一眼
    const guessed = sortDays([].concat.apply([], results.map(function (r) { return r.guessedDays || []; })));
    // 表头只有日期没有星期：星期是按日期推算的，记下用的是哪一年
    const dated = results.find(function (r) { return r.dateYear; });
    // 截图：预览里可以展开对照（只是这台设备上的临时网址，不上传）
    const images = files.filter(function (f) { return /^image\//.test(f.type); }).map(function (f) { return URL.createObjectURL(f); });
    offerImport(results, source, { guessed: guessed, errors: errors, dateYear: dated ? dated.dateYear : null, images: images });
  }
  // 网站和 AI 都没认出课的截图：不只说"没找到"，而是教用户怎么把截图里的字复制出来、粘贴进来
  // AI 已经试过了，提示卡里就不再放 "Read with AI" 按钮
  if (failedImages.length > 0) {
    showOcrTip(aiTried ? [] : failedImages, aiTried ? aiNote : '');
  }
  // 如果是从 "Find classes you share" 来的：换回自己的课表，打开 Shared classes（schedules.js）
  finishFindShared();
}

// 有几个时段是完整的（时间、星期都有）
function completeMeetings(result) {
  return result.located.concat(result.unlocated).filter(function (m) {
    return m.start != null && m.days.length > 0;
  }).length;
}

// 截图读出来的课看起来不对：有课缺时间或星期（比如日历的星期表头没认出来）
function looksDoubtful(result) {
  const all = result.located.concat(result.unlocated);
  return completeMeetings(result) < all.length;
}

// ===== 截图没认出课时的提示 =====
// 网站自己的识别（Tesseract）只认得写过规则的排版；手机和电脑自带的"复制图片里的文字"准得多，
// 而且也在设备上完成、不上传。所以失败时，一步一步教用户用它，再粘贴进来

// 不同设备复制图片文字的方法不一样
function ocrTipSteps() {
  const p = typeof devicePlatform === 'function' ? devicePlatform() : { ios: false, android: false };
  const mac = !p.ios && !p.android && /Macintosh/.test(navigator.userAgent); // 先排除 iPhone、Android，再看是不是 Mac
  if (p.ios) {
    return ['Open the screenshot in <strong>Photos</strong>',
      'Tap the <strong>text button</strong> in the corner (or touch and hold the text), then <strong>Select All</strong> → <strong>Copy</strong>',
      'Come back and tap <strong>Paste text</strong> below'];
  }
  if (mac) {
    return ['Open the screenshot in <strong>Preview</strong>',
      'Drag across the text to select it, then press <strong>⌘C</strong>',
      'Come back and click <strong>Paste text</strong> below'];
  }
  if (p.android) {
    return ['Open the screenshot in <strong>Google Photos</strong>',
      'Tap <strong>Lens</strong> → <strong>Text</strong> → <strong>Select all</strong> → <strong>Copy</strong>',
      'Come back and tap <strong>Paste text</strong> below'];
  }
  return ['Open the screenshot in an app that can copy text from images (for example Google Lens)',
    'Select all the text and copy it',
    'Come back and click <strong>Paste text</strong> below'];
}

// 输入：没读出来的截图（AI 按钮要用）；note：额外的一句说明（比如 AI 为什么也没读出来），可以不传
function showOcrTip(images, note) {
  const box = document.getElementById('ocr-tip');
  myClasses.ocrTipImages = images || [];
  const these = myClasses.ocrTipImages.length > 1 ? 'these screenshots' : 'this screenshot';
  // 第二个办法：交给 AI 读。只在用户点按钮时才上传，并且说清楚发给谁
  const aiOption = aiAvailable() && myClasses.ocrTipImages.length > 0
    ? '<div class="ocr-tip-ai">' +
      '<button type="button" class="small-button" id="ocr-tip-ai">✨ Read with AI</button>' +
      `<span class="hint">Sends ${these} to Anthropic’s Claude AI to read. We don’t save it, and it isn’t used to train AI.</span></div>`
    : '';
  // 已经有一句 "Couldn't find any classes…" 了：这张卡片说得更清楚，那句就不要了
  document.getElementById('schedule-status').textContent = '';
  box.innerHTML = '<p class="ocr-tip-title">📷 We couldn’t read classes from this screenshot.</p>' +
    (note ? `<p class="ocr-tip-lead">${escapeHtml(note)}</p>` : '') +
    '<p class="ocr-tip-lead">Easiest fix: copy the text out of it with your device, then paste it here. It takes about 20 seconds, and nothing is uploaded.</p>' +
    '<ol class="ocr-tip-steps">' + ocrTipSteps().map(function (s) { return `<li>${s}</li>`; }).join('') + '</ol>' +
    '<div class="ocr-tip-actions">' +
    '<button type="button" class="primary-button" id="ocr-tip-paste">📋 Paste text</button>' +
    '<span class="hint">or use your calendar file (.ics): the most accurate</span></div>' +
    aiOption;
  box.hidden = false;
  logEvent('ocr-tip');
  box.scrollIntoView({ block: 'nearest' });
}

function hideOcrTip() {
  const box = document.getElementById('ocr-tip');
  box.hidden = true;
  box.innerHTML = '';
  myClasses.ocrTipImages = [];
}

// 后端能不能用 AI 读图：有后端，而且后端没说"没有 AI 的 key"（还没回答时先当成能用）
function aiAvailable() {
  return Boolean(BACKEND_URL) && backendHasAi !== false;
}

// 把截图一张一张交给 AI（schedule-import.js），换成和其他读法一样的结果
// 输出：{ results: 读出课的结果, failed: AI 也没读出课的截图, errors: 出错的原因（给用户看）}
async function readImagesWithAi(images) {
  const status = document.getElementById('schedule-status');
  const results = [];
  const failed = [];
  const errors = [];
  logEvent('ai-read');
  for (let i = 0; i < images.length; i++) {
    const prefix = images.length > 1 ? `(${i + 1} of ${images.length}) ` : '';
    status.textContent = `${prefix}Reading ${images[i].name} with AI… The first try can take up to a minute.`;
    try {
      const data = await readScheduleWithAi(images[i]);
      const result = parseAiClasses(data.classes, myClasses.placeIndex, knownCourses());
      if (result.located.length + result.unlocated.length > 0) {
        results.push(result);
      } else {
        failed.push(images[i]);
      }
    } catch (error) {
      errors.push(error.message);
      failed.push(images[i]);
    }
  }
  status.textContent = '';
  if (results.length > 0) {
    logEvent('ai-ok');
  }
  if (failed.length > 0) {
    logEvent(errors.length > 0 ? 'ai-fail' : 'ai-empty');
  }
  return { results: results, failed: failed, errors: errors };
}

// 点了提示卡里的 "Read with AI"（后端当时还没说有没有 AI、自动那一步跳过了时才会出现）
async function readOcrTipWithAi() {
  const images = myClasses.ocrTipImages || [];
  const button = document.getElementById('ocr-tip-ai');
  const status = document.getElementById('schedule-status');
  if (images.length === 0 || !button) {
    return;
  }
  button.disabled = true;
  button.textContent = '✨ Reading…';

  const ai = await readImagesWithAi(images);
  if (ai.results.length > 0) {
    hideOcrTip();
    const dated = ai.results.find(function (r) { return r.dateYear; });
    offerImport(ai.results, images.length === 1 ? `"${images[0].name}"` : `${images.length} screenshots`,
      { dateYear: dated ? dated.dateYear : null });
    return;
  }
  status.textContent = ai.errors.length > 0
    ? ai.errors[0]
    : "The AI couldn't find classes in this screenshot either. Try pasting the text, or use your calendar file (.ics).";
  button.disabled = false;
  button.textContent = '✨ Read with AI';
}

// 点了 "Paste text"：打开粘贴框；浏览器允许读剪贴板的话，直接填进去并读出课（用户只要点一下）
async function pasteFromOcrTip() {
  logEvent('ocr-tip-paste');
  document.getElementById('add-schedule').open = true;   // 已经有课时，"添加课表"那一块是收起的
  document.getElementById('schedule-paste').open = true;
  const textarea = document.getElementById('schedule-text');
  let pasted = '';
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      pasted = (await navigator.clipboard.readText()).trim();
    }
  } catch (error) {
    // 浏览器不让读剪贴板（或者用户拒绝了）：让用户自己粘贴
  }
  textarea.scrollIntoView({ block: 'center' });
  if (pasted) {
    textarea.value = pasted;
    hideOcrTip();
    document.getElementById('schedule-text-button').click(); // 直接读，课就出来了
  } else {
    textarea.focus();
    document.getElementById('schedule-status').textContent = 'Paste the copied text into the box, then tap Read text.';
  }
}

// ===== 导入：先核对，再加进课表 =====
//
// 读到的课不直接放进课表，先显示一张"导入预览"：每个上课时段一行，可以改、删、补上漏掉的
// 识别不可能百分之百准，所以一定要让用户对照原图看一眼，有错能当场改
// 当前这份课表里已经有自己的课时，同一张卡片里再问"加进当前这份，还是另存一份"
// 读到的课大多和现在的不一样时，提醒一句"看起来是另一份课表"，但还是让用户自己选

// 读完文件、或者粘贴的文字以后都走这里
// 输入：[{ located, unlocated }]（每个文件一份）、给用户看的来源（比如 '"Fall 2026 calendar.ics"'）
//       options（可以不传）：
//         review：要不要先预览核对（默认要；分享链接里的课是整理好的，不用）
//         guessed：哪几天是猜的（截图把星期标题裁掉了）；errors：其他文件读不了的原因
//         dateYear：截图表头只有日期时，推算星期用的年份
//         images：截图在这台设备上的临时网址（URL.createObjectURL），预览里可以展开对照
function offerImport(results, source, options) {
  const opts = Object.assign({ review: true, guessed: [], errors: [], dateYear: null }, options || {});
  const found = [].concat.apply([], results.map(function (r) { return r.located.concat(r.unlocated); }));
  const status = document.getElementById('schedule-status');
  // 统计：读出了几门课（只记区间）
  logEvent(found.length === 0 ? 'import-empty' : 'import-ok-' + classCountBucket(found.length));
  if (found.length === 0) {
    status.textContent = [`Couldn't find any classes in ${source}. Try a clearer screenshot, paste the text, or add a class by hand.`]
      .concat(opts.errors).join(' ');
    return;
  }
  const hasOwnClasses = myClasses.items.some(function (c) { return !c.sample && !c.draft; });
  // 读到的课里，有几门当前这份课表里已经有了（同一门课、同一个时段）
  const already = found.filter(function (c) {
    return myClasses.items.some(function (item) { return sameMeeting(item, c); });
  }).length;
  // 全都已经有了（比如同一个文件又传了一次）：没有新东西，不用问，问了反而容易多出一份一样的课表
  // 还是照常合并一遍：文件里可能有原来没读到的教室、时间，可以补上
  if (hasOwnClasses && already === found.length) {
    logEvent('import-all-already');
    if (applyImport(results, 'add', '') > 0) {
      return; // 补上了地点：已经有 "Updated N classes… Undo" 的提示
    }
    flashStatus(`All ${found.length} ${found.length === 1 ? 'class' : 'classes'} from ${source} ${found.length === 1 ? 'is' : 'are'} already in "${activeSchedule().name}".`);
    return;
  }
  // 不用预览、也不用问加到哪里：直接加
  if (!opts.review && !hasOwnClasses) {
    applyImport(results, 'add', '');
    return;
  }
  let nextRow = 1;
  myClasses.pendingImport = {
    results: results,
    source: source,
    count: found.length,
    already: already,
    askTarget: hasOwnClasses,
    guessed: opts.guessed,
    errors: opts.errors,
    dateYear: opts.dateYear,
    images: opts.images || [], // 用户传的截图（只在这台设备上显示，方便对照）
    // 预览里的每一行：读到的一个上课时段，外加"地点"输入框里的文字
    rows: opts.review ? found.map(function (c) {
      const text = c.place ? (c.place.code || c.place.name) + (c.room ? ' ' + c.room : '') : '';
      return Object.assign({}, c, {
        days: c.days.slice(), key: nextRow++, locationText: text, readLocationText: text, open: false
      });
    }) : null,
    nextRow: nextRow
  };
  // 同一个课号、拼法差一点的课名（"Linear" / "Linsar"）：统一起来；一样多的让用户选
  if (myClasses.pendingImport.rows) {
    const existing = myClasses.items.filter(function (c) { return !c.sample && !c.draft && c.status !== 'skipped'; });
    myClasses.pendingImport.titleReport = unifyTitles(myClasses.pendingImport.rows, existing);
  }
  // 读文件时出的错（比如另一个文件读不了）写在预览卡片里；"Reading…" 这类进度提示清掉
  status.textContent = '';
  renderImportChoice();
  if (!myClasses.pendingImport.rows) {
    document.getElementById('import-choice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// 真正把读到的课放进去
// 输入：读到的结果、'add'（加进当前这份）或 'new'（另存一份，名字是 name）
// 输出：新文件帮多少门"原来没地点"的课补上了地点
function applyImport(results, target, name) {
  if (target === 'new') {
    createSchedule(name);
  }
  const hadClasses = myClasses.items.length > 0;
  // 记下读之前的样子：如果新文件自动补上了地点，用户可以 Undo
  const before = myClasses.items.map(function (item) {
    return Object.assign({}, item, { days: item.days.slice() });
  });

  let filledIn = 0;
  results.forEach(function (result) {
    filledIn += addParsedSchedule(result);
  });

  // 之前已经有课、这次新文件补上了地点：告诉用户补了几门，可以撤销
  if (hadClasses && filledIn > 0) {
    myClasses.undo = before;
    showToast(`Updated ${filledIn} ${filledIn === 1 ? 'class' : 'classes'} from your new file`);
  }
  if (target === 'new') {
    document.getElementById('schedule-status').textContent =
      `Saved as a new schedule, "${activeSchedule().name}". Switch between schedules at the top.`;
  }
  return filledIn;
}

// 关掉导入预览；预览里给截图开的临时网址也一起释放
function dropPendingImport() {
  const pending = myClasses.pendingImport;
  if (pending && pending.images) {
    pending.images.forEach(function (url) { URL.revokeObjectURL(url); });
  }
  myClasses.pendingImport = null;
}

// 预览里一行的"地点"：输入框里的文字没改过，就用读到的；改过了，重新认
function rowLocation(row) {
  if (row.place && row.locationText === row.readLocationText) {
    return { place: row.place, room: row.room };
  }
  return resolveLocationText(row.locationText, myClasses.placeIndex);
}

// 预览里展开的行：把输入框里的值记回这一行（不检查），重画卡片时才不会丢掉用户正在改的内容
function keepOpenRowInputs(box) {
  const pending = myClasses.pendingImport;
  if (!pending || !pending.rows) {
    return;
  }
  box.querySelectorAll('.preview-row.editing').forEach(function (li) {
    const row = pending.rows.find(function (r) { return r.key === Number(li.dataset.row); });
    if (!row) {
      return;
    }
    Object.assign(row, {
      title: li.querySelector('.f-title').value,
      course: li.querySelector('.f-course').value,
      section: li.querySelector('.f-section').value,
      days: Array.from(li.querySelectorAll('.f-day:checked')).map(function (i) { return i.value; }),
      start: fromTimeValue(li.querySelector('.f-start').value),
      end: fromTimeValue(li.querySelector('.f-end').value),
      locationText: li.querySelector('.f-location').value
    });
  });
}

// 关上一行：检查输入，通过了才收起。输出：通过了没有
function closePreviewRow(li) {
  const row = myClasses.pendingImport.rows.find(function (r) { return r.key === Number(li.dataset.row); });
  const details = readDetailFields(li);
  if (details.error) {
    li.querySelector('.detail-error').textContent = details.error;
    li.scrollIntoView({ block: 'nearest' });
    return false;
  }
  Object.assign(row, details, { locationText: li.querySelector('.f-location').value.trim(), open: false });
  return true;
}

// ===== 导入预览：让用户一眼看出哪里不对 =====
//
// 大多数人不会逐行核对。所以：
//   1. 先画一张小小的周课表：日期全错了（比如全在周六）一眼就看得出来，比读一串文字快得多
//   2. 网站自己先挑出"可疑"的行（缺星期、缺时间、在周末、和别的课撞时间、课名像认错了），
//      放在最上面，直接在那一行里给出要改的那一项（不是一整张表单）
//   3. 没问题的行收起来，只占一行；想看可以展开
//   4. 按钮上方说清楚"不改会怎样"（比如没有星期的课不会算进课间步行），而不是只说"请检查"

// 课名像不像认错了：比如 OCR 把 "Linear Algebra" 认成 "peste"
function titleLooksMisread(row) {
  const t = (row.title || '').trim();
  if (!t || t.toUpperCase() === (row.course || '').toUpperCase()) {
    return false; // 没读到课名：只用课号，不算错
  }
  return /^[a-z]{1,7}$/.test(t) || !/[aeiouy]/i.test(t) || /[^A-Za-z0-9 &,:'’()\-\/.+#]/.test(t);
}

// 这一行有哪些地方可疑
// 输出：[{ kind: 'days' | 'time' | 'weekend' | 'clash' | 'name', text: '给用户看的话' }]
function rowIssues(row, rows) {
  const issues = [];
  // 同一门课两种拼法：只在这门课的第一行问一次（选了以后这门课的所有时段一起改）
  const firstOfCourse = rows.find(function (r) { return r.course === row.course && r.titleOptions; });
  if (row.titleOptions && firstOfCourse === row) {
    issues.push({ kind: 'pick', text: `Two spellings for ${row.course}. Which name is right?` });
  }
  if (row.days.length === 0) {
    issues.push({ kind: 'days', text: 'Which days does it meet? We couldn’t tell.' });
  }
  if (row.start == null) {
    issues.push({ kind: 'time', text: 'What time does it start and end?' });
  }
  const weekend = row.days.filter(function (d) { return d === 'Sat' || d === 'Sun'; });
  if (weekend.length > 0) {
    issues.push({ kind: 'weekend', text: `On ${weekend.join(' and ')}? Few classes meet then, so the day may be misread.` });
  }
  if (row.start != null) {
    const clash = rows.find(function (other) {
      return other !== row && other.start != null && other.days.some(function (d) { return row.days.includes(d); }) &&
        other.start < (row.end || row.start + 50) && row.start < (other.end || other.start + 50);
    });
    if (clash) {
      const day = clash.days.find(function (d) { return row.days.includes(d); });
      issues.push({ kind: 'clash', text: `Overlaps ${clash.course || clash.title}${clash.section ? ' ' + clash.section : ''} on ${day}. One of the two days or times may be misread.` });
    }
  }
  if (!row.titleOptions && titleLooksMisread(row)) {
    issues.push({ kind: 'name', text: `“${row.title}” doesn’t look like a class name.` });
  }
  return issues;
}

// 用户点了"没问题"的行，不再算可疑
function needsLook(row, rows) {
  return !row.ok && rowIssues(row, rows).length > 0;
}

// 一行的星期 + 时间，比如 "Mon, Wed · 10:10 AM – 11:00 AM"
function rowWhen(row) {
  return [row.days.join(', '), row.time].filter(Boolean).join(' · ');
}

// 一行的地点文字
function rowWhere(row) {
  const location = rowLocation(row);
  if (location) {
    return locationLabel(location.place, location.room);
  }
  if (row.locationText) {
    return `${keepOriginal(escapeHtml(row.locationText))} · not in our building list yet`;
  }
  return row.noRoom ? 'No room assigned' : 'No room listed';
}

// ----- 小周课表 -----

// 输出：HTML；上课时段在格子里的位置按时间算，可疑的格子用琥珀色描边，点一下跳到那一行
// focusKey：用户点过的那一行，课表里对应的格子加粗描边
function renderMiniWeek(rows, focusKey) {
  const timed = rows.filter(function (r) { return r.start != null && r.days.length > 0; });
  const usesWeekend = timed.some(function (r) { return r.days.includes('Sat') || r.days.includes('Sun'); });
  const days = usesWeekend ? DAY_ORDER : DAY_ORDER.slice(0, 5);
  let from = 8 * 60;
  let to = 17 * 60;
  timed.forEach(function (r) {
    from = Math.min(from, Math.floor(r.start / 60) * 60);
    to = Math.max(to, Math.ceil((r.end || r.start + 50) / 60) * 60);
  });
  const pxPerMinute = 0.6; // 1 小时 36 像素：50 分钟的课放得下课号和时间
  const height = (to - from) * pxPerMinute;

  // 时间轴：每小时一个刻度，格子里每小时一条细线（--hour）
  let axis = '';
  for (let t = from; t <= to; t += 60) {
    const h = t / 60;
    axis += `<span class="mini-hour" style="top:${(t - from) * pxPerMinute}px">${h % 12 || 12}${h >= 12 ? 'p' : 'a'}</span>`;
  }

  const columns = days.map(function (day) {
    const today = timed.filter(function (r) { return r.days.includes(day); })
      .sort(function (a, b) { return a.start - b.start; });
    // 撞时间的并排放：每个格子找一条不重叠的"车道"
    const lanes = [];
    const placed = today.map(function (r) {
      const end = r.end || r.start + 50;
      let lane = lanes.findIndex(function (laneEnd) { return laneEnd <= r.start; });
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(end);
      } else {
        lanes[lane] = end;
      }
      return { row: r, lane: lane, end: end };
    });
    const laneCount = Math.max(lanes.length, 1);
    const blocks = placed.map(function (p) {
      const flagged = needsLook(p.row, rows) ? ' flagged' : '';
      const focused = p.row.key === focusKey ? ' focused' : '';
      const label = (p.row.course || p.row.title).replace(/^[A-Z]{3}(?=[A-Z]{2}\s)/, ''); // CASMA 242 → MA 242
      const tall = (p.end - p.row.start) * pxPerMinute >= 26;
      const text = laneCount > 1 ? '' : `<span class="mini-code">${escapeHtml(label)}</span>` +
        (tall ? `<span class="mini-time">${escapeHtml(formatClock(p.row.start).replace(/ [AP]M$/, ''))}</span>` : '');
      return `<button type="button" class="mini-block${flagged}${focused}" data-action="row-focus" data-row="${p.row.key}"
        style="top:${(p.row.start - from) * pxPerMinute}px;height:${Math.max((p.end - p.row.start) * pxPerMinute, 16)}px;left:calc(${p.lane / laneCount * 100}% + 1px);width:calc(${100 / laneCount}% - 2px)"
        title="${escapeAttr((p.row.course + ' ' + p.row.section).trim() + ' · ' + rowWhen(p.row))}" translate="no">${text}</button>`;
    }).join('');
    const weekend = day === 'Sat' || day === 'Sun' ? ' weekend' : '';
    return `<div class="mini-day${weekend}"><span class="mini-day-name">${day}</span><div class="mini-day-body" style="height:${height}px;--hour:${60 * pxPerMinute}px">${blocks}</div></div>`;
  }).join('');

  const off = rows.filter(function (r) { return r.start == null || r.days.length === 0; });
  const offNote = off.length > 0
    ? `<p class="mini-off">Not on the calendar yet: ${off.map(function (r) { return keepOriginal(escapeHtml((r.course + ' ' + r.section).trim())); }).join(', ')}</p>`
    : '';
  return `<div class="mini-week" aria-label="Your week as we read it">
      <div class="mini-axis" style="height:${height}px">${axis}</div>
      ${columns}
    </div>${offNote}`;
}

// ----- 预览里的行 -----

// 可疑的行：说清楚哪里可疑，并且直接在这一行里给出要改的那一项
function renderIssueRow(row, rows) {
  const issues = rowIssues(row, rows);
  // 要改的输入框一旦出现就留着（改到一半问题消失了，输入框也不能突然不见）
  row.fixKinds = Array.from(new Set((row.fixKinds || []).concat(issues.map(function (i) { return i.kind; }))));
  const kinds = row.fixKinds;
  const fixed = issues.length === 0;
  let fix = '';
  if (row.titleOptions && issues.some(function (i) { return i.kind === 'pick'; })) {
    fix += `<div class="title-options">${row.titleOptions.map(function (t) {
      return `<button type="button" class="quiet-button" data-action="pick-title" data-title="${escapeAttr(t)}" translate="no">${escapeHtml(t)}</button>`;
    }).join('')}</div>`;
  }
  if (kinds.includes('name')) {
    fix += `<label class="field">Class name<input type="text" class="q-title" maxlength="80" value="${escapeAttr(row.title)}" translate="no"></label>`;
  }
  if (kinds.some(function (k) { return k === 'days' || k === 'weekend' || k === 'clash'; })) {
    fix += `<div class="day-chips q-days">${DAY_ORDER.map(function (d) {
      return `<label class="day-chip"><input type="checkbox" class="q-day" value="${d}" ${row.days.includes(d) ? 'checked' : ''}><span>${DAY_SHORT[d]}</span></label>`;
    }).join('')}</div>`;
  }
  if (kinds.includes('time') || kinds.includes('clash')) {
    fix += `<div class="field-row">
        <label class="field">Starts<input type="time" class="q-start" value="${toTimeValue(row.start)}"></label>
        <label class="field">Ends<input type="time" class="q-end" value="${toTimeValue(row.end)}"></label>
      </div>`;
  }
  return `
    <li class="preview-row issue" data-row="${row.key}">
      <div class="issue-head">
        <strong translate="no">${escapeHtml(row.title || row.course)}</strong>
        <span class="rank-detail">${keepOriginal(escapeHtml([row.course, row.section].filter(Boolean).join(' ')))}${rowWhen(row) ? ' · ' + escapeHtml(rowWhen(row)) : ''}</span>
      </div>
      ${fixed
        ? '<p class="issue-fixed">Looks good now</p>'
        : `<ul class="issue-list">${issues.map(function (i) { return `<li>${escapeHtml(i.text)}</li>`; }).join('')}</ul>`}
      <div class="issue-fix">${fix}</div>
      <div class="preview-actions">
        <button type="button" class="quiet-button${fixed ? ' quiet-button-solid' : ''}" data-action="row-ok">${fixed ? 'Done' : (issues.some(function (i) { return i.kind === 'days' || i.kind === 'time'; }) ? 'Leave it for now' : 'It’s right')}</button>
        <button type="button" class="text-button" data-action="row-edit">Edit everything</button>
        <button type="button" class="text-button text-button-danger" data-action="row-remove">Remove</button>
      </div>
    </li>`;
}

// 没问题的行：只占一行
// hideMissingRoom：整份文件都没有教室时，每一行都写 "No room listed" 只是噪音，不写
function renderGoodRow(row, hideMissingRoom) {
  return `
    <li class="preview-row good" data-row="${row.key}">
      <button type="button" class="good-main" data-action="row-edit">
        <span class="good-when">${escapeHtml(shortWhen(row)) || '—'}</span>
        <span class="good-name" translate="no">${escapeHtml([row.course, row.section].filter(Boolean).join(' ') || row.title)}</span>
        ${hideMissingRoom && !rowLocation(row) && !row.locationText ? '' : `<span class="good-where">${rowWhere(row)}</span>`}
      </button>
      <button type="button" class="link-button" data-action="row-remove" aria-label="Remove ${escapeAttr(row.course || row.title)}">✕</button>
    </li>`;
}

// 展开改全部：和编辑卡片一样的输入框，再加一个地点
function renderPreviewEditor(row) {
  return `
    <li class="preview-row editing" data-row="${row.key}">
      ${renderDetailFields(row)}
      <label class="field">Room
        <input type="search" class="f-location" list="place-options" value="${escapeAttr(row.locationText)}" placeholder="e.g. CAS 211 (leave empty if not listed)" translate="no">
      </label>
      <div class="preview-actions">
        <button type="button" class="small-button" data-action="row-done">Done</button>
        <button type="button" class="link-button" data-action="row-remove">Remove</button>
      </div>
    </li>`;
}

// 导入预览画在哪里：要核对的（有 rows）在页面中间的弹窗里；只问"加进哪一份"的小卡片在侧栏里
function importRoot() {
  const pending = myClasses.pendingImport;
  return pending && pending.rows ? document.getElementById('import-dialog') : document.getElementById('import-choice');
}

// "加进当前这份 / 另存一份"：已经有自己的课时才问
function renderTargetChoice(pending, count, alreadyCount) {
  if (!pending.askTarget) {
    return '';
  }
  const current = escapeHtml(activeSchedule().name);
  const target = pending.target || 'add';
  const alreadyNote = alreadyCount > 0 ? ` <span class="option-note">${alreadyCount} already there</span>` : '';
  // 一半以上都是现在没有的课：多半是另一份课表（Plan B、室友的），提醒一句
  const looksDifferent = alreadyCount < count / 2 && target === 'add'
    ? `<p class="hint import-hint">These look different from "${current}". A new schedule keeps the two apart.</p>`
    : '';
  return `
    <div class="target-choice" role="radiogroup" aria-label="Where to add them">
      <label class="target-option"><input type="radio" name="import-target" value="add" ${target === 'add' ? 'checked' : ''}><span>Add to "${current}"${alreadyNote}</span></label>
      <label class="target-option"><input type="radio" name="import-target" value="new" ${target === 'new' ? 'checked' : ''}><span>Save as a new schedule</span></label>
    </div>
    <input type="text" id="import-name" class="import-name" maxlength="40" aria-label="New schedule name"
      value="${escapeAttr(pending.suggestedName || nextScheduleName())}" ${target === 'new' ? '' : 'hidden'}>
    ${looksDifferent}`;
}

// 显示导入预览（弹窗）/ "加进哪一份"的选择卡片（侧栏）；没有要选的时候都清空
function renderImportChoice() {
  const box = document.getElementById('import-choice');
  const dialog = document.getElementById('import-dialog');
  const pending = myClasses.pendingImport;
  if (!pending || !pending.rows) {
    if (dialog.open) {
      dialog.close();
    }
    dialog.innerHTML = '';
  }
  if (!pending) {
    box.innerHTML = '';
    return;
  }
  const root = importRoot();
  keepOpenRowInputs(root);
  // 保留用户已经选的"加进哪一份"和新名字（重画时不要跳回默认）
  const chosen = root.querySelector('input[name="import-target"]:checked');
  const typedName = root.querySelector('#import-name');
  if (chosen) {
    pending.target = chosen.value;
  }
  if (typedName) {
    pending.suggestedName = typedName.value;
  }

  if (pending.rows) {
    box.innerHTML = '';
    renderImportDialog(pending, dialog);
    return;
  }

  // 不用核对（比如分享链接）：侧栏里一张小卡片，只问加进哪一份
  box.innerHTML = `
    <div class="import-choice">
      <strong>✓ Found ${pending.count} ${pending.count === 1 ? 'class' : 'classes'} in ${escapeHtml(pending.source)}</strong>
      ${renderTargetChoice(pending, pending.count, pending.already)}
      <div class="import-actions">
        <button type="button" class="primary-button" data-action="import-done">Done</button>
        <button type="button" class="link-button" data-action="import-cancel">Cancel</button>
      </div>
    </div>`;
}

// 来源的名字给人看：手机存的截图名常是一长串乱码（"08c6ec4d178d….jpg"、"IMG_4821.PNG"），不如直接说"your screenshot"
function friendlySource(source) {
  const name = source.replace(/^"|"$/g, '');
  if (/^[0-9a-f-]{16,}\.\w+$/i.test(name) || /^(IMG|image|photo)[\s_-]?[\d\s_.:-]*\.\w+$/i.test(name) || /^(Screenshot|Screen Shot|截屏|屏幕截图)/i.test(name)) {
    return 'your screenshot';
  }
  return name.length > 32 ? `"${name.slice(0, 28)}…"` : source;
}

// 导入预览弹窗：左边（手机上是上面）是这一周的课表，右边是要看一眼的课和其他课，底部是"添加"
// 弹窗不占满屏幕：四周露出变暗的页面，让人知道还在同一个网页里，关掉就回到原来的地方
function renderImportDialog(pending, dialog) {
  // 删掉的行不真的丢掉：收进最下面的 "Removed"，随时可以放回来
  const rows = pending.rows.filter(function (r) { return !r.removed; });
  const removed = pending.rows.filter(function (r) { return r.removed; });
  const lastRemoved = removed.find(function (r) { return r.key === pending.lastRemoved; });
  rows.forEach(function (row) {
    row.already = myClasses.items.some(function (item) { return !item.draft && sameMeeting(item, row); });
  });
  const count = rows.length;
  const alreadyCount = rows.filter(function (r) { return r.already; }).length;
  const courses = new Set(rows.map(function (r) { return (r.course || r.title).toUpperCase(); })).size;
  const editing = rows.filter(function (r) { return r.open; });
  // 正在改的可疑行（fixing）留在原地，直到用户点 Done，免得改了一个星期，那一行就跳走了
  const isIssue = function (r) { return !r.open && (r.fixing || needsLook(r, rows)); };
  const issues = rows.filter(isIssue);
  const good = rows.filter(function (r) { return !r.open && !isIssue(r); });

  // 整张截图的提醒：星期是推算 / 猜的
  let notes = '';
  if (pending.dateYear) {
    notes += `<p class="import-note">📅 Your screenshot shows dates, not weekdays, so we worked out the days (assuming ${pending.dateYear}).</p>`;
  }
  if (pending.guessed.length > 0) {
    notes += `<p class="import-note">📅 A day heading was cut off, so we guessed ${escapeHtml(pending.guessed.join(', '))} for some classes.</p>`;
  }
  // 自动统一过的课名：说出来，用户才知道网站改了什么（在行里还能再改）
  const fixes = (pending.titleReport ? pending.titleReport.fixed : []).filter(function (f, i, all) {
    return all.findIndex(function (g) { return g.from === f.from && g.to === f.to; }) === i;
  });
  if (fixes.length > 0) {
    notes += `<p class="import-note">✏️ Fixed ${fixes.length === 1 ? 'a misread name' : 'misread names'}: ${fixes.map(function (f) {
      return `${keepOriginal(escapeHtml(f.from))} → ${keepOriginal(escapeHtml(f.to))}`;
    }).join(', ')}.</p>`;
  }
  pending.errors.forEach(function (e) {
    notes += `<p class="import-note">${escapeHtml(e)}</p>`;
  });
  const shot = pending.images && pending.images.length > 0
    ? `<details class="source-shot"><summary>Compare with your screenshot</summary>${pending.images.map(function (url) { return `<img src="${url}" alt="Your uploaded schedule">`; }).join('')}</details>`
    : '';

  const allGood = issues.length === 0 && editing.length === 0;
  // 还没有教室的课（按课号算）：添加以后紧接着选楼，所以这一步只核对星期和时间
  const noRoomCourses = new Set(rows.filter(function (r) { return !rowLocation(r); })
    .map(function (r) { return (r.course || r.title).toUpperCase(); })).size;
  const noRoomAll = noRoomCourses > 0 && rows.every(function (r) { return !rowLocation(r); });
  // 刚删掉一行：最上面一条提示，可以马上撤销
  const undoBar = lastRemoved
    ? `<div class="undo-bar" role="status"><span>Removed <strong translate="no">${escapeHtml([lastRemoved.course, lastRemoved.section].filter(Boolean).join(' ') || lastRemoved.title)}</strong></span>
        <button type="button" class="undo-bar-button" data-action="row-restore" data-row="${lastRemoved.key}">Undo</button></div>`
    : '';
  const removedHtml = removed.length > 0
    ? `<details class="good-list removed-list"><summary class="preview-heading">Removed <span class="count-pill count-pill-quiet">${removed.length}</span></summary>
        <ul class="preview-list">${removed.map(function (r) {
          return `<li class="preview-row removed" data-row="${r.key}">
              <span class="removed-name" translate="no">${escapeHtml([r.course, r.section].filter(Boolean).join(' ') || r.title)}</span>
              <span class="removed-when">${escapeHtml(shortWhen(r))}</span>
              <button type="button" class="quiet-button" data-action="row-restore">Restore</button>
            </li>`;
        }).join('')}</ul></details>`
    : '';
  const side = `
    ${undoBar}
    ${allGood && noRoomCourses === 0 ? '<p class="all-good">Everything looks right. Give the calendar one glance, then add.</p>' : ''}
    ${allGood && noRoomCourses > 0 ? `<div class="next-step">
        <p class="next-step-title">Days and times look right</p>
        <p class="next-step-text">Next, pick where ${noRoomCourses === 1 ? 'your course meets' : `your ${noRoomCourses} courses meet`}. ${noRoomAll ? 'This file doesn’t list rooms.' : 'Some rooms are missing.'} It takes a few taps.</p>
      </div>` : ''}
    ${editing.length > 0 ? '<ul class="preview-list">' + editing.map(renderPreviewEditor).join('') + '</ul>' : ''}
    ${issues.length > 0 ? `<h3 class="preview-heading issue-heading">Needs a quick look <span class="count-pill">${issues.length}</span></h3>
      <ul class="preview-list">${issues.map(function (r) { return renderIssueRow(r, rows); }).join('')}</ul>` : ''}
    ${good.length > 0 ? `<details class="good-list"${allGood ? ' open' : ''}>
      <summary class="preview-heading">${noRoomCourses > 0 ? 'Days &amp; times look right' : 'Looks right'} <span class="count-pill count-pill-quiet">${good.length}</span></summary>
      <ul class="preview-list">${good.map(function (r) { return renderGoodRow(r, noRoomAll); }).join('')}</ul></details>` : ''}
    <button type="button" class="add-row-button" data-action="row-add">+ Add a class time we missed</button>
    ${removedHtml}`;

  // 不改会怎样：没有星期或时间的课，不会出现在课间步行里
  const incomplete = rows.filter(function (r) { return r.start == null || r.days.length === 0; }).length;
  const open = issues.filter(function (r) { return needsLook(r, rows); }).length;
  let footNote = '';
  if (incomplete > 0) {
    footNote = `${incomplete} without a day or time won’t show in your walks until you add one.`;
  } else if (open > 0) {
    footNote = `${open} still flagged. You can also fix ${open === 1 ? 'it' : 'them'} later in My classes.`;
  } else if (noRoomCourses > 0) {
    footNote = 'Step 1 of 2: days and times. Next: rooms.';
  }

  // 重画时不要让内容跳动：记下两块可以滚动的地方
  const scroll = ['.dlg-body', '.dlg-side', '.dlg-week'].map(function (sel) {
    const el = dialog.querySelector(sel);
    return el ? el.scrollTop : 0;
  });
  const focused = document.activeElement && dialog.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused ? [focused.closest('[data-row]') && focused.closest('[data-row]').dataset.row, focused.className, focused.value] : null;

  dialog.innerHTML = `
    <div class="dlg-head">
      <div class="dlg-title">
        <h2 id="import-dialog-title">Check your classes</h2>
        <p class="dlg-lead">We found <strong>${courses} ${courses === 1 ? 'course' : 'courses'}</strong> and <strong>${count} class ${count === 1 ? 'time' : 'times'}</strong> in <span translate="no">${escapeHtml(friendlySource(pending.source))}</span>. Does your week look like this?</p>
      </div>
      <button type="button" class="dlg-close" data-action="import-cancel" aria-label="Close without adding">×</button>
    </div>
    <div class="dlg-body">
      <section class="dlg-week" aria-label="Your week as we read it">
        ${renderMiniWeek(rows, pending.focus)}
        ${notes}
        ${shot}
      </section>
      <section class="dlg-side" aria-label="Classes">${side}</section>
    </div>
    <div class="dlg-foot">
      ${renderTargetChoice(pending, count, alreadyCount)}
      <div class="dlg-foot-row">
        <p class="import-foot-note">${footNote}</p>
        <button type="button" class="ghost-button" data-action="import-cancel">Cancel</button>
        <button type="button" class="primary-button" data-action="import-done" ${count === 0 ? 'disabled' : ''}>${count === 0 ? 'Nothing to add' : (noRoomCourses > 0 ? 'Next: add rooms →' : `Add ${count} class ${count === 1 ? 'time' : 'times'}`)}</button>
      </div>
    </div>`;
  ['.dlg-body', '.dlg-side', '.dlg-week'].forEach(function (sel, i) {
    const el = dialog.querySelector(sel);
    if (el) {
      el.scrollTop = scroll[i];
    }
  });
  if (!dialog.open) {
    dialog.showModal();
    dialog.querySelector('.dlg-body').scrollTop = 0;
  }
  // 重画前光标在哪个输入框，重画后放回去（比如在可疑行里刚点了一个星期）
  if (focusKey) {
    const again = Array.from(dialog.querySelectorAll('input, button')).find(function (el) {
      const row = el.closest('[data-row]');
      return (row ? row.dataset.row : undefined) === focusKey[0] && el.className === focusKey[1] && el.value === focusKey[2];
    });
    if (again) {
      again.focus({ preventScroll: true });
    }
  }
}

// 可疑行里直接改的那一项（星期、时间、课名）：改完马上记下，重画卡片（问题解决了的行会挪到"没问题"里）
function handleImportChange(event) {
  const pending = myClasses.pendingImport;
  const li = event.target.closest('.preview-row.issue');
  if (event.target.name === 'import-target') {
    renderImportChoice();
    if (event.target.value === 'new') {
      const name = document.getElementById('import-name');
      name.focus();
      name.select();
    }
    return;
  }
  if (!pending || !pending.rows || !li) {
    return;
  }
  const row = pending.rows.find(function (r) { return r.key === Number(li.dataset.row); });
  const t = event.target;
  if (t.classList.contains('q-day')) {
    row.days = sortDays(Array.from(li.querySelectorAll('.q-day:checked')).map(function (i) { return i.value; }));
  } else if (t.classList.contains('q-title')) {
    row.title = t.value.replace(/\s+/g, ' ').trim() || row.course;
  } else if (t.classList.contains('q-start') || t.classList.contains('q-end')) {
    const start = fromTimeValue(li.querySelector('.q-start').value);
    const end = fromTimeValue(li.querySelector('.q-end').value);
    // 开始、结束都填好、而且结束比开始晚，才算改好了
    if (start === null || end === null || end <= start) {
      return;
    }
    Object.assign(row, { start: start, end: end, time: formatTimeRange({ start: start, end: end }) });
  } else {
    return;
  }
  row.fixing = true;
  renderImportChoice();
}

// 预览改好了：整理成和读文件一样的结果，再放进课表
// 输出：{ located, unlocated }
function previewToResult(rows) {
  const meetings = rows.map(function (row) {
    const location = rowLocation(row);
    return {
      title: row.title || row.course, course: row.course, section: row.section,
      start: row.start, end: row.end, time: row.time, days: sortDays(row.days),
      place: location ? location.place : null,
      code: location ? (location.place.code || '') : '',
      room: location ? location.room : '',
      noRoom: !location && !row.locationText && Boolean(row.noRoom)
    };
  });
  return {
    located: meetings.filter(function (m) { return m.place; }),
    unlocated: meetings.filter(function (m) { return !m.place; })
  };
}

function handleImportChoiceClick(event) {
  const button = event.target.closest('button[data-action]');
  const pending = myClasses.pendingImport;
  if (!button || !pending) {
    return;
  }
  const action = button.dataset.action;
  const li = button.closest('.preview-row');
  const status = document.getElementById('schedule-status');

  // 预览里的一行：展开改、改好收起、删掉、补一行
  // 同一门课两种拼法，用户选了一个：这门课的所有时段都用它
  if (action === 'pick-title') {
    const chosenRow = pending.rows.find(function (r) { return r.key === Number(li.dataset.row); });
    pending.rows.forEach(function (r) {
      if (r.course === chosenRow.course && r.titleOptions) {
        r.title = button.dataset.title;
        delete r.titleOptions;
      }
    });
    pending.lastRemoved = null;
    renderImportChoice();
    return;
  }

  // 小周课表里点一个格子：跳到那一行；没问题的行在收起的列表里，先展开
  if (action === 'row-focus') {
    pending.focus = Number(button.dataset.row);
    renderImportChoice(); // 课表里点的那一格加粗
    const target = importRoot().querySelector(`.preview-row[data-row="${button.dataset.row}"]`);
    if (target) {
      const list = target.closest('details');
      if (list) {
        list.open = true;
      }
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      target.classList.remove('flash');
      void target.offsetWidth; // 重新播放闪一下的动画
      target.classList.add('flash');
    }
    return;
  }

  if (action === 'row-edit' || action === 'row-remove' || action === 'row-done' || action === 'row-add' || action === 'row-ok' || action === 'row-restore') {
    keepOpenRowInputs(importRoot());
    const key = li ? li.dataset.row : button.dataset.row;
    const row = key ? pending.rows.find(function (r) { return r.key === Number(key); }) : null;
    pending.lastRemoved = null; // "刚删掉"的提示只在删完的下一步之前显示
    if (action === 'row-restore') {
      row.removed = false;
    } else if (action === 'row-ok') {
      row.ok = true;
      row.fixing = false;
    } else if (action === 'row-edit') {
      row.open = true;
    } else if (action === 'row-remove') {
      Object.assign(row, { removed: true, open: false, fixing: false });
      pending.lastRemoved = row.key;
    } else if (action === 'row-done') {
      if (!closePreviewRow(li)) {
        return;
      }
      row.fixing = false;
      row.ok = true; // 用户自己逐项看过、改过了
    } else {
      logEvent('import-row-add');
      pending.rows.push({
        key: pending.nextRow++, title: '', course: '', section: '', start: null, end: null, time: '', days: [],
        place: null, code: '', room: '', noRoom: false, locationText: '', readLocationText: '', open: true
      });
    }
    renderImportChoice();
    if (action === 'row-add' || action === 'row-edit') {
      const opened = importRoot().querySelector(`.preview-row[data-row="${action === 'row-add' ? pending.nextRow - 1 : row.key}"]`);
      if (opened) {
        opened.scrollIntoView({ block: 'nearest' });
        opened.querySelector('.f-title').focus();
      }
    }
    return;
  }

  if (action === 'import-cancel') {
    logEvent('import-choice-cancel');
    dropPendingImport();
    renderImportChoice();
    flashStatus('Nothing was added.');
    return;
  }

  // import-done：还展开着的行先检查、收起；有问题就停在那一行
  if (pending.rows) {
    const open = Array.from(importRoot().querySelectorAll('.preview-row.editing'));
    for (const openLi of open) {
      if (!closePreviewRow(openLi)) {
        return;
      }
    }
  }
  const checked = document.querySelector('input[name="import-target"]:checked');
  const target = checked ? checked.value : 'add';
  if (pending.askTarget) {
    logEvent('import-choice-' + target);
  }
  const nameInput = document.getElementById('import-name');
  const name = (nameInput ? nameInput.value.trim().slice(0, 40) : '') || nextScheduleName();
  const kept = pending.rows ? pending.rows.filter(function (r) { return !r.removed; }) : null;
  const results = pending.rows ? [previewToResult(kept)] : pending.results;
  dropPendingImport();
  renderImportChoice();
  applyImport(results, target, name);

  // 说清楚这次加了什么、还差什么
  if (pending.rows) {
    const added = kept.length;
    const noRoom = results[0].unlocated.length;
    const parts = [`Added ${added} class ${added === 1 ? 'time' : 'times'} to "${activeSchedule().name}".`];
    if (target === 'new') {
      parts.push('Switch between schedules at the top.');
    }
    flashStatus(parts.concat(pending.errors).join(' '));
    // 有课没教室：接着弹出"一次补完教室"，不用再回列表里一张张找
    if (noRoom > 0 && coursesNeedingRooms().length > 0) {
      openRoomsDialog(added);
    }
  }
}

// 再传的文件里没找到这门课的教室：说清楚到底读到了什么，用户才知道该换哪张图
function explainMissedScan(item, result, fileName) {
  const all = result.located.concat(result.unlocated);
  const sameCourse = all.filter(function (c) { return c.course === item.course; });
  const describe = function (c) {
    return [c.section, c.time, c.days.join(', ')].filter(Boolean).join(' ');
  };

  // 1. 文件里根本没有这门课
  if (sameCourse.length === 0) {
    const others = all.map(function (c) { return c.course; }).filter(Boolean);
    return `${fileName} doesn't show ${item.course}` +
      (others.length > 0 ? ` (we read: ${others.slice(0, 4).join(', ')}).` : ' — we couldn\'t read any course numbers in it.');
  }
  // 2. 有这个时段，但是没写教室
  const sameMeetingNoRoom = sameCourse.find(function (c) { return sameMeeting(c, item); });
  if (sameMeetingNoRoom) {
    return `${fileName} shows ${[item.course, describe(sameMeetingNoRoom)].filter(Boolean).join(' ')}, but no room` +
      (sameMeetingNoRoom.noRoom ? ' ("No room assigned").' : '. Try the class details pop-up, which lists "Room:".');
  }
  // 3. 有这门课，但是别的时段（比如 discussion，或者时间不一样）
  return `${fileName} shows ${item.course} only at other times (${sameCourse.map(describe).join('; ')}), ` +
    `not ${[item.section, item.time].filter(Boolean).join(' ')}.`;
}

// 针对某一门课再传一个文件：先对课号，再对类型和时间；找到有教室的，就作为"建议地点"，仍然要用户确认
async function handleClassScan(file) {
  const item = myClasses.items.find(function (c) { return c.id === myClasses.scanTargetId; });
  if (!item) {
    return;
  }
  const result = await readOneFile(file, 1, 1);
  let found = !result.error && result.located.find(function (c) { return sameMeeting(c, item); });

  // 课号、时间都对上了，但那门课旁边没写教室：如果整个文件里只出现了一个地址 / 教室，就用它（仍然要用户确认）
  if (!found && !result.error) {
    const sameOne = result.unlocated.find(function (c) { return sameMeeting(c, item); });
    const locations = result.fileLocations || [];
    if (sameOne && locations.length === 1) {
      found = locations[0];
    }
  }

  if (found) {
    item.scanSuggestion = { place: found.place, room: found.room };
    item.scanMessage = `Found ${item.course} in your file — please confirm the location above.`;
  } else if (result.error) {
    item.scanMessage = result.error;
  } else {
    item.scanMessage = explainMissedScan(item, result, file.name);
  }
  myClasses.openId = item.id; // 保持展开，让用户直接看到结果
  renderMyClasses();
}

// 电脑上把文件拖到上传框里：和点按钮选文件一样处理
function initUploadDrop() {
  const drop = document.getElementById('upload-drop');
  ['dragenter', 'dragover'].forEach(function (type) {
    drop.addEventListener(type, function (event) {
      event.preventDefault(); // 不写的话，浏览器会直接打开这个文件，而不是交给网页
      drop.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    drop.addEventListener(type, function () {
      drop.classList.remove('dragging');
    });
  });
  drop.addEventListener('drop', async function (event) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) {
      return;
    }
    // 统计和点按钮选文件一样：只记文件的种类，不记文件名和内容（analytics.js）
    files.forEach(function (file) { logEvent('import-' + fileKind(file)); });
    await handleScheduleFiles(files);
  });
}

// app.js 在地点索引建好之后调用：把事件都接上
function initMyClasses(placeIndex) {
  myClasses.placeIndex = placeIndex;

  // 上传一个或多个文件。处理完把输入框清空，这样再选同一个文件也会触发
  document.getElementById('schedule-file').addEventListener('change', async function (event) {
    const files = Array.from(event.target.files);
    if (files.length > 0) {
      await handleScheduleFiles(files);
    }
    event.target.value = '';
  });

  initUploadDrop();

  // 针对某一门课再传一张截图
  document.getElementById('class-scan-file').addEventListener('change', async function (event) {
    const file = event.target.files[0];
    if (file) {
      await handleClassScan(file);
    }
    event.target.value = '';
  });

  document.getElementById('schedule-text-button').addEventListener('click', function () {
    const text = document.getElementById('schedule-text').value;
    document.getElementById('schedule-status').textContent = ''; // 上一次的结果（比如"没找到"）先清掉
    removeSampleClasses();
    hideOcrTip();
    offerImport([parseSchedule(textToLines(text), placeIndex, knownCourses())], 'your text');
  });

  // 截图没认出课时的提示卡片里的 "Paste text" 和 "Read with AI"（卡片每次重画，所以用事件委托）
  document.getElementById('ocr-tip').addEventListener('click', function (event) {
    if (event.target.closest('#ocr-tip-paste')) {
      pasteFromOcrTip();
    }
    if (event.target.closest('#ocr-tip-ai')) {
      readOcrTipWithAi();
    }
  });

  // 导入时"加进当前这份 / 另存一份"的选择卡片
  const importBox = document.getElementById('import-choice');
  importBox.addEventListener('click', handleImportChoiceClick);
  importBox.addEventListener('change', handleImportChange);
  // 导入预览弹窗：和侧栏卡片一样的按钮；按 Esc 等于 Cancel
  const importDialog = document.getElementById('import-dialog');
  importDialog.addEventListener('click', handleImportChoiceClick);
  importDialog.addEventListener('change', handleImportChange); // 可疑行里直接改星期、时间、课名
  // 一次补完教室的弹窗；按 Esc 等于 Cancel
  const roomsDialog = document.getElementById('rooms-dialog');
  roomsDialog.addEventListener('click', handleRoomsClick);
  roomsDialog.addEventListener('input', handleRoomsInput);
  roomsDialog.addEventListener('change', handleRoomsInput);
  roomsDialog.addEventListener('cancel', function (event) {
    event.preventDefault();
    closeRoomsDialog();
  });
  importDialog.addEventListener('cancel', function (event) {
    event.preventDefault();
    const cancel = importDialog.querySelector('[data-action="import-cancel"]');
    if (cancel) {
      cancel.click();
    }
  });
  // 点名字输入框、或者在里面打字，就是想另存一份：自动选上那一项
  // （输入框放在 label 里面，点它不会自动选上 label 里的圆圈，要自己选）
  ['focusin', 'click', 'input'].forEach(function (type) {
    importBox.addEventListener(type, function (event) {
      if (event.target.id === 'import-name') {
        importBox.querySelector('input[value="new"]').checked = true;
      }
    });
  });

  document.getElementById('sample-button').addEventListener('click', loadSampleSchedule);
  document.getElementById('manual-add-button').addEventListener('click', startManualClass);
  // "Paste text"：展开粘贴框，光标直接放进去
  document.getElementById('paste-toggle').addEventListener('click', function () {
    const box = document.getElementById('schedule-paste');
    box.open = !box.open;
    if (box.open) {
      document.getElementById('schedule-text').focus();
    }
  });

  const list = document.getElementById('schedule-list');
  list.addEventListener('click', handleListClick);
  // 在"别的地方"输入框里按回车：数据里没有这个地点的话，去地图上查
  list.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.classList.contains('other-location')) {
      event.preventDefault();
      const card = event.target.closest('[data-id]');
      if (!resolveLocationText(event.target.value, myClasses.placeIndex)) {
        handleAddressLookup(card);
      }
    }
  });
  list.addEventListener('input', handleListInput);  // 在"别的地方"输入框里打字
  list.addEventListener('change', handleListInput); // 选了某个单选项

  document.getElementById('class-toast').addEventListener('click', function (event) {
    if (event.target.id === 'undo-button') {
      undoLastChange();
    }
  });

  // 用户以前自己加过的地点：先放回索引里，下面读回的课才找得到它们的楼
  loadCustomPlaces(placeIndex);

  // 课表切换栏（schedules.js）、对比表（compare.js）
  initScheduleSwitcher();
  initCompare();

  // 上次存在这个浏览器里的课表：读回来直接显示，不用再上传
  const savedSchedules = loadSavedSchedules(placeIndex);
  if (savedSchedules) {
    // 不是当前这份课表里的旧版示例课：直接去掉（当前这份的在下面换成新版）
    savedSchedules.schedules.forEach(function (schedule) {
      if (schedule.id !== savedSchedules.activeId && hasOutdatedSample(schedule.items)) {
        schedule.items = schedule.items.filter(function (c) { return !c.sample; });
      }
    });
    myClasses.schedules = savedSchedules.schedules;
    myClasses.activeId = savedSchedules.activeId;
  }
  const saved = activeSchedule().items;
  if (savedSchedules && (saved.length > 0 || myClasses.schedules.length > 1)) {
    logEvent('load-saved'); // 这个浏览器里存着课：相当于"回来的用户"（不知道是谁）
    myClasses.items = saved;
    renderMyClasses();
    // 以前试过示例、存下来的是旧版示例课：换成现在的示例（用户自己的课不动）
    // 只在过期时才换：示例还是现在这一版的话，保留用户对它做的确认、编辑
    if (hasOutdatedSample(saved)) {
      removeSampleClasses();
      addSampleClasses();
    }
    // 按现在列表里的课数（示例可能刚换过，数量会变）
    const count = myClasses.items.length;
    if (count > 0) {
      const status = document.getElementById('schedule-status');
      flashStatus((`Welcome back: loaded ${count} saved ${count === 1 ? 'class' : 'classes'}. ` + status.textContent).trim(), 6000);
    }
  }

  // 打开的是别人（或自己另一台设备）发来的课表链接：读进来（share.js）
  initShare(placeIndex);
}

console.log('my-classes.js loaded');
