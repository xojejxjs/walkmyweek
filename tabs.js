// tabs.js：左边的三个标签页（My week / Find a dorm / Directions；Directions 在代码里叫 route）
//
// 一次只显示一个标签页，左边就不会一长串什么都有

const TAB_NAMES = ['week', 'dorm', 'route'];

// 切换到某个标签页
// 输入：'week'、'dorm' 或 'route'
function showTab(name) {
  TAB_NAMES.forEach(function (tab) {
    const selected = tab === name;
    document.getElementById('tab-' + tab).hidden = !selected;
    document.getElementById('tab-btn-' + tab).setAttribute('aria-selected', String(selected));
  });
  // 整周宿舍排名在地图上的 ①②③（map.js）：只在 Find a dorm 页显示
  if (typeof setDormRankBadgesVisible === 'function') {
    setDormRankBadgesVisible(name === 'dorm');
  }
  // 我现在的位置（app.js）：只在 Directions 里跟踪；离开就停，回来再继续
  if (typeof stopLocationWatch === 'function') {
    if (name === 'route') {
      resumeLocationIfUsed();
    } else {
      stopLocationWatch();
    }
  }
  // 换了标签页，从这一页的开头看
  const sidebar = document.getElementById('sidebar');
  if (isPhoneLayout()) {
    // 手机上整个页面一起滚：已经滑过了标签栏的话，回到标签栏的位置（地图在上面，不用回到最顶上）
    const top = sidebar.getBoundingClientRect().top + window.scrollY;
    if (window.scrollY > top) {
      window.scrollTo({ top: top });
    }
  } else {
    sidebar.scrollTop = 0;
  }
}

// 是不是手机的上下排列（和 style.css 里的 @media (max-width: 768px) 一致）
function isPhoneLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

// 现在是哪个标签页
function currentTab() {
  return TAB_NAMES.find(function (tab) {
    return !document.getElementById('tab-' + tab).hidden;
  });
}

function initTabs() {
  document.querySelector('.tabs').addEventListener('click', function (event) {
    const button = event.target.closest('button[data-tab]');
    if (button) {
      showTab(button.dataset.tab);
    }
  });
  showTab('week');
}

console.log('tabs.js loaded');
