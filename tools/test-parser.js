// tools/test-parser.js：课表识别的回归测试
// 用法（在项目根目录）：node tools/test-parser.js
// 每个用例是一段课表文字（或日历文件 / 截图读出的片段），写明应该读出什么；改了 schedule.js 以后跑一遍，免得把以前能读的改坏
// 不需要浏览器：在 Node 里载入 schedule.js、schedule-import.js，地点索引用 data.json 现建

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = function (file) { return fs.readFileSync(path.join(root, file), 'utf8'); };

// app.js 里的 buildSearchIndex、findPlace 依赖页面，整份载入不了；只取这两个函数
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Function not found: ' + name);
}

const ctx = { console: { log: function () {} }, window: {}, document: {}, Intl: Intl, Date: Date };
vm.createContext(ctx);
const app = read('app.js');
vm.runInContext(extractFunction(app, 'buildSearchIndex') + '\n' + extractFunction(app, 'findPlace'), ctx);
['schedule.js', 'schedule-import.js', 'course-guess.js'].forEach(function (file) {
  vm.runInContext(read(file), ctx, { filename: file });
});
const data = JSON.parse(read('data.json'));
ctx.places = data.dorms.concat(data.buildings);
vm.runInContext('var placeIndex = buildSearchIndex(places);', ctx);

// 结果 → 一行一个时段，好比较："CDSDS 110 LEC | Intro to DS with Python | Mon | 9:00 AM – 10:00 AM | CAS 211"
function summarize(result) {
  return result.located.concat(result.unlocated).map(function (m) {
    const where = m.place ? (m.place.code || m.place.name) + (m.room ? ' ' + m.room : '') : (m.noRoom ? 'no room' : '-');
    return [(m.course + ' ' + m.section).trim(), m.title, m.days.join(','), m.time || '-', where].join(' | ');
  }).sort();
}

function fromText(text) {
  return vm.runInContext('parseSchedule(textToLines(T), placeIndex, [])', Object.assign(ctx, { T: text }));
}

function fromIcs(text) {
  return vm.runInContext('parseIcs(T, placeIndex, [])', Object.assign(ctx, { T: text }));
}

function fromAi(classes) {
  return vm.runInContext('parseAiClasses(C, placeIndex, [])', Object.assign(ctx, { C: classes }));
}

// 截图（OCR）读出的片段：[{ text, x, y }]，宽高按一行 20 像素估
function fromSegments(segments) {
  const segs = segments.map(function (s) {
    const w = s.text.length * 5;
    return { text: s.text, x: s.x, x0: s.x - w / 2, x1: s.x + w / 2, y: s.y, h: 20, words: [] };
  });
  return vm.runInContext('parseSchedule(S, placeIndex, [])', Object.assign(ctx, { S: segs }));
}

// 一周的日历截图：表头（null = OCR 没认出这个表头）在最上面，每列 100 像素宽
// 化学课在周一、三、五（第 1、3、5 列），写作课在周二、四（第 2、4 列）
function weekGrid(headers) {
  const segments = [];
  headers.forEach(function (label, i) {
    if (label) {
      segments.push({ text: label, x: 100 + i * 100, y: 10 });
    }
  });
  [0, 2, 4].forEach(function (col) {
    const x = 100 + col * 100;
    ['General Chemistry', 'CASCH 101', '9:05 - 9:55 am', 'SCI 109'].forEach(function (text, k) {
      segments.push({ text: text, x: x, y: 50 + k * 20 });
    });
  });
  [1, 3].forEach(function (col) {
    const x = 100 + col * 100;
    ['Writing Seminar', 'CASWR 112', '8:00 - 9:15 am', 'CAS B25A'].forEach(function (text, k) {
      segments.push({ text: text, x: x, y: 50 + k * 20 });
    });
  });
  return segments.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
}

const cases = [
  {
    name: '粘贴文字：Days: 和时间分两行（用户反馈 3）',
    run: function () {
      return fromText([
        'Intro to DS with Python', 'CDSDS 110 (LEC)', 'Days: Monday', '9:00 - 10:00 am', 'CAS 211', '',
        'Calculus Test', 'CASMA 123 (LEC)', 'Days: Monday', '9:30 - 10:30 am', 'CFA 304'
      ].join('\n'));
    },
    expect: [
      'CASMA 123 LEC | Calculus Test | Mon | 9:30 AM – 10:30 AM | CFA 304',
      'CDSDS 110 LEC | Intro to DS with Python | Mon | 9:00 AM – 10:00 AM | CAS 211'
    ]
  },
  {
    name: '粘贴文字：星期和时间同一行，课名不能粘上上一门课的教室',
    run: function () {
      return fromText([
        'Intro to DS with Python', 'CDSDS 110 (LEC)', 'Mo 9:00 - 10:00 am', 'CAS 211', '',
        'Calculus Test', 'CASMA 123 (LEC)', 'Mo 9:30 - 10:30 am', 'CFA 304'
      ].join('\n'));
    },
    expect: [
      'CASMA 123 LEC | Calculus Test | Mon | 9:30 AM – 10:30 AM | CFA 304',
      'CDSDS 110 LEC | Intro to DS with Python | Mon | 9:00 AM – 10:00 AM | CAS 211'
    ]
  },
  {
    name: '粘贴文字：只有一门课，星期单独一行',
    run: function () {
      return fromText(['Calculus 1', 'CASMA 123 (LEC)', 'Monday Wednesday', '9:30 - 10:45 am', 'CAS 211'].join('\n'));
    },
    expect: ['CASMA 123 LEC | Calculus 1 | Mon,Wed | 9:30 AM – 10:45 AM | CAS 211']
  },
  {
    name: '课程详情弹窗：Days / Start / End / Room 标签',
    run: function () {
      return fromText([
        'General Chemistry 1 CASCH 101 A1 (LEC)', 'Days: MoWeFr', 'Start: 9:05AM', 'End: 9:55AM', 'Room: SCI 109',
        'Writing Seminar CASWR 112 (SEM)', 'Days: TuTh', 'Start: 8:00AM', 'End: 9:15AM', 'Room: CAS B25A'
      ].join('\n'));
    },
    expect: [
      'CASCH 101 LEC | General Chemistry 1 | Mon,Wed,Fri | 9:05 AM – 9:55 AM | SCI 109',
      'CASWR 112 SEM | Writing Seminar | Tue,Thu | 8:00 AM – 9:15 AM | CAS B25A'
    ]
  },
  {
    name: '日历文件 .ics',
    run: function () {
      return fromIcs([
        'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:CASCH 101', 'DESCRIPTION:General Chemistry 1',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', 'DTSTART;TZID=America/New_York:20260907T090500',
        'DTEND;TZID=America/New_York:20260907T095500', 'LOCATION:590 Commonwealth Ave SCI 109', 'END:VEVENT', 'END:VCALENDAR'
      ].join('\n'));
    },
    expect: ['CASCH 101 | General Chemistry 1 | Mon,Wed,Fri | 9:05 AM – 9:55 AM | SCI 109']
  },
  {
    name: '日历截图：表头只有日期（SEP 7–11），按日期推算星期（用户反馈 1）',
    run: function () { return fromSegments(weekGrid(['SEP 7', 'SEP 8', 'SEP 9', 'SEP 10', 'SEP 11'])); },
    expect: [
      'CASCH 101 | General Chemistry | Mon,Wed,Fri | 9:05 AM – 9:55 AM | SCI 109',
      'CASWR 112 | Writing Seminar | Tue,Thu | 8:00 AM – 9:15 AM | CAS B25A'
    ]
  },
  {
    name: '日历截图：中间一个表头没认出来（SEP 9），那一列的课不能算到隔壁',
    run: function () { return fromSegments(weekGrid(['SEP 7', 'SEP 8', null, 'SEP 10', 'SEP 11'])); },
    expect: [
      'CASCH 101 | General Chemistry | Mon,Wed,Fri | 9:05 AM – 9:55 AM | SCI 109',
      'CASWR 112 | Writing Seminar | Tue,Thu | 8:00 AM – 9:15 AM | CAS B25A'
    ]
  },
  {
    name: '日历截图：带星期的表头（Mon 9/7）',
    run: function () { return fromSegments(weekGrid(['Mon 9/7', 'Tue 9/8', 'Wed 9/9', 'Thu 9/10', 'Fri 9/11'])); },
    expect: [
      'CASCH 101 | General Chemistry | Mon,Wed,Fri | 9:05 AM – 9:55 AM | SCI 109',
      'CASWR 112 | Writing Seminar | Tue,Thu | 8:00 AM – 9:15 AM | CAS B25A'
    ]
  },
  {
    name: '日历截图：只认出最右边一个表头（SEP 12），不能把所有课都算成周六',
    run: function () { return fromSegments(weekGrid([null, null, null, null, null, 'SEP 12'])); },
    expect: [
      'CASCH 101 | General Chemistry |  | 9:05 AM – 9:55 AM | SCI 109',
      'CASWR 112 | Writing Seminar |  | 8:00 AM – 9:15 AM | CAS B25A'
    ]
  },
  {
    name: 'AI 读截图：表头只有日期时，AI 给日期，网页推算星期',
    run: function () {
      return fromAi([
        { course: 'CASCH 101', title: 'General Chemistry', type: 'LEC', days: [], dates: ['09-07', '09-09', '09-11'], start: '09:05', end: '09:55', room: 'SCI 109' },
        { course: 'CASMA 242', title: 'Linear Algebra', type: 'DIS', days: [], dates: ['09-08'], start: '15:30', end: '16:20', room: 'CAS 226' }
      ]);
    },
    expect: [
      'CASCH 101 LEC | General Chemistry | Mon,Wed,Fri | 9:05 AM – 9:55 AM | SCI 109',
      'CASMA 242 DIS | Linear Algebra | Tue | 3:30 PM – 4:20 PM | CAS 226'
    ]
  },
  {
    name: 'AI 读截图的结果',
    run: function () {
      return fromAi([{ course: 'QSTSM 131', title: 'Statistics', type: 'DIS', days: ['Fri'], start: '12:20', end: '13:10', room: 'HAR 210' }]);
    },
    expect: ['QSTSM 131 DIS | Statistics | Fri | 12:20 PM – 1:10 PM | HAR 210']
  }
];

// 课名统一（unifyTitles）：输入一组上课时段，看最后每个时段的课名
function fromUnify(rows, existing) {
  const copy = rows.map(function (r) { return Object.assign({}, r); });
  const report = vm.runInContext('unifyTitles(R, E)', Object.assign(ctx, { R: copy, E: existing || [] }));
  return copy.map(function (r) { return r.course + ' ' + r.section + ' | ' + r.title + (r.titleOptions ? ' | ask: ' + r.titleOptions.join(' / ') : ''); })
    .concat(report.fixed.map(function (f) { return 'fixed: ' + f.from + ' → ' + f.to; }));
}

const unifyCases = [
  {
    name: '课名统一：两个写对、一个认错（Linsar）→ 自动改成多数',
    run: function () {
      return fromUnify([
        { course: 'CASMA 242', section: 'LEC', title: 'Linear Algebra' },
        { course: 'CASMA 242', section: 'DIS', title: 'Linsar Algebra' },
        { course: 'CASMA 242', section: 'LAB', title: 'Linear Algebra' }
      ]);
    },
    expect: ['CASMA 242 DIS | Linear Algebra', 'CASMA 242 LAB | Linear Algebra', 'CASMA 242 LEC | Linear Algebra', 'fixed: Linsar Algebra → Linear Algebra']
  },
  {
    name: '课名统一：一对一打平 → 不猜，让用户选',
    run: function () {
      return fromUnify([
        { course: 'CASMA 242', section: 'LEC', title: 'Linear Algebra' },
        { course: 'CASMA 242', section: 'DIS', title: 'Linsar Algebra' }
      ]);
    },
    expect: ['CASMA 242 DIS | Linsar Algebra | ask: Linear Algebra / Linsar Algebra', 'CASMA 242 LEC | Linear Algebra | ask: Linear Algebra / Linsar Algebra']
  },
  {
    name: '课名统一：课表里已经有这门课 → 用课表里的',
    run: function () {
      return fromUnify([
        { course: 'CASMA 242', section: 'LEC', title: 'Linear Algebra' },
        { course: 'CASMA 242', section: 'DIS', title: 'Linsar Algebra' }
      ], [{ course: 'CASMA 242', title: 'Linear Algebra' }]);
    },
    expect: ['CASMA 242 DIS | Linear Algebra', 'CASMA 242 LEC | Linear Algebra', 'fixed: Linsar Algebra → Linear Algebra']
  },
  {
    name: '课名统一：完全不同的主题（专题课）不动',
    run: function () {
      return fromUnify([
        { course: 'CASCS 591', section: 'A1', title: 'Topics: Robotics' },
        { course: 'CASCS 591', section: 'B1', title: 'Topics: Cryptography' }
      ]);
    },
    expect: ['CASCS 591 A1 | Topics: Robotics', 'CASCS 591 B1 | Topics: Cryptography']
  }
];
unifyCases.forEach(function (c) { c.run = (function (run) { return function () { return { raw: run() }; }; })(c.run); });
cases.push.apply(cases, unifyCases);

let failed = 0;
cases.forEach(function (c) {
  let actual;
  try {
    const out = c.run();
    actual = out.raw ? out.raw.slice().sort() : summarize(out);
  } catch (error) {
    actual = ['ERROR: ' + error.message];
  }
  const expected = c.expect.slice().sort();
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '✓ ' : '✗ ') + c.name);
  if (!ok) {
    failed++;
    console.log('    expected:\n      ' + expected.join('\n      '));
    console.log('    actual:\n      ' + actual.join('\n      '));
  }
});
console.log(failed === 0 ? `\nAll ${cases.length} passed.` : `\n${failed} of ${cases.length} failed.`);
process.exit(failed === 0 ? 0 : 1);

