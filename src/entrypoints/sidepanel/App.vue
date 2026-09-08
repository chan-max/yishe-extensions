<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import {
  Monitor,
  Refresh,
  TopRight,
  Setting,
  Check,
  Picture,
} from "@element-plus/icons-vue";

import { useActiveTab } from "@/composables/useActiveTab";
import { useUserSession } from "@/composables/useUserSession";
import { useWebsocketStatus } from "@/composables/useWebsocketStatus";
import { useDevMode } from "@/composables/useDevMode";
import { useImageHoverSetting } from "@/composables/useImageHoverSetting";
import { openExtensionTab } from "@/shared/extension";
import type { SiteAction } from "@/shared/site-adapter/types";

// 活跃页面感知与站点模块匹配
const { currentTab, matchedModule, refreshTab } = useActiveTab();

// 图片悬停工具开关
const {
  loading: hoverSettingLoading,
  imageHoverEnabled,
  setEnabled: setImageHoverEnabled,
} = useImageHoverSetting();

async function handleToggleHover(val: boolean | string | number) {
  const next = Boolean(val);
  await setImageHoverEnabled(next);
  ElMessage.success(next ? "已开启图片悬浮保存" : "已关闭图片悬浮保存");
}


// 会话与连接状态
const { authenticated, userInfo } = useUserSession();
const { clientState, refresh: refreshConnections } = useWebsocketStatus();
const { devMode } = useDevMode();

const isInternalPage = computed(() => {
  const url = currentTab.value.url;
  return (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  );
});

// 正在执行的操作
const executingActionId = ref<string | null>(null);

async function handleExecuteAction(action: SiteAction) {
  if (!currentTab.value.id || isInternalPage.value) {
    ElMessage.warning("请在普通网页中使用本功能");
    return;
  }

  executingActionId.value = action.id;
  try {
    await action.handler({
      tabId: currentTab.value.id,
      url: currentTab.value.url,
      hostname: currentTab.value.hostname,
      title: currentTab.value.title,
    });
    ElMessage.success(`已执行：${action.label}`);
  } catch (error: any) {
    ElMessage.error(error?.message || `执行「${action.label}」失败`);
  } finally {
    executingActionId.value = null;
  }
}

// 打开完整控制台
async function handleOpenControl() {
  try {
    await openExtensionTab("/control.html");
  } catch (err: any) {
    ElMessage.error(err?.message || "打开控制台失败");
  }
}

// 刷新状态
async function handleRefreshAll() {
  await Promise.all([refreshTab(), refreshConnections()]);
  ElMessage.success("已刷新");
}
</script>

<template>
  <div class="sidepanel-app">
    <!-- 极简顶部栏 -->
    <header class="sp-navbar">
      <div class="navbar-brand">
        <img src="/assets/logo.png" alt="YiShe" class="navbar-logo" />
        <span class="navbar-title">YiShe 设计助理</span>
        <span v-if="devMode" class="dev-tag">DEV</span>
      </div>

      <div class="navbar-actions">
        <button
          class="nav-btn"
          :class="{ 'is-active': imageHoverEnabled }"
          :title="imageHoverEnabled ? '图片悬浮保存已开启 (点击可关闭)' : '图片悬浮保存已关闭 (点击可开启)'"
          @click="handleToggleHover(!imageHoverEnabled)"
        >
          <el-icon><Picture /></el-icon>
        </button>
        <button
          class="nav-btn"
          title="刷新信息"
          @click="handleRefreshAll"
        >
          <el-icon><Refresh /></el-icon>
        </button>
        <button
          class="nav-btn"
          title="打开完整控制台"
          @click="handleOpenControl"
        >
          <el-icon><Monitor /></el-icon>
        </button>
      </div>
    </header>

    <!-- 当前网页上下文面板 -->
    <section class="site-context-card">
      <div class="site-info-row">
        <div class="site-icon-wrapper">
          <img
            v-if="currentTab.favIconUrl && !isInternalPage"
            :src="currentTab.favIconUrl"
            alt="icon"
            class="site-favicon"
            @error="($event.target as HTMLElement).style.display = 'none'"
          />
          <span v-else class="site-fallback-icon">{{ matchedModule.icon || "🌐" }}</span>
        </div>

        <div class="site-details">
          <div class="site-host-line">
            <strong class="site-hostname">{{ isInternalPage ? "浏览器系统页" : currentTab.hostname }}</strong>
            <span v-if="matchedModule.id !== 'common' && !isInternalPage" class="module-badge">
              {{ matchedModule.name }}
            </span>
          </div>
          <p class="site-page-title" :title="currentTab.title">
            {{ currentTab.title || "YiShe 助理已就绪" }}
          </p>
        </div>
      </div>

      <!-- 图片悬浮保存快捷控制 -->
      <div class="sp-feature-toggle">
        <div class="sp-feature-left">
          <el-icon class="sp-feature-icon"><Picture /></el-icon>
          <span class="sp-feature-title">图片悬浮保存</span>
        </div>
        <el-switch
          :model-value="imageHoverEnabled"
          :loading="hoverSettingLoading"
          size="small"
          inline-prompt
          active-text="开"
          inactive-text="关"
          @change="handleToggleHover"
        />
      </div>
    </section>

    <!-- 站点适配与网页工具功能区 -->
    <main class="actions-container">
      <div v-if="isInternalPage" class="internal-tip-card">
        <span>在普通网页上浏览时，将自动激活对应功能与素材工具</span>
      </div>

      <template v-else>
        <div class="actions-header">
          <span class="section-label">可用操作 ({{ matchedModule.name }})</span>
        </div>

        <div v-if="!matchedModule.actions.length" class="empty-site-card">
          <span class="empty-dot" />
          <span class="empty-text">当前站点暂无专属适配功能</span>
        </div>

        <div v-else class="action-list">
          <div
            v-for="action in matchedModule.actions"
            :key="action.id"
            class="action-card"
            :class="{ 'is-primary': action.primary }"
            @click="handleExecuteAction(action)"
          >
            <div class="action-left">
              <span class="action-icon">{{ action.icon || "⚡" }}</span>
              <div class="action-text">
                <div class="action-label-row">
                  <span class="action-label">{{ action.label }}</span>
                  <span v-if="action.badge" class="action-badge">{{ action.badge }}</span>
                </div>
                <p v-if="action.description" class="action-desc">
                  {{ action.description }}
                </p>
              </div>
            </div>

            <div class="action-right">
              <el-button
                :type="action.primary ? 'primary' : 'default'"
                size="small"
                :loading="executingActionId === action.id"
                class="action-btn"
              >
                {{ action.primary ? "立即运行" : "执行" }}
              </el-button>
            </div>
          </div>
        </div>
      </template>
    </main>

    <!-- 极简底栏 -->
    <footer class="sp-bottombar">
      <div class="bottom-user">
        <span class="user-status-dot" :class="{ online: authenticated }" />
        <span class="user-name">
          {{ authenticated ? (userInfo?.account || "已登录") : "未登录" }}
        </span>
      </div>

      <div class="bottom-client">
        <span
          class="client-dot"
          :class="{ active: clientState.status === 'connected' }"
        />
        <span class="client-text">
          客户端 {{ clientState.status === "connected" ? "就绪" : "离线" }}
        </span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.sidepanel-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: #f8fafc;
  color: #1e293b;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  overflow: hidden;
}

/* 顶部导航 */
.sp-navbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #ffffff;
  border-bottom: 1px solid #e2e8f0;
}

.navbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.navbar-logo {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.navbar-title {
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}

.dev-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: #fef3c7;
  color: #d97706;
  font-weight: 600;
}

.navbar-actions {
  display: flex;
  gap: 6px;
}

.nav-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  background: #ffffff;
  color: #64748b;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
}

.nav-btn:hover {
  color: #4f46e5;
  border-color: #c7d2fe;
  background: #f1f5f9;
}

/* 当前站点上下文卡片 */
.site-context-card {
  margin: 12px 14px 0 14px;
  padding: 12px 14px;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}

.site-info-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.site-icon-wrapper {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

.site-favicon {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.site-fallback-icon {
  font-size: 18px;
}

.site-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.site-host-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.site-hostname {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 9999px;
  background: #e0e7ff;
  color: #4338ca;
  font-weight: 500;
  white-space: nowrap;
}

.site-page-title {
  margin: 0;
  font-size: 11px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp-feature-toggle {
  margin-top: 8px;
  padding: 6px 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sp-feature-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sp-feature-icon {
  font-size: 13px;
  color: #4f46e5;
}

.sp-feature-title {
  font-size: 11px;
  font-weight: 500;
  color: #334155;
}

.nav-btn.is-active {
  color: #4f46e5;
  background: #eef2ff;
  border-color: #c7d2fe;
}

/* 功能列表区 */
.actions-container {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.internal-tip-card {
  padding: 24px 16px;
  background: #ffffff;
  border-radius: 12px;
  border: 1px dashed #cbd5e1;
  color: #64748b;
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}

.empty-site-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 16px;
  color: #94a3b8;
  font-size: 13px;
}

.empty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #cbd5e1;
}

.empty-text {
  font-weight: 500;
}

.actions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 2px 2px 2px;
}

.section-label {
  font-size: 12px;
  font-weight: 700;
  color: #475569;
  letter-spacing: 0.3px;
}

.action-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.action-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-card:hover {
  border-color: #cbd5e1;
  background: #fcfcfd;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.action-card.is-primary {
  background: linear-gradient(135deg, #f5f3ff 0%, #ffffff 100%);
  border-color: #c7d2fe;
}

.action-card.is-primary:hover {
  border-color: #a5b4fc;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.12);
}

.action-card.is-tool-setting {
  cursor: default;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}

.action-card.is-tool-setting:hover {
  border-color: #94a3b8;
  background: #ffffff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
}

.action-badge.is-active {
  background: #dcfce7;
  color: #15803d;
}

.action-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.action-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.action-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.action-label-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.action-label {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
}

.action-badge {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
  background: #ede9fe;
  color: #6d28d9;
  font-weight: 500;
}

.action-desc {
  margin: 0;
  font-size: 11px;
  color: #64748b;
  line-height: 1.3;
}

.action-btn {
  font-size: 12px;
  font-weight: 500;
}

/* 极简底部栏 */
.sp-bottombar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #ffffff;
  border-top: 1px solid #e2e8f0;
  font-size: 11px;
  color: #64748b;
}

.bottom-user,
.bottom-client {
  display: flex;
  align-items: center;
  gap: 6px;
}

.user-status-dot,
.client-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #cbd5e1;
}

.user-status-dot.online,
.client-dot.active {
  background-color: #10b981;
}
</style>
