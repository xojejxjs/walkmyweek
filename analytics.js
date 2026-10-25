// analytics.js：只负责"访问统计 + 反馈链接"
//
// 访问统计用 GoatCounter（index.html 里加载它的脚本）：不用 cookie，不收集名字、邮箱
// 我们只记"发生了什么事"，比如 "import-ics"、"route-check"，绝不发送课表内容、文件名或输入的地址
// 本地测试（localhost）时 GoatCounter 默认不统计，所以自己测试不会把数字弄乱

// 反馈问卷（Google Form）的链接。填上以后，标题栏才会出现 Feedback 按钮
const FEEDBACK_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScqPQiMmCHy4StXtsu15Z72xWaKDjLlXy84NxBYbo0-oDm1qg/viewform';

// 记一次事件
// GoatCounter 的脚本是异步加载的：刚打开网页时（比如记 load-saved）它可能还没准备好，
// 这时先排队，等它准备好再一起发出去；10 秒还没加载好（比如被浏览器插件挡住），就放弃，不影响网站
const pendingEvents = [];
let waitingForCounter = null;

function trackEvent(name) {
  if (window.goatcounter && window.goatcounter.count) {
    window.goatcounter.count({ path: name, title: name, event: true });
    return;
  }
  pendingEvents.push(name);
  if (waitingForCounter === null) {
    let tries = 0;
    waitingForCounter = setInterval(function () {
      tries++;
      const ready = window.goatcounter && window.goatcounter.count;
      if (ready || tries >= 20) {
        clearInterval(waitingForCounter);
        waitingForCounter = null;
        const queued = pendingEvents.splice(0);
        if (ready) {
          queued.forEach(trackEvent);
        }
      }
    }, 500);
  }
}

// 记录了哪些事件（以后做数据分析时对照着看）。全部只是"发生了什么"，不带任何课表内容：
//   打开网页：load-saved（这个浏览器里存着课，相当于"回来的用户"）
//   导入：import-ics / import-image / import-pdf / import-docx / import-text（选了什么格式）
//         import-ok-1-3 / import-ok-4-6 / import-ok-7plus（读出了几门课，按区间）
//         import-empty（一门都没读出来）、import-error（读不了）
//         import-all-already（全都已经有了）、import-choice-add / -new / -cancel（选了加进哪一份）
//   课表：schedule-new、schedule-switch、schedule-delete、schedule-move、compare-open
//   相同的课：shared-start（点了 Find classes you share）、shared-open（打开了 Shared classes）
//   看课：class-expand（列表里点开一门课）、map-building（地图上点了上课的楼）、walk-route（点了一段课间步行）、day-pick（点了星期按钮 / All week）
//   其他：try-sample、tab-week / tab-dorm / tab-route、route-check、ocr-tip / ocr-tip-paste（截图没认出课，提示复制文字再粘贴）、ai-read / ai-ok / ai-empty / ai-fail（点了 Read with AI、结果怎样，不记截图内容）、install-cta / install-steps-open / pwa-install-prompt / pwa-installed（加到主屏幕）、share-open / share-native / share-copy（把课表传到另一台设备）、import-link（打开了课表链接）、break-plan-open / break-stop-add / break-best-order（课间规划，不记去哪里）、route-pick（点了常去的地方）、use-location（用了定位，不记位置）、open-maps-google / open-maps-apple（交给导航软件）、directions-to-class（点了某门课的 Directions）、dorm-open、dorm-ranking、feedback-click


// Feedback 按钮：有链接才显示
function initFeedbackLink() {
  const link = document.getElementById('feedback-link');
  if (FEEDBACK_URL) {
    link.href = FEEDBACK_URL;
    link.hidden = false;
  }
}

// 用"事件委托"在整个页面上监听：不用改其他文件，统计的代码都集中在这里
function initEventTracking() {
  document.addEventListener('click', function (event) {
    const target = event.target.closest('#sample-button, #feedback-link, #schedule-text-button, #new-schedule-button, #friend-button, ' +
      '[data-walk], .tabs [data-tab], [data-action], [data-open-maps]');
    if (!target) {
      return;
    }
    // 按钮上的 data-action → 事件名（只统计下面这几种，其他按钮不记）
    const actions = {
      'switch-schedule': 'schedule-switch',
      'new-schedule': 'schedule-new',
      'delete-schedule': 'schedule-delete',
      'bulk-move': 'schedule-move'
    };
    if (target.dataset.openMaps) {
      trackEvent('open-maps-' + target.dataset.openMaps); // 打开了 Google / Apple Maps；只记哪一个，不记起点终点
    } else if (target.id === 'sample-button') {
      trackEvent('try-sample');
    } else if (target.id === 'feedback-link') {
      trackEvent('feedback-click');
    } else if (target.id === 'schedule-text-button') {
      trackEvent('import-text');
    } else if (target.id === 'new-schedule-button') {
      trackEvent('schedule-new');
    } else if (target.id === 'friend-button') {
      trackEvent('shared-start'); // 点了"找和朋友相同的课"
    } else if (target.dataset.tab) {
      trackEvent('tab-' + target.dataset.tab); // 只记点了哪个标签页
    } else if (target.dataset.walk !== undefined) {
      trackEvent('walk-route'); // 点了"课间步行"的某一行；只记这件事，不记是哪两门课
    } else if (target.dataset.action === 'toggle-compare' && target.getAttribute('aria-expanded') === 'false') {
      trackEvent('compare-open'); // 只算"打开"，不算"收起"
    } else if (target.dataset.action === 'toggle-shared' && target.getAttribute('aria-expanded') === 'false') {
      trackEvent('shared-open'); // 打开了 Shared classes
    } else if (target.dataset.action === 'toggle' && target.getAttribute('aria-expanded') === 'false') {
      trackEvent('class-expand'); // 只算"展开"，不算"收起"
    } else if (actions[target.dataset.action]) {
      trackEvent(actions[target.dataset.action]);
    }
  });

  document.addEventListener('change', function (event) {
    const id = event.target.id;
    // 导入课表：只记文件的种类（ics / image / pdf…），不记文件名和内容
    if (id === 'schedule-file') {
      Array.from(event.target.files).forEach(function (file) {
        trackEvent('import-' + fileKind(file));
      });
    }
    // 查路线：起点、终点都填好了才算一次
    if ((id === 'from-input' || id === 'to-input') &&
        document.getElementById('from-input').value && document.getElementById('to-input').value) {
      trackEvent('route-check'); // 用户自己在 Directions 里查的（事件名还叫 route-check，和以前的数据接得上）（点"课间步行"填好的路线记成 walk-route）
    }
  });

  document.addEventListener('input', function (event) {
    if (event.target.id === 'rank-select') {
      trackEvent('dorm-ranking');
    }
  });
}

initFeedbackLink();
initEventTracking();

console.log('analytics.js loaded');
