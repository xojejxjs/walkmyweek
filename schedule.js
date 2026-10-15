// schedule.js：只负责"课表（截图、PDF、Word、文字）→ 课程列表"
// 图片用 Tesseract.js 在浏览器里识别（OCR），图片不会上传到任何服务器

// ===== 第一步：图片 → 带位置的文字片段 =====

// 识别一张课表图片
// 输入：图片文件、进度回调（收到 0～1 之间的数字）
// 输出：文字片段数组 [{ text, x, x0, x1, y, h, words }]（见 flattenOcrLines）
async function readScheduleImage(file, onProgress) {
  // createWorker('eng')：准备一个英文识别器。第一次会下载约 10 MB 的识别模型，之后浏览器会缓存
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: function (message) {
      if (message.status === 'recognizing text' && onProgress) {
        onProgress(message.progress);
      }
    }
  });

  try {
    // 第三个参数 { blocks: true }：除了纯文字，还要每一行、每个单词的位置
    const result = await worker.recognize(file, {}, { blocks: true, text: true });
    return flattenOcrLines(result.data);
  } finally {
    await worker.terminate(); // 用完就关掉，释放内存
  }
}

// 去掉 OCR 的"杂质"：课表格子右上角的小黑方块 ■ 常被认成 "[]"、"|" 之类的符号
function cleanText(text) {
  // 课表格子角上的小黑方块，OCR 可能认成 [] ■ | {} ®  ©，都去掉
  return text.replace(/[\[\]■□|{}®©]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 把 Tesseract 的结果摊平成"文字片段"的数组
//
// 为什么要切成片段：日历里同一高度、左右并排的几个格子，OCR 常常会读成"一整行"，比如
//   "2 Silber Way WED 130   2 Silber Way WED 130   2 Silber Way WED 130"
// 同一个格子里的单词挨得很近，不同列之间有一大段空白。所以按单词之间的空隙把一行切开，
// 每一段就是一个格子里的一行文字，并记下它的位置（用来判断在哪一列、哪一天）
function flattenOcrLines(data) {
  // 先把 OCR 的每一行和它的单词取出来
  const rawLines = [];
  (data.blocks || []).forEach(function (block) {
    (block.paragraphs || []).forEach(function (paragraph) {
      (paragraph.lines || []).forEach(function (line) {
        rawLines.push({
          text: line.text,
          bbox: line.bbox,
          y: (line.bbox.y0 + line.bbox.y1) / 2,
          height: line.bbox.y1 - line.bbox.y0,
          words: (line.words || []).filter(function (w) { return w.text.trim() !== ''; })
        });
      });
    });
  });

  // 没有位置信息（比如旧版本的 Tesseract）：退回到纯文字，按换行拆开
  if (rawLines.length === 0) {
    return data.text ? textToLines(data.text) : [];
  }

  // 第一遍：按单词之间的大空隙切开（主要是为了先找到表头的日期）
  const byGaps = splitLinesByGaps(rawLines);

  // 第二遍：如果找到了表头日期，就按日期所在的列来切，比猜空隙大小可靠得多
  const dayColumns = findDayColumns(byGaps);
  const segments = dayColumns.length >= 2 ? splitLinesByColumns(rawLines, dayColumns) : byGaps;

  return segments.filter(function (s) { return s.text !== ''; });
}

// 按空隙切：两个单词之间的空隙超过 1.5 倍行高（正常字间距的好几倍），就认为跨到了另一个格子
function splitLinesByGaps(rawLines) {
  const segments = [];
  rawLines.forEach(function (line) {
    if (line.words.length === 0) {
      segments.push(makeSegment(line.text, line.bbox.x0, line.bbox.x1, line.y, line.height, []));
      return;
    }
    const gapLimit = Math.max(line.height * 1.5, 20);
    let current = [line.words[0]];
    for (let i = 1; i < line.words.length; i++) {
      const gap = line.words[i].bbox.x0 - line.words[i - 1].bbox.x1;
      if (gap > gapLimit) {
        segments.push(segmentFromWords(current, line.y, line.height));
        current = [];
      }
      current.push(line.words[i]);
    }
    segments.push(segmentFromWords(current, line.y, line.height));
  });
  return segments;
}

// 按列切：相邻两个日期的中点就是两列的分界线；每个单词看它的中心落在哪一列
// 第一列左边的内容（比如时间轴上的 "8 AM"）单独成一组，不会粘到课名上
function splitLinesByColumns(rawLines, dayColumns) {
  const xs = dayColumns.map(function (d) { return d.x; });
  const halfWidth = (xs[1] - xs[0]) / 2;
  // 分界线：[第一列左边界, 第1和第2列中点, ..., 最后一列右边界]
  const borders = [xs[0] - halfWidth];
  for (let i = 1; i < xs.length; i++) {
    borders.push((xs[i - 1] + xs[i]) / 2);
  }
  borders.push(xs[xs.length - 1] + halfWidth);

  // 两个单词之间的空白里，有没有一条列分界线（左右各留 8 像素误差）
  // 分界线只会落在格子之间的空白里，不会落在一个单词中间，所以只在这种空白处切
  function borderInGap(left, right) {
    return borders.some(function (b) {
      return b > left.bbox.x1 - 8 && b < right.bbox.x0 + 8;
    });
  }

  const segments = [];
  rawLines.forEach(function (line) {
    if (line.words.length === 0) {
      segments.push(makeSegment(line.text, line.bbox.x0, line.bbox.x1, line.y, line.height, []));
      return;
    }
    let current = [line.words[0]];
    for (let i = 1; i < line.words.length; i++) {
      const left = line.words[i - 1];
      const right = line.words[i];
      const gap = right.bbox.x0 - left.bbox.x1;
      // 切开的条件：空白里有列分界线（而且比正常字间距大一点），或者空白本身就特别大
      if ((borderInGap(left, right) && gap > line.height * 0.3) || gap > line.height * 1.5) {
        segments.push(segmentFromWords(current, line.y, line.height));
        current = [];
      }
      current.push(right);
    }
    segments.push(segmentFromWords(current, line.y, line.height));
  });
  return segments;
}

function segmentFromWords(words, y, height) {
  const text = words.map(function (w) { return w.text; }).join(' ');
  return makeSegment(text, words[0].bbox.x0, words[words.length - 1].bbox.x1, y, height, words);
}

// 一个文字片段：text 文字；x0～x1 左右边界；x 中心；y 纵向位置；h 行高；words 单词（找表头日期用）
function makeSegment(text, x0, x1, y, height, words) {
  return { text: cleanText(text), x: (x0 + x1) / 2, x0: x0, x1: x1, y: y, h: height, words: words };
}

// 纯文字（用户粘贴的）→ 片段。没有位置，所以认不出星期几，只能按上下行的顺序找
function textToLines(text) {
  return text.split('\n')
    .map(function (t) { return { text: cleanText(t), x: null, x0: null, x1: null, y: null, h: null, words: [] }; })
    .filter(function (line) { return line.text !== ''; });
}

// ===== 第二步：文字片段 → 课程 =====
//
// 思路：不依赖某一种排版（日历格子、课程详情弹窗、Google 日历、Word / PDF 里的文字都能用）
//   1. 先找"课号"（比如 CASCH 171）：它在任何格式里都一样，最可靠
//   2. 再在课号附近找：类型（LEC / DIS …）、时间、星期、教室
//   3. 统一写法：时间都写成 "9:05 AM – 9:55 AM"，星期都写成 Mon、Wed、Fri
//   4. 课号相同，再比类型和时间：都一样 → 同一个上课时段，合并星期；
//      不一样 → 同一门课的另一个时段（比如 lecture 和 discussion），分开放

// 完整课号：5 个字母 + 3 位数字，比如 CASCH 171（BU 规则：学院 3 个字母 + 系 2 个字母）
// 只认 5 个字母，所以 "CAS 216" 这种教室不会被当成课号
const COURSE_CODE = /\b([A-Z]{5})\s?(\d{3}[A-Z]?)\b/;

// 简写课号：系 2 个字母 + 3 位数字，比如自己记在 Google 日历里的 "DS 110"、"WR 112"
const SHORT_CODE = /\b([A-Z]{2})\s?(\d{3})\b/;

// 课名前面可能粘上了左边时间轴的 "8 AM"、"PM"，去掉
function cleanTitle(text) {
  return text.replace(/^(\d{1,2}\s*)?(AM|PM)\b\s*/i, '').replace(/\s+l$/, '').trim();
}

// 一段结尾的"楼宇代码 + 教室号"，比如 "... CAS B25A"、"... CDS 164"
const LOCATION_PATTERN = /(?:^|\s)([A-Z]{2,4})\s+([A-Z]?\d{1,4}[A-Z]?)\s*$/;

// 日历表头的日期，比如 "SEP 28"，或星期 "MON"
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// 星期的标准写法；DAY_NAMES 的顺序和 JavaScript 的 getDay() 一样（0 = 周日）
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ===== 统一写法：时间 =====

// 时间 → "从午夜开始过了多少分钟"（9:05 AM → 545），这样不同写法的时间也能直接比较
function toMinutes(hour, minute, meridiem) {
  let h = hour % 12;           // 12 点先当成 0
  if (meridiem === 'pm') {
    h += 12;
  }
  return h * 60 + minute;
}

// 找出一段文字里所有的时间，比如 "9:05AM"、"3:30"、"08:00"
// 输出：[{ h, m, mer: 'am' | 'pm' | null, raw: '08:00', index, end }]
function findTimeTokens(text) {
  const tokens = [];
  const re = /(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?\s?[Mm]\b\.?)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const h = Number(m[1]);
    const minute = Number(m[2]);
    if (h <= 23 && minute <= 59) {
      tokens.push({
        h: h,
        m: minute,
        mer: m[3] ? (m[3].toLowerCase() === 'a' ? 'am' : 'pm') : null,
        raw: m[1] + ':' + m[2],
        index: m.index,
        end: m.index + m[0].length
      });
    }
  }
  return tokens;
}

// 把开始、结束时间换成分钟数，补上没写的上午 / 下午
// 输入：开始、结束（结束可以是 null）
// 输出：{ start, end }，end 可能是 null
function resolveTimes(a, b) {
  let merA = a.mer;
  let merB = b ? b.mer : null;

  // 24 小时制：有小时大于 12，或者写成 "08:00" 这种前面带 0 的
  const is24 = !merA && !merB && [a, b].some(function (t) { return t && (t.h > 12 || /^0\d/.test(t.raw)); });
  if (is24) {
    return { start: a.h * 60 + a.m, end: b ? b.h * 60 + b.m : null };
  }

  if (!merA && merB) {
    // 只在最后写了 am / pm（"11:30 - 12:20 pm"）：先当成一样；如果开始比结束还晚，说明开始是上午
    merA = merB;
    if (toMinutes(a.h, a.m, merA) > toMinutes(b.h, b.m, merB)) {
      merA = 'am';
    }
  } else if (merA && b && !merB) {
    merB = merA;
    if (toMinutes(a.h, a.m, merA) > toMinutes(b.h, b.m, merB)) {
      merB = 'pm';
    }
  } else if (!merA && !merB) {
    // 都没写：按上课的常见时间猜。7～11 点是上午；12 点和 1～6 点是下午
    const guess = function (t) { return t.h >= 7 && t.h <= 11 ? 'am' : 'pm'; };
    merA = guess(a);
    merB = b ? guess(b) : null;
  }
  return { start: toMinutes(a.h, a.m, merA), end: b ? toMinutes(b.h, b.m, merB) : null };
}

// 一段文字里的时间段："3:30 - 4:45 pm"、"11:15AM - 12:05PM"、"08:00 – 09:15"；只有开始时间也行（"13:25"）
// 输出：{ start, end }；没有时间时是 null
function parseTimeRange(text) {
  const tokens = findTimeTokens(text);
  if (tokens.length === 0) {
    return null;
  }
  const a = tokens[0];
  // 两个时间之间只隔着 "-"、"–"、"to"，才算一个时间段
  const b = tokens[1] && /^\s*(?:-|–|—|to)\s*$/i.test(text.slice(a.end, tokens[1].index)) ? tokens[1] : null;
  return resolveTimes(a, b);
}

// 分钟数 → "9:05 AM"
function formatClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// { start, end } → "9:05 AM – 9:55 AM"（只有开始时间就只写开始）
function formatTimeRange(time) {
  return time.end === null ? formatClock(time.start) : `${formatClock(time.start)} – ${formatClock(time.end)}`;
}

// ===== 统一写法：星期 =====

const DAY_CODES = { Mo: 'Mon', Tu: 'Tue', We: 'Wed', Th: 'Thu', Fr: 'Fri', Sa: 'Sat', Su: 'Sun' };

// BU 的写法 "MoWeFr"、"TuTh" → ['Mon', 'Wed', 'Fri']；不是这种写法就返回空数组
function parseDayCodes(token) {
  if (!/^(?:Mo|Tu|We|Th|Fr|Sa|Su)+$/.test(token)) {
    return [];
  }
  return token.match(/Mo|Tu|We|Th|Fr|Sa|Su/g).map(function (c) { return DAY_CODES[c]; });
}

// 一段"肯定是星期"的文字（比如 Days: 后面）：支持 MoWeFr、Mon/Wed/Fri、Monday …
function parseDays(text) {
  let days = [];
  text.split(/[\s,/&]+/).forEach(function (token) {
    const codes = parseDayCodes(token);
    if (codes.length > 0) {
      days = days.concat(codes);
      return;
    }
    const m = token.match(/^(mon|tue|wed|thu|fri|sat|sun)(?:day|s|sday|nesday|r|rs|rsday|urday)?\.?$/i);
    if (m) {
      days.push(DAY_NAMES.find(function (d) { return d.toLowerCase() === m[1].toLowerCase(); }));
    }
  });
  return sortDays(days);
}

// 去掉重复，按周一到周日排好
function sortDays(days) {
  return DAY_ORDER.filter(function (d) { return days.includes(d); });
}

// 日历表头 → 星期几："MON" → 'Mon'；"SEP 28" → 算出这一天是周几（用今年的年份）
function headerToDay(label) {
  const parts = label.split(' ');
  if (parts.length === 1) {
    return DAY_NAMES.find(function (d) { return d.toUpperCase() === label; }) || '';
  }
  const date = new Date(new Date().getFullYear(), MONTHS.indexOf(parts[0]), Number(parts[1]));
  return DAY_NAMES[date.getDay()];
}

// ===== 统一写法：类型 =====

const TYPE_WORDS = {
  LECTURE: 'LEC', LEC: 'LEC',
  DISCUSSION: 'DIS', DIS: 'DIS',
  LABORATORY: 'LAB', LAB: 'LAB',
  PLB: 'PLB',
  SEMINAR: 'SEM', SEM: 'SEM',
  INDEPENDENT: 'IND', IND: 'IND',
  RECITATION: 'REC', REC: 'REC',
  STUDIO: 'STU', STU: 'STU'
};

// 一段文字里的上课类型："(LEC)"、"LEC"、"A1-LEC"、"lecture" → 'LEC'；没有时是 ''
function parseType(text) {
  const m = text.match(/(?:^|[\s(\-])(lecture|discussion|laboratory|seminar|recitation|independent|studio|lec|dis|lab|plb|sem|ind|rec|stu)(?=$|[\s)\-,.])/i);
  return m ? TYPE_WORDS[m[1].toUpperCase()] : '';
}

// ===== 课号 =====

// 在一段文字里找课号。完整课号最好；只有简写（DS 110）时，和已经认出的课对一下（CDSDS 110 的后半段就是 DS 110）
// 输入：文字、已经知道的课号列表
// 输出：{ course, index, length, short }；没有课号时是 null
function findCourse(text, knownCourses) {
  const full = text.match(COURSE_CODE);
  if (full) {
    return { course: full[1] + ' ' + full[2], index: full.index, length: full[0].length, short: false };
  }
  const short = text.match(SHORT_CODE);
  if (short) {
    const tail = short[1] + ' ' + short[2];
    const known = (knownCourses || []).find(function (c) { return c.slice(3) === tail; });
    return { course: known || tail, index: short.index, length: short[0].length, short: true };
  }
  return null;
}

// ===== 地点 =====

// 把地址文字拆成 { from, to, street }，比如 "685-725 Comm Ave CAS 211" → { 685, 725, 'commonwealth ave' }
// 缩写统一成同一种写法，这样 "Comm Ave"、"Commonwealth Avenue" 都能和 data.json 里的地址对上
function parseAddress(text) {
  let t = text.toLowerCase().replace(/[–—]/g, '-');
  t = t.replace(/\bcomm\.?\s+ave\.?/g, 'commonwealth ave')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\broad\b/g, 'rd')
    .replace(/\./g, '');
  const m = t.match(/(\d+)(?:\s*-\s*(\d+))?\s+([a-z'’]+(?:\s+[a-z'’]+)*?)\s+(ave|st|rd|way|mall|dr|blvd)\b/);
  if (!m) {
    return null;
  }
  return { from: Number(m[1]), to: Number(m[2] || m[1]), street: m[3] + ' ' + m[4] };
}

// 按地址找楼：同一条街、门牌号范围有重叠就算对上
// 有好几个对上时（比如 "685-725 Comm Ave" 同时包括 CAS 和 Warren 的 700），优先教学楼，再优先门牌号正好是两端的那个
function findPlaceByAddress(text, placeIndex) {
  const target = parseAddress(text);
  if (!target) {
    return undefined;
  }
  const seen = new Set();
  const candidates = [];
  placeIndex.forEach(function (entry) {
    const place = entry.place;
    if (seen.has(place.id) || !place.address) {
      return;
    }
    seen.add(place.id);
    const address = parseAddress(place.address);
    if (address && address.street === target.street &&
        address.from <= target.to && target.from <= address.to) {
      const score = (place.type === 'academic' ? 0 : 10) +
        (address.from === target.from || address.to === target.to ? 0 : 1);
      candidates.push({ place: place, score: score });
    }
  });
  candidates.sort(function (a, b) { return a.score - b.score; });
  return candidates.length > 0 ? candidates[0].place : undefined;
}

// 判断一段文字是不是"上课地点"，是的话认出是哪栋楼
// 输出：{ place, code, room }；不是地点时返回 null
function matchLocation(text, placeIndex) {
  // 1. 结尾是"楼宇代码 + 教室号"，而且代码在我们的代码表里：最准确
  const m = text.match(LOCATION_PATTERN);
  if (m) {
    const place = findPlace(placeIndex, m[1].toUpperCase(), false);
    if (place) {
      return { place: place, code: m[1].toUpperCase(), room: m[2].toUpperCase() };
    }
  }
  // 2. 代码认不出（比如 OCR 把 CAS 认错了）：按地址找
  const byAddress = findPlaceByAddress(text, placeIndex);
  if (byAddress) {
    const room = text.match(/\s([A-Z]?\d{1,4}[A-Z]?)\s*$/);
    return { place: byAddress, code: byAddress.code || '', room: room ? room[1].toUpperCase() : '' };
  }
  return null;
}

// 一段文字里的上课地点（比 matchLocation 多认两种）
// 输出：{ place, code, room }；{ noRoom: true }（课表写了没有教室）；或者 null（没提到地点）
function findLocation(text, placeIndex) {
  if (/no room assigned|\bno room\b|\bTBA\b/i.test(text)) {
    return { noRoom: true };
  }
  const location = matchLocation(text, placeIndex);
  if (location) {
    return location;
  }
  // 自己记的日历里常写成 "DS 110 lecture --CAS"
  const tagged = text.match(/(?:--|—)\s*([A-Z]{2,4})(?:\s+([A-Z]?\d{1,4}[A-Z]?))?\b/);
  if (tagged) {
    const place = findPlace(placeIndex, tagged[1], false);
    if (place) {
      return { place: place, code: tagged[1], room: tagged[2] || '' };
    }
  }
  return null;
}

// 一段文字里依次出现的所有教室（课程详情里可能有两个时段，各自一个教室）
// 输出：数组，每一项是 { place, code, room } 或 { noRoom: true }
function extractRooms(text, placeIndex) {
  const rooms = [];
  const re = /(No room assigned(?:\s+NO ROOM)?|NO ROOM|\bTBA\b)|\b([A-Z]{2,4})\s+([A-Z]?\d{1,4}[A-Z]?)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      rooms.push({ noRoom: true });
    } else {
      const place = findPlace(placeIndex, m[2], false);
      if (place) {
        rooms.push({ place: place, code: m[2], room: m[3] });
      }
    }
  }
  if (rooms.length === 0) {
    const place = findPlaceByAddress(text, placeIndex);
    if (place) {
      rooms.push({ place: place, code: place.code || '', room: '' });
    }
  }
  return rooms;
}

// ===== 版面：日历的列 =====

// 找出表头的每一天，以及它在图片里的横坐标
// 只有"整段文字就是一个日期"才算表头，比如 "SEP 28"、"MON"、"Monday 9/28"
// （不能只看有没有这个词：Wheelock 的楼宇代码 "WED" 会被误认成星期三）
// 输出：[{ label: 'SEP 28', x: 572 }, ...]，按从左到右排好
function findDayColumns(segments) {
  const monthDay = new RegExp('^(' + MONTHS.join('|') + ')[A-Z]*\\.?\\s+(\\d{1,2})$', 'i');
  const weekday = new RegExp('^(' + WEEKDAYS.join('|') + ')[A-Z]*\\.?(\\s+\\d{1,2}(/\\d{1,2})?)?$', 'i');

  const days = [];
  segments.forEach(function (segment) {
    if (segment.x === null) {
      return;
    }
    const m = segment.text.match(monthDay);
    const w = segment.text.match(weekday);
    if (m) {
      days.push({ label: m[1].toUpperCase() + ' ' + m[2], x: segment.x, y: segment.y });
    } else if (w) {
      days.push({ label: w[1].toUpperCase(), x: segment.x, y: segment.y });
    }
  });
  days.sort(function (a, b) { return a.x - b.x; });
  return days;
}

// 是不是日历表头（"SEP 28"、"MON 28"、"Monday"）
function isDayHeader(text) {
  const pattern = new RegExp('^(' + MONTHS.concat(WEEKDAYS).join('|') + ')[A-Z]*\\.?(\\s+\\d{1,2}(/\\d{1,2})?)?$', 'i');
  return pattern.test(text.trim());
}

// 找出和某个片段"在同一个格子里"的其他片段，按离它的远近排好
// 有位置：横向有重叠（同一列），纵向在 5 行以内，而且在它上面（direction = -1）或下面（direction = 1）
// 没有位置（粘贴的文字）：就按上下行的顺序
function neighborsInCell(segments, index, direction) {
  const self = segments[index];

  if (self.x === null) {
    const result = [];
    for (let k = index + direction; k >= 0 && k < segments.length && result.length < 4; k += direction) {
      result.push(segments[k]);
    }
    return result;
  }

  return segments
    .filter(function (other) {
      const sameColumn = other.x0 < self.x1 && other.x1 > self.x0;
      const dy = (other.y - self.y) * direction;
      return other !== self && sameColumn && dy > 0 && dy < self.h * 6;
    })
    .sort(function (a, b) { return Math.abs(a.y - self.y) - Math.abs(b.y - self.y); })
    .slice(0, 4);
}

// 某个片段下面的所有片段（同一列），从近到远；没有位置的文字就是后面的行
function segmentsBelow(segments, index) {
  const self = segments[index];
  if (self.x === null) {
    return segments.slice(index + 1, index + 12);
  }
  return segments
    .filter(function (other) {
      return other.x0 < self.x1 && other.x1 > self.x0 && other.y > self.y && other.y - self.y < self.h * 15;
    })
    .sort(function (a, b) { return a.y - b.y; });
}

// 这个片段在星期几：看它的横坐标离哪个表头日期最近
function dayOf(segment, dayColumns) {
  if (dayColumns.length === 0 || segment.x === null) {
    return '';
  }
  // 在表头上面的（比如 "OTHER" 那一行里的线上课）不属于任何一天
  if (segment.y < dayColumns[0].y) {
    return '';
  }
  let best = dayColumns[0];
  dayColumns.forEach(function (d) {
    if (Math.abs(d.x - segment.x) < Math.abs(best.x - segment.x)) {
      best = d;
    }
  });
  return headerToDay(best.label);
}

// ===== 两种版面的读法 =====

// 版面一：日历格子 / 一行行的文字。以课号为中心，往上找课名，往下找时间和教室
function parseBlocks(segments, placeIndex, knownCourses) {
  const dayColumns = findDayColumns(segments);
  // 简写课号（MA123）出现在一整句话里时，只是"提到"，不是一门课（比如 "Students registered for MA123 need to…"）
  const anchorOf = function (text) {
    const found = findCourse(text, knownCourses);
    return found && (!found.short || text.split(/\s+/).length <= 6) ? found : null;
  };
  const isAnchor = function (s) { return anchorOf(s.text) !== null; };
  const meetings = [];

  segments.forEach(function (segment, i) {
    const found = anchorOf(segment.text);
    if (!found) {
      return;
    }
    const before = segment.text.slice(0, found.index).trim();
    const after = segment.text.slice(found.index + found.length);

    // 同一个格子里、课号下面的几行（碰到下一个课号就停）
    const cell = [];
    for (const s of neighborsInCell(segments, i, 1)) {
      if (isAnchor(s)) {
        break;
      }
      cell.push(s);
    }

    // 课名：课号前面的文字；没有的话，用紧挨在上面的那一行（简写课号那一行本身就是课名，比如 "DS 110 lecture --CAS"）
    let title = cleanTitle(before);
    if (found.short) {
      title = segment.text;
    } else if (title.length < 3) {
      // 格子窄的时候，课名会折成好几行（"Experience" / "Management"）：一行一行往上收，直到不像课名为止
      const parts = [];
      let lower = segment;
      for (const above of neighborsInCell(segments, i, -1)) {
        const close = segment.y === null || Math.abs(above.y - lower.y) < segment.h * 2.5;
        // 同一个格子里的字是左对齐的；左边差太多，就是别的东西（比如时间轴、表头）
        const aligned = segment.x0 === null || Math.abs(above.x0 - segment.x0) < segment.h * 1.5;
        if (!close || !aligned || isAnchor(above) || parseTimeRange(above.text) ||
            findLocation(above.text, placeIndex) || /:\s*$/.test(above.text) || isDayHeader(above.text)) {
          break;
        }
        parts.unshift(above.text);
        lower = above;
        if (parts.length === 3) {
          break;
        }
      }
      if (parts.length > 0) {
        title = cleanTitle(parts.join(' '));
      }
    }

    // 时间、星期、教室：在课号这一行后半段和下面几行里找
    let time = null;
    let days = [];
    let location = null;
    [after].concat(cell.map(function (s) { return s.text; })).forEach(function (text) {
      if (!time) {
        time = parseTimeRange(text);
        if (time) {
          // 和时间写在同一行的 "MoWeFr" 才算星期（别处的 "We"、"Th" 可能只是普通单词）
          days = sortDays([].concat.apply([], text.split(/\s+/).map(parseDayCodes)));
        }
      }
      if (!location) {
        location = findLocation(text, placeIndex);
      }
    });
    // 附近几行没有地点：继续往下找，直到下一门课开始（有的课表把地址放得比较远）
    if (!location) {
      for (const s of segmentsBelow(segments, i)) {
        if (isAnchor(s)) {
          break;
        }
        location = findLocation(s.text, placeIndex);
        if (location) {
          break;
        }
      }
    }
    if (days.length === 0) {
      const day = dayOf(segment, dayColumns);
      if (day) {
        days = [day];
      }
    }

    // 类型可能折到下一行（"CDSDS 110" / "(DIS)"）
    let section = parseType(after);
    if (!section && cell[0] && /^\(?[A-Za-z]{3}\)?$/.test(cell[0].text.trim())) {
      section = parseType(cell[0].text);
    }

    meetings.push({
      title: title,
      course: found.course,
      section: section,
      time: time,
      days: days,
      location: location
    });
  });
  return meetings;
}

// 版面二：课程详情（"Days:"、"Start:"、"Room:" 这种带标签的）
// 标签可以出现在一行的中间：整页截图里，左边菜单的字（比如 "Enrollment"）会和弹窗里的 "Room:" 读成同一行
const LABEL = /(?:^|\s)(Days|Meets|Start|End|Room|Section|Instructor|Dates|Location)\s*:\s*/i;

// 把同一高度的片段拼回一行（有位置时）；没有位置的文字本来就是一行一行的
function groupRows(segments) {
  if (segments.length === 0 || segments[0].y === null) {
    return segments.map(function (s) { return s.text; });
  }
  const rows = [];
  segments.slice().sort(function (a, b) { return a.y - b.y || a.x0 - b.x0; }).forEach(function (s) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - s.y) < Math.max(row.h, s.h) * 0.6) {
      row.parts.push(s);
    } else {
      rows.push({ y: s.y, h: s.h, parts: [s] });
    }
  });
  return rows.map(function (row) {
    return row.parts.sort(function (a, b) { return a.x0 - b.x0; }).map(function (p) { return p.text; }).join('   ');
  });
}

function parseLabeled(rows, placeIndex, knownCourses) {
  // 先按顺序读：遇到课号就开始一门新课，后面的标签都属于这门课
  const entries = [];
  let current = null;
  rows.forEach(function (row) {
    const label = row.match(LABEL);
    if (!label) {
      if (current && !findCourse(row, knownCourses)) {
        current.otherRows.push(row);
      }
      // 别的标签行（比如 "Class Notes: ... MA123 ..."）里的课号只是提到，不是一门新课
      if (/(?:^|\s)[A-Z][A-Za-z ]{1,25}:\s/.test(row) && !COURSE_CODE.test(row)) {
        return;
      }
      // 详情页里只认完整课号（CASMA 123）；简写（MA123）一般只是在说明文字里提到
      const found = findCourse(row, knownCourses);
      if (found && !found.short) {
        current = {
          course: found.course,
          title: cleanTitle(row.slice(0, found.index).split('   ').pop()) || found.course,
          section: parseType(row.slice(found.index + found.length)),
          fields: {},
          otherRows: [] // 不带 "Room:" 这种标签的行：有的课表只写地址，没有标签
        };
        entries.push(current);
      }
      return;
    }
    const key = label[1].toLowerCase();
    if (current && !(key in current.fields)) {
      current.fields[key] = row.slice(label.index + label[0].length); // 只要标签后面的内容，前面菜单的字不要
    }
  });

  // 每门课可能有好几个时段（"Multiple meeting pattern"），一列一个
  const meetings = [];
  entries.forEach(function (entry) {
    const f = entry.fields;
    const section = entry.section || parseType(f.section || '');
    const patterns = [];

    // 写法 1："Meets: MoWeFr 11:15AM - 12:05PM"
    const meetsRe = /((?:Mo|Tu|We|Th|Fr|Sa|Su)+)\s+(\d{1,2}:\d{2}\s*[AaPp]\.?[Mm]\.?)\s*[-–—]\s*(\d{1,2}:\d{2}\s*[AaPp]\.?[Mm]\.?)/g;
    let m;
    while (f.meets && (m = meetsRe.exec(f.meets)) !== null) {
      patterns.push({ days: parseDayCodes(m[1]), time: parseTimeRange(m[2] + ' - ' + m[3]) });
    }

    // 写法 2：分开的 "Days: MoWeFr  Th"、"Start: 9:05AM  6:30PM"、"End: 9:55AM  8:30PM"
    if (patterns.length === 0 && (f.days || f.start)) {
      const dayGroups = (f.days || '').split(/\s+/).map(parseDayCodes).filter(function (d) { return d.length > 0; });
      const starts = findTimeTokens(f.start || '');
      const ends = findTimeTokens(f.end || '');
      const count = Math.max(dayGroups.length, starts.length, 1);
      for (let k = 0; k < count; k++) {
        patterns.push({
          days: sortDays(dayGroups[k] || []),
          time: starts[k] ? resolveTimes(starts[k], ends[k] || null) : null
        });
      }
    }
    if (patterns.length === 0) {
      patterns.push({ days: [], time: null });
    }

    // 教室也是一列一个："675 Commonwealth Ave STO B50   No room assigned"
    let rooms = extractRooms(f.room || f.location || '', placeIndex);
    // 没有 "Room:" 标签（或者里面认不出楼）：在这门课的其他行里找地址或"楼宇代码 + 教室"
    if (rooms.filter(function (r) { return r.place; }).length === 0) {
      for (const row of entry.otherRows) {
        const location = findLocation(row.replace(/^[A-Z][A-Za-z ]{1,25}:\s*/, ''), placeIndex);
        if (location && location.place) {
          rooms = [location];
          break;
        }
      }
    }
    // 只用第一个（左边那一列）时段：右边的一般是附带的（比如每周四的考试），按你的要求不管它
    patterns.slice(0, 1).forEach(function (p, k) {
      meetings.push({
        title: entry.title,
        course: entry.course,
        section: section,
        time: p.time,
        days: p.days,
        location: rooms[k] || null
      });
    });
  });
  return meetings;
}

// ===== 合并、整理 =====

// 是不是同一个上课时段：先看课号（没有课号就看课名）；再看类型和时间。某一边没写类型 / 时间时，就不比那一项
function sameMeeting(a, b) {
  const keyA = (a.course || a.title || '').toUpperCase();
  const keyB = (b.course || b.title || '').toUpperCase();
  if (keyA === '' || keyA !== keyB) {
    return false;
  }
  if (a.section && b.section && a.section !== b.section) {
    return false;
  }
  if (a.start != null && b.start != null && a.start !== b.start) {
    return false;
  }
  if (a.end != null && b.end != null && a.end !== b.end) {
    return false;
  }
  return true;
}

// 排序：同一门课放在一起，再按类型、开始时间
function compareMeetings(a, b) {
  const keyA = a.course || a.title || '';
  const keyB = b.course || b.title || '';
  if (keyA !== keyB) {
    return keyA < keyB ? -1 : 1;
  }
  if ((a.section || '') !== (b.section || '')) {
    return (a.section || '') < (b.section || '') ? -1 : 1;
  }
  return (a.start == null ? 9999 : a.start) - (b.start == null ? 9999 : b.start);
}

// 把同一个时段的合并（星期合在一起），再分成"有地点"和"没地点"两组
function buildResult(meetings) {
  const merged = [];
  meetings.forEach(function (m) {
    const item = {
      title: m.title || m.course,
      course: m.course || '',
      section: m.section || '',
      start: m.time ? m.time.start : null,
      end: m.time ? m.time.end : null,
      time: m.time ? formatTimeRange(m.time) : '',
      days: sortDays(m.days || []),
      place: m.location && m.location.place ? m.location.place : null,
      code: (m.location && m.location.code) || '',
      room: (m.location && m.location.room) || '',
      noRoom: Boolean(m.location && m.location.noRoom)
    };

    const same = merged.find(function (x) { return sameMeeting(x, item); });
    if (!same) {
      merged.push(item);
      return;
    }
    same.days = sortDays(same.days.concat(item.days));
    if (!same.place && item.place) {
      Object.assign(same, { place: item.place, code: item.code, room: item.room, noRoom: false });
    }
    if (same.start == null && item.start != null) {
      Object.assign(same, { start: item.start, end: item.end, time: item.time });
    }
    if (!same.section && item.section) {
      same.section = item.section;
    }
    if (same.title === same.course && item.title !== item.course) {
      same.title = item.title;
    }
  });

  merged.sort(compareMeetings);
  return {
    located: merged.filter(function (m) { return m.place; }),
    unlocated: merged.filter(function (m) { return !m.place; })
  };
}

// ===== 版面三：表格（Schedule Builder 的 Favorites 列表）=====
// 有一行表头 "CLASS  START  END  ROOM …"，下面每门课占两三行：
//   课号一行（"CDSDS 210"），下一行是 "A1-LEC (8226)"；时间在 START / END 列；
//   地址在 ROOM 列，可能折成好几行（"765" / "Commonwealth" / "Ave LAW AUD"）
// 星期不在表里，而是写在每一组上面的小标题（"Wednesday"、"Thursday"）

// 课号可能和左边的课名粘在一起（"ScienceCDSDS 121"），所以前面不要求 \b
const TABLE_COURSE = /([A-Z]{5})\s?(\d{3}[A-Z]?)\b/;
const TABLE_DAY = /^[v>\s]*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

// 找表头：同一行里有 ROOM，还有 START 或 END
// 输出：[{ y, h, cols: { CLASS: x, START: x, ... } }]，按从上到下排；没有表头时是空数组
function findTableHeaders(segments) {
  const headers = [];
  segments.forEach(function (s) {
    if (s.text.trim().toUpperCase() !== 'ROOM') {
      return;
    }
    const cols = {};
    segments.forEach(function (o) {
      const word = o.text.trim().toUpperCase();
      if (/^[A-Z]+$/.test(word) && Math.abs(o.y - s.y) < Math.max(o.h, s.h) * 0.6) {
        cols[word] = o.x;
      }
    });
    if (cols.START !== undefined || cols.END !== undefined) {
      headers.push({ y: s.y, h: s.h, cols: cols });
    }
  });
  return headers.sort(function (a, b) { return a.y - b.y; });
}

// ROOM 列里认地点。比 matchLocation 多认一种：教室不是数字，比如 "LAW AUD"（礼堂）
function matchTableRoom(text, placeIndex) {
  const m = text.match(/(?:^|\s)([A-Z]{2,4})\s+(AUD|[A-Z]?\d{1,4}[A-Z]?)\s*$/);
  if (m) {
    const place = findPlace(placeIndex, m[1], false);
    if (place) {
      return { place: place, code: m[1], room: m[2] };
    }
  }
  return findLocation(text, placeIndex);
}

function parseTable(segments, headers, placeIndex, knownCourses) {
  // 用第一行表头的位置分列：每列的边界是相邻两个表头的中点
  const cols = headers[0].cols;
  const names = Object.keys(cols).sort(function (a, b) { return cols[a] - cols[b]; });
  const edge = function (name, side) {
    const i = names.indexOf(name);
    const j = i + side;
    if (i === -1 || j < 0 || j >= names.length) {
      return side < 0 ? -Infinity : Infinity;
    }
    return (cols[name] + cols[names[j]]) / 2;
  };
  const roomLeft = edge('ROOM', -1);
  const roomRight = edge('ROOM', 1);
  const classLeft = cols.CLASS !== undefined ? edge('CLASS', -1) : -Infinity;

  // 表头和星期小标题是"墙"：一门课的范围不能越过它们
  const walls = headers.map(function (h) { return h.y; });
  const dayHeadings = [];
  segments.forEach(function (s) {
    const m = s.text.trim().match(TABLE_DAY);
    if (m) {
      dayHeadings.push({ y: s.y, day: parseDays(m[1])[0] });
      walls.push(s.y);
    }
  });

  // 每个课号是一门课的"锚点"（在第一行表头下面，而且不是 ROOM 列里的字）
  const anchors = segments.filter(function (s) {
    return s.y > headers[0].y && s.x0 < roomLeft && TABLE_COURSE.test(s.text);
  }).sort(function (a, b) { return a.y - b.y; });

  const meetings = [];
  anchors.forEach(function (anchor, i) {
    // 这门课的上下边界：和前后课号的中点，但不越过表头 / 星期标题
    let top = i > 0 ? (anchors[i - 1].y + anchor.y) / 2 : -Infinity;
    let bottom = i < anchors.length - 1 ? (anchor.y + anchors[i + 1].y) / 2 : Infinity;
    walls.forEach(function (w) {
      if (w < anchor.y && w > top) {
        top = w;
      }
      if (w > anchor.y && w < bottom) {
        bottom = w;
      }
    });
    const band = segments.filter(function (s) {
      return s.y > top && s.y < bottom;
    });

    // 星期：上面最近的小标题
    let day = '';
    dayHeadings.forEach(function (d) {
      if (d.y < anchor.y) {
        day = d.day;
      }
    });

    const code = anchor.text.match(TABLE_COURSE);
    const course = code[1] + ' ' + code[2];

    // 类型：课号下面那行 "A1-LEC (8226)"
    let section = '';
    band.forEach(function (s) {
      if (!section && /\b[A-Z]\d{1,2}\s*-\s*[A-Z]{3}\b/.test(s.text)) {
        section = parseType(s.text);
      }
    });

    // 时间：ROOM 列左边的所有时间，从左到右，第一个是开始，第二个是结束
    const tokens = [];
    band.filter(function (s) { return s.x0 < roomLeft; })
      .sort(function (a, b) { return a.x0 - b.x0; })
      .forEach(function (s) {
        findTimeTokens(s.text).forEach(function (t) { tokens.push(t); });
      });
    const time = tokens.length > 0 ? resolveTimes(tokens[0], tokens[1] || null) : null;

    // 地点：ROOM 列里的几行按上下拼起来；去掉右边购物车图标被认成的乱码（"w"、"h_4"）
    const roomText = band.filter(function (s) { return s.x0 >= roomLeft && s.x0 < roomRight; })
      .sort(function (a, b) { return a.y - b.y; })
      .map(function (s) { return s.text; })
      .join(' ')
      .split(/\s+/)
      .filter(function (w) { return w !== '' && !/_/.test(w) && !/^[a-z]{1,2}$/.test(w); })
      .join(' ');
    const location = roomText ? matchTableRoom(roomText, placeIndex) : null;

    // 课名：CLASS 列左边的字（课名可能折成两行），去掉 ">" 和零散的乱码
    const title = band.filter(function (s) { return s.x0 < classLeft || s === anchor; })
      .sort(function (a, b) { return a.y - b.y || a.x0 - b.x0; })
      .map(function (s) {
        const t = s === anchor ? s.text.slice(0, s.text.search(TABLE_COURSE)) : s.text;
        return t.replace(/^[>\s.]+/, '').trim();
      })
      .filter(function (t) { return /[A-Za-z]{3}/.test(t); })
      .join(' ');

    meetings.push({
      title: title || course,
      course: course,
      section: section,
      time: time,
      days: day ? [day] : [],
      location: location
    });
  });
  return meetings;
}

// 从文字片段里找出所有课程（截图、PDF、Word、粘贴的文字都走这里）
// 输入：片段数组、地点搜索索引、已经知道的课号（用来认简写，比如 DS 110）
// 输出：{ located, unlocated }
//   located：  有地点的上课时段 [{ title, course, section, time, start, end, days, place, code, room }]
//   unlocated：没地点的（线上课、课表写了 No room 等），交给用户决定
function parseSchedule(segments, placeIndex, knownCourses) {
  const rows = groupRows(segments);
  const labelRows = rows.filter(function (r) { return LABEL.test(r); }).length;
  const headers = segments.length > 0 && segments[0].y !== null ? findTableHeaders(segments) : [];
  let meetings;
  if (headers.length > 0) {
    meetings = parseTable(segments, headers, placeIndex, knownCourses || []);
  } else if (labelRows >= 2) {
    meetings = parseLabeled(rows, placeIndex, knownCourses || []);
  } else {
    meetings = parseBlocks(segments, placeIndex, knownCourses || []);
  }
  const result = buildResult(meetings);
  result.fileLocations = findAllLocations(rows, placeIndex);
  return result;
}

// 文件里出现过的所有地点，按楼 + 教室去重
// 输出：[{ place, code, room }]
function findAllLocations(rows, placeIndex) {
  const found = [];
  rows.forEach(function (row) {
    const location = findLocation(row.replace(/^[A-Z][A-Za-z ]{1,25}:\s*/, ''), placeIndex);
    if (location && location.place && !found.some(function (f) { return f.place.id === location.place.id && f.room === location.room; })) {
      found.push(location);
    }
  });
  return found;
}

console.log('schedule.js loaded');
