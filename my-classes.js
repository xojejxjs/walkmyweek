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
          return { id: schedule.id, name: schedule.name, kind: schedule.kind || null, items: schedule.items.map(classToSaved), breakPlans: schedule.breakPlans || undefined };
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

// 记下现在的样子，以便 Undo；然后执行修改、重新显示、弹出提示
function changeWithUndo(message, change) {
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
  if (incoming.length === 0) {
    document.getElementById('schedule-status').textContent =
      "Couldn't find any classes. Try a clearer screenshot, or paste the text instead.";
  }
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
  const review = items.filter(function (c) { return c.status === 'guess' || c.status === 'none'; }).sort(compareMeetings);
  const skipped = items.filter(function (c) { return c.status === 'skipped'; });

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

  // 1. 需要确认的放最上面，并有一个醒目的提示
  if (review.length > 0) {
    html += `<div class="review-banner">⚠ ${review.length} ${review.length === 1 ? 'class needs' : 'classes need'} your check before ${review.length === 1 ? 'it is' : 'they are'} on your map.
      <button type="button" class="banner-button" data-action="scan-all">📷 Add another screenshot or file</button>
      <span class="banner-hint">Rooms we can read from it are filled in for you.</span>
    </div>`;
    html += '<ul class="class-list">' + review.map(renderCard).join('') + '</ul>';
  }

  // 2. 已经确定的
  if (confirmed.length > 0) {
    html += '<ul class="class-list">' + confirmed.map(renderCard).join('') + '</ul>';
  }

  // 3. 跳过的：折叠起来，可以恢复
  if (skipped.length > 0) {
    html += `<details class="skipped-list"><summary>Skipped (${skipped.length})</summary><ul class="class-list">`;
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
      Delete ${n} ${n === 1 ? 'class' : 'classes'}
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

// 批量操作：把勾选的课删掉（可以 Undo）
function bulkDelete() {
  const ids = myClasses.selected;
  const n = ids.size;
  changeWithUndo(`Deleted ${n} ${n === 1 ? 'class' : 'classes'}`, function () {
    myClasses.items = myClasses.items.filter(function (c) { return !ids.has(c.id); });
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

  const intro = isEdit
    ? 'Change where this class meets.'
    : (c.status === 'guess'
      ? "Your schedule doesn't list a room for this class. Here's where it might be — <strong>check your schedule</strong> and pick the right one."
      : "Your schedule doesn't list a room, and we can't guess one. If it meets in person, tell us where. If it's online, skip it.");

  return `
    <li class="class-card editing" data-id="${c.id}" data-mode="${isEdit ? 'edit' : 'review'}">
      <strong translate="no">${escapeHtml(c.title)}</strong>
      ${classMetaLine(c)}
      <p class="card-note">${intro}</p>
      <div class="location-options">${optionsHtml}</div>
      <button type="button" class="primary-button" data-action="confirm" disabled>Choose a location above</button>
      <button type="button" class="scan-one-button" data-action="scan-one">📷 Add a screenshot or file that shows this class</button>
      <p class="scan-message option-note">${c.scanMessage ? escapeHtml(c.scanMessage) : ''}</p>
      <div class="secondary-actions">
        <button type="button" class="link-button" data-action="skip">${isEdit ? 'Remove from my map' : "It's online · Skip"}</button>
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
    clearClassPreview();
    renderMyClasses();
  } else if (action === 'confirm') {
    const selection = readSelection(card, item);
    if (!selection) {
      return; // 按钮是灰的时候本来就点不了，这里再保险一次
    }
    changeWithUndo(`${item.title} → ${selection.place.name}`, function () {
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
    myClasses.items = myClasses.undo;
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

  hideOcrTip(); // 新的一次导入：上一次的提示先收起来

  // 先把所有文件都读完，再决定放进哪一份课表
  const results = [];
  const errors = [];
  let screenshotFailed = false; // 有没有截图一门课都没认出来（或者根本读不了）
  const context = {}; // 按顺序读：表格截图被切成几张时，下一张开头的课接着上一张的星期
  for (let i = 0; i < files.length; i++) {
    const result = await readOneFile(files[i], i + 1, files.length, context);
    const isImage = /^image\//.test(files[i].type) || /\.(png|jpe?g|heic|webp|gif)$/i.test(files[i].name);
    if (result.error) {
      errors.push(result.error);
      screenshotFailed = screenshotFailed || isImage;
    } else {
      results.push(result);
      if (isImage && result.located.length + result.unlocated.length === 0) {
        screenshotFailed = true;
      }
    }
  }

  // 读完了："Reading …" 这类进度提示换成出错的原因；都读成功了就清空
  status.textContent = errors.join(' ');
  errors.forEach(function () { logEvent('import-error'); });
  if (results.length > 0) {
    const source = files.length === 1 ? `"${files[0].name}"` : `${files.length} files`;
    offerImport(results, source);
    // 截图把星期标题裁掉了：星期是按下一个标题往前推的，提醒用户看一眼
    const guessed = sortDays([].concat.apply([], results.map(function (r) { return r.guessedDays || []; })));
    if (guessed.length > 0) {
      status.textContent = (status.textContent + ` A day heading was cut off in your screenshot, so we guessed ${guessed.join(', ')} for some classes. Check their days in My classes.`).trim();
    }
  }
  // 截图没认出课：不只说"没找到"，而是教用户怎么把截图里的字复制出来、粘贴进来
  if (screenshotFailed) {
    showOcrTip();
  }
  // 如果是从 "Find classes you share" 来的：换回自己的课表，打开 Shared classes（schedules.js）
  finishFindShared();
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

function showOcrTip() {
  const box = document.getElementById('ocr-tip');
  // 已经有一句 "Couldn't find any classes…" 了：这张卡片说得更清楚，那句就不要了
  document.getElementById('schedule-status').textContent = '';
  box.innerHTML = '<p class="ocr-tip-title">📷 We couldn’t read classes from this screenshot.</p>' +
    '<p class="ocr-tip-lead">Easiest fix: copy the text out of it with your device, then paste it here. It takes about 20 seconds, and nothing is uploaded.</p>' +
    '<ol class="ocr-tip-steps">' + ocrTipSteps().map(function (s) { return `<li>${s}</li>`; }).join('') + '</ol>' +
    '<div class="ocr-tip-actions">' +
    '<button type="button" class="primary-button" id="ocr-tip-paste">📋 Paste text</button>' +
    '<span class="hint">or use your calendar file (.ics): the most accurate</span></div>';
  box.hidden = false;
  logEvent('ocr-tip');
  box.scrollIntoView({ block: 'nearest' });
}

function hideOcrTip() {
  const box = document.getElementById('ocr-tip');
  box.hidden = true;
  box.innerHTML = '';
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

// ===== 导入时：加进当前这份课表，还是另存一份 =====
//
// 只有当前这份课表里已经有自己的课时才问（第一次导入、只有示例课时不问，直接加）
// 默认是"加进当前这份"：一份课表分成好几张截图时，用户直接点 Done 就行
// 读到的课大多和现在的不一样时，提醒一句"看起来是另一份课表"，但还是让用户自己选

// 读完文件、或者粘贴的文字以后都走这里
// 输入：[{ located, unlocated }]（每个文件一份）、给用户看的来源（比如 '"Fall 2026 calendar.ics"'）
function offerImport(results, source) {
  const found = [].concat.apply([], results.map(function (r) { return r.located.concat(r.unlocated); }));
  // 统计：读出了几门课（只记区间）
  logEvent(found.length === 0 ? 'import-empty' : 'import-ok-' + classCountBucket(found.length));
  const hasOwnClasses = myClasses.items.some(function (c) { return !c.sample; });
  if (found.length === 0 || !hasOwnClasses) {
    applyImport(results, 'add', '');
    return;
  }
  // 读到的课里，有几门当前这份课表里已经有了（同一门课、同一个时段）
  const already = found.filter(function (c) {
    return myClasses.items.some(function (item) { return sameMeeting(item, c); });
  }).length;
  // 全都已经有了（比如同一个文件又传了一次）：没有新东西，不用问，问了反而容易多出一份一样的课表
  // 还是照常合并一遍：文件里可能有原来没读到的教室、时间，可以补上
  if (already === found.length) {
    logEvent('import-all-already');
    if (applyImport(results, 'add', '') > 0) {
      return; // 补上了地点：已经有 "Updated N classes… Undo" 的提示
    }
    document.getElementById('schedule-status').textContent =
      `All ${found.length} ${found.length === 1 ? 'class' : 'classes'} from ${source} ${found.length === 1 ? 'is' : 'are'} already in "${activeSchedule().name}".`;
    return;
  }
  myClasses.pendingImport = { results: results, source: source, count: found.length, already: already };
  renderImportChoice();
  document.getElementById('import-choice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

// 显示"加进哪一份"的选择卡片；没有要选的时候清空
function renderImportChoice() {
  const box = document.getElementById('import-choice');
  const pending = myClasses.pendingImport;
  if (!pending) {
    box.innerHTML = '';
    return;
  }
  const current = escapeHtml(activeSchedule().name);
  const alreadyNote = pending.already > 0
    ? `<span class="option-note">${pending.already} of them ${pending.already === 1 ? 'is' : 'are'} already there</span>`
    : '';
  // 一半以上都是现在没有的课：多半是另一份课表（Plan B、室友的），提醒一句
  const looksDifferent = pending.already < pending.count / 2
    ? `<p class="hint import-hint">These look like different classes than "${current}". Saving them as a new schedule keeps the two apart.</p>`
    : '';
  box.innerHTML = `
    <div class="import-choice">
      <strong>✓ Found ${pending.count} ${pending.count === 1 ? 'class' : 'classes'} in ${escapeHtml(pending.source)}</strong>
      <label class="location-option">
        <input type="radio" name="import-target" value="add" checked>
        <span>Add to "${current}" ${alreadyNote}</span>
      </label>
      <label class="location-option">
        <input type="radio" name="import-target" value="new">
        <span>Save as a new schedule:
          <input type="text" id="import-name" maxlength="40" value="${escapeAttr(pending.suggestedName || nextScheduleName())}">
        </span>
      </label>
      ${looksDifferent}
      <div class="import-actions">
        <button type="button" class="primary-button" data-action="import-done">Done</button>
        <button type="button" class="link-button" data-action="import-cancel">Cancel</button>
      </div>
    </div>`;
}

function handleImportChoiceClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || !myClasses.pendingImport) {
    return;
  }
  const pending = myClasses.pendingImport;
  myClasses.pendingImport = null;
  if (button.dataset.action === 'import-done') {
    const target = document.querySelector('input[name="import-target"]:checked').value;
    logEvent('import-choice-' + target);
    const name = document.getElementById('import-name').value.trim().slice(0, 40) || nextScheduleName();
    renderImportChoice();
    applyImport(pending.results, target, name);
  } else {
    logEvent('import-choice-cancel');
    renderImportChoice();
    document.getElementById('schedule-status').textContent = 'Nothing was added.';
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
    removeSampleClasses();
    hideOcrTip();
    offerImport([parseSchedule(textToLines(text), placeIndex, knownCourses())], 'your text');
  });

  // 截图没认出课时的提示卡片里的 "Paste text"（卡片每次重画，所以用事件委托）
  document.getElementById('ocr-tip').addEventListener('click', function (event) {
    if (event.target.closest('#ocr-tip-paste')) {
      pasteFromOcrTip();
    }
  });

  // 导入时"加进当前这份 / 另存一份"的选择卡片
  const importBox = document.getElementById('import-choice');
  importBox.addEventListener('click', handleImportChoiceClick);
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
      status.textContent = `Welcome back: loaded ${count} saved ${count === 1 ? 'class' : 'classes'}. ` + status.textContent;
    }
  }

  // 打开的是别人（或自己另一台设备）发来的课表链接：读进来（share.js）
  initShare(placeIndex);
}

console.log('my-classes.js loaded');
