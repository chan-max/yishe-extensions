// @ts-nocheck
// floating-robot.ts: YiShe 悬浮胶囊停靠坞（替代旧版小丑机器人）

window.CoreFloatingRobot = {
  robotElement: null,
  containerElement: null,
  menuElement: null,
  isMenuOpen: false,
  isDragging: false,
  dragMoved: false,

  // 创建现代专业风格的 YiShe 悬浮胶囊
  createRobotIcon() {
    const robot = window.CoreDOMUtils.createElement(
      "div",
      "core-floating-robot yishe-dock-pill",
    );
    robot.setAttribute("title", "YiShe 设计助理 · 点击打开侧边栏 (右键更多操作)");

    robot.innerHTML = `
      <div class="yishe-dock-inner">
        <div class="yishe-dock-logo">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="url(#yishe_pill_g1)"/>
            <path d="M2 17L12 22L22 17" stroke="url(#yishe_pill_g2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2 12L12 17L22 12" stroke="url(#yishe_pill_g2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <defs>
              <linearGradient id="yishe_pill_g1" x1="2" y1="2" x2="22" y2="12" gradientUnits="userSpaceOnUse">
                <stop stop-color="#818cf8"/>
                <stop offset="1" stop-color="#4f46e5"/>
              </linearGradient>
              <linearGradient id="yishe_pill_g2" x1="2" y1="12" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop stop-color="#c084fc"/>
                <stop offset="1" stop-color="#6366f1"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <span class="yishe-dock-text">YiShe</span>
        <span class="yishe-dock-dot"></span>
      </div>
    `;

    return robot;
  },

  // 唤起原生侧边栏
  async triggerOpenSidePanel() {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "openSidePanel" }, (res) => {
          if (chrome.runtime.lastError) {
            console.warn("[YiShe] 唤起侧边栏提示:", chrome.runtime.lastError.message);
          }
        });
      }
    } catch (e) {
      console.warn("[YiShe] 打开侧边栏异常:", e);
    }
  },

  // 创建右键快捷微菜单
  createContextMenu() {
    const menu = window.CoreDOMUtils.createElement(
      "div",
      "core-robot-menu yishe-dock-menu",
    );
    menu.style.display = "none";

    const items = [
      {
        icon: "🚀",
        label: "打开原生侧边栏",
        action: () => this.triggerOpenSidePanel(),
      },
      {
        icon: "🖼️",
        label: "嗅探当前页图片",
        action: () => {
          if (window.CorePageImageCollector?.open) {
            window.CorePageImageCollector.open();
          } else {
            window.dispatchEvent(
              new CustomEvent("yishe:page-image-collector:open"),
            );
          }
        },
      },
      {
        icon: "🔄",
        label: "复位到右下角",
        action: () => this.resetPosition(),
      },
      {
        icon: "👁️",
        label: "在此网站隐藏悬浮球",
        action: () => this.hideOnCurrentSite(),
      },
    ];

    items.forEach((item) => {
      const el = window.CoreDOMUtils.createElement("div", "core-menu-item");
      el.innerHTML = `<span class="core-menu-icon">${item.icon}</span><span>${item.label}</span>`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeMenu();
        item.action();
      });
      menu.appendChild(el);
    });

    return menu;
  },

  openMenu(x, y) {
    if (!this.menuElement) return;
    this.isMenuOpen = true;
    this.menuElement.style.display = "block";

    // 智能定位防止超出屏幕
    const menuWidth = 180;
    const menuHeight = 160;
    const left = Math.min(x, window.innerWidth - menuWidth - 10);
    const top = Math.min(y, window.innerHeight - menuHeight - 10);

    this.menuElement.style.left = `${Math.max(10, left)}px`;
    this.menuElement.style.top = `${Math.max(10, top)}px`;

    const handleOutsideClick = (e) => {
      if (
        this.menuElement &&
        !this.menuElement.contains(e.target) &&
        !this.robotElement.contains(e.target)
      ) {
        this.closeMenu();
        document.removeEventListener("click", handleOutsideClick);
        document.removeEventListener("contextmenu", handleOutsideClick);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", handleOutsideClick);
      document.addEventListener("contextmenu", handleOutsideClick);
    }, 50);
  },

  closeMenu() {
    this.isMenuOpen = false;
    if (this.menuElement) {
      this.menuElement.style.display = "none";
    }
  },

  resetPosition() {
    try {
      localStorage.removeItem("yishe_dock_pos");
    } catch (_) {}
    if (this.containerElement) {
      const targetLeft = window.innerWidth - 64;
      const targetTop = window.innerHeight - 100;
      this.containerElement.style.left = `${targetLeft}px`;
      this.containerElement.style.top = `${targetTop}px`;
      this.containerElement.classList.remove("dock-left");
      this.containerElement.classList.add("dock-right");
    }
  },

  hideOnCurrentSite() {
    try {
      localStorage.setItem("yishe_dock_hidden_" + location.hostname, "1");
    } catch (_) {}
    if (this.containerElement) {
      this.containerElement.style.display = "none";
    }
    if (window.CoreDOMUtils?.showNotification) {
      window.CoreDOMUtils.showNotification("悬浮球已在本站隐藏（可点击浏览器工具栏图标打开侧边栏）", "info");
    }
  },

  // 初始化
  init() {
    // 检查当前站点是否配置了隐藏
    try {
      if (localStorage.getItem("yishe_dock_hidden_" + location.hostname) === "1") {
        return;
      }
    } catch (_) {}

    // 创建容器
    const container = window.CoreDOMUtils.createElement(
      "div",
      "core-robot-container yishe-dock-container",
    );
    this.containerElement = container;
    this.robotElement = this.createRobotIcon();
    this.menuElement = this.createContextMenu();

    container.appendChild(this.robotElement);
    document.body.appendChild(container);
    document.body.appendChild(this.menuElement);

    // 读取并设置初始位置
    let savedPos = null;
    try {
      const raw = localStorage.getItem("yishe_dock_pos");
      if (raw) savedPos = JSON.parse(raw);
    } catch (_) {}

    const setPosition = () => {
      const maxX = window.innerWidth - 60;
      const maxY = window.innerHeight - 60;
      let left = savedPos?.left ?? maxX;
      let top = savedPos?.top ?? maxY - 40;

      // 越界修正
      left = Math.max(10, Math.min(left, maxX));
      top = Math.max(20, Math.min(top, maxY));

      container.style.left = `${left}px`;
      container.style.top = `${top}px`;

      if (left < window.innerWidth / 2) {
        container.classList.add("dock-left");
        container.classList.remove("dock-right");
      } else {
        container.classList.add("dock-right");
        container.classList.remove("dock-left");
      }
    };

    setTimeout(setPosition, 0);

    // 拖拽与点击交互（区分点击与拖拽）
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let hasMoved = false;

    this.robotElement.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 仅左键拖拽
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      this.robotElement.setPointerCapture(e.pointerId);
      const rect = container.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      container.classList.add("is-dragging");
    });

    this.robotElement.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
        hasMoved = true;
      }
      const nextLeft = Math.max(
        0,
        Math.min(e.clientX - dragOffsetX, window.innerWidth - container.offsetWidth),
      );
      const nextTop = Math.max(
        0,
        Math.min(e.clientY - dragOffsetY, window.innerHeight - container.offsetHeight),
      );
      container.style.left = `${nextLeft}px`;
      container.style.top = `${nextTop}px`;
    });

    const handlePointerEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      container.classList.remove("is-dragging");
      try {
        this.robotElement.releasePointerCapture(e.pointerId);
      } catch (_) {}

      if (hasMoved) {
        // 自动贴边吸附（磁吸效果）
        const rect = container.getBoundingClientRect();
        const snapToLeft = rect.left + rect.width / 2 < window.innerWidth / 2;
        const targetLeft = snapToLeft ? 10 : window.innerWidth - rect.width - 10;
        container.style.transition = "left 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)";
        container.style.left = `${targetLeft}px`;

        if (snapToLeft) {
          container.classList.add("dock-left");
          container.classList.remove("dock-right");
        } else {
          container.classList.add("dock-right");
          container.classList.remove("dock-left");
        }

        setTimeout(() => {
          container.style.transition = "";
        }, 300);

        try {
          localStorage.setItem(
            "yishe_dock_pos",
            JSON.stringify({ left: targetLeft, top: rect.top }),
          );
        } catch (_) {}
      } else {
        // 单击触发：直接唤起原生侧边栏！
        this.triggerOpenSidePanel();
      }
    };

    this.robotElement.addEventListener("pointerup", handlePointerEnd);
    this.robotElement.addEventListener("pointercancel", handlePointerEnd);

    // 右键呼出快捷菜单
    this.robotElement.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openMenu(e.clientX, e.clientY);
    });

    // 窗口尺寸自适应
    window.addEventListener("resize", () => {
      const rect = container.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width;
      const maxY = window.innerHeight - rect.height;
      container.style.left = `${Math.min(rect.left, maxX)}px`;
      container.style.top = `${Math.min(rect.top, maxY)}px`;
    });

    console.log("[YiShe] 设计助理悬浮坞已就绪");
  },
};
