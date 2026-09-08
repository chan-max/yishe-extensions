<script setup lang="ts">
import { computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { Connection, Lock, SwitchButton } from "@element-plus/icons-vue";

import { useUserSession } from "@/composables/useUserSession";
import { useWebsocketStatus } from "@/composables/useWebsocketStatus";
import { closeCurrentWindow, openExtensionTab } from "@/shared/extension";
import { getStatusMeta } from "@/shared/format";

const {
  loading: sessionLoading,
  authenticated,
  refresh: refreshSession,
  logout,
} = useUserSession();

const {
  serverState,
  clientState,
  loading: statusLoading,
  refresh: refreshConnections,
} = useWebsocketStatus();

const sessionStateText = computed(() =>
  authenticated.value ? "已登录" : "未登录",
);

const serverStatusMeta = computed(() => getStatusMeta(serverState.status));
const clientStatusMeta = computed(() => getStatusMeta(clientState.status));

onMounted(() => {
  void refreshSession({ verifyRemote: true });
  void refreshConnections();
});

async function handleOpenLoginTab() {
  try {
    await openExtensionTab("/login.html");
    closeCurrentWindow();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打开登录页失败");
  }
}

async function handleOpenControlTab() {
  if (!authenticated.value) {
    await handleOpenLoginTab();
    return;
  }

  try {
    await openExtensionTab("/control.html");
    closeCurrentWindow();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打开整页失败");
  }
}

async function handleOpenSidePanel() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const sidePanel = (chrome as any).sidePanel;
    if (sidePanel && typeof sidePanel.open === "function") {
      if (tab?.id) {
        await sidePanel.open({ tabId: tab.id });
      } else if (tab?.windowId) {
        await sidePanel.open({ windowId: tab.windowId });
      }
      closeCurrentWindow();
    } else {
      ElMessage.warning("当前浏览器不支持原生侧边栏");
    }
  } catch (error: any) {
    ElMessage.error(error?.message || "打开侧边栏失败");
  }
}

async function handleLogout() {
  await logout();
}
</script>

<template>
  <div class="page-shell popup-page">
    <div class="popup-card glass-panel">
      <div class="popup-head">
        <div class="popup-brand">
          <span class="brand-mark">
            <img src="/assets/logo.png" alt="YiShe" />
          </span>
          <strong>YiShe</strong>
        </div>

        <div class="popup-head-meta">
          <el-tag
            size="small"
            :type="authenticated ? 'success' : 'info'"
            effect="light"
          >
            {{ sessionStateText }}
          </el-tag>
        </div>
      </div>

      <template v-if="sessionLoading">
        <div class="popup-content">
          <el-skeleton :rows="4" animated />
        </div>
      </template>

      <template v-else-if="!authenticated">
        <div class="popup-body">
          <div class="popup-content">
            <div class="popup-state surface-inset">
              <span>登录状态</span>
              <strong>未登录</strong>
            </div>

            <div class="popup-actions">
              <el-button
                size="small"
                type="primary"
                class="popup-action"
                @click="handleOpenLoginTab"
              >
                去登录
              </el-button>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="popup-body">
          <div v-if="statusLoading" class="popup-status-list">
            <el-skeleton :rows="3" animated />
          </div>

          <div v-else class="popup-content">
            <div class="popup-status-list">
              <article class="status-row">
                <div class="status-row-main">
                  <el-icon><Connection /></el-icon>
                  <span>远程服务</span>
                </div>
                <el-tag size="small" :type="serverStatusMeta.type" effect="light">
                  {{ serverStatusMeta.label }}
                </el-tag>
              </article>

              <div v-if="serverState.lastError" class="status-error">
                {{ serverState.lastError }}
              </div>

              <article class="status-row">
                <div class="status-row-main">
                  <el-icon><Lock /></el-icon>
                  <span>本地客户端</span>
                </div>
                <el-tag size="small" :type="clientStatusMeta.type" effect="light">
                  {{ clientStatusMeta.label }}
                </el-tag>
              </article>

              <div v-if="clientState.lastError" class="status-error">
                {{ clientState.lastError }}
              </div>
            </div>

            <div class="popup-actions">
              <el-button
                size="small"
                type="primary"
                class="popup-action"
                @click="handleOpenSidePanel"
              >
                展开侧边栏
              </el-button>
              <el-button
                size="small"
                class="popup-action"
                @click="handleOpenControlTab"
              >
                控制台
              </el-button>
              <el-button
                size="small"
                plain
                type="danger"
                class="popup-action"
                :icon="SwitchButton"
                @click="handleLogout"
              >
                退出
              </el-button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  width: 288px;
  min-width: 288px;
  min-height: 0;
  height: auto;
}

body {
  overflow-x: hidden;
}
</style>

<style scoped>
.popup-page {
  width: 288px;
  min-height: auto;
  padding: 4px;
}

.popup-page::before {
  display: none;
}

.popup-card {
  display: flex;
  min-height: 196px;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  --ep-cover-control-height: 30px;
  --ep-cover-control-padding-x: 10px;
  --ep-cover-font-size-sm: 10px;
  --ep-cover-font-size-xs: 9px;
}

.popup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.popup-brand {
  display: flex;
  align-items: center;
  gap: 6px;
}

.popup-brand .brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}

.popup-brand strong {
  font-size: 11px;
  letter-spacing: -0.01em;
}

.popup-head-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: 28px;
}

.popup-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.popup-content {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.popup-state {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px;
  border-radius: 10px;
}

.popup-state span {
  color: #7a8ca1;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.popup-state strong {
  font-size: 13px;
  letter-spacing: -0.02em;
}

.popup-actions {
  display: flex;
  width: 100%;
  flex-direction: row;
  gap: 6px;
}

.popup-action {
  flex: 1;
  min-width: 0;
}

.popup-status-list {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 6px;
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 9px;
  background: #f7f9fc;
}

.status-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #1f2937;
}

.status-error {
  padding: 0 2px;
  color: #94a3b8;
  font-size: 9px;
  line-height: 1.5;
  word-break: break-word;
  text-align: center;
}

.popup-card :deep(.el-button) {
  margin-left: 0;
}

.popup-card :deep(.el-button .el-icon) {
  font-size: 12px;
}

.popup-card :deep(.el-button [class*="el-icon"] + span) {
  margin-left: 4px;
}

.popup-card :deep(.el-tag) {
  height: 20px;
  padding: 0 8px;
  line-height: 18px;
  font-size: 9px;
}
</style>
