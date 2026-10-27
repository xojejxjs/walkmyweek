// my-week.js：课间步行分析
//
// 导入课表以后，自动找出每天"上完一节、接着上下一节"的两节课，
// 算出课间有几分钟、走过去要几分钟，判断来不来得及（🟢 / 🟡 / 🔴）
// 用户不用自己去 Directions 里一对一对地选

const LONG_BREAK_MINUTES = 60; // 课间超过这么久，就不算"赶课"，收进折叠区

// 最近一次算出来的步行列表：点某一行时，按行上的编号（data-walk）找到是哪一段
let shownWalks = [];

// 找出一周里所有"相邻两节课"之间的步行
// 输入：所有课（myClasses.items）
// 输出：{ walks, checked, unchecked }
//   walks：[{ from, to, days, gap, kind, route }]，已经排好序（最需要注意的在最上面）
//     kind：'clash'（时间冲突）、'same'（同一栋楼）、'long'（课间很长）、'walk'（要走过去）
//     route：只有 kind 是 'walk' 时才有，是 judgeRoute 的结果 { meters, minutes, verdict, isEstimate }
//   checked：检查了的课（确定了地点、有时间和星期）
//   unchecked：没法检查的课（还没有地点，或者没有上课时间 / 星期）
function findClassWalks(items) {
  const checkable = [];
  const unchecked = [];
  items.forEach(function (c) {
    if (c.status === 'skipped' || c.draft) {
      return; // 用户自己跳过的课、正在手动添加还没保存的课，不算，也不提
    }
    if (c.status === 'confirmed' && c.place && c.start != null && c.end != null && c.days.length > 0) {
      checkable.push(c);
    } else {
      unchecked.push(c);
    }
  });

  // 1. 每天把课按开始时间排好，取相邻的两节
  const walks = [];
  const singleDays = []; // 只有 1 节课的日子：那天没有路可走，要告诉用户
  DAY_ORDER.forEach(function (day) {
    const today = checkable
      .filter(function (c) { return c.days.includes(day); })
      .sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    if (today.length === 1) {
      singleDays.push(day);
    }

    for (let i = 1; i < today.length; i++) {
      const prev = today[i - 1];
      const next = today[i];
      const gap = next.start - prev.end;

      // 2. 同一对课、同样的课间：每周出现在好几天（比如周一三五），合成一行
      const same = walks.find(function (w) {
        return w.from === prev && w.to === next && w.gap === gap;
      });
      if (same) {
        same.days.push(day);
      } else {
        walks.push(describeWalk(prev, next, gap, day));
      }
    }
  });

  // 3. 排序：冲突 → 🔴 → 🟡 → 🟢 → 课间很长；同一级里，按星期和时间
  walks.sort(function (a, b) {
    return walkRank(a) - walkRank(b) ||
      DAY_ORDER.indexOf(a.days[0]) - DAY_ORDER.indexOf(b.days[0]) ||
      a.from.end - b.from.end;
  });

  return { walks: walks, checked: checkable, unchecked: unchecked, singleDays: singleDays };
}

// 判断一对相邻的课属于哪种情况
// 输入：前一节课、后一节课、课间分钟数、星期几
// 输出：{ from, to, days, gap, kind, route }
function describeWalk(prev, next, gap, day) {
  const walk = { from: prev, to: next, days: [day], gap: gap, kind: 'walk', route: null };
  if (gap < 0) {
    walk.kind = 'clash';  // 后一节在前一节下课之前就开始了
  } else if (prev.place.id === next.place.id) {
    walk.kind = 'same';   // 同一栋楼，不用走
  } else if (gap > LONG_BREAK_MINUTES) {
    walk.kind = 'long';   // 课间很长，不用赶
  } else {
    // 和 Directions 用同一套规则：先查表，查不到就直线估算（isEstimate）
    walk.route = judgeRoute(measureRoute(prev.place, next.place), gap);
  }
  return walk;
}

// ===== 按星期看 =====

const DAY_FULL_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

// 某一天的课和课间的路
// 输入：检查了的课（findClassWalks 的 checked）、星期几（'Wed'）
// 输出：{ classes, walks }
//   classes：那天的课，按上课时间排好
//   walks：walks[i] 是 classes[i] → classes[i + 1] 的那段路（describeWalk 的结果，和 All week 一样的判断）
function dayPlan(checked, day) {
  const classes = checked
    .filter(function (c) { return c.days.includes(day); })
    .sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  const walks = [];
  for (let i = 1; i < classes.length; i++) {
    walks.push(describeWalk(classes[i - 1], classes[i], classes[i].start - classes[i - 1].end, day));
  }
  return { classes: classes, walks: walks };
}

// 地图上的顺序编号：1 → ①，2 → ② …（20 以后直接写数字）
function stopNumber(n) {
  return n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n);
}

// 选了某一天时，地图上每栋楼要显示的编号：{ 地点 id: ['①', '③'] }（同一栋楼一天去两次就有两个编号）
// 没选（All week）时返回 null
function dayStops() {
  if (!myClasses.day) {
    return null;
  }
  const stops = {};
  dayPlan(findClassWalks(myClasses.items).checked, myClasses.day).classes.forEach(function (c, i) {
    stops[c.place.id] = (stops[c.place.id] || []).concat([stopNumber(i + 1)]);
  });
  return stops;
}

// 最上面的一排：All week | Mon Tue Wed Thu Fri（周六、周日有课才显示）
function renderDayPicker(checked) {
  const days = DAY_ORDER.filter(function (day) {
    const weekend = day === 'Sat' || day === 'Sun';
    return !weekend || checked.some(function (c) { return c.days.includes(day); });
  });
  let html = '<div class="day-picker" role="group" aria-label="Show one day">';
  html += `<button type="button" class="day-button" data-day="" aria-pressed="${!myClasses.day}">All week</button>`;
  days.forEach(function (day) {
    const count = checked.filter(function (c) { return c.days.includes(day); }).length;
    // 那天没课：按钮变灰，但还是能点（点了会说"那天没课"）
    html += `<button type="button" class="day-button${count === 0 ? ' day-empty' : ''}" data-day="${day}" ` +
      `aria-pressed="${myClasses.day === day}" title="${DAY_FULL_NAMES[day]}: ${count} ${count === 1 ? 'class' : 'classes'}">${day}</button>`;
  });
  return html + '</div>';
}

// 选了某一天：按时间顺序列出那天的课，课和课之间是那段路
function renderDayPlan(result) {
  const day = myClasses.day;
  const plan = dayPlan(result.checked, day);
  shownWalks = plan.walks;

  let html = `<div class="day-head"><h4>${DAY_FULL_NAMES[day]}` +
    (plan.classes.length > 0 ? ` · ${plan.classes.length} ${plan.classes.length === 1 ? 'class' : 'classes'}` : '') +
    '</h4><button type="button" class="link-button" data-day="">← Back to all week</button></div>';

  if (plan.classes.length === 0) {
    html += `<p class="hint">No classes on ${DAY_FULL_NAMES[day]}.</p>`;
  } else {
    // 一行总结（课间很长的不算"赶课"，和 All week 一样）
    const urgent = plan.walks.filter(function (w) { return w.kind !== 'long'; });
    if (urgent.length > 0) {
      html += renderWalkSummary(urgent);
    } else if (plan.walks.length === 0) {
      html += '<p class="hint">Only 1 class that day, so nothing to walk.</p>';
    }
    html += '<ol class="day-plan">';
    plan.classes.forEach(function (c, i) {
      // 左边是顺序编号（和地图上的 ①②③ 一样），右边第一行时间、第二行课名和教室
      html += `<li class="day-class"><span class="day-stop">${stopNumber(i + 1)}</span><div>` +
        `<span class="day-time">${escapeHtml(formatClock(c.start))} – ${escapeHtml(formatClock(c.end))}</span>` +
        `<strong translate="no">${escapeHtml(c.title)}</strong> <span class="walk-where" translate="no">${escapeHtml(classWhere(c))}</span></div>` +
        `<button type="button" class="directions-button" data-directions="${c.id}">Directions ›</button></li>`;
      if (i < plan.walks.length) {
        html += renderDayWalk(plan.walks[i], i);
      }
    });
    html += '</ol>';
    if (plan.walks.length > 0) {
      html += '<p class="hint">Tap a walk to see the route on the map, then open it in your maps app.</p>';
    }
  }

  // 那天有课但还不知道在哪：说出来，不然用户会以为那天就这几节
  const missing = result.unchecked.filter(function (c) { return c.days && c.days.includes(day); });
  if (missing.length > 0) {
    html += `<p class="hint walk-unchecked">${uncheckedSummary(missing)} to be included.
      <button type="button" class="link-button" data-action="fix-unchecked">Add</button></p>`;
  }
  return html;
}

// 时间线里两节课之间的那段路：比 All week 的一行短（星期和课名上下已经有了）
function renderDayWalk(walk, index) {
  let icon;
  let color;
  let detail;
  if (walk.kind === 'clash') {
    icon = '⚠️';
    color = 'clash';
    detail = `Time clash: these overlap by ${-walk.gap} min`;
  } else if (walk.kind === 'same') {
    icon = '🟢';
    color = 'green';
    detail = `${walk.gap} min break · same building, no walk needed`;
  } else if (walk.kind === 'long') {
    icon = '🟢';
    color = 'long';
    detail = longBreakText(walk);
  } else {
    const route = walk.route;
    icon = { green: '🟢', yellow: '🟡', red: '🔴' }[route.verdict];
    color = route.verdict;
    detail = `${walk.gap} min break · ~${route.minutes} min walk${route.isEstimate ? ' (estimate)' : ''} · ${spareText(walk.gap - route.minutes)}`;
  }
  const content = `<span class="walk-detail">↓ ${icon} ${escapeHtml(detail)}</span>`;
  // 时间冲突：没有课间可以走，不能点
  if (walk.kind === 'clash') {
    return `<li class="day-walk"><div class="walk-row walk-${color}">${content}</div></li>`;
  }
  return `<li class="day-walk"><button type="button" class="walk-row walk-${color}" data-walk="${index}">${content}` +
    '<span class="walk-show">Show route on map ›</span></button></li>';
}

// 换一天（或者回到 All week）
// 输入：'Wed'，或者 null 表示 All week
function pickDay(day) {
  if (day === myClasses.day) {
    return;
  }
  myClasses.day = day;
  logEvent('day-pick');
  // 之前画的路线可能不是这一天的：去掉，免得看错
  clearRouteLine();
  selectClassPlace(null);
  renderMyClasses(); // 时间线和地图（只显示那天的楼、加编号）一起更新
}

// 课间很长的那一行：不用赶，但还是告诉用户要走多久
// 输出："1 hr 20 min break · ~15 min walk"
function longBreakText(walk) {
  const route = measureRoute(walk.from.place, walk.to.place);
  return `${formatBreak(walk.gap)} break · ~${Math.ceil(route.minutes)} min walk${route.isEstimate ? ' (estimate)' : ''}`;
}

// ===== 怎么走到一门课（从宿舍、我现在的位置……） =====

// Directions 下面的 "← Back to …" 要回到哪里：null 是不显示；{ day: 'Wed' } 或 { day: null }（All week）
let routeBack = null;

// 输入：null，或者 { day }
function setRouteBack(target) {
  routeBack = target;
  const button = document.getElementById('route-back');
  if (!target) {
    button.hidden = true;
    return;
  }
  button.textContent = target.day ? `← Back to ${DAY_FULL_NAMES[target.day]}` : '← Back to My week';
  button.hidden = false;
}

// 点了某门课的 "Directions ›"：切到 Directions，To 填好这门课，From 让用户选
// 课一般是终点（"我能不能准时到课"），很少是起点；配合 📍 就是：点课 → 点 📍 → Open in Google Maps
// 用户不用记课名、不用再打一遍
// 输入：那门课、从哪一天的时间线点的（null 表示从 My classes 列表点的）
function directionsToClass(c, day) {
  const from = document.getElementById('from-input');
  const to = document.getElementById('to-input');
  to.value = myClassLabel(c);
  // From 已经是"我现在的位置"就留着（直接出结果）；否则清空，下面会出现 📍 和常去的地方
  if (from.value !== MY_LOCATION_LABEL) {
    from.value = '';
  }
  logEvent('directions-to-class');
  setRouteBack({ day: day });
  showTab('route');
  to.dispatchEvent(new Event('change'));
  // 电脑上直接把光标放进 From；手机上不放，免得键盘弹出来挡住 📍 和常去的地方
  if (!isPhoneLayout() && from.value === '') {
    from.focus();
  }
}

// "← Back to Wednesday"：回到 My week 刚才看的那一天
function returnFromRoute() {
  const target = routeBack;
  setRouteBack(null);
  if (!target) {
    return;
  }
  if (target.day !== myClasses.day) {
    pickDay(target.day);
  }
  showTab('week');
  document.getElementById('class-walks').scrollIntoView({ block: 'start' });
}

// 排序用的等级：数字越小越靠前
function walkRank(walk) {
  if (walk.kind === 'clash') {
    return 0;
  }
  if (walk.kind === 'walk') {
    return { red: 1, yellow: 2, green: 3 }[walk.route.verdict];
  }
  if (walk.kind === 'same') {
    return 3; // 和 🟢 同一级
  }
  return 4;   // 'long'
}

// ===== 显示 =====

// 在 My classes 下面显示 "Your walks between classes"
// renderMyClasses() 每次最后都会调用它，所以课表一变，这里就重新算
function renderClassWalks() {
  const box = document.getElementById('class-walks');
  closeBreakPlanner(); // 整个列表要重画：打开着的课间规划也一起收起（规划已经存下来了）
  const result = findClassWalks(myClasses.items);
  shownWalks = result.walks;

  // 还没有课（或者全都跳过了）：什么都不显示
  if (result.checked.length === 0 && result.unchecked.length === 0) {
    box.innerHTML = '';
    return;
  }

  const urgent = result.walks.filter(function (w) { return w.kind !== 'long'; });
  const long = result.walks.filter(function (w) { return w.kind === 'long'; });

  let html = '<h3>Your walks between classes</h3>';

  // 按星期看：有能检查的课才显示这一排按钮
  if (result.checked.length > 0) {
    html += renderDayPicker(result.checked);
  } else {
    myClasses.day = null; // 课都没了（或者都没地点）：回到 All week
  }
  if (myClasses.day) {
    box.innerHTML = html + renderDayPlan(result);
    return;
  }

  if (result.walks.length > 0) {
    // 先给结论：一行总结，一眼看出有没有问题
    html += renderWalkSummary(urgent);
    html += `<p class="hint">Each day, from one class to the next. 🟢 means at least ${BUFFER_MINUTES} min to spare.</p>`;
  } else if (result.checked.length > 0) {
    // 每天都只有 1 节课时，下面"只有 1 节课"那一行已经说清楚了，这句就不用了
    if (result.singleDays.length === 0) {
      html += '<p class="hint">No back-to-back classes on the same day, so there are no walks to check.</p>';
    }
  } else {
    // 一门课都还没法检查：不列一长串课名，只说缺什么、给一个按钮去补
    html += renderUncheckedEmpty(result.unchecked);
  }

  // 1. 要注意的：冲突、🔴、🟡、🟢（已经按这个顺序排好）
  if (urgent.length > 0) {
    html += '<ul class="walk-list">' + urgent.map(renderWalkRow).join('') + '</ul>';
    html += '<p class="hint">Tap a walk to see the route on the map, then open it in your maps app.</p>';
  }

  // 2. 课间很长的：不用赶，折叠起来
  if (long.length > 0) {
    html += `<details class="walk-long"><summary>Longer breaks, over ${LONG_BREAK_MINUTES} min (${long.length})</summary>
      <ul class="walk-list">${long.map(renderWalkRow).join('')}</ul></details>`;
  }

  // 3. 只有 1 节课的日子：说出来，不然用户会以为少算了 walk
  if (result.singleDays.length > 0) {
    html += `<p class="hint walk-single">${result.singleDays.join(', ')}: only 1 class that day, so nothing to walk.</p>`;
  }

  // 4. 有一部分课还没法检查：一行说清楚有几门、缺什么，不然用户会以为"没显示 = 没问题"
  if (result.unchecked.length > 0 && result.checked.length > 0) {
    html += `<p class="hint walk-unchecked">${uncheckedSummary(result.unchecked)} to be included.
      <button type="button" class="link-button" data-action="fix-unchecked">Add</button></p>`;
  }

  box.innerHTML = html;
}

// 一行：星期和时间 / 从哪门课 / 到哪门课 / 课间多久、走多久、结论
function renderWalkRow(walk) {
  const from = walk.from;
  const to = walk.to;
  const days = walk.days.join(', ');

  let icon;
  let color;
  let when = `${formatClock(from.end)} → ${formatClock(to.start)}`;
  let detail;

  if (walk.kind === 'clash') {
    icon = '⚠️';
    color = 'clash';
    when = `${formatClock(from.start)}–${formatClock(from.end)} and ${formatClock(to.start)}–${formatClock(to.end)}`;
    detail = `Time clash: these overlap by ${-walk.gap} min`;
  } else if (walk.kind === 'same') {
    icon = '🟢';
    color = 'green';
    detail = `${walk.gap} min break · same building, no walk needed`;
  } else if (walk.kind === 'long') {
    icon = '🟢';
    color = 'long';
    detail = longBreakText(walk);
  } else {
    const route = walk.route;
    icon = { green: '🟢', yellow: '🟡', red: '🔴' }[route.verdict];
    color = route.verdict;
    // 估算要说清楚，不能让它看起来像真实路线
    const walkText = `~${route.minutes} min walk${route.isEstimate ? ' (estimate)' : ''}`;
    detail = `${walk.gap} min break · ${walkText} · ${spareText(walk.gap - route.minutes)}`;
  }

  const content = `
      <span class="walk-when">${icon} ${escapeHtml(days)} · ${escapeHtml(when)}</span>
      <strong translate="no">${escapeHtml(from.title)} <span class="walk-where">${escapeHtml(classWhere(from))}</span></strong>
      <strong translate="no">→ ${escapeHtml(to.title)} <span class="walk-where">${escapeHtml(classWhere(to))}</span></strong>
      <span class="walk-detail">${escapeHtml(detail)}</span>`;

  // 时间冲突：没有课间可以走，不能点
  if (walk.kind === 'clash') {
    return `<li><div class="walk-row walk-${color}">${content}</div></li>`;
  }
  // 其他的做成按钮：点了在 Directions 里显示这段路（用 button，键盘 Tab + 回车也能用）
  const index = shownWalks.indexOf(walk);
  return `<li><button type="button" class="walk-row walk-${color}" data-walk="${index}">${content}
      <span class="walk-show">Show route on map ›</span></button></li>`;
}

// 点了某一行：Directions 里填好这两节课和课间分钟数，地图上画出路线，然后滚到结果
function handleWalkClick(event) {
  if (event.target.closest('[data-action="fix-unchecked"]')) {
    // 缺教室：一次补完；只缺时间或星期：打开那门课改
    if (coursesNeedingRooms().length > 0) {
      openRoomsDialog();
    } else {
      openFirstUnchecked();
    }
    return;
  }
  // 星期按钮、"← Back to all week"：data-day 是空的就是 All week
  const dayButton = event.target.closest('button[data-day]');
  if (dayButton) {
    pickDay(dayButton.dataset.day || null);
    return;
  }
  // 时间线里的 "Directions ›"：怎么走到这节课
  const directions = event.target.closest('button[data-directions]');
  if (directions) {
    const c = myClasses.items.find(function (item) { return item.id === Number(directions.dataset.directions); });
    if (c) {
      directionsToClass(c, myClasses.day);
    }
    return;
  }
  const row = event.target.closest('button[data-walk]');
  if (!row) {
    return;
  }
  const walk = shownWalks[Number(row.dataset.walk)];
  if (!walk) {
    return;
  }
  // 在地图上画出这段路（Directions 也会填好，切过去就能看到详细结果）
  // 留在 My week 里不跳走：这一行本身已经写了结论；地图在旁边（手机上在上面）
  fillRouteCheck(walk.from, walk.to);
  // 上一段选中的：取消选中，收起它下面的 "Open in Google Maps"
  document.querySelectorAll('#class-walks .walk-row.selected').forEach(function (el) {
    el.classList.remove('selected');
  });
  closeBreakPlanner(); // 换了一段路：上一段的课间规划也收起来
  document.querySelectorAll('#class-walks .walk-open').forEach(function (el) {
    el.parentElement.classList.remove('walk-expanded');
    el.remove();
  });
  row.classList.add('selected');
  showOpenInMaps(row, walk);
}

// 点了一段路：这一行下面展开 "Open in Google Maps › · Apple Maps ›"（渐进式展示：用户表现出兴趣时才给下一步）
// 一次只有一行展开，页面平时保持干净
// 链接不能放进 <button> 里（HTML 不允许，手机上点击会出问题），所以放在按钮下面，样式上接成一张卡片
// 输入：那一行的按钮、那段路
function showOpenInMaps(row, walk) {
  // 同一栋楼：没有路可以导航，但课间还是可以规划（比如中间去吃饭）
  const links = walk.kind === 'same' ? '' : renderOpenInMaps(walk.from.place, walk.to.place); // app.js，和 Directions 结果卡片底部一模一样
  // 课间有空余时间：可以规划中间去哪（gap-planner.js）
  const plan = canPlanBreak(walk) ? renderPlanBreakButton(walk) : '';
  if (!links && !plan) {
    return;
  }
  const color = Array.from(row.classList).find(function (name) { return name.indexOf('walk-') === 0 && name !== 'walk-row'; });
  const box = document.createElement('div');
  box.className = 'walk-row walk-open ' + (color || '');
  box.innerHTML = links + plan;
  row.after(box);
  row.parentElement.classList.add('walk-expanded');
}

// 一行总结：🔴 1 can't make · 🟡 1 tight · 🟢 2 fine（还有时间冲突的话也写上）
// 每一项数的是"一行"，也就是同一对课（一周里重复的算一行）
function renderWalkSummary(walks) {
  function count(test) {
    return walks.filter(test).length;
  }
  const clash = count(function (w) { return w.kind === 'clash'; });
  const red = count(function (w) { return w.kind === 'walk' && w.route.verdict === 'red'; });
  const yellow = count(function (w) { return w.kind === 'walk' && w.route.verdict === 'yellow'; });
  const green = count(function (w) { return w.kind === 'same' || (w.kind === 'walk' && w.route.verdict === 'green'); });

  const parts = [];
  if (clash > 0) {
    parts.push(`<span class="summary-item summary-clash">⚠️ ${clash} time ${clash === 1 ? 'clash' : 'clashes'}</span>`);
  }
  parts.push(`<span class="summary-item summary-red">🔴 ${red} can't make</span>`);
  parts.push(`<span class="summary-item summary-yellow">🟡 ${yellow} tight</span>`);
  parts.push(`<span class="summary-item summary-green">🟢 ${green} fine</span>`);
  return `<p class="walk-summary">${parts.join('')}</p>`;
}

// 只需要绑定一次：#class-walks 里面的内容每次都会重画，但它本身不变（事件委托）
function initClassWalks() {
  document.getElementById('class-walks').addEventListener('click', handleWalkClick);
}

// 走到以后还剩几分钟 → 一句话（和 judgeRoute 用的是同一个"剩余分钟"）
function spareText(spare) {
  if (spare < 0) {
    return `${-spare} min late`;
  }
  if (spare === 0) {
    return 'just on time';
  }
  return `${spare} min to spare`;
}

// 145 → "2 hr 25 min"；不到 1 小时就只写分钟
function formatBreak(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) {
    return `${m} min`;
  }
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

// 没法检查的课 → 很短的一句："3 courses need a room"、"2 courses need a room or time"
// 同一门课的几个时段（LEC / DIS、每周几次）只算一门；不列课名（下面 My classes 里都有）
function uncheckedSummary(unchecked) {
  const courses = new Set(unchecked.map(function (c) { return (c.course || c.title).toUpperCase(); })).size;
  const allNoRoom = unchecked.every(function (c) { return uncheckedReason(c) === 'no location yet'; });
  const what = allNoRoom ? 'a room' : 'a room or time';
  return `${courses} ${courses === 1 ? 'course needs' : 'courses need'} ${what}`;
}

// 一门课都还不能检查时：一行字 + 一个按钮，用户不用读就知道下一步
function renderUncheckedEmpty(unchecked) {
  const allNoRoom = unchecked.every(function (c) { return uncheckedReason(c) === 'no location yet'; });
  return `<div class="walks-empty">
      <span class="walks-empty-title">📍 ${allNoRoom ? 'Add rooms to see your walks' : 'A few details missing'}</span>
      <button type="button" class="small-button" data-action="fix-unchecked">${allNoRoom ? 'Add rooms' : 'Fix'}</button>
    </div>`;
}

// 点了"Add rooms / Fix"：打开第一门还没法检查的课，滚过去
function openFirstUnchecked() {
  const result = findClassWalks(myClasses.items);
  const first = result.unchecked.slice().sort(compareMeetings)[0];
  if (!first) {
    return;
  }
  myClasses.openId = first.id;
  renderMyClasses();
  const card = document.querySelector(`#schedule-list [data-id="${first.id}"]`);
  if (card) {
    if (typeof updateConfirmButton === 'function' && card.classList.contains('editing')) {
      updateConfirmButton(card);
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// 为什么这门课没法检查
function uncheckedReason(c) {
  if (c.status !== 'confirmed' || !c.place) {
    return 'no location yet';
  }
  if (c.start == null || c.end == null) {
    return 'no class time';
  }
  return 'no class days';
}
