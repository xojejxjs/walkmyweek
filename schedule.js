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

// 日历表头 → 星期几："MON" → 'Mon'；"SEP 28" → 算出这一天是周几（year 不传就用今年）
function headerToDay(label, year) {
  const parts = label.split(' ');
  if (parts.length === 1) {
    return DAY_NAMES.find(function (d) { return d.toUpperCase() === label; }) || '';
  }
  return DAY_NAMES[headerDate(label, year || new Date().getFullYear()).getUTCDay()];
}

// "SEP 28" + 年份 → 日期（用 UTC，免得夏令时让"相差几天"算错）
function headerDate(label, year) {
  const parts = label.split(' ');
  return new Date(Date.UTC(year, MONTHS.indexOf(parts[0]), Number(parts[1])));
}

// 表头只有日期、没有星期（"SEP 7"）时，截图上没写年份：在去年、今年、明年里挑一个
// 课表一般是周一到周五：哪一年让这些日期落在工作日上最多，就用哪一年；一样多时优先今年
// 输出：年份；表头里没有日期时是 null
function guessHeaderYear(columns) {
  const dated = columns.filter(function (c) { return c.label.includes(' '); });
  if (dated.length === 0) {
    return null;
  }
  const now = new Date().getFullYear();
  let best = now;
  let bestScore = -1;
  [now, now - 1, now + 1].forEach(function (year) {
    const score = dated.filter(function (c) {
      const day = headerDate(c.label, year).getUTCDay();
      return day >= 1 && day <= 5;
    }).length;
    if (score > bestScore) {
      best = year;
      bestScore = score;
    }
  });
  return best;
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
  const monthDay = new RegExp('^(' + MONTHS.join('|') + ')[A-Z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?$', 'i');
  // 星期后面可以跟日期："MON 28"、"Mon 9/7"、"Monday, Sep 7"（有星期就用星期，最可靠）
  const weekday = new RegExp('^(' + WEEKDAYS.join('|') + ')[A-Z]*\\.?,?(\\s+(\\d{1,2}(/\\d{1,2})?|(' + MONTHS.join('|') + ')[A-Z]*\\.?\\s+\\d{1,2}))?$', 'i');
  // 只有数字日期："9/7"
  const numeric = /^(\d{1,2})\/(\d{1,2})$/;

  const days = [];
  segments.forEach(function (segment) {
    if (segment.x === null) {
      return;
    }
    const m = segment.text.match(monthDay);
    const w = segment.text.match(weekday);
    const n = segment.text.match(numeric);
    if (m) {
      days.push({ label: m[1].toUpperCase() + ' ' + Number(m[2]), x: segment.x, y: segment.y });
    } else if (w) {
      days.push({ label: w[1].toUpperCase(), x: segment.x, y: segment.y });
    } else if (n && Number(n[1]) >= 1 && Number(n[1]) <= 12 && Number(n[2]) >= 1 && Number(n[2]) <= 31) {
      days.push({ label: MONTHS[Number(n[1]) - 1] + ' ' + Number(n[2]), x: segment.x, y: segment.y });
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

// 表头 → "横坐标对应星期几"的规则
// 有两个以上表头时，按列宽推算：某一列的表头没认出来（OCR 漏了），那一列的课也不会被算到隔壁那天
// 输入：findDayColumns 的结果；anchorXs：课号的横坐标（只有一个表头时，用来判断课是不是分在好几列）
// 输出：{ dayAt(x) → 'Mon' 或 ''，fromDates：星期是不是从日期推算的，year：推算用的年份，unsure：认不准星期 }
function buildDayAxis(dayColumns, anchorXs, lineHeight) {
  const axis = { fromDates: false, year: null, unsure: false, dayAt: function () { return ''; } };
  if (dayColumns.length === 0) {
    return axis;
  }
  // 有星期的表头最可靠，有的话只用它们；否则用日期
  const named = dayColumns.filter(function (c) { return !c.label.includes(' '); });
  const columns = named.length > 0 ? named : dayColumns;
  const year = named.length > 0 ? null : guessHeaderYear(columns);
  axis.fromDates = named.length === 0;
  axis.year = year;
  // 每个表头 → 一个"第几天"的数：星期用 0（周日）～6，日期用从 1970 年起的天数
  const points = columns.map(function (c) {
    const n = c.label.includes(' ')
      ? Math.round(headerDate(c.label, year).getTime() / 86400000)
      : DAY_NAMES.findIndex(function (d) { return d.toUpperCase() === c.label; });
    return { x: c.x, n: n };
  }).sort(function (a, b) { return a.x - b.x; });
  const weekdayOf = function (n) {
    // 1970-01-01 是周四；星期表头的数本来就是 0～6
    return DAY_NAMES[(((axis.fromDates ? n + 4 : n) % 7) + 7) % 7];
  };

  // 只有一个表头：课都在这一列附近才用它；课分散在好几列，说明别的表头没认出来，宁可不填，让用户自己选
  if (points.length === 1 || points.every(function (p) { return p.n === points[0].n; })) {
    const spread = anchorXs.length > 0 ? Math.max.apply(null, anchorXs) - Math.min.apply(null, anchorXs) : 0;
    if (spread > (lineHeight || 20) * 8) {
      axis.unsure = true;
      return axis;
    }
    axis.dayAt = function () { return weekdayOf(points[0].n); };
    return axis;
  }

  // 列宽：相邻两个表头之间，每差一天隔多宽（取中位数，个别认错的表头影响不大）
  const widths = [];
  for (let i = 1; i < points.length; i++) {
    const dn = points[i].n - points[i - 1].n;
    if (dn > 0) {
      widths.push((points[i].x - points[i - 1].x) / dn);
    }
  }
  if (widths.length === 0) {
    axis.unsure = true; // 表头顺序和日期对不上（比如认错了），不要乱猜
    return axis;
  }
  widths.sort(function (a, b) { return a - b; });
  const width = widths[Math.floor(widths.length / 2)];
  const first = points[0];
  const last = points[points.length - 1];
  axis.dayAt = function (x) {
    // 只认表头范围内（左右各多半列）的课
    if (x < first.x - width * 0.75 || x > last.x + width * 0.75) {
      return '';
    }
    return weekdayOf(first.n + Math.round((x - first.x) / width));
  };
  return axis;
}

// 这个片段在星期几
function dayOf(segment, dayColumns, axis) {
  if (dayColumns.length === 0 || segment.x === null) {
    return '';
  }
  // 在表头上面的（比如 "OTHER" 那一行里的线上课）不属于任何一天
  if (segment.y < dayColumns[0].y) {
    return '';
  }
  return axis.dayAt(segment.x);
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
  // 表头在下面的课号都算：每个课号的横坐标、行高，用来判断只认出一个表头时课是不是分在好几列
  const anchors = segments.filter(function (s) { return s.x !== null && isAnchor(s) && (dayColumns.length === 0 || s.y > dayColumns[0].y); });
  const axis = buildDayAxis(dayColumns, anchors.map(function (s) { return s.x; }),
    anchors.length > 0 ? anchors[0].h : 20);

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
        // 上一门课的教室（"CAS 211"）、星期行也不是课名
        if (!close || !aligned || isAnchor(above) || parseTimeRange(above.text) ||
            findLocation(above.text, placeIndex) || LOCATION_PATTERN.test(above.text) ||
            /:\s*$/.test(above.text) || isDayHeader(above.text) || isDaysOnly(above.text).length > 0) {
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
          const sameLine = sortDays([].concat.apply([], text.split(/\s+/).map(parseDayCodes)));
          days = sameLine.length > 0 ? sameLine : days;
        }
      }
      // 单独一行的星期（"Monday"、"Days: Mon, Wed"）
      if (days.length === 0 && isDaysOnly(text).length > 0) {
        days = isDaysOnly(text);
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
    let dayFromDate = false;
    if (days.length === 0) {
      const day = dayOf(segment, dayColumns, axis);
      if (day) {
        days = [day];
        dayFromDate = axis.fromDates;
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
      location: location,
      dayFromDate: dayFromDate,
      dateYear: dayFromDate ? axis.year : null
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

// 一行字像不像课名：不是标签、时间、课号、教室、星期，长度也合适
// 用在"课名单独写在课号上面一行"的时候（比如粘贴的 "Intro to DS with Python" / "CDSDS 110 (LEC)"）
function looksLikeTitle(text, placeIndex) {
  const t = (text || '').trim();
  return t.length >= 3 && t.length <= 80 && /[A-Za-z]{3}/.test(t) && !LABEL.test(t) &&
    findTimeTokens(t).length === 0 && !COURSE_CODE.test(t) && !LOCATION_PATTERN.test(t) &&
    isDaysOnly(t).length === 0 && !findLocation(t, placeIndex);
}

// 一整行都是星期吗（"Monday"、"MoWeFr"、"Mon, Wed"、"Days: Tue/Thu"）
// 输出：星期数组；不是的话是空数组
function isDaysOnly(text) {
  const t = text.replace(/^\s*(days|meets)\s*:\s*/i, '').trim();
  const tokens = t.split(/[\s,/&]+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every(function (tok) { return parseDays(tok).length > 0; })) {
    return [];
  }
  return parseDays(t);
}

function parseLabeled(rows, placeIndex, knownCourses) {
  // 先按顺序读：遇到课号就开始一门新课，后面的标签都属于这门课
  const entries = [];
  let current = null;
  rows.forEach(function (row, i) {
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
        // 课名：课号同一行前面的字；没有的话，看上一行像不像课名
        const sameRow = cleanTitle(row.slice(0, found.index).split('   ').pop());
        const above = i > 0 && looksLikeTitle(rows[i - 1], placeIndex) ? cleanTitle(rows[i - 1]) : '';
        current = {
          course: found.course,
          title: sameRow || above || found.course,
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
    // 没有 "Start:" 时，时间可能写在 "Days:" 同一行（"Days: Monday 9:00 - 10:00 am"），或者单独一行（"9:00 - 10:00 am"）
    const looseTime = function () {
      const sameLine = parseTimeRange(f.days || '');
      if (sameLine) {
        return sameLine;
      }
      for (const row of entry.otherRows) {
        const time = parseTimeRange(row);
        if (time) {
          return time;
        }
      }
      return null;
    };
    if (patterns.length === 0 && (f.days || f.start)) {
      let dayGroups = (f.days || '').split(/\s+/).map(parseDayCodes).filter(function (d) { return d.length > 0; });
      // 不是 "MoWeFr" 这种写法：按完整的英文星期读（"Monday"、"Mon, Wed"），算一组
      if (dayGroups.length === 0 && parseDays(f.days || '').length > 0) {
        dayGroups = [parseDays(f.days)];
      }
      const starts = findTimeTokens(f.start || '');
      const ends = findTimeTokens(f.end || '');
      const count = Math.max(dayGroups.length, starts.length, 1);
      const fallback = starts.length === 0 ? looseTime() : null;
      for (let k = 0; k < count; k++) {
        patterns.push({
          days: sortDays(dayGroups[k] || []),
          time: starts[k] ? resolveTimes(starts[k], ends[k] || null) : (k === 0 ? fallback : null)
        });
      }
    }
    // 连 "Days:" 都没有：在这门课的其他行里找时间，和时间同一行（或单独一行）的星期
    if (patterns.length === 0) {
      for (const row of entry.otherRows) {
        const time = parseTimeRange(row);
        if (time) {
          const days = sortDays([].concat.apply([], row.split(/\s+/).map(parseDayCodes)).concat(parseDays(row.replace(/\d.*$/, ''))));
          patterns.push({ days: days, time: time });
          break;
        }
      }
      const dayRow = entry.otherRows.map(isDaysOnly).find(function (d) { return d.length > 0; });
      if (patterns.length > 0 && patterns[0].days.length === 0 && dayRow) {
        patterns[0].days = dayRow;
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

// 星期往前 / 往后挪几天：('Tue', -1) → 'Mon'；超出周一到周日时是 ''
function shiftDay(day, step) {
  const i = DAY_ORDER.indexOf(day) + step;
  return i >= 0 && i < DAY_ORDER.length ? DAY_ORDER[i] : '';
}

// context：几张截图连着读时共用的记录，{ lastDay }（上一张截图最后一门课是星期几）
function parseTable(segments, headers, placeIndex, knownCourses, context) {
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
  dayHeadings.sort(function (a, b) { return a.y - b.y; });

  // 一门课是星期几。输出：{ day, guessed }
  //   1. 上面有小标题：就是它
  //   2. 在第一个小标题上面，而且上面没有表头：这几行是接着上一张截图的，用上一张最后的星期
  //   3. 其他情况（截图把小标题裁掉了一半）：用下一个小标题往前推一天，算"猜的"，提醒用户检查
  const dayFor = function (y) {
    let heading = null;
    dayHeadings.forEach(function (d) {
      if (d.y < y) {
        heading = d;
      }
    });
    if (heading) {
      return { day: heading.day, guessed: false };
    }
    const headerAbove = headers.some(function (h) { return h.y < y; });
    if (!headerAbove && context.lastDay) {
      return { day: context.lastDay, guessed: false };
    }
    if (dayHeadings.length > 0) {
      const day = shiftDay(dayHeadings[0].day, -1);
      return { day: day, guessed: day !== '' };
    }
    return { day: '', guessed: false };
  };

  // 每个课号是一门课的"锚点"：右边伸进 CLASS 列（课名里偶尔提到的课号不算），又在 ROOM 列左边
  // 表头上面的行也算（接着上一张截图的那几行）
  const anchors = segments.filter(function (s) {
    return s.x1 > classLeft && s.x0 < roomLeft && TABLE_COURSE.test(s.text);
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

    const day = dayFor(anchor.y);

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
    // ROOM 列是空的或者只有 "-"：课表没给教室
    const location = /[A-Za-z0-9]/.test(roomText) ? matchTableRoom(roomText, placeIndex) : { noRoom: true };

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
      days: day.day ? [day.day] : [],
      dayGuessed: day.guessed,
      location: location
    });
  });
  // 记下这张截图最后的星期，下一张截图开头接着用
  if (meetings.length > 0 && meetings[meetings.length - 1].days.length > 0) {
    context.lastDay = meetings[meetings.length - 1].days[0];
  }
  return meetings;
}

// ===== AI 读出来的课（用户点了 "Read with AI"，后端 /api/read-schedule 返回的）=====

// "09:30"（24 小时制）→ 从午夜开始的分钟数；没写或格式不对时是 null
function aiClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// 输入：后端返回的 classes 数组 [{ course, title, type, days, start, end, room, no_room }]、地点搜索索引、已经知道的课号
// 输出：和 parseSchedule 一样的 { located, unlocated, guessedDays, fileLocations }
// AI 只负责"看懂截图"；教室在哪栋楼，还是用网站自己的规则对（matchTableRoom），不靠 AI 猜
function parseAiClasses(classes, placeIndex, knownCourses) {
  // 表头只有日期时，AI 给的是日期（"09-07"）：所有课的日期放在一起挑年份，再算星期
  const labels = [];
  (classes || []).forEach(function (c) {
    (c.dates || []).forEach(function (d) {
      const m = /^(\d{2})-(\d{2})$/.exec(d);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
        labels.push({ label: MONTHS[Number(m[1]) - 1] + ' ' + Number(m[2]), from: d });
      }
    });
  });
  const year = labels.length > 0 ? guessHeaderYear(labels) : null;
  const daysFromDates = function (dates) {
    return sortDays((dates || []).map(function (d) {
      const found = labels.find(function (l) { return l.from === d; });
      return found ? headerToDay(found.label, year) : '';
    }).filter(Boolean));
  };
  let usedDates = false;
  const meetings = (classes || []).map(function (c) {
    const raw = String(c.course || '').toUpperCase();
    const found = findCourse(raw, knownCourses || []);
    const course = found ? found.course : raw;
    const start = aiClock(c.start);
    const end = aiClock(c.end);
    let location = null;
    if (c.no_room) {
      location = { noRoom: true };
    } else if (c.room) {
      location = matchTableRoom(c.room, placeIndex);
    }
    return {
      title: c.title || course,
      course: course,
      section: parseType(c.type || ''),
      time: start === null ? null : { start: start, end: end },
      days: (c.days || []).length > 0 ? sortDays(c.days) : (function () {
        const days = daysFromDates(c.dates);
        usedDates = usedDates || days.length > 0;
        return days;
      })(),
      location: location
    };
  });
  const result = buildResult(meetings);
  result.guessedDays = [];
  result.fileLocations = [];
  result.dateYear = usedDates ? year : null;
  return result;
}

// ===== 同一门课、拼法差一点的课名 =====
// 识别常把一个字母认错（"Linear Algebra" → "Linsar Algebra"）。同一个课号的几个时段（LEC / DIS / LAB）
// 课名本来应该一样，所以拿它们互相比：差一两个字母，多半是认错了

// 两段文字差几个字母（插入、删除、替换各算一次）
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, function (_, j) { return j; });
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

// 两个课名像不像同一个、只是认错了几个字母（完全不一样的课名，比如专题课的不同主题，不算）
function titlesLookAlike(a, b) {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y || x.length < 4 || y.length < 4) {
    return false;
  }
  return editDistance(x, y) <= Math.max(2, Math.floor(Math.max(x.length, y.length) * 0.2));
}

// 把同一个课号里拼法差一点的课名统一起来
// 输入：上课时段 [{ course, title }]（会直接改）、已经在课表里的课（用户确认过的课名最可信）
// 输出：{ fixed: [{ course, from, to }]：自动改了哪些，ties: [{ course, options }]：一样多、要用户选的 }
//   1. 课表里已经有这门课：用那个课名
//   2. 某个拼法出现得最多：用它
//   3. 一样多（比如 LEC 写对、DIS 写错，各一次）：不猜，交给用户选（rows 上记 titleOptions）
function unifyTitles(rows, existing) {
  const report = { fixed: [], ties: [] };
  const byCourse = {};
  rows.forEach(function (r) {
    if (r.course && r.title && r.title.toUpperCase() !== r.course.toUpperCase()) {
      (byCourse[r.course] = byCourse[r.course] || []).push(r);
    }
  });
  Object.keys(byCourse).forEach(function (course) {
    const group = byCourse[course];
    const counts = {};
    group.forEach(function (r) { counts[r.title] = (counts[r.title] || 0) + 1; });
    const titles = Object.keys(counts);
    if (titles.length < 2) {
      return;
    }
    // 只处理"长得像"的那些拼法：和别的某个拼法差一点
    const alike = titles.filter(function (t) {
      return titles.some(function (u) { return u !== t && titlesLookAlike(t, u); });
    });
    if (alike.length < 2) {
      return;
    }
    const known = (existing || []).find(function (c) {
      return c.course === course && alike.some(function (t) { return t === c.title || titlesLookAlike(t, c.title); });
    });
    let best = known ? known.title : null;
    if (!best) {
      const top = Math.max.apply(null, alike.map(function (t) { return counts[t]; }));
      const leaders = alike.filter(function (t) { return counts[t] === top; });
      if (leaders.length === 1) {
        best = leaders[0];
      } else {
        group.forEach(function (r) {
          if (alike.includes(r.title)) {
            r.titleOptions = leaders;
          }
        });
        report.ties.push({ course: course, options: leaders });
        return;
      }
    }
    group.forEach(function (r) {
      if (alike.includes(r.title) && r.title !== best) {
        report.fixed.push({ course: course, from: r.title, to: best });
        r.title = best;
      }
    });
  });
  return report;
}

// 从文字片段里找出所有课程（截图、PDF、Word、粘贴的文字都走这里）
// 输入：片段数组、地点搜索索引、已经知道的课号（用来认简写，比如 DS 110）
//       context（可以不传）：几张截图连着读时共用的记录，见 parseTable
// 输出：{ located, unlocated, guessedDays }
//   located：  有地点的上课时段 [{ title, course, section, time, start, end, days, place, code, room }]
//   unlocated：没地点的（线上课、课表写了 No room 等），交给用户决定
//   guessedDays：哪几天是猜的（截图把星期标题裁掉了），比如 ['Mon']；没有猜就是空数组
function parseSchedule(segments, placeIndex, knownCourses, context) {
  const rows = groupRows(segments);
  const labelRows = rows.filter(function (r) { return LABEL.test(r); }).length;
  const headers = segments.length > 0 && segments[0].y !== null ? findTableHeaders(segments) : [];
  let meetings;
  if (headers.length > 0) {
    meetings = parseTable(segments, headers, placeIndex, knownCourses || [], context || {});
  } else if (labelRows >= 2) {
    meetings = parseLabeled(rows, placeIndex, knownCourses || []);
  } else {
    meetings = parseBlocks(segments, placeIndex, knownCourses || []);
  }
  const result = buildResult(meetings);
  // 有的课星期是猜的（截图把星期标题裁掉了），让页面提醒用户检查
  result.guessedDays = sortDays([].concat.apply([], meetings.filter(function (m) { return m.dayGuessed; })
    .map(function (m) { return m.days; })));
  result.fileLocations = findAllLocations(rows, placeIndex);
  // 截图表头只有日期、没有星期：星期是按日期推算的（假设了年份），也要让用户看一眼
  const dated = meetings.find(function (m) { return m.dayFromDate; });
  result.dateYear = dated ? dated.dateYear : null;
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
