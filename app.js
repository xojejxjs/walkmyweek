// app.js：主业务逻辑
// 以后会在这里：读取 data.json → 读取用户选择 → 调用距离函数 → 排序 → 更新网页

console.log('app.js loaded');

// 读取 data.json，并返回里面的数据
// async 表示这个函数里有"需要等待"的操作（读文件需要时间）
async function loadData() {
  const response = await fetch('data.json?v=' + APP_VERSION); // 1. 向服务器请求 data.json 这个文件
  const data = await response.json();        // 2. 把文件里的文字解析成 JavaScript 对象
  return data;
}

// 读取 shapes.json（建筑轮廓）。这个文件只是锦上添花：
// 读不到也不影响网站其他功能，所以出错时返回空对象，而不是让整个页面报错
async function loadShapes() {
  try {
    const response = await fetch('shapes.json?v=' + APP_VERSION);
    if (!response.ok) {
      return {};
    }
    return await response.json();
  } catch (error) {
    console.log('shapes.json not loaded, using circles instead');
    return {};
  }
}

// 把一个宿舍的信息显示到左侧 #dorm-info 区域
// 输入：一个 dorm 对象
// 输出：网页上 #dorm-info 的内容被替换
function showDormInfo(dorm) {
  logEvent('dorm-open'); // 统计：看了一个宿舍的详情（不记是哪个）
  // 宿舍详情在 Find a dorm 标签页里（比如在 My week 里点了地图上的宿舍，要切过去才看得到）
  showTab('dorm');

  // 1. 在网页里找到要修改的那个元素
  const infoBox = document.getElementById('dorm-info');

  // 2. 有些字段可能是空字符串 ""，空的就显示"暂无"，不放一个坏链接
  let imageHtml = '';
  if (dorm.image_url) {
    imageHtml = `<img src="${dorm.image_url}" alt="${dorm.name}">`;
  }

  let floorPlanHtml = 'Not available';
  if (dorm.floor_plan_url) {
    floorPlanHtml = `<a href="${dorm.floor_plan_url}" target="_blank">View floor plan</a>`;
  }

  let tourHtml = 'Not available';
  if (dorm.tour_360_url) {
    tourHtml = `<a href="${dorm.tour_360_url}" target="_blank">Open tour</a>`;
  }

  // 设施：数组为空或者根本没有这个字段时，这一行整个不显示
  let amenitiesHtml = '';
  if (dorm.amenities && dorm.amenities.length > 0) {
    amenitiesHtml = `<p><strong>Amenities:</strong> ${dorm.amenities.join(', ')}</p>`;
  }

  // 分楼：有才显示
  let unitsHtml = '';
  if (dorm.units && dorm.units.length > 0) {
    unitsHtml = `<p><strong>Buildings:</strong> ${keepOriginal(dorm.units.join(', '))}</p>`;
  }

  // 覆盖的地址（Bay State Road 这类"一个点代表一段街"的宿舍）：只写门牌号的范围，比如 "153–214 Bay State Rd"
  // 一个一个的地址还留在 data.json 里，搜索 "188 Bay State Road" 照样能找到，只是不全部列出来
  let addressesHtml = '';
  if (dorm.addresses && dorm.addresses.length > 0) {
    addressesHtml = `<p><strong>Addresses:</strong> ${keepOriginal(dorm.address)}</p>`;
  }

  // 官方页面：有才显示
  let officialHtml = '';
  if (dorm.official_url) {
    officialHtml = `<p><a href="${dorm.official_url}" target="_blank">Official housing page →</a></p>`;
  }

  // 3. 拼出一段 HTML，替换掉元素原来的内容
  infoBox.innerHTML = `
    <h3 translate="no">${dorm.name}</h3>
    ${unitsHtml}
    ${imageHtml}
    ${addressesHtml}
    <p>${dorm.description}</p>
    <p><strong>Room types:</strong> ${dorm.room_types.join(', ')}</p>
    ${amenitiesHtml}
    <p><strong>Floor plan:</strong> ${floorPlanHtml}</p>
    <p><strong>Virtual tour:</strong> ${tourHtml}</p>
    ${officialHtml}
  `;
}

// 生成 From / To 共用的候选列表：只放正式名字，保持简洁
// 有分楼的宿舍（如 Warren）每座楼一条，名字和选宿舍系统一致
// 输入：dorms 数组、buildings 数组
// 输出：#place-options 里出现候选项
// 宿舍和教学楼的数据，存下来，课表变化时重新生成候选列表要用
let placeOptionData = { dorms: [], buildings: [] };

function renderPlaceOptions(dorms, buildings) {
  if (dorms && buildings) {
    placeOptionData = { dorms: dorms, buildings: buildings };
  }
  dorms = placeOptionData.dorms;
  buildings = placeOptionData.buildings;

  // 1. 自己课表里的课排在最前面：value 是课名（选中后填进输入框），label 是右边的小字说明在哪
  let html = '';
  getMyClassOptions().forEach(function (option) {
    html += `<option value="${escapeAttr(option.value)}" label="${escapeAttr(option.label)}"></option>`;
  });

  // 2. 然后是所有宿舍和教学楼
  dorms.forEach(function (dorm) {
    if (dorm.units && dorm.units.length > 0) {
      dorm.units.forEach(function (unit) {
        html += `<option value="${unit}"></option>`;
      });
    } else {
      html += `<option value="${dorm.name}"></option>`;
    }
  });
  buildings.forEach(function (building) {
    html += `<option value="${building.name}"></option>`;
  });
  document.getElementById('place-options').innerHTML = html;
}

// 根据 id 找到完整的地点对象
// 输入：places 数组、一个 id（例如 'cas'）
// 输出：id 相同的那个对象；找不到时是 undefined
function findPlaceById(places, id) {
  return places.find(function (place) {
    return place.id === id;
  });
}

const BUFFER_MINUTES = 3; // 缓冲时间：下课拖堂、收拾东西、找教室

// 计算两个地点之间的距离和步行时间（Step 8 和 Step 9 共用）
// 输入：起点对象、终点对象
// 输出：{ meters, minutes }
function measureRoute(fromPlace, toPlace) {
  // 1. 两个都是已知地点：查提前算好的真实步行时间表
  const real = lookupWalkTime(fromPlace.id, toPlace.id);
  if (real) {
    return { meters: real.meters, minutes: real.seconds / 60, isEstimate: false };
  }

  // 2. 有一个不在表里（比如用户输入的地址）：退回到直线估算
  const meters = getDistance(
    fromPlace.latitude, fromPlace.longitude,
    toPlace.latitude, toPlace.longitude
  );
  return { meters: meters, minutes: getWalkMinutes(meters), isEstimate: true };
}

// ===== 提前算好的真实步行时间表（walk-times.json，由 tools/fetch-walk-times.js 生成） =====

// 表的内容，以及"地点 id → 在表里第几行 / 第几列"的对照
let walkTable = null;
let walkTableIndex = {};

// 读取 walk-times.json。和 shapes.json 一样：读不到也不影响网站，只是全部退回到直线估算
async function loadWalkTimes() {
  try {
    const response = await fetch('walk-times.json?v=' + APP_VERSION);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.log('walk-times.json not loaded, using straight-line estimates');
    return null;
  }
}

// 保存表，并建立 id → 位置 的对照，查表时就不用每次在 ids 数组里找
function setWalkTable(table) {
  walkTable = table;
  walkTableIndex = {};
  if (table) {
    table.ids.forEach(function (id, i) {
      walkTableIndex[id] = i;
    });
  }
}

// 查两个地点之间的真实步行时间
// 输入：起点 id、终点 id
// 输出：{ seconds, meters }；表里没有（或者路线服务算不出来）时返回 null
function lookupWalkTime(fromId, toId) {
  if (!walkTable) {
    return null;
  }
  const i = walkTableIndex[fromId];
  const j = walkTableIndex[toId];
  if (i === undefined || j === undefined) {
    return null;
  }
  const seconds = walkTable.seconds[i][j];
  if (seconds === null) {
    return null;
  }
  return { seconds: seconds, meters: walkTable.meters[i][j] };
}

// 根据一条路线的距离和时间，判断来不来得及
// 单独拿出来，是因为时间有两个来源：measureRoute（查表 / 估算）和后端的真实路线，判断规则只写一份
// 输入：{ meters, minutes, isEstimate }、课间分钟数
// 输出：{ meters, minutes, verdict, isEstimate }
function judgeRoute(route, gapMinutes) {
  const meters = route.meters;
  // 先向上取整再判断：页面上显示的分钟数和判断用的分钟数永远是同一个，不会出现"显示 10 分钟却说够 9.5 分钟"
  const minutes = Math.ceil(route.minutes);

  // 走到以后还剩几分钟（负数就是会迟到）
  const spareMinutes = gapMinutes - minutes;

  let verdict;
  if (spareMinutes >= BUFFER_MINUTES) {
    verdict = 'green';   // 剩的时间 ≥ 缓冲时间（正好等于也算够）
  } else if (spareMinutes >= 0) {
    verdict = 'yellow';  // 能赶到但缓冲不够：剩 0 到 BUFFER_MINUTES - 1 分钟（正好卡点到也算这里）
  } else {
    verdict = 'red';     // 会迟到
  }

  return { meters: meters, minutes: minutes, verdict: verdict, isEstimate: route.isEstimate };
}

// 把结果显示到 #route-result
// Directions 只回答"走过去要多久"，不判断来不来得及（那是 My week 的事，课间分钟数来自课表）
// 所以卡片是中性的白色：🟢🟡🔴 只用来表示"来不来得及"
// 输入：measureRoute 的结果 { meters, minutes, isEstimate }、起点、终点
function showRouteResult(result, fromPlace, toPlace) {
  const box = document.getElementById('route-result');
  const minutes = Math.ceil(result.minutes);

  // 真实路线和估算要说清楚是哪一种，不能让估算看起来像真实数据
  const meta = result.isEstimate
    ? `~${formatDistance(result.meters)} straight-line · rough estimate, not a real route`
    : `${formatDistance(result.meters)} · along streets`;

  // 名字可能来自用户的课表文件或查到的地址：先转义再放进 innerHTML
  box.className = 'route-done';
  box.innerHTML = `
    <p class="route-minutes">${result.isEstimate ? '~' : ''}${minutes} min walk</p>
    <p class="route-meta">${escapeHtml(meta)}</p>
    <p class="route-ends" translate="no">${escapeHtml(fromPlace.name)} → ${escapeHtml(toPlace.name)}</p>
    ${renderOpenInMaps(fromPlace, toPlace)}
  `;
}

// ===== 交给真正的导航软件 =====
// 逐步导航（"前方左转"、走错路重新规划）Google / Apple Maps 已经做得很好，我们不重做：
// 用户真的要走的时候，一键打开地图 App，起点、终点、步行模式都填好

// 苹果设备（iPhone、iPad、Mac）才显示 Apple Maps
function isApplePlatform() {
  return /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
}

// 地点 → "纬度,经度"（有入口坐标就用入口，和步行时间表一致）
function placeCoords(place) {
  const point = place.entrance || [place.latitude, place.longitude];
  return point[0].toFixed(6) + ',' + point[1].toFixed(6);
}

// 输出：两个链接的 HTML；起点是"我现在的位置"时不写起点，导航软件会用手机的实时位置（走路时会跟着更新）
function renderOpenInMaps(fromPlace, toPlace) {
  const to = placeCoords(toPlace);
  const google = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' + to +
    (fromPlace.isMyLocation ? '' : '&origin=' + placeCoords(fromPlace));
  let html = `<p class="route-open"><a href="${google}" target="_blank" rel="noopener" data-open-maps="google">Open in <span translate="no">Google Maps</span> ›</a>`;
  if (isApplePlatform()) {
    const apple = 'https://maps.apple.com/?dirflg=w&daddr=' + to +
      (fromPlace.isMyLocation ? '' : '&saddr=' + placeCoords(fromPlace));
    html += `<a href="${apple}" target="_blank" rel="noopener" data-open-maps="apple">Open in <span translate="no">Apple Maps</span> ›</a>`;
  }
  return html + '</p>';
}

// ===== 从我现在的位置出发 =====
// 只在用户点了 "📍 Use my location" 以后才问浏览器要位置；打开网站时绝不问
// 位置只存在这个页面里：蓝点、直线估算都在浏览器里算；画沿街道的路线时会发给我们的后端（不保存）

const MY_LOCATION_LABEL = '📍 Your location'; // 输入框里显示的文字；看到它就代表"我现在的位置"
let myLocation = null;       // { latitude, longitude, accuracy }；还没定位时是 null
let locationWatchId = null;  // 正在跟踪位置时，watchPosition 返回的编号
let routePlaceIndex = null;  // main() 里存好，定位成功后要用它重新算路线

// From 或 To 里是不是"我现在的位置"
function locationInUse() {
  return [document.getElementById('from-input'), document.getElementById('to-input')].some(function (box) {
    return box.value === MY_LOCATION_LABEL;
  });
}

// 把"我现在的位置"变成和其他地点一样的对象，后面的计算、画线都能直接用
// kind 是 'location'：不在步行时间表里，所以先用直线估算，再问后端要真实路线（和输入地址一样）
function myLocationPlace() {
  return {
    id: 'my-location',
    name: 'Your location',
    latitude: myLocation.latitude,
    longitude: myLocation.longitude,
    kind: 'location',
    isMyLocation: true
  };
}

// 点了 "📍 Use my location"
function useMyLocation() {
  const button = document.getElementById('use-location');
  if (!navigator.geolocation) {
    showRouteMessage('This browser can’t share your location. Pick a place instead.');
    return;
  }
  button.disabled = true;
  button.textContent = '📍 Finding you…';
  showRouteMessage('Finding your location…');

  navigator.geolocation.getCurrentPosition(function (position) {
    button.disabled = false;
    button.textContent = '📍 Use my location';
    setMyLocation(position);
    logEvent('use-location'); // 只记"用了定位"这件事，绝不发送位置

    // 放进 From（如果 To 里已经是"我的位置"，就不动，免得两边一样）
    const from = document.getElementById('from-input');
    const to = document.getElementById('to-input');
    if (to.value !== MY_LOCATION_LABEL) {
      from.value = MY_LOCATION_LABEL;
    }
    startLocationWatch();
    // 还没选目的地：地图先移到你在的地方
    if (to.value.trim() === '') {
      map.setView([myLocation.latitude, myLocation.longitude], Math.max(map.getZoom(), 16));
      bringMapIntoView();
    }
    updateRoute(routePlaceIndex, true);
  }, function (error) {
    button.disabled = false;
    button.textContent = '📍 Use my location';
    // 每种失败都说清楚原因和下一步，不能什么都不显示
    const messages = {
      1: 'Location is off for this site. Turn it on in your browser settings, or pick a place instead.',
      2: 'Couldn’t find your location right now. Try again outdoors, or pick a place instead.',
      3: 'Finding your location took too long. Try again, or pick a place instead.'
    };
    showRouteMessage(messages[error.code] || messages[2]);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

function setMyLocation(position) {
  myLocation = {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy
  };
  showUserLocation(myLocation.latitude, myLocation.longitude, myLocation.accuracy);
}

// 走路时蓝点跟着动。路线不跟着重算：不然每走几步就要问一次后端；想更新就再点一次 📍
function startLocationWatch() {
  if (locationWatchId !== null || !navigator.geolocation) {
    return;
  }
  locationWatchId = navigator.geolocation.watchPosition(setMyLocation, function () {
    // 跟踪途中出错（比如进了楼里）：保留最后的位置，不打扰用户
  }, { enableHighAccuracy: true, maximumAge: 10000 });
}

// 不再跟踪：去掉蓝点，省电，也不会在用户不知道时一直拿位置
// 离开 Directions（tabs.js）、或者 From / To 都不是"我的位置"了（updateRoute）时调用
function stopLocationWatch() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
  clearUserLocation();
}

// 回到 Directions：如果还在用"我的位置"，重新显示蓝点并继续跟踪（已经允许过，不会再弹窗）
function resumeLocationIfUsed() {
  if (myLocation && locationInUse()) {
    showUserLocation(myLocation.latitude, myLocation.longitude, myLocation.accuracy);
    startLocationWatch();
  }
}

// ===== 常去的地方（To 下面的一排小按钮） =====

// 大家都会去的地点；label 是按钮上的短名字
const ROUTE_POPULAR = [
  { id: 'gsu', label: 'GSU' },
  { id: 'fitrec', label: 'FitRec' },
  { id: 'mugar', label: 'Mugar Library' },
  { id: 'dining_marciano', label: 'Marciano Commons' }
];
let routePopular = []; // main() 里根据 data.json 填好：[{ label, value }]

// 最近查过的目的地：只存在用户自己的浏览器里，读不到（隐私模式等）也没关系
const RECENT_KEY = 'bu-dorm-dash:recent-to';
const RECENT_MAX = 3;

function loadRecentDestinations() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string'; }).slice(0, RECENT_MAX) : [];
  } catch (error) {
    return [];
  }
}

// 输入：输入框里的文字（下次点按钮时原样填回去，一定找得到）
function rememberRecentDestination(text) {
  if (text === '') {
    return;
  }
  const list = loadRecentDestinations().filter(function (x) { return x.toLowerCase() !== text.toLowerCase(); });
  list.unshift(text);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch (error) {
    // 存不了就算了，只是下次没有"Recent"
  }
}

// 常去的地方：Recent（最近查过的）+ Popular（大家都会去的），显示在"空着的那一栏"下面
//   To 空着 → 显示在 To 下面，点了填进 To
//   To 填好了、From 空着（比如点了课的 "Directions"，课是终点）→ 显示在 From 下面，点了填进 From
//   两栏都填好了 → 收起来，不占地方
function renderRoutePicks() {
  const fromEmpty = document.getElementById('from-input').value.trim() === '';
  const toEmpty = document.getElementById('to-input').value.trim() === '';
  const slot = toEmpty ? 'to' : (fromEmpty ? 'from' : null);
  document.getElementById('route-picks').innerHTML = '';
  document.getElementById('from-picks').innerHTML = '';
  if (!slot) {
    return;
  }
  const box = document.getElementById(slot === 'to' ? 'route-picks' : 'from-picks');
  const recent = loadRecentDestinations();
  const popular = routePopular.filter(function (p) {
    return !recent.some(function (r) { return r.toLowerCase() === p.value.toLowerCase(); });
  });
  function chips(items) {
    return items.map(function (item) {
      return `<button type="button" class="pick-chip" translate="no" data-pick="${escapeAttr(item.value)}" data-slot="${slot}" title="${escapeAttr(item.value)}">${escapeHtml(item.label)}</button>`;
    }).join('');
  }
  let html = '';
  if (recent.length > 0) {
    // 最近去过的如果也是常去的地方（比如 GSU），按钮上用短名字
    const recentItems = recent.map(function (r) {
      const known = routePopular.find(function (p) { return p.value.toLowerCase() === r.toLowerCase(); });
      return { label: known ? known.label : r, value: r };
    });
    html += `<div class="pick-row"><span class="pick-label">Recent</span>${chips(recentItems)}</div>`;
  }
  if (popular.length > 0) {
    html += `<div class="pick-row"><span class="pick-label">Popular</span>${chips(popular)}</div>`;
  }
  box.innerHTML = html;
}

// 在结果区域显示一句提示（没选完、输入不对时用）
function showRouteMessage(text) {
  const box = document.getElementById('route-result');
  box.className = '';
  box.innerHTML = `<p class="placeholder">${text}</p>`;
}

// 识别课表上的"楼宇代码 + 教室号"，比如 "CAS 211"、"cds164"、"PHO-206"、"STO B50"
// 输入：用户输入的文字
// 输出：{ code: 'CAS', room: '211' }；不是这种格式时返回 null
function parseClassroom(text) {
  // 正则表达式：2～4 个字母（代码） + 可有可无的空格或横线 + 教室号（数字，前后可以带一个字母）
  const match = text.trim().match(/^([A-Za-z]{2,4})\s*-?\s*([A-Za-z]?\d{1,4}[A-Za-z]?)$/);
  if (!match) {
    return null;
  }
  return { code: match[1].toUpperCase(), room: match[2].toUpperCase() };
}

// 把一个输入框里的文字变成地点对象
// 查找顺序：1. 已登记的地点（宿舍、教学楼、别名、门牌号）  2. 都不是，就当成地址去查经纬度
// 输入：输入框元素、'from' 或 'to'、搜索索引、是否允许模糊查找
// 输出：找到的地点对象；空的或找不到时是 undefined
async function resolvePlaceInput(inputBox, slot, placeIndex, allowPartial) {
  const text = inputBox.value;
  if (text.trim() === '') {
    return undefined;
  }

  // "📍 Your location"：用户点了 Use my location
  if (text === MY_LOCATION_LABEL) {
    return myLocation ? myLocationPlace() : undefined;
  }

  // 自己课表里的课（从候选列表里选的课名，完全一样才算）
  const myClassExact = findMyClass(text, false);
  if (myClassExact) {
    return myClassExact;
  }

  // 课表格式（比如 "CAS 211"）：用代码找楼，教室号放进显示的名字里
  const classroom = parseClassroom(text);
  if (classroom) {
    // 按 data.json 里的官方楼宇代码找（完全一样才算）
    const building = findPlace(placeIndex, classroom.code, false);
    if (building) {
      // 复制一份楼的对象，只改名字；id 不变，所以地图上的点、判断"是不是两节课之间"都照常工作
      return Object.assign({}, building, { name: `${building.name}, room ${classroom.room}` });
    }
    // 是课表格式，但这个代码我们还没有收录：不要拿去当地址查（会查到奇怪的地方）
    return undefined;
  }

  const place = findPlace(placeIndex, text, allowPartial);
  if (place) {
    // 模糊查找到了（比如输入 "stuvi"）：把输入框改成正式名字，让用户确认找到的是哪个
    // 如果输入的本来就是某个完整名字（比如 "Warren Tower C - Shields"），就保持原样
    if (allowPartial && !findPlace(placeIndex, text, false)) {
      inputBox.value = place.name;
    }
    return place;
  }

  // 正在打字时不查地址（Nominatim 不允许边打字边查，也免得地图乱跳）
  if (!allowPartial) {
    return undefined;
  }

  // 打完了：地点里找不到，再看是不是自己某门课名字的一部分（比如 "calc" → Calculus 1）
  const myClassPartial = findMyClass(text, true);
  if (myClassPartial) {
    inputBox.value = myClassLabel(myClassPartial.myClass); // 改成完整课名，让用户确认找到的是哪门课
    return myClassPartial;
  }

  showRouteMessage(`Looking up "${escapeHtml(text)}"…`);
  const found = await geocodeAddress(text);
  if (!found) {
    return undefined;
  }

  // 造一个和 data.json 里格式一样的地点对象，后面的计算函数就能直接用
  return {
    id: 'address-' + slot,
    name: found.label,
    address: text,
    latitude: found.latitude,
    longitude: found.longitude,
    kind: 'address'
  };
}

// 每次计算路线都编一个号。查地址要等网络，等的时候用户可能又改了输入：
// 回来时如果编号已经不是最新的，说明这次结果过时了，直接丢掉
let routeRequestId = 0;

// 读取用户输入 → 检查 → 计算 → 显示
// 输入：搜索索引、是否允许模糊查找（正在打字时不允许，打完了才允许，免得地图跟着每个字母乱跳）
async function updateRoute(placeIndex, allowPartial) {
  const requestId = ++routeRequestId;

  const fromBox = document.getElementById('from-input');
  const toBox = document.getElementById('to-input');
  const fromPlace = await resolvePlaceInput(fromBox, 'from', placeIndex, allowPartial);
  const toPlace = await resolvePlaceInput(toBox, 'to', placeIndex, allowPartial);
  renderRoutePicks(); // To 空着时才显示"常去的地方"
  if (!locationInUse()) {
    stopLocationWatch(); // From / To 都换成别的地方了：不再跟踪位置
  }

  if (requestId !== routeRequestId) {
    return; // 等待期间又有新的输入，这次的结果作废
  }

  // 地址地点：在地图上放可拖动的大头针；拖完后记住新位置，并重新计算
  [[fromBox, 'from', fromPlace], [toBox, 'to', toPlace]].forEach(function ([box, slot, place]) {
    if (place && place.kind === 'address') {
      showAddressMarker(slot, place, function (lat, lng) {
        adjustGeocode(box.value, lat, lng);
        updateRoute(placeIndex, true);
      });
    } else {
      clearAddressMarker(slot);
    }
  });

  // 选中的起点、终点一定显示在地图上（没找到时是 undefined，pinPlace 会当作"没有"）
  pinPlace('from', fromPlace && fromPlace.id);
  pinPlace('to', toPlace && toPlace.id);

  // 先清掉旧的线；如果下面因为输入不完整提前 return，地图上就不会留下过时的线
  clearRouteLine();

  // 打完了但找不到：告诉用户是哪个没找到
  if (allowPartial) {
    const missing = [fromBox, toBox].find(function (box, i) {
      return box.value.trim() !== '' && [fromPlace, toPlace][i] === undefined;
    });
    if (missing && missing.value === MY_LOCATION_LABEL) {
      // 输入框里还留着"我的位置"，但这次打开页面还没定位过（比如刷新了页面）
      showRouteMessage('Tap “📍 Use my location” to find where you are.');
      return;
    }
    if (missing) {
      showRouteMessage(`Can't find "${escapeHtml(missing.value)}". Try a dorm or building name, or a street address near campus.`);
      return;
    }
  }

  if (!fromPlace || !toPlace) {
    // 只差一头时，提示具体一点（比如点了课的 "Directions"：终点有了，只差起点）
    let message = 'Choose a starting point and a destination to see the walking time.';
    if (fromPlace && !toPlace) {
      message = 'Now choose where you’re going — or tap a place above.';
    } else if (toPlace && !fromPlace) {
      message = 'Now choose where you’re starting from — tap 📍 or a place above.';
    }
    showRouteMessage(message);
    return;
  }
  if (fromPlace.id === toPlace.id) {
    // 两门课在同一栋楼（或者选了同一个地点）：不用走路，但地图上还是标出是哪栋楼
    showRouteMessage(`Both are in the same building (${keepOriginal(escapeHtml(fromPlace.code || fromPlace.name))}) — no walk needed.`);
    showRouteEnds(fromPlace, toPlace);
    focusRouteEnds();
    return;
  }
  // 第一轮：马上显示（已知地点查表，地址用直线估算；地图先画虚线）
  let result = measureRoute(fromPlace, toPlace);
  showRouteResult(result, fromPlace, toPlace);
  drawRouteLine(fromPlace, toPlace);

  // 打完了、算出了结果：记住起点和终点（自己的课、"我的位置"不算），下次排在"常去的地方"最前面
  // 先记起点再记终点：最近一次的终点排在最前
  if (allowPartial) {
    if (!fromPlace.myClass && !fromPlace.isMyLocation) {
      rememberRecentDestination(fromBox.value.trim());
    }
    if (!toPlace.myClass && !toPlace.isMyLocation) {
      rememberRecentDestination(toBox.value.trim());
    }
    renderRoutePicks();
  }

  // 第二轮：问后端要真实路线（后端不可用时返回 null，第一轮的结果就保留着）
  const real = await fetchRealRoute(fromPlace, toPlace);
  if (!real || requestId !== routeRequestId) {
    return; // 没有真实路线，或者等待期间用户又改了输入
  }

  // 地址这类只有估算的：换成后端算出的真实时间。已知地点保持查表的时间，和排名里的数字一致
  if (result.isEstimate) {
    result = { meters: real.meters, minutes: real.seconds / 60, isEstimate: false };
    showRouteResult(result, fromPlace, toPlace);
  }
  console.log('Route result:', result);
  drawRouteLine(fromPlace, toPlace, null, real.path);
}

// 生成"排名依据"下拉框的选项：只列出教学楼（包括 FitRec）
// 输入：buildings 数组
// 输出：<option> 的 HTML 字符串
// withWeek：最上面加一个"我的整周课表"（按整周课表排名）
function buildBuildingOptions(buildings, withWeek) {
  let html = '<option value="">-- Select a building --</option>';
  if (withWeek) {
    html += '<option value="my-week">⭐ My whole week of classes</option>';
  }
  buildings.forEach(function (building) {
    html += `<option value="${building.id}" translate="no">${building.name}</option>`;
  });
  return html;
}

// 计算每个宿舍到某栋楼的步行时间，并从近到远排序
// 输入：dorms 数组、一个 building 对象
// 输出：排好序的新数组，每一项是 { dorm, meters, minutes }
function rankDorms(dorms, building) {
  // map：把"宿舍数组"变成"宿舍 + 距离"的数组，一一对应
  const ranked = dorms.map(function (dorm) {
    const route = measureRoute(dorm, building);
    return { dorm: dorm, meters: route.meters, minutes: route.minutes };
  });

  // sort：按 minutes 从小到大排列
  ranked.sort(function (a, b) {
    return a.minutes - b.minutes;
  });

  return ranked;
}

// 把排名显示到 #results
// 输入：rankDorms 的结果、目标 building 对象
function showDormRanking(ranked, building) {
  let html = `<p><strong>Walking time to ${keepOriginal(building.name)}</strong></p><ol>`;

  ranked.forEach(function (item) {
    // data-dorm-id：把宿舍 id 藏在元素上，点击时靠它知道点的是哪个宿舍
    html += `
      <li class="rank-item" data-dorm-id="${item.dorm.id}">
        <strong translate="no">${item.dorm.name}</strong><br>
        <span class="rank-detail">${formatDistance(item.meters)}, ~${Math.ceil(item.minutes)} min walk</span><br>
        <span class="rank-detail">Room types: ${item.dorm.room_types.join(', ')}</span>
      </li>
    `;
  });

  html += '</ol>';
  document.getElementById('results').innerHTML = html;
}

// ===== 按整周课表给宿舍排名 =====
//
// 每个上课日：从宿舍走到当天第一节课 + 最后一节课走回宿舍，一周加起来
// 课和课之间的步行，从哪个宿舍出发都一样，所以不算

// 排名下拉框要用的宿舍、教学楼（main 里存下来，课表变了重画下拉框时用）
let rankData = null;

// 能用来排名的课：确定了地点、有星期、有时间（my-classes.js）
function weekRankClasses() {
  if (typeof myClasses === 'undefined') {
    return [];
  }
  return myClasses.items.filter(function (c) {
    return c.status === 'confirmed' && c.place && c.days.length > 0 && c.start != null;
  });
}

// 输入：dorms 数组、能用来排名的课
// 输出：排好序的 [{ dorm, minutes: 一周总共, days: 上课天数, busiest: { day, minutes } }]
function rankDormsByWeek(dorms, classes) {
  const classDays = DAY_ORDER.map(function (day) {
    const today = classes.filter(function (c) { return c.days.includes(day); })
      .sort(function (a, b) { return a.start - b.start; });
    return today.length > 0 ? { day: day, first: today[0].place, last: today[today.length - 1].place } : null;
  }).filter(Boolean);

  const ranked = dorms.map(function (dorm) {
    let total = 0;
    let busiest = { day: '', minutes: -1 };
    classDays.forEach(function (d) {
      // 每一段向上取整，和课间步行的显示一致
      const minutes = Math.ceil(measureRoute(dorm, d.first).minutes) + Math.ceil(measureRoute(d.last, dorm).minutes);
      total += minutes;
      if (minutes > busiest.minutes) {
        busiest = { day: d.day, minutes: minutes };
      }
    });
    return { dorm: dorm, minutes: total, days: classDays.length, busiest: busiest };
  });
  ranked.sort(function (a, b) { return a.minutes - b.minutes; });
  return ranked;
}

function showWeekRanking(ranked) {
  const days = ranked.length > 0 ? ranked[0].days : 0;
  // 有的课还没教室（或时间）：排名只算了一部分，要说出来，不然看起来像完整的结果
  const courseKey = function (c) { return (c.course || c.title).toUpperCase(); };
  const all = new Set(myClasses.items.filter(function (c) { return c.status !== 'skipped' && !c.draft && !c.sample; }).map(courseKey));
  const used = new Set(weekRankClasses().map(courseKey));
  const partial = used.size < all.size
    ? `<div class="rank-partial"><span>Based on ${used.size} of ${all.size} courses. Add the rest for a fair ranking.</span>
        <button type="button" class="small-button" data-action="rank-rooms">Add rooms</button></div>`
    : '';
  let html = `${partial}<p><strong>Walking to and from your classes, per week</strong></p>
    <p class="rank-detail">From the dorm to your first class and back from your last class, on each of your ${days} class ${days === 1 ? 'day' : 'days'}. Walks between classes are the same from any dorm, so they aren't counted.</p><ol>`;
  ranked.forEach(function (item) {
    html += `
      <li class="rank-item" data-dorm-id="${item.dorm.id}">
        <strong translate="no">${item.dorm.name}</strong><br>
        <span class="rank-detail">~${item.minutes} min a week · ~${Math.round(item.minutes / item.days)} min a class day</span><br>
        <span class="rank-detail">Longest day: ${item.busiest.day}, ~${item.busiest.minutes} min</span><br>
        <span class="rank-detail">Room types: ${item.dorm.room_types.join(', ')}</span>
      </li>
    `;
  });
  html += '</ol>';
  document.getElementById('results').innerHTML = html;
}

// 排名下拉框：有能用的课时，最上面多一个"我的整周课表"；第一次有课时自动选上它
// my-classes.js 每次课表变了都会调用（renderMyClasses）
function refreshRankOptions() {
  if (!rankData) {
    return;
  }
  const select = document.getElementById('rank-select');
  const before = select.value;
  const hasWeek = weekRankClasses().length > 0;
  select.innerHTML = buildBuildingOptions(rankData.buildings, hasWeek);
  if (before === 'my-week' && !hasWeek) {
    select.value = '';
  } else if (before === '' && hasWeek) {
    select.value = 'my-week';
  } else {
    select.value = before;
  }
  if (before === 'my-week' || select.value === 'my-week') {
    updateRanking(rankData.dorms, rankData.buildings);
  }
}

// 读取排名下拉框 → 计算 → 显示
// 输入：dorms 数组、buildings 数组
function updateRanking(dorms, buildings) {
  const buildingId = document.getElementById('rank-select').value;

  if (buildingId === 'my-week') {
    pinPlace('rank', null);
    showWeekRanking(rankDormsByWeek(dorms, weekRankClasses()));
    return;
  }
  pinPlace('rank', buildingId); // 排名选的那栋楼一定显示在地图上

  if (buildingId === '') {
    document.getElementById('results').innerHTML =
      '<p class="placeholder">Choose a building to rank the dorms. Add your classes in My week to rank them by your whole week.</p>';
    return;
  }

  const building = findPlaceById(buildings, buildingId);
  const ranked = rankDorms(dorms, building);
  console.log('Dorm ranking:', ranked);
  showDormRanking(ranked, building);
}

// 建立搜索索引：把每个地点所有可能被搜的名字都列出来，每个名字指回它的地点
// 输入：地点数组（宿舍、教学楼都可以）
// 输出：[{ label: 'StuVi', place: 10 Buick Street 的对象 }, ...]
function buildSearchIndex(places) {
  const index = [];
  places.forEach(function (place) {
    // 官方名字、地址、楼宇代码、分楼、覆盖的地址、别名，全部可以搜
    // 教学楼没有 units / addresses / aliases，用 || [] 换成空数组，免得 concat 把 undefined 也加进来
    const labels = [place.name, place.address, place.code]
      .concat(place.units || [], place.addresses || [], place.aliases || []);

    labels.forEach(function (label) {
      if (label) { // 跳过空的（比如还没填代码的楼，code 是 ""）
        index.push({ label: label, place: place });
      }
    });
  });
  return index;
}

// 把索引里的名字放进 datalist，作为打字时的候选项
// 候选列表只放每个宿舍的正式名字，一个宿舍一条，保持简洁
// （地址、俗称、门牌号不列出来，但输入后按回车仍然能搜到，因为它们都在搜索索引里）
function renderSearchOptions(dorms) {
  let html = '';
  dorms.forEach(function (dorm) {
    html += `<option value="${dorm.name}"></option>`;
  });
  document.getElementById('dorm-search-options').innerHTML = html;
}

// 根据用户输入找地点：先找完全一样的名字，找不到再找"包含"这段文字的
// 输入：索引、用户输入的文字、是否允许模糊查找（不传时默认允许）
// 输出：找到的地点对象；找不到时是 undefined
function findPlace(index, query, allowPartial = true) {
  const q = query.trim().toLowerCase(); // 去掉首尾空格、统一小写，"warren " 也能找到 "Warren"

  // 空的输入什么都不匹配（否则 "".includes 永远成立，会匹配到列表里第一个地点）
  if (q === '') {
    return undefined;
  }

  const exact = index.find(function (entry) {
    return entry.label.toLowerCase() === q;
  });
  if (exact) {
    return exact.place;
  }
  if (!allowPartial) {
    return undefined;
  }

  const partial = index.find(function (entry) {
    return entry.label.toLowerCase().includes(q);
  });
  if (partial) {
    return partial.place;
  }

  return undefined;
}

// 程序入口：页面加载后从这里开始执行
async function main() {
  // 三个标签页（tabs.js）：先显示 My week
  initTabs();

  const data = await loadData();
  setBuildingShapes(await loadShapes());
  setWalkTable(await loadWalkTimes());

  // 把数据交给 map.js 里的函数，画到地图上
  addDormMarkers(data.dorms);
  addBuildingMarkers(data.buildings);

  // 宿舍和教学楼合并成一个"所有地点"数组，后面按 id 查找时用
  // 给每个地点标上它是宿舍还是教学楼。合并成一个数组以后，靠这个字段还能分辨出来
  data.dorms.forEach(function (dorm) {
    dorm.kind = 'dorm';
  });
  data.buildings.forEach(function (building) {
    building.kind = 'building';
  });

  const places = data.dorms.concat(data.buildings);

  // 生成 From / To 下拉框
  // From / To：候选列表 + 所有地点的搜索索引
  renderPlaceOptions(data.dorms, data.buildings);
  const placeIndex = buildSearchIndex(places);

  // 我的课：上传截图、粘贴文字、确认 / 编辑（全部在 my-classes.js 里）
  initMyClasses(placeIndex);
  // 课间步行分析：点一行 → 在 Directions 里显示这段路（my-week.js）
  initClassWalks();
  // 课间规划：点一段路 → "＋ Plan this break"（gap-planner.js）
  initBreakPlanner();

  ['from-input', 'to-input'].forEach(function (id) {
    const box = document.getElementById(id);
    // 正在打字（包括从候选列表里点选）：只接受完全一样的名字
    box.addEventListener('input', function () {
      updateRoute(placeIndex, false);
    });
    // 打完了（按回车或点到别处）：允许模糊查找
    box.addEventListener('change', function () {
      updateRoute(placeIndex, true);
    });
  });

  // 常去的地方：几个大家都会去的地点（名字从 data.json 里拿，和候选列表里的一样）
  routePopular = ROUTE_POPULAR.map(function (item) {
    const place = findPlaceById(places, item.id);
    return place ? { label: item.label, value: place.name } : null;
  }).filter(Boolean);
  renderRoutePicks();

  // 点一个常去的地方：填进按钮所在的那一栏（From 或 To），和用户自己选完一样
  ['route-picks', 'from-picks'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', function (event) {
      const chip = event.target.closest('button[data-pick]');
      if (chip) {
        const box = document.getElementById(chip.dataset.slot === 'from' ? 'from-input' : 'to-input');
        box.value = chip.dataset.pick;
        logEvent('route-pick');
        box.dispatchEvent(new Event('change'));
      }
    });
  });

  // 📍 从我现在的位置出发
  routePlaceIndex = placeIndex;
  document.getElementById('use-location').addEventListener('click', useMyLocation);

  // ⇅ 交换起点和终点
  document.getElementById('swap-route').addEventListener('click', function () {
    const from = document.getElementById('from-input');
    const to = document.getElementById('to-input');
    const old = from.value;
    from.value = to.value;
    to.value = old;
    updateRoute(placeIndex, true);
  });

  // "← Back to Wednesday"：回到 My week 刚才看的那一天（my-week.js）
  document.getElementById('route-back').addEventListener('click', returnFromRoute);

  // 生成"排名依据"下拉框，并监听它的变化
  document.getElementById('rank-select').innerHTML = buildBuildingOptions(data.buildings);
  document.getElementById('rank-select').addEventListener('input', function () {
    updateRanking(data.dorms, data.buildings);
  });
  rankData = { dorms: data.dorms, buildings: data.buildings };
  refreshRankOptions(); // 浏览器里已经存着课：直接按整周课表排

  // 宿舍搜索框
  const searchIndex = buildSearchIndex(data.dorms);
  renderSearchOptions(data.dorms);

  // 'change'：按回车、或者从候选项里点选一个时触发（不是每打一个字都触发）
  document.getElementById('dorm-search').addEventListener('change', function (event) {
    const query = event.target.value;
    const message = document.getElementById('dorm-search-message');

    if (query.trim() === '') {
      message.textContent = '';
      return;
    }

    // 先按名字 / 别名找；找不到再按门牌号找：
    // "188 Bay State Road" 落在 "153–214 Bay State Rd" 这个范围里，就是那一段的宿舍（schedule.js 的 findPlaceByAddress）
    const dorm = findPlace(searchIndex, query) || findPlaceByAddress(query, searchIndex);
    if (dorm === undefined) {
      // 用 textContent 而不是 innerHTML：query 是用户打的字，不能当 HTML 执行
      message.textContent = `No dorm matches "${query}".`;
      return;
    }

    message.textContent = '';
    showDormInfo(dorm);
    focusPlace(dorm);
  });

  // 点击排名里的宿舍：显示详情 + 地图飞过去
  // 监听挂在外层 #results 上，因为里面的列表每次排名都会重新生成
  document.getElementById('results').addEventListener('click', function (event) {
    // event.target 是实际被点到的元素（可能是名字、距离文字……）
    // closest 从它开始往外找，找到最近的 .rank-item，也就是整个这一项
    // 排名上方"只算了几门课"那一行的按钮：去补教室（my-classes.js）
    if (event.target.closest('[data-action="rank-rooms"]')) {
      if (coursesNeedingRooms().length > 0) {
        openRoomsDialog();
      } else {
        showTab('week');
        openFirstUnchecked();
      }
      return;
    }
    const item = event.target.closest('.rank-item');
    if (item === null) {
      return; // 点到的是标题或空白处，不是某个宿舍
    }

    const dorm = findPlaceById(data.dorms, item.dataset.dormId);
    showDormInfo(dorm);
    focusPlace(dorm);

    // Dorm info 在侧边栏顶部；滚动过去，让用户看到信息已经更新
    document.getElementById('dorm-panel').scrollIntoView({ behavior: 'smooth' });
  });
}

main();
