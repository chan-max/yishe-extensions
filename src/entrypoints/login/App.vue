<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Link, Lock, User } from "@element-plus/icons-vue";

import { useDevMode } from "@/composables/useDevMode";
import { ApiUtils } from "@/shared/api-utils";
import { navigateToExtensionPage } from "@/shared/extension";
import { openAuthorizePage } from "@/shared/oauth";

const form = reactive({
  username: "",
  password: "",
  rememberMe: false,
});

const submitting = ref(false);
const errorMessage = ref("");

const {
  loading: devModeLoading,
  devMode,
  refresh,
  toggle,
} = useDevMode();

onMounted(async () => {
  await refresh();
  const token = await ApiUtils.getToken();
  if (token) {
    navigateToExtensionPage("/control.html");
  }
});

async function handleSubmit() {
  if (!form.username.trim() || !form.password) {
    errorMessage.value = "请输入用户名和密码";
    return;
  }

  submitting.value = true;
  errorMessage.value = "";

  try {
    await ApiUtils.login(form.username.trim(), form.password, form.rememberMe);
    ElMessage.success("登录成功");
    navigateToExtensionPage("/control.html");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "登录失败";
  } finally {
    submitting.value = false;
  }
}

async function handleOAuthLogin() {
  try {
    await openAuthorizePage();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打开授权页面失败");
  }
}

async function handleDevModeChange(nextValue: boolean | string | number) {
  try {
    await toggle(Boolean(nextValue));
    ElMessage.success(Boolean(nextValue) ? "已启用开发模式" : "已切换到生产模式");
  } catch (error) {
    await refresh();
    ElMessage.error(error instanceof Error ? error.message : "切换失败");
  }
}
</script>

<template>
  <div class="page-shell login-page">
    <div class="login-stage">
      <section class="login-card glass-panel">
        <div class="login-card-head">
          <span class="brand-mark login-brand-mark">
            <img src="/assets/logo.png" alt="YiShe" />
          </span>

          <div class="login-card-copy">
            <strong>YiShe 登录</strong>
            <span>登录后进入控制台</span>
          </div>
        </div>

        <el-form class="login-form" label-position="top" @submit.prevent="handleSubmit">
          <el-form-item label="用户名">
            <el-input
              v-model="form.username"
              clearable
              placeholder="用户名"
              :prefix-icon="User"
              autocomplete="username"
            />
          </el-form-item>

          <el-form-item label="密码">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              placeholder="密码"
              :prefix-icon="Lock"
              autocomplete="current-password"
              @keyup.enter="handleSubmit"
            />
          </el-form-item>

          <div class="login-meta surface-inset">
            <el-checkbox v-model="form.rememberMe">记住我</el-checkbox>

            <div class="login-mode">
              <span>开发模式</span>
              <el-switch
                :model-value="devMode"
                :loading="devModeLoading"
                inline-prompt
                active-text="开"
                inactive-text="关"
                @change="handleDevModeChange"
              />
            </div>
          </div>

          <el-alert
            v-if="errorMessage"
            class="login-alert"
            type="error"
            :closable="false"
            show-icon
          >
            {{ errorMessage }}
          </el-alert>

          <el-button
            class="login-submit"
            type="primary"
            :loading="submitting"
            @click="handleSubmit"
          >
            登录
          </el-button>

          <div class="login-divider">
            <span>或</span>
          </div>

          <el-button
            class="oauth-submit"
            plain
            :icon="Link"
            @click="handleOAuthLogin"
          >
            已登录网页一键授权
          </el-button>
        </el-form>
      </section>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
}

.login-stage {
  width: min(100%, 360px);
}

.login-card {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px;
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.94)),
    #ffffff;
}

.login-card-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}

.login-brand-mark {
  width: 48px;
  height: 48px;
  border-radius: 14px;
}

.login-card-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.login-card-copy strong {
  font-size: 18px;
  letter-spacing: -0.03em;
}

.login-card-copy span {
  color: var(--app-muted-color);
  font-size: 11px;
  line-height: 1.55;
}

.login-form {
  display: flex;
  flex-direction: column;
}

.login-card :deep(.el-form-item) {
  margin-bottom: 14px;
}

.login-card :deep(.el-form-item__label) {
  margin-bottom: 6px;
}

.login-card :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.98);
}

.login-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  padding: 10px 12px;
}

.login-mode {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--app-muted-color);
  font-size: 11px;
}

.login-alert {
  margin-bottom: 14px;
}

.login-submit {
  width: 100%;
}

.login-divider {
  display: flex;
  align-items: center;
  margin: 12px 0;
  text-align: center;
}

.login-divider::before,
.login-divider::after {
  content: "";
  flex: 1;
  border-bottom: 1px solid rgba(148, 163, 184, 0.25);
}

.login-divider span {
  padding: 0 10px;
  color: var(--app-muted-color, #94a3b8);
  font-size: 11px;
}

.oauth-submit {
  width: 100%;
}

@media (max-width: 480px) {
  .login-page {
    padding: 16px 12px;
  }

  .login-card {
    padding: 16px;
    border-radius: 16px;
  }

  .login-meta {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
