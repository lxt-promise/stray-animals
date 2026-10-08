<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <router-link to="/" class="logo">
          <span class="logo-emoji">🐱</span>
          <span class="logo-text">喵园</span>
          <span class="logo-sub" v-if="store.school">{{ store.school.name }}</span>
        </router-link>

        <nav class="nav">
          <router-link to="/">首页</router-link>
          <router-link to="/cats">猫谱</router-link>
          <router-link to="/map">校园地图</router-link>
          <router-link to="/sighting">目击打卡</router-link>
          <router-link to="/workbench">工作台</router-link>
          <router-link to="/vision" class="dev">识别测试</router-link>
          <router-link to="/cat-entry" class="dev">猫录入</router-link>
        </nav>

        <div class="account">
          <template v-if="store.isLogin">
            <el-dropdown @command="onCommand">
              <span class="user-chip">
                {{ store.user?.nickName || '我' }}
                <span class="role" :class="store.isMember ? 'on' : ''">
                  {{ store.isAdmin ? '管理员' : (store.isMember ? '成员' : '爱猫同学') }}
                </span>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="mine">我的主页</el-dropdown-item>
                  <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
          <template v-else>
            <el-button type="primary" size="small" round @click="$router.push('/login')">登录 / 注册</el-button>
          </template>
        </div>
      </div>
    </header>

    <main>
      <router-view />
    </main>

    <footer class="footer">
      <div>喵园 CatCampus · 校园流浪猫守护计划</div>
      <div class="small muted" style="margin-top:6px">
        流浪不是猫的归宿，校园也不是流浪猫的天堂。记录与管理，是为了让它们少一点。
      </div>
    </footer>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'

const store = useUserStore()
const router = useRouter()

onMounted(() => {
  if (!store.ready) store.loadMe()
})

function onCommand(cmd) {
  if (cmd === 'mine') router.push('/mine')
  if (cmd === 'logout') {
    store.logout()
    router.push('/')
  }
}
</script>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(255, 255, 255, .95);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
.topbar-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 24px;
}
.logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 18px; }
.logo-emoji { font-size: 24px; }
.logo-sub { font-size: 12px; font-weight: 400; color: var(--text-sub); }
.nav { display: flex; gap: 20px; flex: 1; font-size: 15px; }
.nav a { color: var(--text-sub); padding: 4px 0; }
.nav a.router-link-exact-active { color: var(--brand); font-weight: 600; }
.nav a.dev { color: var(--info); font-size: 13px; }
.account { margin-left: auto; }
.user-chip { cursor: pointer; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; }
.role { font-size: 12px; color: var(--text-sub); background: #f2f2f2; padding: 2px 8px; border-radius: 10px; }
.role.on { background: var(--brand-light); color: var(--brand-dark); }
.footer {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-sub);
  border-top: 1px solid var(--line);
  margin-top: 40px;
}
</style>
