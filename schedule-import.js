// schedule-import.js：只负责"读各种格式的课表文件"
// 支持：截图（OCR）、日历文件 .ics（BU 课表页面的 Download (.ics)，或 Google 日历导出）、PDF、Word (.docx)、纯文字 .txt
// 所有文件都只在浏览器里读，不会上传到任何服务器
// 唯一的例外：网站读不出截图、用户自己点了 "Read with AI"，那张截图才会发给后端（见文件最后）

// PDF 和 Word 的读取工具比较大，只有用户真的上传这种文件时才下载
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

// 记住已经加载过的脚本，同一个只加载一次
const loadedScripts = {};

// 在页面里动态加一个 <script>，加载完成后继续
function loadScriptOnce(url) {
  if (!loadedScripts[url]) {
    loadedScripts[url] = new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = url;
      script.onload = resolve;
      script.onerror = function () { reject(new Error("Couldn't load the file reader. Check your internet connection.")); };
      document.head.appendChild(script);
    });
  }
  return loadedScripts[url];
}

// 这是哪种文件：看文件名后缀，没有后缀再看类型
function fileKind(file) {
  const name = file.name.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (ext === 'ics' || file.type === 'text/calendar') return 'ics';
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'doc') return 'doc';
  if (['txt', 'text', 'csv'].includes(ext) || file.type === 'text/plain') return 'text';
  if (file.type.startsWith('image/')) return 'image';
  return 'unknown';
}

// 读一个课表文件
// 输入：文件、地点搜索索引、已经知道的课号、显示进度的函数（收到一句话）
// 输出：{ located, unlocated }；读不了时抛出一个错误，错误信息可以直接给用户看
async function readScheduleFile(file, placeIndex, knownCourses, onStatus, context) {
  const kind = fileKind(file);

  if (kind === 'image') {
    onStatus('Loading the text reader (first time takes a few seconds)…');
    const lines = await readScheduleImage(file, function (progress) {
      onStatus(`Reading ${file.name}… ${Math.round(progress * 100)}%`);
    });
    console.log(`OCR lines (${file.name}):`, lines.map(function (l) { return l.text; }));
    return parseSchedule(lines, placeIndex, knownCourses, context);
  }

  if (kind === 'ics') {
    onStatus(`Reading ${file.name}…`);
    return parseIcs(await file.text(), placeIndex, knownCourses);
  }

  if (kind === 'text') {
    return parseSchedule(textToLines(await file.text()), placeIndex, knownCourses);
  }

  if (kind === 'docx') {
    onStatus(`Reading ${file.name}…`);
    await loadScriptOnce(MAMMOTH_URL);
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return parseSchedule(textToLines(result.value), placeIndex, knownCourses);
  }

  if (kind === 'pdf') {
    onStatus(`Reading ${file.name}…`);
    const segments = await readPdf(file);
    if (segments.length === 0) {
      throw new Error(`${file.name} has no readable text (it may be a scanned image). Try a screenshot instead.`);
    }
    return parseSchedule(segments, placeIndex, knownCourses);
  }

  if (kind === 'doc') {
    throw new Error(`${file.name} is an old Word file (.doc). Save it as .docx or PDF and try again.`);
  }
  throw new Error(`${file.name} isn't a supported file. Use a screenshot, .ics, PDF, Word (.docx) or text file.`);
}

// ===== PDF =====

// 读出 PDF 里的文字，以及每段文字的位置（和截图识别的结果格式一样，后面的分析可以共用）
async function readPdf(file) {
  await loadScriptOnce(PDFJS_URL);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;

  const lines = [];
  let pageOffset = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    // PDF 的坐标从下往上算，换成和图片一样从上往下；同一高度的文字拼成一行
    const rows = [];
    content.items.forEach(function (item) {
      if (!item.str || item.str.trim() === '') {
        return;
      }
      const height = item.height || Math.abs(item.transform[3]) || 10;
      const y = pageOffset + viewport.height - item.transform[5] - height / 2;
      const x0 = item.transform[4];
      const word = { text: item.str, bbox: { x0: x0, x1: x0 + item.width, y0: y - height / 2, y1: y + height / 2 } };
      let row = rows.find(function (r) { return Math.abs(r.y - y) < height * 0.5; });
      if (!row) {
        row = { y: y, height: height, words: [] };
        rows.push(row);
      }
      row.words.push(word);
    });

    rows.forEach(function (row) {
      row.words.sort(function (a, b) { return a.bbox.x0 - b.bbox.x0; });
      lines.push({
        text: row.words.map(function (w) { return w.text; }).join(' '),
        bbox: {
          x0: row.words[0].bbox.x0,
          x1: row.words[row.words.length - 1].bbox.x1,
          y0: row.y - row.height / 2,
          y1: row.y + row.height / 2
        },
        words: row.words
      });
    });
    pageOffset += viewport.height;
  }

  lines.sort(function (a, b) { return a.bbox.y0 - b.bbox.y0; });
  return flattenOcrLines({ blocks: [{ paragraphs: [{ lines: lines }] }] });
}

// ===== 日历文件 .ics =====
//
// .ics 是标准的日历格式，每节课是一个 VEVENT，里面是整整齐齐的字段：
//   SUMMARY:Calculus 1 CASMA 123        课名、课号
//   LOCATION:675 Commonwealth Ave STO B50
//   DTSTART;TZID=America/New_York:20260902T090500
//   RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR    每周哪几天
// 所以不用"认字"，直接读字段，最准确

// .ics 里的特殊写法还原：\, → ,   \n → 换行
function unescapeIcs(text) {
  return text.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

// 读一个字段，比如 field(event, 'SUMMARY')；字段名后面可能带参数（DTSTART;TZID=...），一起跳过
function icsField(event, name) {
  const m = event.match(new RegExp('^' + name + '(?:;[^:\\n]*)?:(.*)$', 'm'));
  return m ? unescapeIcs(m[1]).trim() : '';
}

// 读开始 / 结束时间，换成波士顿当地时间
// 输出：{ minutes, day: 'Mon' }；没有时间时是 null
function icsTime(event, name) {
  const m = event.match(new RegExp('^' + name + '(?:;[^:\\n]*)?:(\\d{4})(\\d{2})(\\d{2})(?:T(\\d{2})(\\d{2})\\d{0,2}(Z?))?', 'm'));
  if (!m || m[4] === undefined) {
    return null; // 全天的事件，不是课
  }
  if (m[6] === 'Z') {
    // 结尾带 Z 的是世界标准时间（UTC），要换成波士顿时间
    const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short'
    }).formatToParts(date);
    const get = function (type) { return parts.find(function (p) { return p.type === type; }).value; };
    return { minutes: Number(get('hour')) * 60 + Number(get('minute')), day: get('weekday') };
  }
  const local = new Date(+m[1], +m[2] - 1, +m[3]);
  return { minutes: Number(m[4]) * 60 + Number(m[5]), day: DAY_NAMES[local.getDay()] };
}

function parseIcs(text, placeIndex, knownCourses) {
  // 一行太长时会折成好几行，下一行以空格开头。先拼回去
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const events = unfolded.split('BEGIN:VEVENT').slice(1).map(function (chunk) {
    return chunk.split('END:VEVENT')[0];
  });

  const meetings = [];
  events.forEach(function (event) {
    const summary = icsField(event, 'SUMMARY');
    const description = icsField(event, 'DESCRIPTION');
    const locationText = icsField(event, 'LOCATION');

    // 期末考试（"Exam - SHAHF 150"）只有一天，不是每周的课，跳过
    if (/^exam\b/i.test(summary)) {
      return;
    }

    // 只要课：标题或说明里有课号的才算（个人日程，比如 "yoga"，会被跳过）
    const found = findCourse(summary, knownCourses) || findCourse(description, knownCourses);
    if (!found) {
      return;
    }

    const start = icsTime(event, 'DTSTART');
    const end = icsTime(event, 'DTEND');

    // 每周哪几天：RRULE 里的 BYDAY；没有的话，就是开始那天
    let days = [];
    const byday = event.match(/^RRULE:.*BYDAY=([A-Z,]+)/m);
    if (byday) {
      days = byday[1].split(',').map(function (d) { return DAY_CODES[d[0] + d[1].toLowerCase()]; }).filter(Boolean);
    } else if (start) {
      days = [start.day];
    }

    // 课名：标题去掉课号和类型；剩下的太短就用课号
    const inSummary = findCourse(summary, knownCourses);
    let title = inSummary ? (summary.slice(0, inSummary.index) + ' ' + summary.slice(inSummary.index + inSummary.length)) : summary;
    title = title.replace(/\(?\b(?:LEC|DIS|LAB|PLB|SEM|IND|REC|STU)\b\)?/g, '').replace(/[|\-–—]+/g, ' ').replace(/\s+/g, ' ').trim();

    const sectionLine = (description.match(/section[^\n]*/i) || [''])[0];
    meetings.push({
      // BU 的 .ics：SUMMARY 只有课号（"CDSDS 110"），课名写在 DESCRIPTION 里（"Intro to DS with Python"）
      title: title.length >= 3 ? title : (description.split('\n')[0].trim() || found.course),
      course: found.course,
      section: parseType(summary.slice(found.index + found.length)) || parseType(sectionLine),
      time: start ? { start: start.minutes, end: end ? end.minutes : null } : null,
      days: days,
      location: findLocation(locationText, placeIndex) || findLocation(summary, placeIndex)
    });
  });

  if (events.length > 0 && meetings.length === 0) {
    throw new Error("This calendar file has no events with a course number (like CASMA 123).");
  }
  return buildResult(meetings);
}

console.log('schedule-import.js loaded');

// ===== 用 AI 读截图（用户主动点了 "Read with AI" 才会用）=====

// 把截图缩小再发：长边最多 1568 像素（Claude 看图的上限，再大也会被它缩小），转成 JPEG
// 更小 = 上传更快、花钱更少，字还是看得清
// 输出：base64 文字（不带 "data:image/jpeg;base64," 开头）
function shrinkImage(file, maxSide) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // 透明的地方填白色，JPEG 没有透明
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't open ${file.name} as an image.`));
    };
    img.src = url;
  });
}

// 把一张截图交给后端，让 AI 读
// 输出：{ classes: [...] }（格式见 schedule.js 的 parseAiClasses）；出错时抛出一个可以直接给用户看的错误
async function readScheduleWithAi(file) {
  if (!BACKEND_URL) {
    throw new Error('AI reading is not available right now.');
  }
  const image = await shrinkImage(file, 1568);
  let response;
  try {
    // 免费的后端睡着时，第一次要几十秒才醒，所以多等一会儿
    response = await fetch(`${BACKEND_URL}/api/read-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: image, media_type: 'image/jpeg' }),
      signal: AbortSignal.timeout(90000)
    });
  } catch (error) {
    throw new Error("Couldn't reach the AI reader. Check your connection and try again.");
  }
  if (response.status === 429) {
    throw new Error("AI reading has hit today's limit. Try again tomorrow, or paste the text instead.");
  }
  if (!response.ok) {
    throw new Error('The AI reader had a problem. Try again in a minute, or paste the text instead.');
  }
  return response.json();
}
