// map.js：只负责和地图有关的事情
// （这段代码原来写在 index.html 的 <script> 里，现在搬到这里）

// L 是 Leaflet 库暴露出来的全局对象，所有地图功能都从这里开始
// L.map('map', ...) 表示：把地图画在 id="map" 的那个 div 里
const map = L.map('map', {
  center: [42.3505, -71.1075], // 地图初始中心点：[纬度, 经度]，这里先用 Warren Towers 附近
  zoom: 15 // 缩放级别，数字越大看到的范围越小、细节越多
});

// 添加地图的"底图"图层——没有这一步，地图容器是空白的
// 这里用的是 OpenStreetMap 提供的免费地图瓦片，不需要 API key
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <span translate="no">OpenStreetMap</span> contributors' // 使用免费地图要求保留这行版权说明
}).addTo(map);

// 去掉右下角的 "Leaflet" 前缀，只保留地图数据的版权说明
map.attributionControl.setPrefix(false);

// ===== 地图上的点：显示还是隐藏 =====

// 所有圆点都登记在这里：{ id, type, marker }。创建时先不放上地图，由 refreshMarkers 决定显示哪些
const markerEntries = [];

// 图例里勾选了哪些类别。默认只显示宿舍；想连宿舍也默认隐藏，就改成 new Set()
const visibleTypes = new Set(['dorm']);

// 当前"被选中"的地点 id。被选中的地点不管类别有没有勾选，都一定显示
const pinnedIds = {
  from: null,      // Directions 标签页的起点
  to: null,        // Directions 标签页的终点
  rank: null,      // 排名选的那栋楼
  highlight: null  // 当前框起来的地点
};

// 记录某一类"选中"变成了哪个地点（没选时传 null），然后刷新地图
function pinPlace(slot, id) {
  pinnedIds[slot] = id || null;
  refreshMarkers();
}

// 按规则逐个决定圆点显示还是隐藏：类别被勾选，或者这个点正被选中，就显示
function refreshMarkers() {
  const pinned = Object.values(pinnedIds);

  markerEntries.forEach(function (entry) {
    const shouldShow = visibleTypes.has(entry.type) || pinned.includes(entry.id);
    const isShown = map.hasLayer(entry.marker);

    if (shouldShow && !isShown) {
      entry.marker.addTo(map);
    } else if (!shouldShow && isShown) {
      map.removeLayer(entry.marker);
    }
  });
}

// 把所有宿舍画到地图上
// 输入：dorms 数组（来自 data.json）
// 输出：每个宿舍一个橙色圆点（登记到 markerEntries，由 refreshMarkers 决定是否显示）
function addDormMarkers(dorms) {
  dorms.forEach(function (dorm) {
    // forEach 会对数组里的每一项执行一次这个函数，dorm 就是"当前这一个宿舍"
    const marker = L.circleMarker([dorm.latitude, dorm.longitude], {
      radius: 9,
      color: 'white',       // 边框颜色
      weight: 2,            // 边框粗细
      fillColor: DORM_COLOR, // 宿舍：橙色（红色只留给"来不及"）
      fillOpacity: 0.9
    })
      .bindTooltip(keepOriginal(escapeHtml(dorm.name))) // 鼠标悬停时显示名字
      .on('click', function () {
        // 点击这个 marker 时执行：把"当前这个宿舍"交给 showDormInfo（在 app.js 里）
        showDormInfo(dorm);
        highlightPlace(dorm);
      });

    markerEntries.push({ id: dorm.id, type: 'dorm', marker: marker });
  });
  refreshMarkers();
}

// 每种地点类型对应的颜色（key 就是 data.json 里的 type）
// 规则：一种颜色只有一个意思。绿 / 黄 / 红只用来表示"来不来得及"（🟢🟡🔴），所以地点都不用这三种颜色
const TYPE_COLORS = {
  academic: '#2563eb',    // 教学楼：蓝色
  recreation: '#7c3aed',  // 健身 / 娱乐：紫色
  dining: '#0891b2',      // 食堂：青色（原来的橙色和 🟡 太像）
  student_life: '#c026d3' // 学生服务（GSU、ISSO 等）：品红（原来的青绿色和 🟢 太像）
};
const DEFAULT_TYPE_COLOR = '#666666'; // data.json 里出现没定义过的 type 时用灰色
const DORM_COLOR = '#ea580c';         // 宿舍：橙色（暖色，像"家"；和别的类型都分得开）

// 把所有教学楼画到地图上（逻辑和宿舍一样，颜色按 type 决定）
function addBuildingMarkers(buildings) {
  buildings.forEach(function (building) {
    // 查表：type 是 'recreation' 就取紫色；表里没有这个 type，就用默认灰色
    const fillColor = TYPE_COLORS[building.type] || DEFAULT_TYPE_COLOR;

    const marker = L.circleMarker([building.latitude, building.longitude], {
      radius: 7,
      color: 'white',
      weight: 2,
      fillColor: fillColor,
      fillOpacity: 0.9
    })
      .bindTooltip(keepOriginal(escapeHtml(building.name)))
      .on('click', function () {
        highlightPlace(building);
      });

    markerEntries.push({ id: building.id, type: building.type, marker: marker });
  });
  refreshMarkers();
}

// 当前画在地图上的路线。一次只保留一条，所以用一个变量记住它，下次画之前先删掉
let routeLine = null;
let routeEnds = null; // 现在画的路线从哪个地点到哪个地点：{ from: id, to: id }

// 在地图上画 A → B 的路线（统一一种醒目的颜色）
// 输入：起点对象、终点对象、结论（'green' / 'yellow' / 'red'）
// 输出：地图上出现一条虚线，并缩放到能看到两个点
// 输入：起点、终点、结论，以及可选的 path（后端返回的沿街道路线）
// 有 path：画实线，沿着街道走；没有 path：画虚线直线，只表示方向
// 路线统一用导航软件那种风格：亮蓝色主线 + 深蓝色边框
// 深蓝边框把路线和米色建筑、黄色道路、绿色公园都隔开，在哪种背景上都看得清
// 结论（🟢🟡🔴）只显示在左侧结果框里，不再用路线颜色表示
const ROUTE_COLOR = '#4a9dff';        // 主线：亮蓝色
const ROUTE_BORDER_COLOR = '#1558c0'; // 边框：深蓝色

function drawRouteLine(fromPlace, toPlace, verdict, path) {
  clearRouteLine();

  // 有 path：沿街道的实线；没有：起点到终点的直线，用虚线表示"这不是真实路线"
  const points = (path && path.length > 1)
    ? path
    : [[fromPlace.latitude, fromPlace.longitude], [toPlace.latitude, toPlace.longitude]];
  const dash = (path && path.length > 1) ? null : '8 10';

  // 描边技巧：底下一条更宽的深蓝线当边框，上面一条亮蓝线当主线
  const casing = L.polyline(points, { color: ROUTE_BORDER_COLOR, weight: 9, opacity: 1, dashArray: dash });
  const line = L.polyline(points, { color: ROUTE_COLOR, weight: 5, opacity: 1, dashArray: dash });

  // 起点、终点：路线和别的标签挤在一起时，也能一眼看出从哪里走到哪里
  // 起点：白色圆点、深蓝边；终点：深蓝实心圆点、白边（导航软件常见的样子）
  const start = L.circleMarker(points[0], {
    radius: 7, color: ROUTE_BORDER_COLOR, weight: 3, fillColor: 'white', fillOpacity: 1
  }).bindTooltip('Start: ' + keepOriginal(escapeHtml(fromPlace.name)));
  const end = L.circleMarker(points[points.length - 1], {
    radius: 8, color: 'white', weight: 3, fillColor: ROUTE_BORDER_COLOR, fillOpacity: 1
  }).bindTooltip('End: ' + keepOriginal(escapeHtml(toPlace.name)));

  // featureGroup：把线和两个点当成一个整体，一起添加、一起删除，还能一起算范围
  // 起点或终点是"我现在的位置"：那一头已经有蓝点了，不再画白点（不然会盖住蓝点）
  const parts = [casing, line];
  if (!fromPlace.isMyLocation) {
    parts.push(start);
  }
  if (!toPlace.isMyLocation) {
    parts.push(end);
  }
  routeLine = L.featureGroup(parts).addTo(map);
  // 蓝点永远在路线上面
  if (userDot) {
    userAccuracy.bringToFront();
    userDot.bringToFront();
  }

  // 路线两头的楼：框出来，标上 FROM / TO
  showRouteEnds(fromPlace, toPlace);

  // 手机上地图很小：画路线时把展开的图例收起来，路线和起点、终点的标签才放得下（点 "Show on map" 可以再打开）
  const legend = map.getContainer().querySelector('.map-legend');
  if (legend && legend.open && window.matchMedia('(max-width: 768px)').matches) {
    legend.open = false;
  }

  // 自动缩放，让整条线都在视野里；padding 留出边距：左右多留一些，起点、终点的标签放得下
  // maxZoom：很短的路不要放大到最大（地图会变模糊，也看不出周围是哪里）
  map.fitBounds(routeLine.getBounds(), { padding: [90, 60], maxZoom: 17 });
  layoutClassLabels(); // 标签避开新的路线（地图移动结束后还会再摆一次）
  bringMapIntoView();
}

// 课间规划（gap-planner.js）：下课的楼 → ① → ② → 上课的楼，一整条线
// 输入：地点数组（第一个和最后一个是两节课的楼）、每一段的沿街道路线（没有的段是 null，画直的虚线）
function drawBreakRoute(points, paths) {
  clearRouteLine();
  const parts = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = [points[i].latitude, points[i].longitude];
    const b = [points[i + 1].latitude, points[i + 1].longitude];
    const path = paths[i] && paths[i].length > 1 ? paths[i] : [a, b];
    const dash = paths[i] && paths[i].length > 1 ? null : '8 10';
    parts.push(L.polyline(path, { color: ROUTE_BORDER_COLOR, weight: 9, opacity: 1, dashArray: dash }));
    parts.push(L.polyline(path, { color: ROUTE_COLOR, weight: 5, opacity: 1, dashArray: dash }));
  }
  // 中间每个地方：深蓝圆圈里写 ①②，和按星期看的编号一样
  points.slice(1, -1).forEach(function (place, i) {
    parts.push(L.marker([place.latitude, place.longitude], {
      icon: L.divIcon({
        className: 'class-pin-wrapper',
        html: `<div class="stop-pin">${stopNumber(i + 1)}</div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      zIndexOffset: 16000
    }).bindTooltip(keepOriginal(escapeHtml(place.name))));
  });
  routeLine = L.featureGroup(parts).addTo(map);
  showRouteEnds(points[0], points[points.length - 1]); // 两节课的楼：FROM / TO
  map.fitBounds(routeLine.getBounds(), { padding: [90, 60], maxZoom: 17 });
  layoutClassLabels();
  // 不调用 bringMapIntoView：用户正在规划面板里加、改地方，手机上页面不能每次都跳回地图
}

// 把地图上的路线删掉（如果有的话）
function clearRouteLine() {
  if (routeLine !== null) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  clearRouteEnds();
}

// ===== 路线的起点、终点那两栋楼 =====
// 不管是不是"我的课"的楼、是不是同一栋（同一栋楼时没有线，但也要让用户看到是哪栋楼），都：
//   1. 用粗边框出来；
//   2. 是"我的课"的楼：它的标签上写 FROM / TO（markRouteEnds）；
//      不是的（比如宿舍、自己输入的地址）：另外放一个 "FROM · Warren Towers" 的标签

const routeEndLayer = L.featureGroup().addTo(map);

const ROUTE_END_STYLE = {
  color: '#1a1f71',
  weight: 4,
  fillColor: '#1a1f71',
  fillOpacity: 0.25,
  interactive: false
};

// 输入：起点、终点（同一个地点也可以）
function showRouteEnds(fromPlace, toPlace) {
  // 之前在列表或地图上选中的那栋楼：去掉它的粗框，现在只有路线两头是粗框，不会分不清
  if (selectedClassPlaceId !== null) {
    selectClassPlace(null);
  }
  routeEndLayer.clearLayers();
  routeEnds = { from: fromPlace.id, to: toPlace.id };
  const same = fromPlace.id === toPlace.id;
  const classIds = classLayer.getLayers().map(function (marker) { return marker.options.placeId; });
  const ends = same ? [[fromPlace, 'From + To']] : [[fromPlace, 'From'], [toPlace, 'To']];

  ends.forEach(function (end) {
    const place = end[0];
    // 我现在的位置：地图上已经有蓝点了（showUserLocation），不用再框一圈
    if (place.isMyLocation) {
      return;
    }
    const shape = buildingShapes[place.id];
    const outline = shape
      ? L.polygon(shape, ROUTE_END_STYLE)
      : L.circle([place.latitude, place.longitude], Object.assign({ radius: 30, dashArray: '6 6' }, ROUTE_END_STYLE));
    outline.addTo(routeEndLayer);

    // 不是"我的课"的楼：没有现成的标签，另外放一个
    if (!classIds.includes(place.id)) {
      const bounds = outline.getBounds();
      const name = place.code || place.name;
      L.marker([bounds.getNorth(), bounds.getCenter().lng], {
        icon: L.divIcon({
          className: 'class-pin-wrapper',
          html: `<div class="class-label route-end pos-above" style="--label-bg:${ROUTE_BORDER_COLOR}">` +
            `<span class="label-role">${end[1]}</span>${keepOriginal(escapeHtml(name))}</div>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: false,
        zIndexOffset: 15000
      }).addTo(routeEndLayer);
    }

    // 同一栋楼：楼的下面再加一句说明，比只有 FROM + TO 更一眼看得懂
    if (same) {
      const bounds = outline.getBounds();
      L.marker([bounds.getSouth(), bounds.getCenter().lng], {
        icon: L.divIcon({
          className: 'class-pin-wrapper',
          html: '<div class="class-label route-note pos-below">Same building · no walk needed</div>',
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        }),
        interactive: false,
        zIndexOffset: 15000
      }).addTo(routeEndLayer);
    }
  });
  layoutClassLabels();
}

// 同一栋楼（没有路线）：地图移到这栋楼
// 手机上整个页面一起滚动：地图可能已经滑出屏幕了。地图上画了新东西（路线、选中的楼），就滑回去让用户看到
function bringMapIntoView() {
  if (!isPhoneLayout()) {
    return;
  }
  const rect = map.getContainer().getBoundingClientRect();
  if (rect.bottom < rect.height / 2) { // 地图一半以上已经在屏幕外面
    // 直接跳过去，不用平滑滚动：平滑滚动会被紧接着的地图、标签更新打断，结果停在原地
    window.scrollTo({ top: 0 });
  }
}

function focusRouteEnds() {
  bringMapIntoView();
  if (routeEndLayer.getLayers().length > 0) {
    map.fitBounds(routeEndLayer.getBounds(), { padding: [90, 90], maxZoom: 17 });
  }
}

function clearRouteEnds() {
  routeEndLayer.clearLayers();
  routeEnds = null;
  layoutClassLabels();
}

// ===== 整周宿舍排名：在地图上比较几个宿舍（app.js showWeekRanking） =====
// 勾选的宿舍：宿舍点放大、旁边写名字；从宿舍连到你每天第一节课、最后一节课的楼
// 每个宿舍一种颜色，都是实线；这几种颜色在地图上没有别的意思（深浅差得多，色弱的人也分得开）
// 只在 Find a dorm 页显示：My week 的地图上画的是课和课之间的路
const DORM_COMPARE_STYLES = [
  { color: '#ea580c' },   // 橙：和地图上宿舍的颜色一样
  { color: '#475569' },   // 石板灰
  { color: '#92400e' }    // 深棕
];
const dormCompareLayer = L.featureGroup();

function setDormCompareVisible(visible) {
  if (visible) {
    dormCompareLayer.addTo(map);
  } else {
    dormCompareLayer.remove();
  }
}

// entries：[{ dorm, style, targets: [{ place, minutes, note }] }]
// paths：沿街道的路线，key 是 "宿舍 id>楼 id"；没有的（或没打开路线）画直线虚线
function showDormCompare(entries, paths) {
  dormCompareLayer.clearLayers();
  setDormCompareVisible(currentTab() === 'dorm');
  entries.forEach(function (entry) {
    const style = entry.style;
    entry.targets.forEach(function (t) {
      const path = paths && paths[entry.dorm.id + '>' + t.place.id];
      const points = path && path.length > 1
        ? path
        : [[entry.dorm.latitude, entry.dorm.longitude], [t.place.latitude, t.place.longitude]];
      L.polyline(points, { color: 'white', weight: 7, opacity: 0.9 }).addTo(dormCompareLayer);
      L.polyline(points, { color: style.color, weight: 4, opacity: 0.95, lineCap: 'round' })
        .bindTooltip(keepOriginal(escapeHtml(`${entry.dorm.name} → ${t.place.code || t.place.name}`)) + ` · ${t.minutes} min · ${escapeHtml(t.note)}`, { sticky: true })
        .addTo(dormCompareLayer);
    });
    // 宿舍：放大的点 + 一直显示的名字
    L.circleMarker([entry.dorm.latitude, entry.dorm.longitude], {
      radius: 11, color: 'white', weight: 3, fillColor: style.color, fillOpacity: 1
    })
      .bindTooltip(keepOriginal(escapeHtml(entry.dorm.name)), {
        permanent: true, direction: 'top', offset: [0, -10], className: 'dorm-compare-label'
      })
      .on('click', function () {
        showDormInfo(entry.dorm);
        highlightPlace(entry.dorm);
      })
      .addTo(dormCompareLayer);
  });
}

function clearDormCompare() {
  dormCompareLayer.clearLayers();
}

// 地图缩放到能看到这几个宿舍和它们连到的楼
function fitDormCompare(entries) {
  const points = [];
  entries.forEach(function (entry) {
    points.push([entry.dorm.latitude, entry.dorm.longitude]);
    entry.targets.forEach(function (t) { points.push([t.place.latitude, t.place.longitude]); });
  });
  if (points.length > 0) {
    bringMapIntoView();
    map.fitBounds(L.latLngBounds(points), { padding: [70, 70], maxZoom: 17 });
  }
}

// 让地图平滑地飞到某个地点
// 输入：一个地点对象（宿舍或教学楼）
function focusPlace(place) {
  map.flyTo([place.latitude, place.longitude], 17);
  highlightPlace(place);
}

// 建筑轮廓：key 是地点 id，value 是轮廓各个角的 [纬度, 经度]（来自 shapes.json）
let buildingShapes = {};

// app.js 读完 shapes.json 后调用，把轮廓交给地图
function setBuildingShapes(shapes) {
  buildingShapes = shapes;
}

// 当前框出来的建筑。和路线一样，一次只保留一个
let highlightLayer = null;

const HIGHLIGHT_STYLE = {
  color: '#1a1f71',     // 边框：深蓝（和"我的课"标签同一个颜色，表示"你选中的"）
  weight: 4,            // 比"我的课"每栋楼的轮廓（2）粗、填色更深，一眼看出选中的是哪栋
  fillColor: '#1a1f71',
  fillOpacity: 0.3,
  interactive: false    // 框只用来看，不接收点击，这样不会挡住下面的圆点
};

// 把某个地点所在的建筑框起来
// 输入：一个地点对象
// 输出：地图上出现一个按建筑形状画的深蓝框；没有轮廓数据时画一个圆圈代替
let highlightedId = null; // 现在框着的是哪个地点

function highlightPlace(place) {
  if (highlightLayer !== null) {
    map.removeLayer(highlightLayer);
  }
  highlightedId = place.id;

  const shape = buildingShapes[place.id];
  if (shape) {
    highlightLayer = L.polygon(shape, HIGHLIGHT_STYLE);
  } else {
    // 没有轮廓（比如 Bay State Road 这种代表一段街的点）：画一个 40 米半径的虚线圆
    highlightLayer = L.circle([place.latitude, place.longitude],
      Object.assign({ radius: 40, dashArray: '6 6' }, HIGHLIGHT_STYLE));
  }

  highlightLayer.addTo(map);
  highlightLayer.bringToBack(); // 放到圆点下面一层，圆点不会被框的颜色盖住

  pinPlace('highlight', place.id); // 框起来的地点一定要显示它的圆点
}

// 去掉框（比如在列表里收起了那门课）
function clearHighlight() {
  if (highlightLayer !== null) {
    map.removeLayer(highlightLayer);
    highlightLayer = null;
  }
  highlightedId = null;
  pinPlace('highlight', null);
}

// ===== 用户输入的地址：可以拖动的大头针 =====

// From、To 各最多一个地址大头针
const addressMarkers = { from: null, to: null };

// 在地图上放（或移动）一个地址大头针
// 输入：'from' 或 'to'、地址地点对象、拖动结束后要执行的函数（会收到新的纬度、经度）
function showAddressMarker(slot, place, onMoved) {
  const position = [place.latitude, place.longitude];

  // 每次都重新创建：保证名字和"拖完以后做什么"都对应当前这个地址
  clearAddressMarker(slot);

  // L.marker 是 Leaflet 默认的蓝色大头针；draggable: true 让用户可以拖动
  const marker = L.marker(position, { draggable: true })
    .bindTooltip(keepOriginal(escapeHtml(place.name)) + ' — drag to adjust')
    .addTo(map);

  // 'dragend'：用户松开鼠标、拖动结束时触发
  marker.on('dragend', function () {
    const latLng = marker.getLatLng();
    onMoved(latLng.lat, latLng.lng);
  });

  addressMarkers[slot] = marker;
}

// 移除一个地址大头针（这个输入框现在不是地址了）
function clearAddressMarker(slot) {
  if (addressMarkers[slot]) {
    map.removeLayer(addressMarkers[slot]);
    addressMarkers[slot] = null;
  }
}

// ===== 我现在的位置（Directions 里点了 "📍 Use my location"） =====
// 蓝点 + 浅蓝色圆圈：圆圈是定位精度，意思是"你大概在这一圈里"（室内可能偏差几十米）
// 只在用户自己点了按钮以后才出现；离开 Directions 就去掉（app.js stopLocationWatch）

const USER_DOT_COLOR = '#1a73e8'; // 地图软件里"我的位置"通用的蓝色，大家一看就懂
let userDot = null;
let userAccuracy = null;

// 输入：纬度、经度、精度（米）
function showUserLocation(lat, lng, accuracy) {
  const position = [lat, lng];
  if (!userDot) {
    userAccuracy = L.circle(position, {
      radius: accuracy, color: USER_DOT_COLOR, weight: 1, opacity: 0.4,
      fillColor: USER_DOT_COLOR, fillOpacity: 0.12, interactive: false
    }).addTo(map);
    userDot = L.circleMarker(position, {
      radius: 8, color: 'white', weight: 3, fillColor: USER_DOT_COLOR, fillOpacity: 1
    }).bindTooltip('You are here').addTo(map);
    return;
  }
  // 走动时只移动位置，不重新创建，也不移动地图（用户可能正在看别的地方）
  userDot.setLatLng(position);
  userAccuracy.setLatLng(position);
  userAccuracy.setRadius(accuracy);
}

function clearUserLocation() {
  if (userDot) {
    map.removeLayer(userDot);
    map.removeLayer(userAccuracy);
    userDot = null;
    userAccuracy = null;
  }
}

// ===== 我的课：在地图上标出上课的楼 =====

// 所有"我的课"标记放在一个图层组里，方便一次性清掉或重新画
const classLayer = L.featureGroup().addTo(map);

// "我的课"所在的每栋楼都画出轮廓：就算两个标签挤在一起（比如 LSE 和 PRB 只隔 51 米），
// 也能看清每栋楼在哪里、一共是几栋楼
const classOutlineLayer = L.featureGroup().addTo(map);

const CLASS_OUTLINE_STYLE = {
  color: CLASS_COLOR,   // 和"我的课"标签同一个深蓝色
  weight: 2,
  fillColor: CLASS_COLOR,
  fillOpacity: 0.12,
  interactive: false    // 只用来看，不接收点击，不会挡住下面的圆点
};

let classBuildingsKey = '';        // 上次画的是哪些楼。楼没变（比如只是点开了一门课）就不重新缩放地图
let selectedClassPlaceId = null;   // 列表里点开的那门课在哪栋楼

// 在地图上标出上课的楼：每栋楼一个标签 "CAS · 3 classes"，并画出楼的轮廓
// 输入：[{ place, classes, color }]，每栋楼一项
function showClassMarkers(groups) {
  classLayer.clearLayers();
  classOutlineLayer.clearLayers();

  groups.forEach(function (group) {
    // 1. 楼的轮廓；没有轮廓数据的（比如一段街）画一个虚线小圆
    const shape = buildingShapes[group.place.id];
    const style = Object.assign({ placeId: group.place.id }, CLASS_OUTLINE_STYLE);
    const outline = shape
      ? L.polygon(shape, style)
      : L.circle([group.place.latitude, group.place.longitude], Object.assign({ radius: 25, dashArray: '4 4' }, style));
    outline.addTo(classOutlineLayer);

    // 2. 标签直接写清楚意思，不用鼠标悬停也能看懂
    const count = group.classes.length;
    let shortName = group.place.code || group.place.name;
    let label = `${shortName} · ${count} ${count === 1 ? 'class' : 'classes'}`;
    // 按星期看（my-week.js）：写上课顺序 "① PRB"，一天去两次就是 "①③ CAS"
    if (group.stops) {
      shortName = group.stops.join('') + ' ' + shortName;
      label = shortName;
    }
    // 浏览器翻译网页时：楼的代码（CAS）保持原样，后面的 "· 3 classes" 可以翻
    const labelHtml = keepOriginal(escapeHtml(shortName)) + escapeHtml(label.slice(shortName.length));

    // divIcon：用一小段 HTML 当标记的图案
    // 两种写法都放进去：完整的 "CAS · 3 classes"，和挤的时候用的短的 "CAS"（style.css 决定显示哪个）
    const icon = L.divIcon({
      className: 'class-pin-wrapper',
      // label-role：画了路线、这栋楼是起点或终点时，写上 FROM / TO（markRouteEnds）
      // --label-bg：标签的底色；小尾巴（style.css 的 ::after）也用这个颜色，看起来是一体的
      html: `<div class="class-label" style="--label-bg:${group.color}"><span class="label-role"></span>` +
        `<span class="label-full">${labelHtml}</span><span class="label-short" translate="no">${escapeHtml(shortName)}</span></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });

    // 鼠标悬停时显示：楼名 + 每门课的课号、时间、教室
    const lines = group.classes.map(function (c) {
      return escapeHtml(`${c.course} ${c.section} · ${c.time} · ${c.code} ${c.room}`);
    });
    const tooltip = keepOriginal(`<strong>${escapeHtml(group.place.name)}</strong><br>${lines.join('<br>')}`);

    // 标签贴着楼的边放，不压在楼上，轮廓永远看得见；放在哪一边由 layoutClassLabels 决定
    // bounds：楼的范围，用来算上、下、右、左四个可以放的位置
    // classCount：标签挤在一起时，课多的楼优先挑位置
    const bounds = outline.getBounds();
    L.marker(labelAnchor(bounds, 'above'), {
      icon: icon,
      bounds: bounds,
      placeId: group.place.id,
      classCount: count,
      zIndexOffset: count * 100
    })
      .bindTooltip(tooltip)
      .on('click', function () {
        showClassesAt(group.place); // 左边 My classes 里标出在这栋楼上的课（my-classes.js）
      })
      .addTo(classLayer);
  });
  classOutlineLayer.bringToBack();

  // 上课的楼变了（导入、确认、删除）才缩放地图，让所有楼都在视野里
  // 只是点开、收起一门课时不缩放，不然地图会跳回去，刚移过去的楼又看不到了
  const key = groups.map(function (g) { return g.place.id; }).sort().join(',');
  if (groups.length > 0 && key !== classBuildingsKey) {
    map.fitBounds(classLayer.getBounds(), { padding: [60, 60], maxZoom: 17 });
  }
  classBuildingsKey = key;

  applyClassSelection();
  layoutClassLabels();
}

// 列表里点开一门课：地图移到这栋楼、把楼框出来（粗边），这门课的标签加一圈深色边
// 输入：一个地点；传 null 表示收起了，取消选中
function selectClassPlace(place) {
  selectedClassPlaceId = place ? place.id : null;
  if (place) {
    bringMapIntoView();
    highlightPlace(place);
    map.fitBounds(highlightLayer.getBounds(), { padding: [90, 90], maxZoom: 17 });
  } else {
    clearHighlight();
  }
  applyClassSelection();
  layoutClassLabels();
}

// 按现在选中的楼，标出选中的标签（重新画标签以后也要再标一次）
function applyClassSelection() {
  classLayer.getLayers().forEach(function (marker) {
    // 只有框着的正好是选中的那栋楼时才算选中（用户之后可能点了别的楼，框已经换了）
    const selected = selectedClassPlaceId !== null && highlightedId === selectedClassPlaceId &&
      marker.options.placeId === selectedClassPlaceId;
    marker.options.selected = selected;
    const label = marker.getElement() && marker.getElement().querySelector('.class-label');
    if (label) {
      label.classList.toggle('selected', selected);
    }
  });
}

// ===== 摆放"我的课"的标签：不挡别的标签、不挡别的上课楼、不挡路线 =====
//
// 标签不固定在一个位置：每个标签都试楼的上、下、右、左四个位置，
// 给每个位置"打分"（挡住的东西越多分越高），选分最低的那个
// 四个位置都不理想时，再试缩小的标签（只写楼代码，比如 "LSE"）
// 地图移动、缩放、路线变了，都会重新摆一次

const LABEL_POSITIONS = ['above', 'below', 'right', 'left'];

// 挡住各种东西的"扣分"：挡住别的标签最糟糕（字会叠在一起看不清）
const COST_LABEL = 10;     // 和别的标签重叠
const COST_BUILDING = 3;   // 压住别的上课楼的轮廓
const COST_ROUTE = 3;      // 压住地图上的路线
const COST_COMPACT = 2;    // 缩小成只写楼代码（能完整显示就尽量完整）
const COST_OFFSCREEN = 8;  // 有一部分跑到地图外面（手机上地图窄，最容易发生）

// 标签贴着楼的哪一边：返回那一边中点的经纬度（style.css 的 .pos-above 等决定标签往哪个方向伸出去）
function labelAnchor(bounds, pos) {
  const center = bounds.getCenter();
  if (pos === 'above') {
    return L.latLng(bounds.getNorth(), center.lng);
  }
  if (pos === 'below') {
    return L.latLng(bounds.getSouth(), center.lng);
  }
  if (pos === 'right') {
    return L.latLng(center.lat, bounds.getEast());
  }
  return L.latLng(center.lat, bounds.getWest());
}

// 把标签放到某个位置
function placeLabel(marker, label, pos, compact) {
  marker.setLatLng(labelAnchor(marker.options.bounds, pos));
  LABEL_POSITIONS.forEach(function (p) {
    label.classList.toggle('pos-' + p, p === pos);
  });
  label.classList.toggle('compact', compact);
}

function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// 这个位置挡住了多少东西
function placementCost(box, ownId, placed, outlines, routePoints) {
  let cost = 0;
  const mapBox = map.getContainer().getBoundingClientRect();
  if (box.left < mapBox.left || box.right > mapBox.right || box.top < mapBox.top || box.bottom > mapBox.bottom) {
    cost += COST_OFFSCREEN;
  }
  placed.forEach(function (other) {
    if (boxesOverlap(box, other)) {
      cost += COST_LABEL;
    }
  });
  outlines.forEach(function (outline) {
    if (outline.id !== ownId && boxesOverlap(box, outline.box)) {
      cost += COST_BUILDING;
    }
  });
  const onRoute = routePoints.some(function (p) {
    return p.x > box.left && p.x < box.right && p.y > box.top && p.y < box.bottom;
  });
  if (onRoute) {
    cost += COST_ROUTE;
  }
  return cost;
}

// 路线上每隔几个像素取一个点（屏幕坐标），用来判断标签有没有压住路线
function routeScreenPoints() {
  if (routeLine === null) {
    return [];
  }
  const box = map.getContainer().getBoundingClientRect();
  const latLngs = routeLine.getLayers()[0].getLatLngs();
  const points = [];
  for (let i = 1; i < latLngs.length; i++) {
    const a = map.latLngToContainerPoint(latLngs[i - 1]);
    const b = map.latLngToContainerPoint(latLngs[i]);
    const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 6));
    for (let s = 0; s <= steps; s++) {
      points.push({ x: box.left + a.x + (b.x - a.x) * s / steps, y: box.top + a.y + (b.y - a.y) * s / steps });
    }
  }
  return points;
}

// 画了路线时：起点、终点那两栋楼的标签写上 FROM / TO 并加深色边；别的"我的课"标签变淡
// 路线两头都不是上课的楼（比如宿舍 → 体育馆）时，标签保持原样
function markRouteEnds() {
  const ids = classLayer.getLayers().map(function (marker) { return marker.options.placeId; });
  const routeTouchesClass = routeEnds !== null && (ids.includes(routeEnds.from) || ids.includes(routeEnds.to));
  classLayer.getLayers().forEach(function (marker) {
    const label = marker.getElement() && marker.getElement().querySelector('.class-label');
    if (!label) {
      return;
    }
    let role = '';
    if (routeTouchesClass && marker.options.placeId === routeEnds.from && routeEnds.from === routeEnds.to) {
      role = 'From + To'; // 同一栋楼
    } else if (routeTouchesClass && marker.options.placeId === routeEnds.from) {
      role = 'From';
    } else if (routeTouchesClass && marker.options.placeId === routeEnds.to) {
      role = 'To';
    }
    label.querySelector('.label-role').textContent = role;
    label.classList.toggle('route-end', role !== '');
    label.classList.toggle('route-other', routeTouchesClass && role === '');
    marker.options.routeEnd = role !== '';
  });
}

// 选中的标签和路线两头的标签最先摆（它们最重要），然后是课多的楼
function layoutClassLabels() {
  markRouteEnds();
  const markers = classLayer.getLayers().slice().sort(function (a, b) {
    return (b.options.selected ? 1 : 0) - (a.options.selected ? 1 : 0) ||
      (b.options.routeEnd ? 1 : 0) - (a.options.routeEnd ? 1 : 0) ||
      b.options.classCount - a.options.classCount;
  });
  const outlines = classOutlineLayer.getLayers().map(function (layer) {
    return { id: layer.options.placeId, box: screenBox(layer.getBounds()) };
  });
  const routePoints = routeScreenPoints();
  // 已经摆好的标签。地图自己的按钮和面板（缩放按钮、"Show on map" 图例）一开始就算"占了"，标签不放到它们下面
  // 路线两头不是"我的课"的楼另外放的 FROM / TO 标签也算，"我的课"的标签不盖住它们
  const placed = Array.from(map.getContainer().querySelectorAll('.leaflet-control')).map(function (control) {
    return control.getBoundingClientRect();
  });
  routeEndLayer.eachLayer(function (layer) {
    const label = layer.getElement && layer.getElement() && layer.getElement().querySelector('.class-label');
    if (label) {
      placed.push(label.getBoundingClientRect());
    }
  });

  markers.forEach(function (marker) {
    const label = marker.getElement() && marker.getElement().querySelector('.class-label');
    if (!label) {
      return;
    }
    // 试遍"完整 / 缩小" × "上 / 下 / 右 / 左"，记下分最低的
    let best = null;
    [false, true].forEach(function (compact) {
      if (compact && (marker.options.selected || marker.options.routeEnd)) {
        return; // 选中的标签、路线两头的标签永远完整显示
      }
      LABEL_POSITIONS.forEach(function (pos) {
        if (best && best.cost === 0) {
          return; // 已经找到完全不挡东西的位置
        }
        placeLabel(marker, label, pos, compact);
        const cost = placementCost(label.getBoundingClientRect(), marker.options.placeId, placed, outlines, routePoints) +
          (compact ? COST_COMPACT : 0);
        if (!best || cost < best.cost) {
          best = { pos: pos, compact: compact, cost: cost };
        }
      });
    });
    placeLabel(marker, label, best.pos, best.compact);
    placed.push(label.getBoundingClientRect());

    // 选中的放最上层；其次缩小的（不会被大标签盖住）；其余按课的数量
    let z = marker.options.classCount * 100;
    if (best.compact) {
      z = 10000;
    }
    if (marker.options.routeEnd) {
      z = 15000;
    }
    if (marker.options.selected) {
      z = 20000;
    }
    marker.setZIndexOffset(z);
  });
}

// 地图上一块经纬度范围，换成它在屏幕上的位置（和 getBoundingClientRect 同一种坐标，方便比较是否重叠）
function screenBox(bounds) {
  const box = map.getContainer().getBoundingClientRect();
  const nw = map.latLngToContainerPoint(bounds.getNorthWest());
  const se = map.latLngToContainerPoint(bounds.getSouthEast());
  return { left: box.left + nw.x, top: box.top + nw.y, right: box.left + se.x, bottom: box.top + se.y };
}

map.on('moveend', layoutClassLabels); // 移动、缩放结束后重新摆标签（缩放结束也会触发 moveend）

function clearClassMarkers() {
  classLayer.clearLayers();
  classOutlineLayer.clearLayers();
  classBuildingsKey = ''; // 下次有课时重新缩放
}

// 确认 / 编辑时的"预览"标记：空心、虚线、带问号，表示"还没确认"
let classPreviewMarker = null;

// 在地图上预览用户正在选的那栋楼，并把地图移过去
function showClassPreview(place) {
  clearClassPreview();
  const icon = L.divIcon({
    className: 'class-pin-wrapper',
    html: '<div class="class-pin class-pin-preview">?</div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
  classPreviewMarker = L.marker([place.latitude, place.longitude], { icon: icon, interactive: false }).addTo(map);
  map.flyTo([place.latitude, place.longitude], Math.max(map.getZoom(), 16));
}

function clearClassPreview() {
  if (classPreviewMarker) {
    map.removeLayer(classPreviewMarker);
    classPreviewMarker = null;
  }
}

// 图例里的每一类：type 对应 data.json 里的 type（宿舍用 'dorm'）
const LEGEND_ITEMS = [
  { type: 'dorm', label: 'Dorm', color: DORM_COLOR },
  { type: 'academic', label: 'Academic', color: TYPE_COLORS.academic },
  { type: 'recreation', label: 'Recreation', color: TYPE_COLORS.recreation },
  { type: 'dining', label: 'Dining', color: TYPE_COLORS.dining },
  { type: 'student_life', label: 'Student Life', color: TYPE_COLORS.student_life }
];

// 在地图右下角加一个图例。每一类前面有勾选框，勾上才在地图上显示这一类
function addLegend() {
  const legend = L.control({ position: 'bottomright' });

  // Leaflet 把图例放到地图上时，会调用 onAdd，要求返回一个 HTML 元素
  legend.onAdd = function () {
    // 用 <details>：点标题可以收起 / 展开。手机屏幕小，默认收起，免得挡住地图
    const box = L.DomUtil.create('details', 'map-legend');
    box.open = !window.matchMedia('(max-width: 768px)').matches;

    let html = '<summary class="legend-title">Show on map</summary>';
    LEGEND_ITEMS.forEach(function (item) {
      const checked = visibleTypes.has(item.type) ? 'checked' : '';
      html += `
        <label>
          <input type="checkbox" data-type="${item.type}" ${checked}>
          <span class="legend-dot" style="background:${item.color}"></span>${item.label}
        </label>
      `;
    });
    box.innerHTML = html;

    // 不让图例上的点击、滚动传到地图上（否则勾选时地图会跟着拖动或缩放）
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);

    // 勾选变化：更新 visibleTypes，然后刷新地图上的点
    box.addEventListener('change', function (event) {
      const type = event.target.dataset.type;
      if (event.target.checked) {
        visibleTypes.add(type);
      } else {
        visibleTypes.delete(type);
      }
      refreshMarkers();
    });

    // 图例展开 / 收起，占的地方变了："我的课"的标签重新摆，不被图例挡住
    box.addEventListener('toggle', layoutClassLabels);

    return box;
  };

  legend.addTo(map);
}

addLegend();

console.log('map.js loaded');
