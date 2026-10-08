<template>
  <div class="page-narrow">
    <div class="card login-card">
      <div class="brand">
        <span class="emoji">🐱</span>
        <div>
          <div class="title">喵园 CatCampus</div>
          <div class="small muted">校园流浪猫守护计划</div>
        </div>
      </div>

      <el-tabs v-model="tab" class="mt">
        <el-tab-pane label="登录" name="login">
          <el-form :model="loginForm" label-position="top" @submit.prevent>
            <el-form-item label="用户名">
              <el-input v-model="loginForm.username" placeholder="请输入用户名" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="loginForm.password" type="password" show-password placeholder="请输入密码" @keyup.enter="doLogin" />
            </el-form-item>
            <el-button type="primary" class="block" :loading="loading" @click="doLogin">登录</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="注册" name="register">
          <el-form :model="regForm" label-position="top">
            <el-form-item label="用户名">
              <el-input v-model="regForm.username" placeholder="登录用，建议真名或昵称" />
            </el-form-item>
            <el-form-item label="昵称">
              <el-input v-model="regForm.nickName" placeholder="展示给其他人看的名字" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="regForm.password" type="password" show-password placeholder="至少 6 位" />
            </el-form-item>
            <el-form-item label="联系方式（选填）">
              <el-input v-model="regForm.contact" placeholder="微信 / 手机号，仅管理员可见" />
            </el-form-item>
            <el-button type="primary" class="block" :loading="loading" @click="doRegister">注册</el-button>
          </el-form>
          <div class="small muted mt" style="line-height:1.7">
            提示：<b>第一个注册的用户自动成为管理员</b>，可以在「我的主页」创建学校、审核入社申请。
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'

const store = useUserStore()
const route = useRoute()
const router = useRouter()

const tab = ref('login')
const loading = ref(false)
const loginForm = ref({ username: '', password: '' })
const regForm = ref({ username: '', nickName: '', password: '', contact: '' })

async function doLogin() {
  if (!loginForm.value.username || !loginForm.value.password) {
    return ElMessage.warning('请填写用户名和密码')
  }
  loading.value = true
  try {
    await store.login(loginForm.value.username, loginForm.value.password)
    ElMessage.success('欢迎回来')
    router.push(route.query.redirect || '/mine')
  } catch (e) { /* 拦截器已提示 */ }
  loading.value = false
}

async function doRegister() {
  const f = regForm.value
  if (!f.username || !f.password) return ElMessage.warning('请填写用户名和密码')
  if (f.password.length < 6) return ElMessage.warning('密码至少 6 位')
  loading.value = true
  try {
    await store.register(f)
    ElMessage.success('注册成功')
    router.push('/mine')
  } catch (e) { /* ignore */ }
  loading.value = false
}
</script>

<style scoped>
.login-card { padding: 32px; margin-top: 40px; }
.brand { display: flex; align-items: center; gap: 14px; }
.emoji { font-size: 44px; }
.title { font-size: 22px; font-weight: 700; }
.block { width: 100%; }
</style>
